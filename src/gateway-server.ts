#!/usr/bin/env bun
/**
 * RecallNest Read-Only Gateway
 *
 * A thin, authenticated, read-only front door for the RecallNest HTTP API.
 *
 * Why this exists as a separate process:
 *   `api-server.ts` deliberately binds to 127.0.0.1 AND rejects any request whose
 *   Host header is not local (`enforceLocalHttpRequestPolicy`). That is a load-bearing
 *   safety property — it also exposes write routes (`/v1/store`, `/v1/checkpoint`).
 *   Exposing it directly to a phone or a tunnel would hand out write access.
 *   This gateway sits in front instead: it authenticates, rate-limits, allows only
 *   read routes, and forwards to the local API over the loopback interface.
 *
 * Intended use: put it behind a tunnel (Tailscale Serve/Funnel, Cloudflare Tunnel, …)
 * so an AI app on a phone can read the same memory your desktop agents use.
 *
 * Design constraints (each is deliberate — think before changing):
 *   - Binds to 127.0.0.1 by default. Reaching it from outside is the tunnel's job,
 *     not this process's. Overriding the host is possible but unwise.
 *   - Read-only. The forward allow-list has no write route in it, and requests to
 *     anything not on the list are rejected before any forwarding happens.
 *   - Bearer token required, compared in constant time, and refused if too short.
 *   - Rate limited, with a hard cap on response size.
 *   - Optional file search roots are an explicit allow-list; queries are passed to
 *     ripgrep as an argv element, never through a shell.
 *
 * Start:  bun run gateway
 * Env:
 *   RECALLNEST_GATEWAY_PORT        default 8791
 *   RECALLNEST_GATEWAY_HOST        default 127.0.0.1
 *   RECALLNEST_GATEWAY_TOKEN       bearer token (>= 32 chars); or put it in
 *                                  ~/.config/recallnest/gateway-token
 *   RECALLNEST_API_URL             default http://127.0.0.1:4318
 *   RECALLNEST_GATEWAY_RATE_MAX    default 30 (requests per minute)
 *   RECALLNEST_GATEWAY_FILE_ROOTS  optional, enables GET /files/search
 *                                  format: name=/abs/path,name=/abs/path
 *   RECALLNEST_GATEWAY_RG          path to ripgrep (default: rg on PATH)
 *   RECALLNEST_GATEWAY_LOG         access log path (default ~/.config/recallnest/gateway-access.log)
 *
 * Public-door hardening (2026-11-01, after a read-only audit of the office page next door):
 *   - A per-address budget runs BEFORE auth, so an anonymous flood cannot burn CPU or fill the
 *     log; the address is the last X-Forwarded-For entry (the one the funnel proxy appended) or
 *     the socket peer. Only the first few auth failures per address and window are logged.
 *   - The log rotates at 5 MB (one .1 copy), so it can never eat the disk.
 *   - /health without a token says only that the gateway is up and read-only; the route list
 *     and file scopes are for callers that hold the token.
 *   - Upstream errors go to the log, not to the caller.
 */

import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync, appendFile, existsSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import * as envConfig from "./env-config.js";
import { HTTP_WRITE_IDLE_TIMEOUT_S } from "./store-write-budget.js";

const HOME = homedir();
const PORT = clampInt(envConfig.gatewayPortRaw(), 8791, 1, 65535);
const HOST = envConfig.gatewayHostRaw()?.trim() || "127.0.0.1";
const API_URL = (envConfig.apiUrlRaw()?.trim() || "http://127.0.0.1:4318").replace(/\/+$/, "");
const RATE_MAX = clampInt(envConfig.gatewayRateMaxRaw(), 30, 1, 10_000);
const RATE_WINDOW_MS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const RG = envConfig.gatewayRgRaw()?.trim() || "rg";
const LOG_FILE = envConfig.gatewayLogRaw()?.trim() || join(HOME, ".config", "recallnest", "gateway-access.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const ADDR_MAX = 60; // anonymous requests per address per minute, counted before auth
const AUTH_LOG_PER_ADDR = 3; // auth failures logged per address per window; the rest are silent

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ── token ────────────────────────────────────────────────────────────────────
function loadToken(): string {
  const fromEnv = envConfig.gatewayTokenRaw()?.trim();
  if (fromEnv) return fromEnv;
  const file = join(HOME, ".config", "recallnest", "gateway-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  throw new Error(
    "gateway: no token. Set RECALLNEST_GATEWAY_TOKEN or write ~/.config/recallnest/gateway-token",
  );
}

const TOKEN = loadToken();
if (TOKEN.length < 32) {
  throw new Error("gateway: token shorter than 32 chars — refusing to start");
}

// ── optional file search roots ───────────────────────────────────────────────
function parseFileRoots(): Record<string, string> {
  const raw = envConfig.gatewayFileRootsRaw()?.trim();
  if (!raw) return {};
  const roots: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [name, ...rest] = pair.split("=");
    const key = name?.trim();
    const dir = rest.join("=").trim();
    if (!key || !dir) continue;
    if (!isAbsolute(dir)) throw new Error(`gateway: file root "${key}" must be an absolute path`);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`gateway: file root "${key}" is not an existing directory: ${dir}`);
    }
    roots[key] = dir;
  }
  return roots;
}

