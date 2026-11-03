import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planCascadeForget } from "../cascade-forget.js";
import { forgetMemory } from "../forget-engine.js";
import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { registerGovernanceTools } from "../mcp-tools-governance.js";
import {
  findProtectedDemotions,
  findSameKeyInOtherScopes,
  otherScopeWarning,
  recordSessionWrite,
  resetSessionWrites,
  sessionWrittenIds,
} from "../revision-guard.js";
import { MemoryStore } from "../store.js";
import { createToolHarness, type ToolHarness } from "./helpers/mcp-tool-harness.js";

/**
 * 修订级联闸（2026-11-03 错误转脚本检查第 6 条）。
 *
 * 回放夹具 fixtures/revision-replay-sequences.json 是从真实会话里扫出的「同会话 store 之后 40 步内 forget」序列
 * （2026-07 至 10 月，7 个会话），只留结构：哪个 scope 存、哪个 scope 删、删的是不是刚存的那条。
 * 本仓公开，正文与真实向量不进仓，所以相似度用构造向量模拟——新条与被删条的相似度设成真实事故里会被 cascade
 * 打中的区间（≥ 0.9）。夹具证明的是「这种形状会被拦 / 放」，不证明真实嵌入下的相似度。
 */

interface ReplaySequence {
  session: string;
  date: string;
  storeScope: string;
  forgetScope: string;
  forgotTheNewRow: boolean;
  crossScopeDuplicate?: boolean;
  expect: "refuse" | "proceed" | "warn-on-store";
}

const SEQUENCES: ReplaySequence[] = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "revision-replay-sequences.json"), "utf8"),
);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  resetSessionWrites();
});
beforeEach(() => resetSessionWrites());

function freshStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "rn-revision-guard-"));
  tmpDirs.push(dir);
  return new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 3 });
}

function meta(canonicalKey?: string): string {
  return JSON.stringify({ ...(canonicalKey ? { canonicalKey } : {}), tier: "working" });
}

async function put(store: MemoryStore, scope: string, vector: number[], importance: number, canonicalKey?: string) {
  return store.store({
    text: `revision guard row ${Math.random().toString(36).slice(2)}`,
    vector,
    category: "events",
    scope,
    importance,
    metadata: meta(canonicalKey),
  });
}

const OLD_VEC = [1, 0, 0];
const NEAR_VEC = [0.95, Math.sqrt(1 - 0.95 ** 2), 0]; // cos = 0.95
const FAR_VEC = [0, 0, 1];

describe("回放 14 个历史 store→forget 序列", () => {
  for (const seq of SEQUENCES.filter((s) => s.expect !== "warn-on-store")) {
    it(`${seq.date} ${seq.session}: ${seq.storeScope} 存 → ${seq.forgetScope} 删${seq.forgotTheNewRow ? "（删的就是新条）" : ""} → ${seq.expect}`, async () => {
      const store = freshStore();
      const old = await put(store, seq.forgetScope, OLD_VEC, 0.8);
      const fresh = seq.forgotTheNewRow ? old : await put(store, seq.storeScope, NEAR_VEC, 0.92);
      recordSessionWrite(fresh.id);
      const target = seq.forgotTheNewRow ? fresh : old;

      const result = await forgetMemory({ store }, { memoryId: target.id, confirm: true });
      if (seq.expect === "refuse") {
        expect(result.success).toBe(false);
        expect(result.error).toContain("Not forgotten");
        expect(result.error).toContain(fresh.id.slice(0, 8));
        // 什么都没改：旧条还在，新条 importance 没动
        expect(await store.getById(old.id)).not.toBeNull();
        expect((await store.getById(fresh.id))!.importance).toBeCloseTo(0.92, 5);
      } else {
        expect(result.success).toBe(true);
        if (!seq.forgotTheNewRow) expect((await store.getById(fresh.id))!.importance).toBeCloseTo(0.92, 5);
      }
    }, 30_000);
  }

  it("夹具本身：14 条序列 + 1 条跨 scope 重复，拒 / 放各 7", () => {
    expect(SEQUENCES.filter((s) => s.expect !== "warn-on-store")).toHaveLength(14);
    expect(SEQUENCES.filter((s) => s.expect === "refuse")).toHaveLength(7);
    expect(SEQUENCES.filter((s) => s.crossScopeDuplicate)).toHaveLength(1);
  });
});

