import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maybeRunGc, resetGcTimestamp, type AutoGcConfig } from "../auto-gc.js";
import { createAuditLogger, type AuditEntry } from "../audit-log.js";
import { parseEvolution, patchEvolutionOnMeta } from "../memory-evolution.js";
import type { MemoryStorePort } from "../memory-store-port.js";
import { saveRetentionPolicy } from "../retention-policy.js";
import { MemoryStore, type MemoryEntry } from "../store.js";
import { readFileSync, existsSync } from "node:fs";

/**
 * Auto-GC re-checks each candidate under the store-write lock before archiving it.
 * The scan and the write are a full page apart (seconds on a real corpus); a row
 * pinned (importance ≥ 0.95), superseded, or consolidated in between must not be
 * archived, and its superseded / consolidated status must not be overwritten.
 *
 * Real temp LanceDB. The concurrent change is made by a second MemoryStore instance
 * on the same directory (a second process), injected at the moment GC hands its
 * batch to patchMetadataBatch — after the scan picked the row, before the write.
 */

const SCOPE = "project:gc-recheck";
const DAY = 86_400_000;
const GC_CONFIG: AutoGcConfig = {
  minMemoryCount: 1,
  minHoursSinceLastGc: 0,
  decayScoreThreshold: 0.15,
  maxArchivePerRun: 100,
  minAgeDays: 30,
};

const dirs: string[] = [];
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.RECALLNEST_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "rn-gc-recheck-data-"));
  dirs.push(dataDir);
  process.env.RECALLNEST_DATA_DIR = dataDir; // GC run lock, throttle stamp, store-write lock
  resetGcTimestamp();
});

