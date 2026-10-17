import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistMemory, persistMemoryBatch, type PersistMemoryDeps, type PersistedMemoryRecord } from "../capture-engine.js";
import { MemoryStore } from "../store.js";
import {
  buildStoreHttpResponse,
  dispositionWroteMemory,
  formatBatchStoreReceipt,
  formatStoreMemoryReceipt,
} from "../store-receipts.js";
import { TriggerStore } from "../trigger-store.js";

/**
 * 写入工具回执与实际结果对得上（2026-10-17 体检第 7 条）。
 *
 * 真实临时 LanceDB + 真实 TriggerStore + 本地假向量：回执里说存了几行、挂了几条 trigger，
 * 都拿表里实际的行数核对。另有三个 handler 的源码守卫，确认它们用的就是这里测的格式化函数。
 */

const SCOPE = "project:receipt-test";
const PIVOT_SCOPE = "memory:pivot";
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// 所有正文同一个向量：偏好写第二条时 matcher 的无 LLM 分支必判 skip（相似度 1 ≥ 0.92）
const SAME_VECTOR = [1, 0, 0];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "rn-store-receipts-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "db");
  const store = new MemoryStore({ dbPath, vectorDim: 3 });
  const triggerStore = new TriggerStore({ dbPath, vectorDim: 3 });
  const deps: PersistMemoryDeps = {
    store,
    embedder: { embedPassage: async () => SAME_VECTOR },
    triggerStore,
    embedQueryBatch: async (texts: string[]) => texts.map(() => SAME_VECTOR),
    noisePrototypeBank: null,
  };
  const rowCount = async (scope: string): Promise<number> =>
    (await store.list([scope], undefined, 100, 0, "exact")).length;
  return { deps, store, triggerStore, rowCount };
}

function record(overrides: Partial<PersistedMemoryRecord>): PersistedMemoryRecord {
  return {
    id: "a1b2c3d4-0000-0000-0000-000000000000",
    text: "User prefers dark editor themes everywhere",
    category: "preferences",
    importance: 0.7,
    scope: SCOPE,
    source: "manual",
    tags: [],
    privacyTier: "durable",
    canonicalKey: "preferences:dark-theme",
    resolvedScope: SCOPE,
    storedAt: "2026-10-17T00:00:00.000Z",
    disposition: "stored",
    triggersWritten: 0,
    ...overrides,
  };
}

