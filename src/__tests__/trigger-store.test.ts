import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TriggerStore,
  extractTriggerCandidates,
  normalizeTriggerTexts,
  MAX_TRIGGERS_PER_MEMORY,
} from "../trigger-store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function createStore(): TriggerStore {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-trigger-"));
  cleanupPaths.push(dbPath);
  return new TriggerStore({ dbPath, vectorDim: 3 });
}

// 固定「问法 → 向量」表，模拟嵌入器；不认识的句子给一个斜向量
const VEC: Record<string, number[]> = {
  "跑分要不要再跑": [1, 0, 0],
  "榜要不要去排名": [0.9, 0.1, 0],
  "老的要不要清掉": [0, 1, 0],
  "写入前要不要审": [0, 0, 1],
};
const embed = async (texts: string[]) => texts.map((t) => VEC[t] ?? [0.33, 0.33, 0.33]);

describe("normalizeTriggerTexts", () => {
  it("去空白、去尾标点、去重（不分大小写）、封顶", () => {
    const out = normalizeTriggerTexts([
      "  那个跑分要不要再跑一次？ ",
      "那个跑分要不要再跑一次",
      "Benchmark 还测不测",
      "benchmark 还测不测",
      "x", // 太短
      "a".repeat(201), // 太长
      "1", "22", "33", "44", "55", "66", "77",
    ]);
    expect(out[0]).toBe("那个跑分要不要再跑一次");
    expect(out[1]).toBe("Benchmark 还测不测");
    expect(out).not.toContain("x");
    expect(out.length).toBeLessThanOrEqual(MAX_TRIGGERS_PER_MEMORY);
  });

  it("空输入返回空数组", () => {
    expect(normalizeTriggerTexts(undefined)).toEqual([]);
    expect(normalizeTriggerTexts([])).toEqual([]);
  });
});

describe("extractTriggerCandidates（回填用，只认正文里已写下的话）", () => {
  it("抠出「她以后会这么问起：「A」「B」」", () => {
    const text =
      "……于是定下规则三层结构 L0 / L1 / L2，并明确绝不为新端另写精简版。" +
      "她以后会这么问起：「接新的 AI 是不是又要从头讲一遍」「有没有大家默认都指向的那份」。";
    expect(extractTriggerCandidates(text)).toEqual([
      "接新的 AI 是不是又要从头讲一遍",
      "有没有大家默认都指向的那份",
    ]);
  });

  it("抠出「她以后可能会这样问起：A、B、C。」（顿号拆句，剪掉句号后的尾巴）", () => {
    const text =
      "自有 canary 定位是回归护栏不是优化靶子，当靶子会重演同一个应试问题。 " +
      "她以后可能会这样问起：那个跑分要不要再跑一次、别人这个 benchmark 我们要不要也测一下、我们在 LongMemEval 上多少分。";
    expect(extractTriggerCandidates(text)).toEqual([
      "那个跑分要不要再跑一次",
      "别人这个 benchmark 我们要不要也测一下",
      "我们在 LongMemEval 上多少分",
    ]);
  });

  it("认「检索锚点：」写法", () => {
    const text = "结论是 X。检索锚点：为什么我记的否决换个说法就搜不到；口语锚点要不要单独存";
    expect(extractTriggerCandidates(text)).toEqual([
      "为什么我记的否决换个说法就搜不到",
      "口语锚点要不要单独存",
    ]);
  });

  it("正文中段提到这条纪律本身不算问法；只认最后一次、且在后半段的那句", () => {
    const text =
      "评估结论：…探针里 64df5691 本身带了「她以后可能会这样问起」句，在「腾讯那篇论文的榜我们要不要也去排个名」下仍 top-10 不出现——写了也被正文稀释。" +
      "推理链：…借的是「给这句话一个 triggers 字段 + 单独嵌入 + max cos 归宿主 + 只召回不渲染」。" +
      "她以后可能会这样问起：那个腾讯的记忆论文我们借了没、trigger 那个东西做了吗、为什么我记的否决换个说法就搜不到。";
    expect(extractTriggerCandidates(text)).toEqual([
      "那个腾讯的记忆论文我们借了没",
      "trigger 那个东西做了吗",
      "为什么我记的否决换个说法就搜不到",
    ]);
    // 只在前半段出现 → 不算
    const early = "她以后会这么问起：「A 问法四个字」。" + "正文".repeat(200);
    expect(extractTriggerCandidates(early)).toEqual([]);
  });

  it("日期开头的引用、引导语自己不当问法", () => {
    const text = "结论略。" + "x".repeat(20) + "她以后会这样问起：常驻规则上限是多少、预算超了怎么办、2026-09-19-常驻层预算";
    expect(extractTriggerCandidates(text)).toEqual(["常驻规则上限是多少", "预算超了怎么办"]);
  });

  it("没有那句就返回空，不编造", () => {
    expect(extractTriggerCandidates("一条普通的记忆正文，讲了三件事，没有预演问法。")).toEqual([]);
    expect(extractTriggerCandidates("")).toEqual([]);
  });
});