describe("forget 预演", () => {
  it("auto preflight failure leaves every layer untouched and offers skip/force", async () => {
    const store = freshStore();
    const old = await put(store, "project:preflight-failure", OLD_VEC, 0.8);
    const before = await store.getById(old.id);
    const calls: string[] = [];
    const search = spyOn(store, "vectorSearch").mockRejectedValue(new Error("synthetic search failure"));
    const update = spyOn(store, "update");
    const remove = spyOn(store, "delete");
    const prev = process.env.RECALLNEST_REVISION_GUARD;
    delete process.env.RECALLNEST_REVISION_GUARD;
    try {
      const result = await forgetMemory({
        store,
        triggerStore: {
          deleteForMemory: async () => { calls.push("triggers"); return 1; },
          countForMemory: async () => 0,
        },
        pins: {
          archiveForMemory: () => { calls.push("pins"); return 1; },
          countForMemory: () => 0,
        },
      }, { memoryId: old.id, confirm: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain("synthetic search failure");
      expect(result.error).toContain("cascadeMode=skip");
      expect(result.error).toContain("cascadeMode=force");
      expect(calls).toEqual([]);
      expect(update).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(await store.getById(old.id)).toEqual(before);
    } finally {
      search.mockRestore();
      update.mockRestore();
      remove.mockRestore();
      if (prev === undefined) delete process.env.RECALLNEST_REVISION_GUARD;
      else process.env.RECALLNEST_REVISION_GUARD = prev;
    }
  }, 30_000);

  for (const cascadeMode of ["auto", "force"] as const) {
    it(`${cascadeMode}: rows inserted after preflight are never demoted`, async () => {
      const store = freshStore();
      const old = await put(store, "project:plan-race", OLD_VEC, 0.8);
      const planned = await put(store, old.scope, NEAR_VEC, 0.7);
      let lateId = "";
      const search = spyOn(store, "vectorSearch");
      try {
        const result = await forgetMemory({
          store,
          triggerStore: {
            deleteForMemory: async () => {
              const late = await put(store, old.scope, OLD_VEC, 0.92);
              lateId = late.id;
              recordSessionWrite(late.id);
              return 0;
            },
            countForMemory: async () => 0,
          },
        }, { memoryId: old.id, confirm: true, cascadeMode });
        expect(result.success).toBe(true);
        expect(result.plannedDemotions?.map((p) => p.entry.id)).toEqual([planned.id]);
        expect(result.cascadeResult.demotedIds).toEqual([planned.id]);
        expect((await store.getById(planned.id))!.importance).toBeCloseTo(result.plannedDemotions![0].to, 5);
        expect((await store.getById(lateId))!.importance).toBeCloseTo(0.92, 5);
        expect(search).toHaveBeenCalledTimes(1);
      } finally {
        search.mockRestore();
      }
    }, 30_000);
  }

  it("an empty preflight plan remains empty after a late insert", async () => {
    const store = freshStore();
    const old = await put(store, "project:empty-plan", OLD_VEC, 0.8);
    let lateId = "";
    const result = await forgetMemory({
      store,
      triggerStore: {
        deleteForMemory: async () => {
          lateId = (await put(store, old.scope, NEAR_VEC, 0.9)).id;
          return 0;
        },
        countForMemory: async () => 0,
      },
    }, { memoryId: old.id, confirm: true });
    expect(result.success).toBe(true);
    expect(result.plannedDemotions).toEqual([]);
    expect(result.cascadeResult.demotedIds).toEqual([]);
    expect((await store.getById(lateId))!.importance).toBeCloseTo(0.9, 5);
  }, 30_000);

  it("同 canonicalKey 的兄弟条会被降权时拒绝（不是本会话写的也拒）", async () => {
    const store = freshStore();
    const old = await put(store, "project:x", OLD_VEC, 0.8, "decision:x");
    const sibling = await put(store, "project:x", NEAR_VEC, 0.7, "decision:x");
    const result = await forgetMemory({ store, sessionWrittenIds: () => new Set() }, { memoryId: old.id, confirm: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("与被删条同 canonicalKey");
    expect(result.error).toContain(sibling.id.slice(0, 8));
  }, 30_000);

  it("无关的相似条照旧降权，名单进结果", async () => {
    const store = freshStore();
    const old = await put(store, "project:x", OLD_VEC, 0.8);
    const other = await put(store, "project:x", NEAR_VEC, 0.7);
    const result = await forgetMemory({ store, sessionWrittenIds: () => new Set() }, { memoryId: old.id, confirm: true });
    expect(result.success).toBe(true);
    expect(result.cascadeResult.demotedIds).toEqual([other.id]);
    expect(result.plannedDemotions?.map((p) => p.entry.id)).toEqual([other.id]);
    expect((await store.getById(other.id))!.importance).toBeLessThan(0.7);
  }, 30_000);

  it("cascadeMode=skip：删掉旧条、新条不动", async () => {
    const store = freshStore();
    const old = await put(store, "project:x", OLD_VEC, 0.8);
    const fresh = await put(store, "project:x", NEAR_VEC, 0.92);
    recordSessionWrite(fresh.id);
    const result = await forgetMemory({ store }, { memoryId: old.id, confirm: true, cascadeMode: "skip" });
    expect(result.success).toBe(true);
    expect(result.cascadeSkipped).toBe(true);
    expect(await store.getById(old.id)).toBeNull();
    expect((await store.getById(fresh.id))!.importance).toBeCloseTo(0.92, 5);
  }, 30_000);

  it("cascadeMode=force：照旧降权（老行为）", async () => {
    const store = freshStore();
    const old = await put(store, "project:x", OLD_VEC, 0.8);
    const fresh = await put(store, "project:x", NEAR_VEC, 0.92);
    recordSessionWrite(fresh.id);
    const result = await forgetMemory({ store }, { memoryId: old.id, confirm: true, cascadeMode: "force" });
    expect(result.success).toBe(true);
    expect((await store.getById(fresh.id))!.importance).toBeLessThan(0.92);
  }, 30_000);

  it("RECALLNEST_REVISION_GUARD=off 时不拒", async () => {
    const store = freshStore();
    const old = await put(store, "project:x", OLD_VEC, 0.8);
    const fresh = await put(store, "project:x", NEAR_VEC, 0.92);
    recordSessionWrite(fresh.id);
    const prev = process.env.RECALLNEST_REVISION_GUARD;
    process.env.RECALLNEST_REVISION_GUARD = "off";
    try {
      expect((await forgetMemory({ store }, { memoryId: old.id, confirm: true })).success).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.RECALLNEST_REVISION_GUARD;
      else process.env.RECALLNEST_REVISION_GUARD = prev;
    }
  }, 30_000);

  it("预演名单与实际降权名单逐条相同（同一套候选与公式）", async () => {
    const store = freshStore();
    const old = await put(store, "project:x", OLD_VEC, 0.8);
    await put(store, "project:x", NEAR_VEC, 0.7);
    await put(store, "project:x", [0.8, 0.6, 0], 0.6);
    await put(store, "project:x", FAR_VEC, 0.6);
    const plan = await planCascadeForget(store, old);
    const result = await forgetMemory({ store, sessionWrittenIds: () => new Set() }, { memoryId: old.id, confirm: true });
    expect(result.cascadeResult.demotedIds.sort()).toEqual(plan.map((p) => p.entry.id).sort());
  }, 30_000);

  it("findProtectedDemotions 标出两种理由", () => {
    const entry = (id: string, key?: string) => ({ id, metadata: meta(key), importance: 0.5 }) as never;
    const planned = [
      { entry: entry("aaaaaaaa-1", "k"), similarity: 0.9, from: 0.5, to: 0.3 },
      { entry: entry("bbbbbbbb-2"), similarity: 0.9, from: 0.5, to: 0.3 },
      { entry: entry("cccccccc-3"), similarity: 0.9, from: 0.5, to: 0.3 },
    ];
    const got = findProtectedDemotions({ id: "old", metadata: meta("k") }, planned, new Set(["bbbbbbbb-2"]));
    expect(got.map((g) => [g.plan.entry.id, g.reasons])).toEqual([
      ["aaaaaaaa-1", ["same-canonical-key"]],
      ["bbbbbbbb-2", ["written-this-session"]],
    ]);
  });
});

describe("store 时同 key 在别的 scope", () => {
  it("真实形状 739f925a（10-28）：同 key 存进第二个 scope 时找得到另一份", async () => {
    const store = freshStore();
    // 库里存的是归一化后的 key（冒号会变成连字符），查询传原样 key
    const first = await put(store, "memory:pivot", OLD_VEC, 0.8, "decision-grok-build");
    const hits = await findSameKeyInOtherScopes(store, "decision:grok-build", "project:grok-build");
    expect(hits).toEqual([{ id: first.id, scope: "memory:pivot" }]);
    expect(otherScopeWarning(hits)).toContain("scope 传错了");
    expect(await findSameKeyInOtherScopes(store, "decision:grok-build", "memory:pivot")).toEqual([]);
  }, 30_000);

  const harnesses: ToolHarness[] = [];
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()!.cleanup();
  });

  it("经真实 store_memory handler：回执带跨 scope 警告，写入登记进本会话", async () => {
    const h = createToolHarness([registerCoreTools, registerAdvancedTools, registerGovernanceTools]);
    harnesses.push(h);
    await h.text("store_memory", { text: "第一次写在 pivot 里的一条决策记录，用来测跨 scope 同 key", scope: "memory:pivot", canonicalKey: "decision:dup-test", tags: ["pinned", "src:test0001"] });
    const text = await h.text("store_memory", { text: "同一个 key 又写进了另一个 project scope 的一条决策记录", scope: "project:dup-test", canonicalKey: "decision:dup-test" });
    expect(text).toContain("同 canonicalKey 已在别的 scope 存在");
    const rows = await h.store.list(["project:dup-test"], undefined, 10, 0, "exact");
    expect(sessionWrittenIds().has(rows[0].id)).toBe(true);
  }, 30_000);

  it("经真实 forget_memory handler：拒绝时报错里带名单", async () => {
    const h = createToolHarness([registerCoreTools, registerAdvancedTools, registerGovernanceTools]);
    harnesses.push(h);
    await h.text("store_memory", { text: "旧的一条项目决策，马上要被新写法取代掉", scope: "project:rev-test", canonicalKey: "decision:old-wording" });
    await h.text("store_memory", { text: "新的一条项目决策，取代旧写法但换了一个 key", scope: "project:rev-test", canonicalKey: "decision:new-wording" });
    const rows = await h.store.list(["project:rev-test"], undefined, 10, 0, "exact");
    const old = rows.find((r) => r.metadata?.includes("old-wording"))!;
    const text = await h.text("forget_memory", { memoryId: old.id, confirm: true });
    expect(text).toContain("Not forgotten");
    expect(text).toContain("本会话刚写的");
    expect(await h.store.getById(old.id)).not.toBeNull();
  }, 30_000);
});
