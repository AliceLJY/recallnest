import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareRegexWithCandidates,
  findKGContradictionCandidates,
  loadRegexInput,
  loadScopeTriples,
  normalizeKGValue,
  regexHitPairs,
  sampleCandidates,
  type RegexHitPair,
} from "../kg-contradiction.js";
import { KGStore, tripleId, type KGTriple } from "../kg-store.js";
import { loadLanceDB, MemoryStore, type MemoryEntry } from "../store.js";

/**
 * KG 矛盾候选（影子期，只读）：分组纯函数、归一化、与现有正则检测的双向对照、只读加载。
 * CLI 只读性见 kg-contradiction-cli.test.ts。
 */

function triple(p: Partial<KGTriple> & { subject: string; predicate: string; object: string }, sources: string[] = ["m1"]): KGTriple {
  const scope = p.scope ?? "memory:pivot";
  return {
    id: tripleId(scope, p.subject, p.predicate, p.object),
    scope,
    subject: p.subject,
    predicate: p.predicate,
    object: p.object,
    confidence: p.confidence ?? 0.9,
    source_memory_id: sources[0],
    source_text: "",
    timestamp: p.timestamp ?? 2000,
    mention_count: p.mention_count ?? sources.length,
    first_seen: p.first_seen ?? 1000,
    source_memory_ids: JSON.stringify(sources),
  };
}

describe("normalizeKGValue", () => {
  it("去首尾空白", () => {
    expect(normalizeKGValue("  mini \t\n")).toBe("mini");
  });
  it("大小写折叠", () => {
    expect(normalizeKGValue("MacBook")).toBe("macbook");
  });
  it("全角转半角（含全角空格）", () => {
    expect(normalizeKGValue("ＭａｃＢｏｏｋ　Ｐｒｏ")).toBe("macbook pro");
    expect(normalizeKGValue("１２３")).toBe("123");
  });
  it("去首尾标点（中英文），不动中间的", () => {
    expect(normalizeKGValue("「mini」。")).toBe("mini");
    expect(normalizeKGValue('"Bun"!')).toBe("bun");
    expect(normalizeKGValue("（mac-mini）")).toBe("mac-mini");
  });
  it("不做同义词或语义合并", () => {
    expect(normalizeKGValue("Mac mini")).not.toBe(normalizeKGValue("mini"));
    expect(normalizeKGValue("笔记本")).not.toBe(normalizeKGValue("MacBook"));
  });
  it("全是标点的取值归一化为空串", () => {
    expect(normalizeKGValue(" ...。 ")).toBe("");
  });
});

