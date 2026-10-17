import { describe, expect, it } from "bun:test";

import { persistMemory } from "../capture-engine.js";
import { executeMergeDecisions } from "../llm-consolidation.js";
import { parseEvolution } from "../memory-evolution.js";
import { acceptPredictedReminder, demotePredictedReminder, fireReminder } from "../prospective-memory.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";
import { createVersionGroup } from "../version-manager.js";

/**
 * 2026-10-17 起 update() 在行已被删掉时返回 null、不再把行插回来。依赖「改成了」才往下走的调用方，
 * 看到 null 必须当作没改成。这里每条都用一个「读得到、写不进」的替身：getById / vectorSearch 还交出那一行，
 * update() 返回 null——正是别的进程在读与写之间删掉它时调用方看到的样子。
 */

function entry(id: string, metadata: Record<string, unknown>, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    text: `memory ${id} with enough words to pass any length checks in the capture path`,
    vector: [1, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.7,
    timestamp: Date.now() - 86_400_000,
    metadata: JSON.stringify(metadata),
    ...overrides,
  };
}

/** getById 交出 rows 里的行；update 对 vanished 里的 id 返回 null，其余照常写并记下 */
function storeWithVanished(rows: MemoryEntry[], vanished: Set<string>) {
  const data = new Map(rows.map((r) => [r.id, { ...r }]));
  const updates: Array<{ id: string; metadata?: string; importance?: number }> = [];
  return {
    data,
    updates,
    async getById(id: string) {
      return data.get(id) ?? null;
    },
    async update(id: string, upd: { metadata?: string; importance?: number }) {
      if (vanished.has(id)) return null;
      const row = data.get(id);
      if (!row) return null;
      if (upd.metadata !== undefined) row.metadata = upd.metadata;
      if (upd.importance !== undefined) row.importance = upd.importance;
      updates.push({ id, ...upd });
      return row;
    },
  };
}

const pendingPredicted = (confidence: number) => ({
  prospective: { trigger: "deploy", action: "check the rollback plan", status: "pending", source: "predicted", confidence },
});

describe("prospective-memory：update() 返回 null 不算成功", () => {
  it("fireReminder：标记 fired 没写进去 → 返回 null，不把动作交给调用方", async () => {
    const row = entry("r1", { prospective: { trigger: "deploy", action: "check the rollback plan", status: "pending" } });
    const store = storeWithVanished([row], new Set(["r1"]));
    expect(await fireReminder(store as never, "r1")).toBeNull();
  });

  it("acceptPredictedReminder：升格没写进去 → false", async () => {
    const store = storeWithVanished([entry("r1", pendingPredicted(0.7))], new Set(["r1"]));
    expect(await acceptPredictedReminder(store as never, "r1")).toBe(false);
  });

  it("demotePredictedReminder：降到阈值下（过期分支）没写进去 → false", async () => {
    const store = storeWithVanished([entry("r1", pendingPredicted(0.62))], new Set(["r1"]));
    expect(await demotePredictedReminder(store as never, "r1")).toBe(false);
  });

  it("demotePredictedReminder：只降置信度的分支没写进去 → false", async () => {
    const store = storeWithVanished([entry("r1", pendingPredicted(0.95))], new Set(["r1"]));
    expect(await demotePredictedReminder(store as never, "r1")).toBe(false);
  });

  it("正常路径不变：写得进去时 fire 返回动作、accept / demote 返回 true", async () => {
    const store = storeWithVanished([
      entry("f", { prospective: { trigger: "deploy", action: "check the rollback plan", status: "pending" } }),
      entry("a", pendingPredicted(0.7)),
      entry("d", pendingPredicted(0.95)),
    ], new Set());
    expect(await fireReminder(store as never, "f")).toBe("check the rollback plan");
    expect(await acceptPredictedReminder(store as never, "a")).toBe(true);
    expect(await demotePredictedReminder(store as never, "d")).toBe(true);
  });
});