describe("TriggerStore", () => {
  it("upsert → search 按宿主取最高分（nanmax 归属），scope 过滤下推，硬闸生效", async () => {
    const store = createStore();
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], embed);
    await store.upsertForMemory("mem-B", "memory:pivot", ["老的要不要清掉"], embed);
    await store.upsertForMemory("mem-C", "project:other", ["写入前要不要审"], embed);

    const hits = await store.search([1, 0, 0], 5, ["memory:pivot"], { minCosine: 0 });
    expect(hits[0].memoryId).toBe("mem-A");
    expect(hits[0].cosine).toBeCloseTo(1, 3);
    expect(hits[0].text).toBe("跑分要不要再跑"); // 两条都命中，归属取最高的那条
    expect(hits.filter((h) => h.memoryId === "mem-A").length).toBe(1);
    expect(hits.map((h) => h.memoryId)).not.toContain("mem-C"); // 别的 scope 进不来

    const gated = await store.search([1, 0, 0], 5, ["memory:pivot"], { minCosine: 0.95 });
    expect(gated.map((h) => h.memoryId)).toEqual(["mem-A"]);
    expect(gated[0].admittedBy).toBe("hard");

    // 软闸：余弦没过硬闸（mem-B 对 [0.6,0.8,0] 余弦 0.8 < 0.95），但整句问法且词面重合够就放行
    const softOpts = { minCosine: 0.95, softCosine: 0.5, minOverlap: 0.4, minQueryTokens: 8 };
    const soft = await store.search([0.6, 0.8, 0], 5, ["memory:pivot"], {
      ...softOpts,
      queryText: "老的那批记忆要不要清掉一下",
    });
    expect(soft.map((h) => h.memoryId)).toEqual(["mem-B"]);
    expect(soft[0].admittedBy).toBe("soft");
    expect(soft[0].overlap).toBeGreaterThanOrEqual(0.4);
    // 同样余弦、词面不重合 → 不放行
    const softMiss = await store.search([0.6, 0.8, 0], 5, ["memory:pivot"], {
      ...softOpts,
      queryText: "完全无关的一句很长很长的话说了半天",
    });
    expect(softMiss).toEqual([]);
    // 关键词短 query（去停用词 < 8 token）即使词面重合高也不走软闸
    const softShort = await store.search([0.6, 0.8, 0], 5, ["memory:pivot"], {
      ...softOpts,
      queryText: "老的清掉",
    });
    expect(softShort).toEqual([]);

    expect(await store.stats(["memory:pivot"])).toEqual({ rows: 3, memories: 2 });
    expect([...(await store.listMemoryIds(["memory:pivot"]))].sort()).toEqual(["mem-A", "mem-B"]);
  });

  it("重复 upsert 覆盖不追加；空文本只删不加；deleteForMemory 清空", async () => {
    const store = createStore();
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], embed);
    expect((await store.stats()).rows).toBe(2);
    await store.upsertForMemory("mem-A", "memory:pivot", ["老的要不要清掉"], embed);
    expect(await store.stats()).toEqual({ rows: 1, memories: 1 });
    expect(await store.upsertForMemory("mem-A", "memory:pivot", ["x"], embed)).toBe(0);
    expect((await store.stats()).rows).toBe(0);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑"], embed);
    await store.deleteForMemory("mem-A");
    expect(await store.stats()).toEqual({ rows: 0, memories: 0 });
  });

  it("embed 返回条数对不上就抛错，不写半截", async () => {
    const store = createStore();
    await expect(
      store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], async () => [[1, 0, 0]]),
    ).rejects.toThrow(/embed returned/);
    expect((await store.stats()).rows).toBe(0);
  });
});