const FILE_ROOTS = parseFileRoots();
const FILE_SEARCH_ENABLED = Object.keys(FILE_ROOTS).length > 0;

// ── read-only forward allow-list ─────────────────────────────────────────────
// Anything not listed here is a 404 before a single byte is forwarded.
const FORWARD_GET: Record<string, string> = {
  "/stats": "/v1/stats",
  "/health": "/v1/health",
};
const FORWARD_POST: Record<string, string> = {
  "/recall": "/v1/recall",
  "/search": "/v1/search",
};

// ── auth / rate limiting ─────────────────────────────────────────────────────
const wantToken = Buffer.from(TOKEN);

function authOk(header: string | null): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7).trim());
  if (given.length !== wantToken.length) return false;
  return timingSafeEqual(given, wantToken);
}

const rateHits: number[] = [];
function rateOk(): boolean {
  const now = Date.now();
  while (rateHits.length && now - rateHits[0]! >= RATE_WINDOW_MS) rateHits.shift();
  if (rateHits.length >= RATE_MAX) return false;
  rateHits.push(now);
  return true;
}

// Per-address budget, applied before the token is even looked at.
interface AddrRecord { start: number; n: number; authLogged: number }
const addrHits = new Map<string, AddrRecord>();
function clientAddress(request: Request, peer: string | undefined): string {
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded.at(-1) || peer || "unknown";
}
function addrBudget(addr: string, now: number): AddrRecord {
  if (addrHits.size > 5_000) for (const [k, r] of addrHits) if (now - r.start >= RATE_WINDOW_MS) addrHits.delete(k);
  if (addrHits.size > 20_000) addrHits.clear();
  let rec = addrHits.get(addr);
  if (!rec || now - rec.start >= RATE_WINDOW_MS) { rec = { start: now, n: 0, authLogged: 0 }; addrHits.set(addr, rec); }
  rec.n++;
  return rec;
}

let logWrites = 0;
function log(entry: Record<string, unknown>): void {
  if (++logWrites % 100 === 0) {
    try { if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, LOG_FILE + ".1"); } catch { /* no file yet, or rotation lost a race: both fine */ }
  }
  appendFile(LOG_FILE, JSON.stringify(entry) + "\n", () => {});
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  let payload = JSON.stringify(body);
  if (payload.length > MAX_RESPONSE_BYTES) {
    payload = JSON.stringify({ error: "response too large", limit: MAX_RESPONSE_BYTES });
    status = 502;
  }
  return new Response(payload, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store", ...extra },
  });
}

// ── forwarding ───────────────────────────────────────────────────────────────
async function forward(target: string, method: "GET" | "POST", body?: string): Promise<Response> {
  const init: RequestInit = { method };
  if (method === "POST") {
    init.headers = { "content-type": "application/json" };
    init.body = body ?? "{}";
  }
  const upstream = await fetch(`${API_URL}${target}`, init);
  const text = await upstream.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    return json(502, { error: "upstream response too large", limit: MAX_RESPONSE_BYTES });
  }
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ── optional ripgrep file search ─────────────────────────────────────────────
interface FileHit { file: string; line: number; text: string }

function fileSearch(query: string, scope: string, limit: number): Promise<FileHit[]> {
  const targets = scope === "all" ? Object.values(FILE_ROOTS) : [FILE_ROOTS[scope]!];
  return new Promise((resolve, reject) => {
    // argv form: the query is always one element, never touched by a shell
    const args = ["--json", "--max-count", "3", "--max-filesize", "2M", "-i", "--", query, ...targets];
    execFile(RG, args, { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 }, (err, stdout) => {
      // ripgrep exits 1 when there is no match — not an error
      if (err && err.code !== 1 && !stdout) return reject(err);
      const hits: FileHit[] = [];
      for (const line of String(stdout).split("\n")) {
        if (!line.trim() || hits.length >= limit) continue;
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.type !== "match") continue;
        hits.push({
          file: String(row.data.path.text).replace(HOME, "~"),
          line: row.data.line_number,
          text: String(row.data.lines.text).trim().slice(0, 400),
        });
      }
      resolve(hits);
    });
  });
}