afterEach(() => {
  resetGcTimestamp();
  if (previousDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
  else process.env.RECALLNEST_DATA_DIR = previousDataDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function staleEntry(id: string, text: string, vector: number[]): MemoryEntry {
  const ts = Date.now() - 400 * DAY;
  return {
    id,
    text,
    vector,
    category: "events",
    scope: SCOPE,
    importance: 0.1,
    timestamp: ts,
    metadata: JSON.stringify({
      evolution: { status: "active", version: 1, accessCount: 0, lastAccessedAt: null, validFrom: ts, validUntil: null },
    }),
    language: "en",
    fts_text: text,
  };
}

const TARGET = "00000000-0000-4000-8000-000000000001";
const CONTROL = "00000000-0000-4000-8000-000000000002";

async function seed(): Promise<{ dbPath: string; gcStore: MemoryStore; other: MemoryStore }> {
  const dir = mkdtempSync(join(tmpdir(), "rn-gc-recheck-"));
  dirs.push(dir);
  const dbPath = join(dir, "db");
  const gcStore = new MemoryStore({ dbPath, vectorDim: 3 });
  await gcStore.importEntry(staleEntry(TARGET, "a stale low-value note that GC picks", [1, 0, 0]));
  await gcStore.importEntry(staleEntry(CONTROL, "another stale low-value note, left alone", [0, 1, 0]));
  const other = new MemoryStore({ dbPath, vectorDim: 3 });
  return { dbPath, gcStore, other };
}

/** Runs `between` once, right after the scan picked its rows and before the batch write. */
function interceptBatch(store: MemoryStore, between: () => Promise<void>): { port: MemoryStorePort; picked: string[] } {
  const picked: string[] = [];
  let fired = false;
  const port = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "patchMetadataBatch") {
        const batchFn: MemoryStorePort["patchMetadataBatch"] = async (patches, scopeFilter) => {
          picked.push(...patches.map((p) => p.id));
          if (!fired) {
            fired = true;
            await between();
          }
          return target.patchMetadataBatch(patches, scopeFilter);
        };
        return batchFn;
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as MemoryStorePort;
  return { port, picked };
}

async function statusOf(store: MemoryStore, id: string): Promise<string> {
  const row = await store.getById(id);
  if (!row) throw new Error(`row ${id} missing`);
  return parseEvolution(row.metadata).status;
}

describe("auto-gc re-checks candidates under the write lock", () => {
  it("baseline: with nothing changed in between, both stale rows are archived", async () => {
    const { gcStore } = await seed();
    const { port, picked } = interceptBatch(gcStore, async () => {});
    const result = await maybeRunGc(port, GC_CONFIG, join(dirs[0]!, "no-retention"));
    expect(picked.sort()).toEqual([TARGET, CONTROL].sort());
    expect(result.archivedCount).toBe(2);
    expect(await statusOf(gcStore, TARGET)).toBe("archived");
    expect(await statusOf(gcStore, CONTROL)).toBe("archived");
  });

  it("a row pinned (importance 0.96) and superseded after the scan keeps its status and is not archived", async () => {
    const { gcStore, other } = await seed();
    const auditPath = join(dirs[0]!, "audit.jsonl");
    const { port, picked } = interceptBatch(gcStore, async () => {
      await other.update(TARGET, { importance: 0.96 });
      await other.patchMetadata(TARGET, (meta) => patchEvolutionOnMeta(meta, { status: "superseded" }));
    });

    const result = await maybeRunGc(port, GC_CONFIG, join(dirs[0]!, "no-retention"), createAuditLogger(auditPath));

    expect(picked).toContain(TARGET); // the scan did pick it — the re-check is what saved it
    expect(result.archivedCount).toBe(1);
    expect(await statusOf(gcStore, TARGET)).toBe("superseded");
    expect((await gcStore.getById(TARGET))?.importance).toBeCloseTo(0.96, 5);
    expect(await statusOf(gcStore, CONTROL)).toBe("archived");

    const audited = existsSync(auditPath)
      ? readFileSync(auditPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEntry)
      : [];
    expect(audited.filter((e) => e.operation === "archive").map((e) => e.memoryId)).toEqual([CONTROL]);
  });

  it("a row only pinned after the scan (still active) is not archived", async () => {
    const { gcStore, other } = await seed();
    const { port } = interceptBatch(gcStore, async () => {
      await other.update(TARGET, { importance: 0.96 });
    });
    const result = await maybeRunGc(port, GC_CONFIG, join(dirs[0]!, "no-retention"));
    expect(result.archivedCount).toBe(1);
    expect(await statusOf(gcStore, TARGET)).toBe("active");
  });

  it("a low-importance row superseded after the scan keeps superseded", async () => {
    const { gcStore, other } = await seed();
    const { port } = interceptBatch(gcStore, async () => {
      await other.patchMetadata(TARGET, (meta) => patchEvolutionOnMeta(meta, { status: "superseded" }));
    });
    const result = await maybeRunGc(port, GC_CONFIG, join(dirs[0]!, "no-retention"));
    expect(result.archivedCount).toBe(1);
    expect(await statusOf(gcStore, TARGET)).toBe("superseded");
  });

  it("a row consolidated after the scan keeps consolidated", async () => {
    const { gcStore, other } = await seed();
    const { port } = interceptBatch(gcStore, async () => {
      await other.patchMetadata(TARGET, (meta) => patchEvolutionOnMeta(meta, { status: "consolidated" }));
    });
    await maybeRunGc(port, GC_CONFIG, join(dirs[0]!, "no-retention"));
    expect(await statusOf(gcStore, TARGET)).toBe("consolidated");
  });

  it("a row picked by decay whose importance rose after the scan (decay back above threshold) is not archived", async () => {
    const { gcStore, other } = await seed();
    const { port, picked } = interceptBatch(gcStore, async () => {
      await other.update(TARGET, { importance: 0.9 }); // below the 0.95 pin line
    });
    const result = await maybeRunGc(port, GC_CONFIG, join(dirs[0]!, "no-retention"));
    expect(picked).toContain(TARGET);
    expect(result.archivedCount).toBe(1);
    expect(await statusOf(gcStore, TARGET)).toBe("active");
  });

  it("a row picked by retention policy and pinned after the scan is not archived", async () => {
    const { gcStore, other } = await seed();
    const retentionDir = join(dirs[0]!, "retention-cfg");
    saveRetentionPolicy(SCOPE, { autoArchiveAfterDays: 10 }, retentionDir);
    const { port, picked } = interceptBatch(gcStore, async () => {
      await other.update(TARGET, { importance: 0.96 });
    });
    // minAgeDays out of reach: the decay branch never fires, so both rows are picked by the policy alone
    const result = await maybeRunGc(port, { ...GC_CONFIG, minAgeDays: 100_000 }, retentionDir);
    expect(picked.sort()).toEqual([TARGET, CONTROL].sort());
    expect(result.archivedCount).toBe(1);
    expect(await statusOf(gcStore, TARGET)).toBe("active");
    expect(await statusOf(gcStore, CONTROL)).toBe("archived");
  });
});
