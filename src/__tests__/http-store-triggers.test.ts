import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleStore, type StoreHandlerDeps } from "../api-server.js";
import { createAuditLogger } from "../audit-log.js";
import { MemoryStore } from "../store.js";
import { TriggerStore } from "../trigger-store.js";

/**
 * HTTP POST /v1/store writes triggers into the memory_triggers side table, the same as
 * MCP store_memory. Before this, /v1/store did not pass `triggerStore`: triggers only
 * landed in metadata.triggers and reached recall after `triggers-backfill --rebuild`.
 * Real temp LanceDB (main table + side table in the same directory) + fake vectors.
 */

const SCOPE = "project:http-store-triggers";
const dirs: string[] = [];
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.RECALLNEST_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "rn-http-store-triggers-data-"));
  dirs.push(dataDir);
  process.env.RECALLNEST_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
  else process.env.RECALLNEST_DATA_DIR = previousDataDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TEXT = "The HTTP store endpoint must put triggers into the side table, like MCP does.";
const TRIGGERS = ["http 写的 trigger 进侧表了吗", "回填之前召回得到吗", "两条入口一样吗"];

function vectorFor(text: string): number[] {
  if (text === TEXT) return [1, 0, 0];
  const i = TRIGGERS.indexOf(text);
  if (i === 0) return [0, 1, 0];
  if (i === 1) return [0, 0.8, 0.6];
  if (i === 2) return [0, 0.6, 0.8];
  return [0, 0, 1];
}

function harness(): { deps: StoreHandlerDeps; store: MemoryStore; triggerStore: TriggerStore; queryEmbeds: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "rn-http-store-triggers-"));
  dirs.push(dir);
  const dbPath = join(dir, "db");
  const store = new MemoryStore({ dbPath, vectorDim: 3 });
  const triggerStore = new TriggerStore({ dbPath, vectorDim: 3, lockDir: join(dir, "locks") });
  const queryEmbeds: string[] = [];
  const deps: StoreHandlerDeps = {
    store,
    embedder: { embedPassage: async (text: string) => vectorFor(text) },
    auditLogger: createAuditLogger(join(dir, "audit.jsonl")),
    triggerStore,
    embedQueryBatch: async (texts: string[]) => {
      queryEmbeds.push(...texts);
      return texts.map(vectorFor);
    },
  };
  return { deps, store, triggerStore, queryEmbeds };
}

function post(body: unknown): Request {
  return new Request("http://127.0.0.1/v1/store", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/store writes triggers into the side table", () => {
  it("the side table holds as many rows as the response reports, embedded on the query side", async () => {
    const h = harness();
    const response = await handleStore(post({ text: TEXT, category: "events", scope: SCOPE, triggers: TRIGGERS }), () => h.deps);
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; triggersWritten: number; disposition: string };
    expect(body.disposition).toBe("stored");
    expect(body.triggersWritten).toBe(TRIGGERS.length);
    expect(await h.triggerStore.countForMemory(body.id)).toBe(body.triggersWritten);
    expect(h.queryEmbeds.sort()).toEqual([...TRIGGERS].sort());

    const hits = await h.triggerStore.search([0, 1, 0], 5, [SCOPE]);
    expect(hits.map((hit) => hit.memoryId)).toContain(body.id);
  });

  it("without triggers the response reports 0 and the side table stays empty for the memory", async () => {
    const h = harness();
    const response = await handleStore(post({ text: TEXT, category: "events", scope: SCOPE }), () => h.deps);
    const body = await response.json() as { id: string; triggersWritten: number };
    expect(body.triggersWritten).toBe(0);
    expect(await h.triggerStore.countForMemory(body.id)).toBe(0);
  });

  it("the default wiring hands the server's trigger store and query-side batch embedder to persistMemory", () => {
    const api = readFileSync(join(import.meta.dir, "../api-server.ts"), "utf-8");
    const from = api.indexOf("function defaultStoreDeps(");
    expect(from).toBeGreaterThanOrEqual(0);
    const body = api.slice(from, api.indexOf("\n}\n", from));
    expect(body).toMatch(/\{[^}]*\btriggerStore\b[^}]*\}\s*=\s*getComponents\(\)/);
    expect(body).toMatch(/return \{[\s\S]*\btriggerStore,[\s\S]*embedQueryBatch:[^\n]*embedBatchQuery/);
    const handler = api.slice(api.indexOf("export async function handleStore("));
    expect(handler.slice(0, handler.indexOf("\n}\n"))).toContain("persistMemory(resolveDeps(), body)");
  });
});