// ── server ───────────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  // Writes can wait up to 30 s for store-write before they start; Bun's 10 s default would drop
  // the connection while the handler still commits.
  idleTimeout: HTTP_WRITE_IDLE_TIMEOUT_S,
  hostname: HOST,
  async fetch(request, server) {
    const id = randomUUID().slice(0, 8);
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const base = { id, at: new Date().toISOString(), path: pathname, method };

    // Anonymous budget first: a flood from one address is answered with 429 before any work, and logged once.
    const now = Date.now();
    const rec = addrBudget(clientAddress(request, server.requestIP(request)?.address), now);
    if (rec.n > ADDR_MAX) {
      if (rec.n === ADDR_MAX + 1) log({ ...base, r: "addr-rate" });
      return json(429, { error: "too many requests" }, { "retry-after": String(Math.ceil((RATE_WINDOW_MS - (now - rec.start)) / 1000)) });
    }

    const authed = authOk(request.headers.get("authorization"));

    // liveness probe needs no token; without one it says only that the door is up and read-only
    if (method === "GET" && pathname === "/health") {
      if (!authed) return json(200, { ok: true, readOnly: true });
      return json(200, {
        ok: true,
        readOnly: true,
        routes: [...Object.keys(FORWARD_GET), ...Object.keys(FORWARD_POST),
                 ...(FILE_SEARCH_ENABLED ? ["/files/search"] : [])],
        fileScopes: Object.keys(FILE_ROOTS),
      });
    }

    if (!authed) {
      if (rec.authLogged < AUTH_LOG_PER_ADDR) { rec.authLogged++; log({ ...base, r: "auth" }); }
      return json(401, { error: "unauthorized" });
    }
    if (!rateOk()) {
      log({ ...base, r: "rate" });
      return json(429, { error: `rate limited, ${RATE_MAX}/min` });
    }

    try {
      if (method === "GET" && FORWARD_GET[pathname]) {
        log({ ...base, r: "fwd" });
        return await forward(FORWARD_GET[pathname]!, "GET");
      }

      if (method === "POST" && FORWARD_POST[pathname]) {
        const raw = await request.text();
        if (raw.length > MAX_REQUEST_BYTES) {
          log({ ...base, r: "too-large" });
          return json(413, { error: `request body exceeds ${MAX_REQUEST_BYTES} bytes` });
        }
        try { JSON.parse(raw || "{}"); } catch {
          return json(400, { error: "body must be valid JSON" });
        }
        log({ ...base, r: "fwd" });
        return await forward(FORWARD_POST[pathname]!, "POST", raw || "{}");
      }

      if (method === "GET" && pathname === "/files/search") {
        if (!FILE_SEARCH_ENABLED) return json(404, { error: "file search not configured" });
        const q = (url.searchParams.get("q") || "").trim();
        const scope = url.searchParams.get("scope") || "all";
        const limit = Math.min(clampInt(url.searchParams.get("limit") ?? undefined, 10, 1, 30), 30);
        if (q.length < 2 || q.length > 200) return json(400, { error: "q must be 2-200 chars" });
        if (scope !== "all" && !FILE_ROOTS[scope]) {
          return json(400, { error: `scope must be all|${Object.keys(FILE_ROOTS).join("|")}` });
        }
        const hits = await fileSearch(q, scope, limit);
        log({ ...base, q, scope, r: "ok", n: hits.length });
        return json(200, { query: q, scope, count: hits.length, hits });
      }

      log({ ...base, r: "404" });
      return json(404, { error: "not found (this gateway is read-only)" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log({ ...base, r: "err", msg: message });
      // The message may name internal hosts and paths; the caller gets the request id to quote instead.
      return json(502, { error: "gateway error", id });
    }
  },
});

console.log(
  `RecallNest read-only gateway on http://${HOST}:${server.port} → ${API_URL}` +
    (FILE_SEARCH_ENABLED ? ` | file scopes: ${Object.keys(FILE_ROOTS).join(", ")}` : ""),
);