describe("findKGContradictionCandidates", () => {
  it("单值的组不报", () => {
    const out = findKGContradictionCandidates([
      triple({ subject: "真相源", predicate: "位于", object: "MacBook" }, ["m1"]),
      triple({ subject: "真相源", predicate: "位于", object: "MacBook" }, ["m2"]),
    ]);
    expect(out).toEqual([]);
  });

  it("同组两个取值报为候选，带全部字段", () => {
    const out = findKGContradictionCandidates([
      triple({ subject: "真相源", predicate: "位于", object: "MacBook", first_seen: 100, timestamp: 300 }, ["m1", "m2"]),
      triple({ subject: "真相源", predicate: "位于", object: "mini", first_seen: 500, timestamp: 600 }, ["m3"]),
    ]);
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.scope).toBe("memory:pivot");
    expect(c.subject).toBe("真相源");
    expect(c.predicate).toBe("位于");
    expect(c.distinctValueCount).toBe(2);
    expect(c.secondMentionCount).toBe(1);
    expect(c.values.map((v) => v.object)).toEqual(["MacBook", "mini"]);
    expect(c.values[0]).toMatchObject({ mention_count: 2, source_memory_ids: ["m1", "m2"], first_seen: 100, timestamp: 300 });
    expect(c.values[1]).toMatchObject({ mention_count: 1, source_memory_ids: ["m3"], first_seen: 500, timestamp: 600 });
  });

  it("不同 scope 不混成一组", () => {
    const out = findKGContradictionCandidates([
      triple({ scope: "memory:pivot", subject: "真相源", predicate: "位于", object: "MacBook" }),
      triple({ scope: "cc:other", subject: "真相源", predicate: "位于", object: "mini" }),
    ]);
    expect(out).toEqual([]);
  });

  it("不同 predicate 不混成一组", () => {
    const out = findKGContradictionCandidates([
      triple({ subject: "真相源", predicate: "位于", object: "MacBook" }),
      triple({ subject: "真相源", predicate: "备份到", object: "mini" }),
    ]);
    expect(out).toEqual([]);
  });

  it("归一化后相同的取值不算多值，写法与证据合并", () => {
    const out = findKGContradictionCandidates([
      triple({ subject: "运行时", predicate: "是", object: "Bun", first_seen: 300, timestamp: 400 }, ["m1", "m2"]),
      triple({ subject: "运行时", predicate: "是", object: " ｂｕｎ。", first_seen: 100, timestamp: 900 }, ["m2", "m3"]),
    ]);
    expect(out).toEqual([]);

    const withOther = findKGContradictionCandidates([
      triple({ subject: "运行时", predicate: "是", object: "Bun", first_seen: 300, timestamp: 400 }, ["m1", "m2"]),
      triple({ subject: "运行时", predicate: "是", object: " ｂｕｎ。", first_seen: 100, timestamp: 900 }, ["m2", "m3"]),
      triple({ subject: "运行时", predicate: "是", object: "Node" }, ["m9"]),
    ]);
    expect(withOther).toHaveLength(1);
    expect(withOther[0].distinctValueCount).toBe(2);
    const bun = withOther[0].values[0];
    expect(bun.normalized).toBe("bun");
    expect(bun.rawObjects).toEqual(["Bun", " ｂｕｎ。"]);
    expect(bun.source_memory_ids.sort()).toEqual(["m1", "m2", "m3"]);
    expect(bun.mention_count).toBe(3); // 并集 3，不是 2+2
    expect(bun.first_seen).toBe(100);
    expect(bun.timestamp).toBe(900);
  });

  it("按第二多取值的 mention_count 降序，其次按组大小", () => {
    const out = findKGContradictionCandidates([
      // A：10 vs 1 → 第二多 = 1
      triple({ subject: "A", predicate: "p", object: "x", mention_count: 10 }),
      triple({ subject: "A", predicate: "p", object: "y", mention_count: 1 }),
      // B：3 vs 3 → 第二多 = 3
      triple({ subject: "B", predicate: "p", object: "x", mention_count: 3 }),
      triple({ subject: "B", predicate: "p", object: "y", mention_count: 3 }),
      // C：2 vs 1 vs 1 → 第二多 = 1，但 3 个取值，排在 A 前
      triple({ subject: "C", predicate: "p", object: "x", mention_count: 2 }),
      triple({ subject: "C", predicate: "p", object: "y", mention_count: 1 }),
      triple({ subject: "C", predicate: "p", object: "z", mention_count: 1 }),
    ]);
    expect(out.map((c) => c.subject)).toEqual(["B", "C", "A"]);
    expect(out.map((c) => c.secondMentionCount)).toEqual([3, 1, 1]);
    expect(out[1].values.map((v) => v.mention_count)).toEqual([2, 1, 1]);
  });

  it("不按时间筛：时间完全不重叠的取值照样是候选", () => {
    const out = findKGContradictionCandidates([
      triple({ subject: "负责人", predicate: "是", object: "张三", first_seen: 1, timestamp: 2 }),
      triple({ subject: "负责人", predicate: "是", object: "李四", first_seen: 1_000_000, timestamp: 2_000_000 }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("归一化为空的取值不参与计数", () => {
    const out = findKGContradictionCandidates([
      triple({ subject: "S", predicate: "p", object: "x" }),
      triple({ subject: "S", predicate: "p", object: "……" }),
    ]);
    expect(out).toEqual([]);
  });

  it("sampleCandidates 同 seed 同结果、不超过总数", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(sampleCandidates(items, 10, 7)).toEqual(sampleCandidates(items, 10, 7));
    expect(sampleCandidates(items, 10, 7)).not.toEqual(sampleCandidates(items, 10, 8));
    expect(new Set(sampleCandidates(items, 10, 7)).size).toBe(10);
    expect(sampleCandidates(items, 100, 1)).toHaveLength(30);
  });
});

describe("compareRegexWithCandidates", () => {
  // 夹具：
  // - m1 × m2：在「真相源—位于」各给一个取值 → 覆盖
  // - m3 × m4：m4 没有任何三元组 → 抽取覆盖面缺口
  // - m5 × m6：都有三元组，但一个在「运行时—是」、一个在「端口—是」，从不对撞 → 方法盲区
  // - m7 × m8：都在「数据库—是」给了同一个值 → 方法盲区，且标出同值组
  // - 候选「负责人—是」（m9 / m10）：正则没抓 → 方向二
  const triples: KGTriple[] = [
    triple({ subject: "真相源", predicate: "位于", object: "MacBook" }, ["m1"]),
    triple({ subject: "真相源", predicate: "位于", object: "mini" }, ["m2"]),
    triple({ subject: "工具", predicate: "用", object: "bun" }, ["m3"]),
    triple({ subject: "运行时", predicate: "是", object: "bun" }, ["m5"]),
    triple({ subject: "端口", predicate: "是", object: "8080" }, ["m6"]),
    triple({ subject: "数据库", predicate: "是", object: "LanceDB" }, ["m7", "m8"]),
    triple({ subject: "负责人", predicate: "是", object: "张三" }, ["m9"]),
    triple({ subject: "负责人", predicate: "是", object: "李四" }, ["m10"]),
  ];
  const pairs: RegexHitPair[] = [
    { a: "m1", b: "m2" },
    { a: "m3", b: "m4" },
    { a: "m5", b: "m6" },
    { a: "m7", b: "m8" },
  ];
  const candidates = findKGContradictionCandidates(triples);
  const cmp = compareRegexWithCandidates(pairs, candidates, triples, new Set(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]));

  it("两个方向都完整列出，交集也列出", () => {
    expect(cmp.regexPairCount).toBe(4);
    expect(cmp.candidateCount).toBe(2);
    expect(cmp.regexCovered.map((x) => [x.pair.a, x.pair.b])).toEqual([["m1", "m2"]]);
    expect(cmp.regexCovered[0].groups).toEqual([{ subject: "真相源", predicate: "位于" }]);
    expect(cmp.candidatesCaught.map((c) => c.subject)).toEqual(["真相源"]);
    expect(cmp.candidatesUncaught.map((x) => x.candidate.subject)).toEqual(["负责人"]);
    const total = cmp.regexCovered.length + cmp.regexOnlyNoTriples.length + cmp.regexOnlyBlindSpot.length;
    expect(total).toBe(cmp.regexPairCount);
    expect(cmp.candidatesCaught.length + cmp.candidatesUncaught.length).toBe(cmp.candidateCount);
  });

  it("「没有三元组」与「方法盲区」分得开", () => {
    expect(cmp.regexOnlyNoTriples).toEqual([{ pair: { a: "m3", b: "m4" }, memoriesWithoutTriples: ["m4"] }]);
    expect(cmp.regexOnlyBlindSpot.map((x) => [x.pair.a, x.pair.b])).toEqual([["m5", "m6"], ["m7", "m8"]]);
    expect(cmp.regexOnlyBlindSpot[0]).toMatchObject({ aTripleCount: 1, bTripleCount: 1, sharedSameValueGroups: [] });
    expect(cmp.regexOnlyBlindSpot[1].sharedSameValueGroups).toEqual([{ subject: "数据库", predicate: "是" }]);
  });

  it("两条都没有三元组时都列出", () => {
    const r = compareRegexWithCandidates([{ a: "x1", b: "x2" }], candidates, triples);
    expect(r.regexOnlyNoTriples[0].memoriesWithoutTriples).toEqual(["x1", "x2"]);
    expect(r.regexOnlyBlindSpot).toEqual([]);
  });

  it("方向二标出正则输入里没有的来源记忆", () => {
    expect(cmp.candidatesUncaught[0].sourcesOutsideRegexInput).toEqual(["m10"]);
  });

  it("一条记忆在同组给两个取值、另一条只给其中一个：仍算覆盖（各自贡献了不同取值）", () => {
    const t = [
      triple({ subject: "S", predicate: "p", object: "x" }, ["a"]),
      triple({ subject: "S", predicate: "p", object: "y" }, ["a", "b"]),
    ];
    const r = compareRegexWithCandidates([{ a: "a", b: "b" }], findKGContradictionCandidates(t), t);
    expect(r.regexCovered).toHaveLength(1);
  });

  it("两条记忆在同组给的是同一个取值：不算覆盖", () => {
    const t = [
      triple({ subject: "S", predicate: "p", object: "x" }, ["a", "b"]),
      triple({ subject: "S", predicate: "p", object: "y" }, ["c"]),
    ];
    const r = compareRegexWithCandidates([{ a: "a", b: "b" }], findKGContradictionCandidates(t), t);
    expect(r.regexCovered).toEqual([]);
    expect(r.regexOnlyBlindSpot[0].sharedSameValueGroups).toEqual([{ subject: "S", predicate: "p" }]);
  });
});

describe("regexHitPairs 复用线上 memory-lint 的判断与配对", () => {
  const vec = [1, 0, 0, 0];
  const entry = (id: string, text: string, category: MemoryEntry["category"] = "preferences"): MemoryEntry => ({
    id, text, vector: vec, category, scope: "memory:pivot", importance: 0.5, timestamp: 1, metadata: "{}",
  });

  it("否定词对 + 共享长词 → 命中；类别不在 lint 名单内 → 不配对", () => {
    const pairs = regexHitPairs([
      entry("p1", "never use tabs in code files"),
      entry("p2", "always use tabs in code files"),
      entry("e1", "never use tabs in code files", "events"),
      entry("e2", "always use tabs in code files", "events"),
    ]);
    expect(pairs.map((p) => [p.a, p.b])).toEqual([["p1", "p2"]]);
  });

  it("没有向量时相似度为 0，一对都不出（与 lint 同口径）", () => {
    const pairs = regexHitPairs([
      { ...entry("p1", "never use tabs in code files"), vector: [] },
      { ...entry("p2", "always use tabs in code files"), vector: [] },
    ]);
    expect(pairs).toEqual([]);
  });
});

describe("只读加载（临时目录真实 LanceDB）", () => {
  const dirs: string[] = [];
  afterAll(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("没有 kg_triples / memories 表时返回空，且不建表", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "rn-kgc-empty-")), "lancedb");
    dirs.push(dbPath);
    expect(await loadScopeTriples(dbPath, "memory:pivot")).toEqual([]);
    expect(await loadRegexInput(dbPath, "memory:pivot")).toEqual({ entries: [], scanLimited: false });
    const db = await (await loadLanceDB()).connect(dbPath);
    expect(await db.tableNames()).toEqual([]);
  });

  it("scope 精确匹配；只留活跃记忆且带向量", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "rn-kgc-load-")), "lancedb");
    dirs.push(dbPath);
    const kg = new KGStore({ dbPath });
    await kg.createTriples([
      { scope: "memory:pivot", subject: "S", predicate: "p", object: "x", confidence: 1, source_memory_id: "a", source_text: "" },
      { scope: "memory:pivot:child", subject: "S", predicate: "p", object: "y", confidence: 1, source_memory_id: "b", source_text: "" },
    ]);
    const store = new MemoryStore({ dbPath, vectorDim: 4 });
    await store.storeBatch([
      { text: "active one", vector: [1, 0, 0, 0], category: "preferences", scope: "memory:pivot", importance: 0.5, metadata: "{}" },
      { text: "archived one", vector: [1, 0, 0, 0], category: "preferences", scope: "memory:pivot", importance: 0.5, metadata: JSON.stringify({ evolution: { status: "archived" } }) },
      { text: "child scope", vector: [1, 0, 0, 0], category: "preferences", scope: "memory:pivot:child", importance: 0.5, metadata: "{}" },
    ]);

    const triples = await loadScopeTriples(dbPath, "memory:pivot");
    expect(triples.map((t) => t.object)).toEqual(["x"]);
    const input = await loadRegexInput(dbPath, "memory:pivot");
    expect(input.entries.map((e) => e.text)).toEqual(["active one"]);
    expect(input.entries[0].vector).toEqual([1, 0, 0, 0]);
  });
});
