import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleCapture, type CaptureHandlerDeps } from "../api-server.js";
import { createAuditLogger, type AuditEntry } from "../audit-log.js";
import { MemoryStore } from "../store.js";

/**
 * HTTP POST /v1/capture writes an audit.jsonl line per stored memory, like
 * /v1/store and MCP capture do. Real temp LanceDB + fake vectors + a temp audit
 * file; the test reads the audit file back and matches it to the rows written.
 */

const SCOPE = "project:http-capture-audit";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VECTORS: Record<string, number[]> = {
  "Capture over HTTP must leave an audit trail like MCP capture does.": [1, 0, 0],
  "The audit line carries the memory id, scope and the writing source.": [0, 1, 0],
};

function harness(): { deps: CaptureHandlerDeps; store: MemoryStore; auditPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rn-http-capture-audit-"));
  dirs.push(dir);
  const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
  const auditPath = join(dir, "audit.jsonl");
  const deps: CaptureHandlerDeps = {
    store,
    embedder: { embedPassage: async (text: string) => VECTORS[text] ?? [0, 0, 1] },
    auditLogger: createAuditLogger(auditPath),
  };
  return { deps, store, auditPath };
}

function post(body: unknown): Request {
  return new Request("http://127.0.0.1/v1/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function readAudit(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditEntry);
}

describe("POST /v1/capture writes to audit.jsonl", () => {
  it("each stored memory gets a store line with its id, scope and source", async () => {
    const h = harness();
    const texts = Object.keys(VECTORS);

    const response = await handleCapture(post({
      scope: SCOPE,
      source: "api",
      memories: texts.map((text) => ({ text, category: "events" })),
    }), () => h.deps);

    expect(response.status).toBe(201);
    const rows = await h.store.list([SCOPE], undefined, 100, 0, "exact");
    expect(rows).toHaveLength(2);

    const entries = readAudit(h.auditPath).filter((e) => e.operation === "store");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.memoryId).sort()).toEqual(rows.map((r) => r.id).sort());
    for (const entry of entries) {
      expect(entry.scope).toBe(SCOPE);
      expect(entry.actor).toBe("api");
    }
  });

  it("a body that fails validation writes nothing and logs nothing", async () => {
    const h = harness();
    const response = await handleCapture(post({ scope: SCOPE, memories: [] }), () => h.deps);
    expect(response.status).toBe(400);
    expect(readAudit(h.auditPath)).toEqual([]);
  });

  it("the default wiring hands the server's audit logger to the batch write", () => {
    const api = readFileSync(join(import.meta.dir, "../api-server.ts"), "utf-8");
    const from = api.indexOf("function defaultCaptureDeps(");
    expect(from).toBeGreaterThanOrEqual(0);
    const body = api.slice(from, api.indexOf("\n}\n", from));
    expect(body).toMatch(/return \{[^}]*\bauditLogger\b[^}]*\}/);
  });
});
