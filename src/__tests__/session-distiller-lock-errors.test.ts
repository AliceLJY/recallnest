import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withWriteLock } from "../distill-lock.js";
import {
  DISTILL_PERSIST_LOCK_OPTS,
  distillSession,
  extractAndPersist,
  type ConversationMessage,
  type SummaryResult,
} from "../session-distiller.js";
import { STORE_WRITE_NESTED_WAIT_MS } from "../store-write-budget.js";

/**
 * session distill: a failed dimension write is reported, not swallowed; a second distill of the
 * same scope waits out the first one's whole persist phase instead of timing out and throwing its
 * computed summary away; and if the scope lock is still held past the wait budget, the summary is
 * persisted without it rather than lost.
 *
 * The per-scope lock is the real cross-process flock (distill-lock.ts); RECALLNEST_DATA_DIR points
 * its directory at a temp dir. Two acquisitions from one process conflict like two processes do.
 */

const dirs: string[] = [];
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.RECALLNEST_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "rn-distill-lock-errors-"));
  dirs.push(dataDir);
  process.env.RECALLNEST_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.RECALLNEST_DATA_DIR;
  else process.env.RECALLNEST_DATA_DIR = previousDataDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface StoredRow { id: string; text: string; scope: string; [key: string]: unknown }

function createDeps(opts: { storeDelayMs?: number; embed?: (text: string) => Promise<number[]> } = {}) {
  const stored: StoredRow[] = [];
  let seq = 1;
  const deps = {
    store: {
      async store(entry: Record<string, unknown>) {
        if (opts.storeDelayMs) await sleep(opts.storeDelayMs);
        const record: StoredRow = {
          ...entry,
          id: `distill-${String(seq).padStart(8, "0")}`,
          text: String(entry.text),
          scope: String(entry.scope),
          timestamp: 1_700_000_000_000 + seq,
        };
        seq++;
        stored.push(record);
        return record;
      },
      async list() { return stored; },
      async update() { return null; },
      async getById(id: string) { return stored.find((e) => e.id === id) ?? null; },
      async get(id: string) { return stored.find((e) => e.id === id) ?? null; },
      async vectorSearch() { return []; },
    },
    embedder: { embedPassage: opts.embed ?? (async () => [0.1, 0.2, 0.3]) },
    conflictStore: {
      async save(record: Record<string, unknown>) { return record; },
      async replace(record: Record<string, unknown>) { return record; },
      async getOpenByFingerprint() { return null; },
      async getLatestByFingerprint() { return null; },
    },
  };
  return { deps, stored };
}

function summaryLLM(intent: string, fixes: string) {
  const response = `<summary>
## 1. User intent and requests
${intent}

## 4. Errors and fix records
${fixes}
</summary>`;
  return {
    chatLong: async () => response,
    breaker: { canAttempt: () => true, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, getFailureCount: () => 0 },
  };
}

const MESSAGES: ConversationMessage[] = [
  { role: "user", content: "start" },
  { role: "assistant", content: "ok" },
  { role: "user", content: "keep going" },
  { role: "assistant", content: "done" },
];

type DistillDeps = Parameters<typeof distillSession>[1];
const SCOPE = "project:distill-lock-errors";

describe("extractAndPersist reports failed dimensions", () => {
  it("an embedding failure shows up in memories_failed and errors; the other dimensions still persist", async () => {
    const { deps, stored } = createDeps({
      embed: async (text: string) => {
        if (text.includes("embedding service")) throw new Error("embedding request failed: 503");
        return [0.1, 0.2, 0.3];
      },
    });
    const summary: SummaryResult = {
      text: "s",
      dimensions: {
        user_intent: "Ship the distiller fix before the embedding service outage window",
        errors_and_fixes: "Fixed the lock wait budget for concurrent distills of a scope",
      },
    };

    const result = await extractAndPersist(summary, deps as Parameters<typeof extractAndPersist>[1], SCOPE);

    expect(result.memories_failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.dimension).toBe("user_intent");
    expect(result.errors[0]!.error).toContain("embedding request failed: 503");
    expect(result.memories_stored).toBe(1);
    expect(stored.map((r) => r.text)).toEqual(["Fixed the lock wait budget for concurrent distills of a scope"]);
  });

  it("distillSession carries the failure out to its caller", async () => {
    const { deps } = createDeps({ embed: async () => { throw new Error("embedder down"); } });
    const llm = summaryLLM("Distill this session into memories please", "Repaired the broken embedder client config");
    const result = await distillSession(MESSAGES, { ...deps, llm } as unknown as DistillDeps, { scope: SCOPE, preserveRecent: 0 });
    expect(result.persisted.memories_failed).toBe(2);
    expect(result.persisted.errors.map((e) => e.dimension).sort()).toEqual(["errors_and_fixes", "user_intent"]);
    expect(result.persisted.memories_stored).toBe(0);
  });
});