describe("createVersionGroup：任一行已被删 → 不成组", () => {
  it("canonical 已被删：返回 null，member 不被打上组标记", async () => {
    const canonical = entry("canon", { confidence: 1 });
    const member = entry("member", { confidence: 0.5 });
    const store = storeWithVanished([canonical, member], new Set(["canon"]));
    expect(await createVersionGroup(store as never, canonical, member, "project:test")).toBeNull();
    expect(store.updates).toHaveLength(0);
    expect(JSON.parse(store.data.get("member")!.metadata!).version_group).toBeUndefined();
  });

  it("member 已被删、组是这次新建的：返回 null，canonical 上的三个组字段被撤回", async () => {
    const canonical = entry("canon", { confidence: 1 });
    const member = entry("member", { confidence: 0.5 });
    const store = storeWithVanished([canonical, member], new Set(["member"]));
    expect(await createVersionGroup(store as never, canonical, member, "project:test")).toBeNull();
    const canonMeta = JSON.parse(store.data.get("canon")!.metadata!) as Record<string, unknown>;
    expect(canonMeta.version_group).toBeUndefined();
    expect(canonMeta.version_rank).toBeUndefined();
    expect(canonMeta.version_created).toBeUndefined();
    expect(canonMeta.confidence).toBe(1);
  });

  it("member 已被删、canonical 原本就在组里：返回 null，canonical 的组不动", async () => {
    const canonical = entry("canon", { confidence: 1, version_group: "existing-group", version_rank: 0.9, version_created: "2026-01-01" });
    const member = entry("member", { confidence: 0.5 });
    const store = storeWithVanished([canonical, member], new Set(["member"]));
    expect(await createVersionGroup(store as never, canonical, member, "project:test")).toBeNull();
    expect(JSON.parse(store.data.get("canon")!.metadata!).version_group).toBe("existing-group");
  });

  it("executeMergeDecisions：没成组的不计入合并数", async () => {
    const canonical = entry("canon", { confidence: 1 }, { importance: 0.9 });
    const member = entry("member", { confidence: 0.5 }, { importance: 0.5 });
    const store = storeWithVanished([canonical, member], new Set(["member"]));
    const merged = await executeMergeDecisions(store as never, [canonical, member], { mergeGroups: [[0, 1]], keepSeparate: [], reasoning: "test" }, "project:test");
    expect(merged).toBe(0);
  });
});

describe("persistMemory 语义 MERGE：旧行没标记成 superseded 就不在新行上指向它", () => {
  it("update() 返回 null → 新行的 evolution 不带 supersedes 指向旧行", async () => {
    const scope = "project:test";
    const old = entry("old-1", { evolution: { status: "active" } }, {
      text: "The staging deploy runs every Tuesday at noon from the release branch.",
      category: "events",
      scope,
    });
    const stored: MemoryEntry[] = [];
    const store = {
      async store(e: Omit<MemoryEntry, "id" | "timestamp"> & { id?: string }) {
        const full = { ...e, id: e.id ?? "new-1", timestamp: Date.now() } as MemoryEntry;
        stored.push(full);
        return full;
      },
      async list() { return []; },
      async getById() { return null; },
      async update() { return null; }, // old-1 was deleted after the vector search returned it
      async vectorSearch(): Promise<MemorySearchResult[]> {
        return [{ entry: old, score: 0.95 }];
      },
    };
    const deps = {
      store,
      embedder: { async embedPassage() { return [1, 0, 0]; } },
      llm: {
        async assessImportance() { return null; },
        async dedupDecision() { return { action: "MERGE", reason: "new adds detail" }; },
        async synthesizeFragments() { return null; },
      },
    };
    await persistMemory(deps as never, {
      text: "The staging deploy now runs every Tuesday at noon from the release branch, with a smoke test after.",
      category: "events",
      scope,
      source: "manual",
    });
    expect(stored.length).toBeGreaterThan(0);
    const main = stored[0];
    expect(parseEvolution(main.metadata).supersedes ?? null).not.toBe("old-1");
    expect(main.metadata ?? "").not.toContain("old-1");
  });
});
