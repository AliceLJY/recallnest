import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The gateway is one process with a server at module top level, so it is exercised the way it runs: as a child.
const TOKEN = "t".repeat(40);
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let logFile = "";

async function up(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch { /* not yet */ }
    await Bun.sleep(100);
  }
  throw new Error("gateway did not start");
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  logFile = join(dir, "access.log");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.RECALLNEST_GATEWAY_FILE_ROOTS;
  Object.assign(env, {
    RECALLNEST_GATEWAY_TOKEN: TOKEN,
    RECALLNEST_GATEWAY_PORT: String(PORT),
    RECALLNEST_GATEWAY_HOST: "127.0.0.1",
    RECALLNEST_API_URL: "http://127.0.0.1:1", // nothing listens there: every forward fails upstream
    RECALLNEST_GATEWAY_LOG: logFile,
  });
  proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "gateway-server.ts")], { env, stdout: "pipe", stderr: "pipe" });
  await up();
});

afterAll(() => { proc?.kill(); });

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${BASE}${path}`, { headers });
const auth = { authorization: `Bearer ${TOKEN}` };

describe("gateway public door", () => {
  test("health without a token says only up and read-only; with the token it lists routes", async () => {
    const anon = await (await get("/health")).json() as Record<string, unknown>;
    expect(anon).toEqual({ ok: true, readOnly: true });
    const full = await (await get("/health", auth)).json() as Record<string, unknown>;
    expect(full.routes).toContain("/recall");
    expect(Array.isArray(full.fileScopes)).toBe(true);
  });

  test("no token is 401 with nosniff and no-store; an upstream failure is 502 without the error text", async () => {
    const r = await get("/stats");
    expect(r.status).toBe(401);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const bad = await get("/stats", auth);
    expect(bad.status).toBe(502);
    const body = await bad.json() as Record<string, unknown>;
    expect(body.detail).toBeUndefined();
    expect(typeof body.id).toBe("string");
  });

  test("an anonymous flood from one address hits 429 after sixty requests; another address is untouched; only three auth failures per address are logged", async () => {
    const flood = (ip: string) => get("/recall", { "x-forwarded-for": `9.9.9.9, ${ip}` });
    let status = 0;
    for (let i = 0; i < 60; i++) status = (await flood("5.5.5.5")).status;
    expect(status).toBe(401);
    const over = await flood("5.5.5.5");
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await flood("6.6.6.6")).status).toBe(401);
    await Bun.sleep(200);
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const authLines = lines.filter((l) => l.r === "auth");
    expect(authLines.length).toBeGreaterThan(0);
    expect(authLines.length).toBeLessThanOrEqual(3 + 1 + 1); // 5.5.5.5 ×3, 6.6.6.6 ×1, the earlier /stats from loopback ×1
    expect(lines.filter((l) => l.r === "addr-rate").length).toBe(1);
    expect(lines.some((l) => "addr" in l)).toBe(false);
  });
});
