import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isKGModeEnabled } from "../kg-extractor.js";
import { KGStore, parseSourceIds, tripleId, type KGTripleInput } from "../kg-store.js";

/**
 * Two KGStore instances on one database directory stand in for two processes (e.g. the MCP server
 * extracting triples while a CLI forget runs). Before the fix, KGStore connected without
 * readConsistencyInterval, so a long-lived handle never saw the other instance's commits, and
 * deleteBySource read outside its lock and wrote back with insert-if-missing. Reproduced
 * 2026-10-17: B's stale deleteBySource("m1") deleted o1 outright although m3 still evidenced it,
 * and left o2 (evidenced only by m1) behind.
 *
 * Runs with RECALLNEST_KG_MODE=true (the flag that turns the KG on in production).
 */

const SCOPE = "project:kg-cross-process";
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["RECALLNEST_KG_MODE", "RECALLNEST_READ_CONSISTENCY_INTERVAL", "RECALLNEST_DATA_DIR"] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.RECALLNEST_KG_MODE = "true";
  delete process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL;
  const dataDir = mkdtempSync(join(tmpdir(), "rn-kg-xproc-data-"));
  dirs.push(dataDir);
  process.env.RECALLNEST_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function triple(object: string, source: string): KGTripleInput {
  return {
    scope: SCOPE,
    subject: "RecallNest",
    predicate: "uses",
    object,
    confidence: 0.9,
    source_memory_id: source,
    source_text: `RecallNest uses ${object} (${source})`,
  };
}

/** a, b: the two "processes"; fresh(): a new instance opened at check time, so checks never read a stale handle. */
function pair(): { a: KGStore; b: KGStore; fresh: () => KGStore } {
  const dir = mkdtempSync(join(tmpdir(), "rn-kg-xproc-"));
  dirs.push(dir);
  const dbPath = join(dir, "db");
  const lockDir = join(dir, "locks");
  return {
    a: new KGStore({ dbPath, lockDir }),
    b: new KGStore({ dbPath, lockDir }),
    fresh: () => new KGStore({ dbPath, lockDir }),
  };
}

async function sourcesOf(store: KGStore, object: string): Promise<string[] | null> {
  const edges = await store.getOutgoingEdges("RecallNest", SCOPE);
  const row = edges.find((t) => t.id === tripleId(SCOPE, "RecallNest", "uses", object));
  return row ? parseSourceIds(row.source_memory_ids, row.source_memory_id) : null;
}

/** A writes o1 from m1; B opens and reads (its handle is now on that version); A then adds m3 to o1 and writes o2 from m1. */
async function staleSetup(): Promise<ReturnType<typeof pair>> {
  const p = pair();
  await p.a.createTriples([triple("o1", "m1")]);
  expect(await p.b.countTriples(SCOPE)).toBe(1);
  await p.a.createTriples([triple("o1", "m3"), triple("o2", "m1")]);
  return p;
}

describe("KGStore sees another instance's writes (RECALLNEST_KG_MODE=true)", () => {
  it("the KG flag is on for these tests", () => {
    expect(isKGModeEnabled()).toBe(true);
  });

  it("a long-lived instance reads rows another instance committed after it opened", async () => {
    const { a, b } = pair();
    await a.createTriples([triple("o1", "m1")]);
    expect(await b.countTriples(SCOPE)).toBe(1);
    await a.createTriples([triple("o2", "m2")]);
    expect(await b.countTriples(SCOPE)).toBe(2);
    expect(await sourcesOf(b, "o2")).toEqual(["m2"]);
  });

  it("deleteBySource on the other instance keeps a triple still evidenced elsewhere and removes the one it alone evidenced", async () => {
    const { b, fresh } = await staleSetup();
    await b.deleteBySource("m1");
    expect(await sourcesOf(fresh(), "o1")).toEqual(["m3"]);
    expect(await sourcesOf(fresh(), "o2")).toBeNull();
  });

  it("with read consistency switched off, deleteBySource still decides on the latest version (read inside the lock)", async () => {
    process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = "off";
    const { b, fresh } = await staleSetup();
    await b.deleteBySource("m1");
    expect(await sourcesOf(fresh(), "o1")).toEqual(["m3"]);
    expect(await sourcesOf(fresh(), "o2")).toBeNull();
  });

  it("createTriples on a stale instance counts a mention the other instance already added", async () => {
    process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = "off";
    const { a, b, fresh } = pair();
    await a.createTriples([triple("o1", "m1")]);
    expect(await b.countTriples(SCOPE)).toBe(1);
    await a.createTriples([triple("o1", "m2")]);
    await b.createTriples([triple("o1", "m3")]);
    expect((await sourcesOf(fresh(), "o1"))?.sort()).toEqual(["m1", "m2", "m3"]);
  });
});