describe("persistMemory reports what actually landed", () => {
  it("rejected write: receipt says Not stored, no undefined key, no trigger count, table empty", async () => {
    const h = harness();
    const stored = await persistMemory(h.deps, {
      text: "too short",
      category: "events",
      scope: SCOPE,
      triggers: ["那个太短的东西是什么", "之前存过的短句"],
    });
    expect(stored.disposition).toBe("rejected");
    expect(stored.triggersWritten).toBe(0);
    expect(await h.rowCount(SCOPE)).toBe(0);

    const text = formatStoreMemoryReceipt(stored, { requestedTriggers: 2, scope: SCOPE });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Not stored: rejected (text_too_short)");
    expect(text).not.toContain("Stored memory");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("Stored at:");
    expect(lines).toContain("Triggers: 0 of 2 written (nothing was stored)");
  }, 30_000);

  it("preference deduped by the matcher: receipt names the existing row, trigger count is 0 and matches the side table", async () => {
    const h = harness();
    const first = await persistMemory(h.deps, {
      text: "User prefers dark editor themes in every tool",
      category: "preferences",
      scope: SCOPE,
    });
    expect(first.disposition).toBe("stored");

    const second = await persistMemory(h.deps, {
      text: "User likes a dark theme for all editors",
      category: "preferences",
      scope: SCOPE,
      triggers: ["她编辑器用什么主题", "深色还是浅色", "配色偏好是什么"],
    });
    // 写入行为不变：仍是判重跳过，表里只有第一行，侧表没给任何行写 trigger
    expect(second.disposition).toBe("deduped");
    expect(await h.rowCount(SCOPE)).toBe(1);
    expect(await h.triggerStore.countForMemory(first.id)).toBe(0);
    // 回执：报被命中那一行的 id（以前是字面量 "skipped"），trigger 报实际写入的 0 条
    expect(second.id).toBe(first.id);
    expect(second.triggersWritten).toBe(0);

    const text = formatStoreMemoryReceipt(second, { requestedTriggers: 3, scope: SCOPE });
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Not stored: duplicate of existing memory ${first.id}`);
    expect(lines).toContain(`Triggers: 0 of 3 written (none attached to memory ${first.id.slice(0, 8)})`);
    expect(lines).not.toContain("Triggers: 3");
  }, 30_000);

  it("stored write with triggers: receipt count equals the side-table rows", async () => {
    const h = harness();
    const stored = await persistMemory(h.deps, {
      text: "RecallNest receipts now follow the write disposition",
      category: "events",
      scope: SCOPE,
      triggers: ["回执怎么写的", "存没存成功怎么看"],
    });
    expect(stored.disposition).toBe("stored");
    expect(stored.triggersWritten).toBe(2);
    expect(await h.triggerStore.countForMemory(stored.id)).toBe(2);

    const lines = formatStoreMemoryReceipt(stored, { requestedTriggers: 2, scope: SCOPE }).split("\n");
    expect(lines[0]).toBe(`Stored memory ${stored.id.slice(0, 8)}`);
    expect(lines).toContain("Triggers: 2");
  }, 30_000);

  it("trigger store absent: a stored write reports 0 of N, not N", async () => {
    const h = harness();
    const stored = await persistMemory({ ...h.deps, triggerStore: null }, {
      text: "A memory written through an entry point without a trigger table",
      category: "events",
      scope: SCOPE,
      triggers: ["没有侧表时怎么报", "trigger 写到哪去了"],
    });
    expect(stored.disposition).toBe("stored");
    expect(stored.triggersWritten).toBe(0);
    const lines = formatStoreMemoryReceipt(stored, { requestedTriggers: 2, scope: SCOPE }).split("\n");
    expect(lines).toContain(`Triggers: 0 of 2 written (none attached to memory ${stored.id.slice(0, 8)})`);
  }, 30_000);

  it("batch: rejected items are counted as rejected, and the stored count matches the table", async () => {
    const h = harness();
    const records = await persistMemoryBatch(h.deps, {
      scope: SCOPE,
      source: "agent",
      defaultImportance: 0.7,
      memories: [
        { text: "First batch memory long enough to be admitted", category: "events" },
        { text: "short", category: "events" },
        { text: "Second batch memory long enough to be admitted", category: "entities" },
        { text: "tiny", category: "events" },
      ],
    });
    expect(await h.rowCount(SCOPE)).toBe(2);

    const lines = formatBatchStoreReceipt(records).split("\n");
    expect(lines[0]).toBe("Stored 2 of 4 memories (2 new, 0 updated, 0 promoted, 0 deduped, 0 conflict, 2 rejected)");
    expect(lines.slice(1)).toEqual([
      "- #2 rejected (text_too_short)",
      "- #4 rejected (text_too_short)",
    ]);
  }, 30_000);
});

describe("formatStoreMemoryReceipt", () => {
  it("headline follows the disposition", () => {
    const head = (r: PersistedMemoryRecord) => formatStoreMemoryReceipt(r, { requestedTriggers: 0, scope: SCOPE }).split("\n")[0];
    expect(head(record({ disposition: "stored" }))).toBe("Stored memory a1b2c3d4");
    expect(head(record({ disposition: "updated" }))).toBe("Updated memory a1b2c3d4");
    expect(head(record({ disposition: "promoted" }))).toBe("Promoted memory a1b2c3d4");
    expect(head(record({ disposition: "deduped" }))).toBe("Not stored: duplicate of existing memory a1b2c3d4-0000-0000-0000-000000000000");
    expect(head(record({ disposition: "conflict", conflictId: "ffeeddcc-1" }))).toBe(
      "Not stored: canonical key conflict with memory a1b2c3d4-0000-0000-0000-000000000000",
    );
  });

  it("conflict: triggers are reported as not written even if the record carries the input triggers", () => {
    const text = formatStoreMemoryReceipt(
      record({ disposition: "conflict", conflictId: "ffeeddcc-1", triggers: ["一", "二"] as string[] }),
      { requestedTriggers: 2, scope: SCOPE },
    );
    expect(text.split("\n")).toContain("Triggers: 0 of 2 written (nothing was stored)");
    expect(text).toContain("Conflict: ffeeddcc");
  });

  it("pivot hint: shown when a pivot memory landed without triggers, never on rejected or conflict", () => {
    const hint = "pivot 记忆缺 triggers";
    const pivot = { resolvedScope: PIVOT_SCOPE, scope: PIVOT_SCOPE };
    const at = (r: PersistedMemoryRecord) => formatStoreMemoryReceipt(r, { requestedTriggers: 0, scope: PIVOT_SCOPE });
    expect(at(record({ ...pivot, disposition: "stored" }))).toContain(hint);
    expect(at(record({ ...pivot, disposition: "deduped" }))).toContain(hint);
    expect(at(record({ ...pivot, disposition: "rejected", rejectionReason: "text_too_short" }))).not.toContain(hint);
    expect(at(record({ ...pivot, disposition: "conflict", conflictId: "c-1" }))).not.toContain(hint);
    // 判重分支不写入口，提示不再声称「deduped 也会写入口」
    expect(at(record({ ...pivot, disposition: "stored" }))).not.toContain("deduped 也会写入口");
  });
});

describe("formatBatchStoreReceipt", () => {
  it("counts every disposition separately and lists what was not written", () => {
    const text = formatBatchStoreReceipt([
      record({ disposition: "stored" }),
      record({ disposition: "updated" }),
      record({ disposition: "deduped", id: "dup-row" }),
      record({ disposition: "conflict", id: "owner-row", conflictId: "ccccdddd-9" }),
      record({ disposition: "rejected", rejectionReason: "noise_detected" }),
    ]);
    expect(text.split("\n")).toEqual([
      "Stored 2 of 5 memories (1 new, 1 updated, 0 promoted, 1 deduped, 1 conflict, 1 rejected)",
      "- #3 deduped: duplicate of existing memory dup-row",
      "- #4 conflict with memory owner-row (conflict ccccdddd)",
      "- #5 rejected (noise_detected)",
    ]);
  });
});

describe("buildStoreHttpResponse", () => {
  it("stored is true and status 201 only for stored / updated / promoted", () => {
    for (const disposition of ["stored", "updated", "promoted"] as const) {
      const res = buildStoreHttpResponse(record({ disposition }));
      expect(res.status).toBe(201);
      expect(res.body.stored).toBe(true);
    }
    for (const disposition of ["deduped", "conflict", "rejected"] as const) {
      const res = buildStoreHttpResponse(record({ disposition }));
      expect(res.status).toBe(200);
      expect(res.body.stored).toBe(false);
      expect(res.body.disposition).toBe(disposition);
    }
    expect(dispositionWroteMemory("deduped")).toBe(false);
  });

  it("rejected carries the rejection reason", () => {
    const res = buildStoreHttpResponse(record({ disposition: "rejected", rejectionReason: "rate_limited" }));
    expect(res.body.rejectionReason).toBe("rate_limited");
  });
});

describe("handlers use the receipt functions", () => {
  const src = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");

  function between(text: string, start: string, end: string): string {
    const from = text.indexOf(start);
    expect(from).toBeGreaterThanOrEqual(0);
    const to = text.indexOf(end, from + start.length);
    expect(to).toBeGreaterThan(from);
    return text.slice(from, to);
  }

  it("store_memory returns formatStoreMemoryReceipt", () => {
    const body = between(src("mcp-tools-core.ts"), '"store_memory"', "registerTool(");
    expect(body).toContain("formatStoreMemoryReceipt(stored,");
    expect(body).not.toContain("`Stored memory");
  });

  it("batch_store returns formatBatchStoreReceipt", () => {
    const body = between(src("mcp-tools-advanced.ts"), '"batch_store"', "registerTool(");
    expect(body).toContain("formatBatchStoreReceipt(stored)");
    expect(body).not.toContain("counts.new");
  });

  it("HTTP /v1/store answers with buildStoreHttpResponse", () => {
    const body = between(src("api-server.ts"), "async function handleStore", "\n}\n");
    expect(body).toContain("buildStoreHttpResponse(stored)");
    expect(body).toContain("jsonResponse(response.body, response.status)");
    expect(body).not.toContain("201");
  });
});