describe("concurrent distills of one scope keep both summaries", () => {
  it("the default wait budget covers a holder's whole persist phase", () => {
    expect(DISTILL_PERSIST_LOCK_OPTS.waitTimeoutMs).toBeGreaterThanOrEqual(DISTILL_PERSIST_LOCK_OPTS.maxHoldMs);
    // 8 mapped dimensions, each budgeted like one nested store-write
    expect(DISTILL_PERSIST_LOCK_OPTS.maxHoldMs).toBeGreaterThanOrEqual(8 * STORE_WRITE_NESTED_WAIT_MS);
    // and distillSession actually hands those budgets to the lock
    const src = readFileSync(join(import.meta.dir, "../session-distiller.ts"), "utf-8");
    const body = src.slice(src.indexOf("export async function distillSession("));
    expect(body).toMatch(/maxHoldMs: DISTILL_PERSIST_LOCK_OPTS\.maxHoldMs/);
    expect(body).toMatch(/waitTimeoutMs: opts\.lockWaitTimeoutMs \?\? DISTILL_PERSIST_LOCK_OPTS\.waitTimeoutMs/);
  });

  it("two distills racing on one scope both persist, serialized by the scope lock", async () => {
    const { deps, stored } = createDeps({ storeDelayMs: 150 });
    const a = distillSession(
      MESSAGES,
      { ...deps, llm: summaryLLM("First session wanted the alpha feature shipped", "Alpha: fixed the flaky alpha test") } as unknown as DistillDeps,
      { scope: SCOPE, preserveRecent: 0 },
    );
    const b = distillSession(
      MESSAGES,
      { ...deps, llm: summaryLLM("Second session wanted the beta feature shipped", "Beta: fixed the slow beta migration") } as unknown as DistillDeps,
      { scope: SCOPE, preserveRecent: 0 },
    );
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.persisted.memories_stored).toBe(2);
    expect(rb.persisted.memories_stored).toBe(2);
    expect(ra.persisted.scope_lock_timed_out).toBe(false);
    expect(rb.persisted.scope_lock_timed_out).toBe(false);
    expect(stored).toHaveLength(4);
    // serialized: one distill's two rows, then the other's
    const firstTwo = stored.slice(0, 2).map((r) => r.text.startsWith("First") || r.text.startsWith("Alpha"));
    expect(new Set(firstTwo).size).toBe(1);
  });

  it("when the scope lock outlasts the wait budget, the summary is persisted without it instead of thrown away", async () => {
    const { deps, stored } = createDeps();
    let releaseHolder: () => void = () => {};
    const holderRunning = new Promise<void>((started) => {
      void withWriteLock(`distill-${SCOPE}`, async () => {
        started();
        await new Promise<void>((resolve) => { releaseHolder = resolve; });
      });
    });
    await holderRunning;
    try {
      const result = await distillSession(
        MESSAGES,
        { ...deps, llm: summaryLLM("Keep this summary even if the lock is stuck", "Fixed: lock timeout no longer drops the summary") } as unknown as DistillDeps,
        { scope: SCOPE, preserveRecent: 0, lockWaitTimeoutMs: 200 },
      );
      expect(result.persisted.scope_lock_timed_out).toBe(true);
      expect(result.persisted.memories_stored).toBe(2);
      expect(stored).toHaveLength(2);
    } finally {
      releaseHolder();
    }
  });
});
