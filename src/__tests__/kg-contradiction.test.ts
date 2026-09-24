import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareRegexWithCandidates,
  computePredicateStats,
  DEFAULT_FUNCTIONAL_MIN_SUBJECTS,
  filterKGCandidates,
  findKGContradictionCandidates,
  formatCandidateReport,
  formatFunnel,
  hasCandidateFilter,
  loadRegexInput,
  loadScopeTriples,
  normalizeKGValue,
  parseCandidateFilterArgs,
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

// ----------------------------------------------------------------------------
// 函数型谓词过滤与证据门槛
// ----------------------------------------------------------------------------

/**
 * 过滤夹具（同一 scope）：
 * - located_in：5 个 subject，只有 tool-e 两个取值（各 2 条来源）；tool-a 的 "Hooks" / " hooks。" 归一化同值。
 *   subjects 5 / pairs 6 → 0.833…
 * - has：2 个 subject，proj-x 三个取值、proj-y 两个取值 → 2 / 5 = 0.4
 * - owned_by：4 个 subject，只有 repo-d 两个取值 → 4 / 5 = 0.8（恰在 0.8 边界上）
 * - runs_on：2 个 subject，只有 svc-b 两个取值 → 2 / 3（subject 数不足 3）
 */
function filterFixture(): KGTriple[] {
  return [
    triple({ subject: "tool-a", predicate: "located_in", object: "Hooks" }, ["m1"]),
    triple({ subject: "tool-a", predicate: "located_in", object: " hooks。" }, ["m2"]),
    triple({ subject: "tool-b", predicate: "located_in", object: "bin" }, ["m3"]),
    triple({ subject: "tool-c", predicate: "located_in", object: "bin" }, ["m4"]),
    triple({ subject: "tool-d", predicate: "located_in", object: "opt" }, ["m5"]),
    triple({ subject: "tool-e", predicate: "located_in", object: "~/.claude/hooks" }, ["e1", "e2"]),
    triple({ subject: "tool-e", predicate: "located_in", object: "~/.Trash" }, ["e3", "e4"]),
    triple({ subject: "proj-x", predicate: "has", object: "tests" }, ["m6"]),
    triple({ subject: "proj-x", predicate: "has", object: "docs" }, ["m7"]),
    triple({ subject: "proj-x", predicate: "has", object: "ci" }, ["m8"]),
    triple({ subject: "proj-y", predicate: "has", object: "cli" }, ["m9"]),
    triple({ subject: "proj-y", predicate: "has", object: "ui" }, ["m10"]),
    triple({ subject: "repo-a", predicate: "owned_by", object: "alice" }, ["m11"]),
    triple({ subject: "repo-b", predicate: "owned_by", object: "bob" }, ["m12"]),
    triple({ subject: "repo-c", predicate: "owned_by", object: "carol" }, ["m13"]),
    triple({ subject: "repo-d", predicate: "owned_by", object: "dave" }, ["m14", "m15"]),
    triple({ subject: "repo-d", predicate: "owned_by", object: "erin" }, ["m16"]),
    triple({ subject: "svc-a", predicate: "runs_on", object: "mini" }, ["m17"]),
    triple({ subject: "svc-b", predicate: "runs_on", object: "mini" }, ["m18"]),
    triple({ subject: "svc-b", predicate: "runs_on", object: "macbook" }, ["m19", "m20"]),
  ];
}

function groupsOf(cs: ReadonlyArray<{ subject: string; predicate: string }>): string[] {
  return cs.map((c) => `${c.subject}/${c.predicate}`);
}

describe("computePredicateStats", () => {
  it("subjects / pairs / functionality / multiValuedSubjects，按 functionality 降序", () => {
    const stats = computePredicateStats(filterFixture());
    expect(stats.map((s) => [s.predicate, s.subjects, s.pairs, s.multiValuedSubjects])).toEqual([
      ["located_in", 5, 6, 1],
      ["owned_by", 4, 5, 1],
      ["runs_on", 2, 3, 1],
      ["has", 2, 5, 2],
    ]);
    expect(stats[0].functionality).toBeCloseTo(5 / 6, 12);
    expect(stats[1].functionality).toBe(0.8);
    expect(stats[2].functionality).toBeCloseTo(2 / 3, 12);
    expect(stats[3].functionality).toBe(0.4);
  });

  it("归一化后同值不重复计对", () => {
    const [s] = computePredicateStats([
      triple({ subject: "tool-a", predicate: "located_in", object: "Hooks" }),
      triple({ subject: "tool-a", predicate: "located_in", object: "  ＨＯＯＫＳ。" }),
      triple({ subject: "tool-b", predicate: "located_in", object: "bin" }),
    ]);
    expect(s).toEqual({ scope: "memory:pivot", predicate: "located_in", subjects: 2, pairs: 2, functionality: 1, multiValuedSubjects: 0 });
  });

  it("归一化为空的取值不计对；只有空取值的 subject 不计 subject", () => {
    const [s] = computePredicateStats([
      triple({ subject: "a", predicate: "p", object: "x" }),
      triple({ subject: "a", predicate: "p", object: " 。" }),
      triple({ subject: "b", predicate: "p", object: "..." }),
    ]);
    expect([s.subjects, s.pairs, s.functionality]).toEqual([1, 1, 1]);
  });

  it("同 functionality 按 subjects 降序，再按谓词字典序；不同 scope 分开统计", () => {
    const stats = computePredicateStats([
      triple({ subject: "a", predicate: "zeta", object: "1" }),
      triple({ subject: "a", predicate: "alpha", object: "1" }),
      triple({ subject: "a", predicate: "big", object: "1" }),
      triple({ subject: "b", predicate: "big", object: "1" }),
      triple({ subject: "a", predicate: "alpha", object: "2", scope: "cc:other" }),
    ]);
    expect(stats.map((s) => `${s.scope}|${s.predicate}|${s.subjects}`)).toEqual([
      "memory:pivot|big|2",
      "cc:other|alpha|1",
      "memory:pivot|alpha|1",
      "memory:pivot|zeta|1",
    ]);
  });

  it("谓词本身不归一化：大小写不同是两个谓词", () => {
    const stats = computePredicateStats([
      triple({ subject: "a", predicate: "located_in", object: "x" }),
      triple({ subject: "a", predicate: "Located_In", object: "y" }),
    ]);
    expect(stats.map((s) => [s.predicate, s.pairs]).sort()).toEqual([["Located_In", 1], ["located_in", 1]]);
  });
});

describe("parseCandidateFilterArgs / hasCandidateFilter", () => {
  it("合法值：谓词去空白去重去空项，比例与整数照原值", () => {
    expect(parseCandidateFilterArgs({ predicates: " located_in, owned_by,,located_in ", functionalMin: "0.8", functionalMinSubjects: "4", minSecondMentions: "2" })).toEqual({
      predicates: ["located_in", "owned_by"],
      functionalMin: 0.8,
      functionalMinSubjects: 4,
      minSecondMentions: 2,
    });
    expect(parseCandidateFilterArgs({ functionalMin: "1" })).toEqual({ functionalMin: 1 });
  });

  it("非法值直接拒绝，不静默改成默认值", () => {
    for (const functionalMin of ["0", "-0.1", "1.01", "abc", "", "NaN"]) {
      expect(() => parseCandidateFilterArgs({ functionalMin })).toThrow("--functional-min");
    }
    for (const n of ["0", "2.5", "-1", "x", ""]) {
      expect(() => parseCandidateFilterArgs({ functionalMinSubjects: n })).toThrow("--functional-min-subjects");
      expect(() => parseCandidateFilterArgs({ minSecondMentions: n })).toThrow("--min-second-mentions");
    }
    expect(() => parseCandidateFilterArgs({ predicates: " , ," })).toThrow("--predicates");
  });

  it("一个都没给才算没有过滤", () => {
    expect(hasCandidateFilter(parseCandidateFilterArgs({}))).toBe(false);
    expect(hasCandidateFilter({ predicates: ["p"] })).toBe(true);
    expect(hasCandidateFilter({ functionalMin: 0.8 })).toBe(true);
    expect(hasCandidateFilter({ functionalMinSubjects: 3 })).toBe(true);
    expect(hasCandidateFilter({ minSecondMentions: 2 })).toBe(true);
  });
});

describe("filterKGCandidates", () => {
  const triples = filterFixture();
  const all = findKGContradictionCandidates(triples);

  it("夹具的全部候选组", () => {
    expect(groupsOf(all)).toEqual(["tool-e/located_in", "proj-x/has", "proj-y/has", "repo-d/owned_by", "svc-b/runs_on"]);
  });

  it("--predicates 正例：白名单里的留下，顺序不变", () => {
    const r = filterKGCandidates(all, triples, { predicates: ["has", "located_in"] });
    expect(groupsOf(r.candidates)).toEqual(["tool-e/located_in", "proj-x/has", "proj-y/has"]);
  });

  it("--predicates 反例：精确匹配，大小写或写法不同不算", () => {
    const r = filterKGCandidates(all, triples, { predicates: ["Located_In", "located in", "位于"] });
    expect(r.candidates).toEqual([]);
  });

  it("--functional-min 正例：0.8 留下 located_in（5/6）与恰在边界的 owned_by（4/5）", () => {
    const r = filterKGCandidates(all, triples, { functionalMin: 0.8 });
    expect(groupsOf(r.candidates)).toEqual(["tool-e/located_in", "repo-d/owned_by"]);
  });

  it("--functional-min 反例：宽泛谓词 has（0.4）被砍；阈值抬到 0.84 连 located_in 也砍", () => {
    expect(groupsOf(filterKGCandidates(all, triples, { functionalMin: 0.5 }).candidates)).not.toContain("proj-x/has");
    expect(filterKGCandidates(all, triples, { functionalMin: 0.84 }).candidates).toEqual([]);
  });

  it("subject 数不足按不满足处理：runs_on（2 个 subject，2/3）默认被砍，门槛降到 2 才留下", () => {
    expect(DEFAULT_FUNCTIONAL_MIN_SUBJECTS).toBe(3);
    expect(groupsOf(filterKGCandidates(all, triples, { functionalMin: 0.6 }).candidates)).toEqual(["tool-e/located_in", "repo-d/owned_by"]);
    expect(groupsOf(filterKGCandidates(all, triples, { functionalMin: 0.6, functionalMinSubjects: 2 }).candidates)).toEqual([
      "tool-e/located_in",
      "repo-d/owned_by",
      "svc-b/runs_on",
    ]);
    // 门槛抬到 5：owned_by 只有 4 个 subject，被砍
    expect(groupsOf(filterKGCandidates(all, triples, { functionalMin: 0.8, functionalMinSubjects: 5 }).candidates)).toEqual(["tool-e/located_in"]);
  });

  it("functionality 按整批三元组算，不只看有候选的 subject", () => {
    // 只把 located_in 的候选组交进来，统计照样数到 5 个 subject
    const only = all.filter((c) => c.predicate === "located_in");
    const r = filterKGCandidates(only, triples, { functionalMin: 0.8 });
    expect(r.candidates.map((c) => c.subject)).toEqual(["tool-e"]);
    expect(r.predicateStats.find((s) => s.predicate === "located_in")?.subjects).toBe(5);
  });

  it("--min-second-mentions 正例与反例", () => {
    // 第二多取值的 mention_count：tool-e 2、svc-b 1（mini 两个 subject 各 1）、repo-d 1、has 1
    expect(groupsOf(filterKGCandidates(all, triples, { minSecondMentions: 2 }).candidates)).toEqual(["tool-e/located_in"]);
    expect(filterKGCandidates(all, triples, { minSecondMentions: 3 }).candidates).toEqual([]);
    expect(filterKGCandidates(all, triples, { minSecondMentions: 1 }).candidates).toEqual(all);
  });

  it("funnel：同一批三元组上依次报每一步剩多少、砍多少，没启用的标 skipped", () => {
    const r = filterKGCandidates(all, triples, { predicates: ["located_in", "owned_by", "has"], functionalMin: 0.8, minSecondMentions: 2 });
    expect(r.funnel.map((f) => [f.step, f.status, f.remaining, f.removed])).toEqual([
      ["all", "applied", 5, 0],
      ["predicates", "applied", 4, 1],
      ["functional", "applied", 2, 2],
      ["min-second-mentions", "applied", 1, 1],
    ]);
    expect(groupsOf(r.candidates)).toEqual(["tool-e/located_in"]);

    const partial = filterKGCandidates(all, triples, { functionalMin: 0.8 });
    expect(partial.funnel.map((f) => [f.step, f.status, f.remaining, f.removed, f.criterion])).toEqual([
      ["all", "applied", 5, 0, ""],
      ["predicates", "skipped", 5, 0, ""],
      ["functional", "applied", 2, 3, "functionality >= 0.8 and subjects >= 3"],
      ["min-second-mentions", "skipped", 2, 0, ""],
    ]);
  });

  it("没给任何选项：候选原样返回，每一步都是 skipped", () => {
    const r = filterKGCandidates(all, triples, {});
    expect(r.candidates).toEqual(all);
    expect(r.funnel.map((f) => f.status)).toEqual(["applied", "skipped", "skipped", "skipped"]);
    expect(r.funnel.every((f) => f.remaining === all.length)).toBe(true);
  });

  it("文本报告：给了 funnel 才多出漏斗几行，不给与原来一样", () => {
    const r = filterKGCandidates(all, triples, { functionalMin: 0.8 });
    const withFunnel = formatCandidateReport("memory:pivot", triples.length, r.candidates.length, r.candidates, "top 20", r.funnel);
    const without = formatCandidateReport("memory:pivot", triples.length, r.candidates.length, r.candidates, "top 20");
    expect(withFunnel).toBe(without.replace("(top 20)\n", `(top 20)\n${formatFunnel(r.funnel).join("\n")}\n`));
    expect(formatFunnel(r.funnel)).toEqual([
      "funnel (same triples, steps applied in order):",
      "  all candidate groups    5",
      "  predicate whitelist     skipped",
      "  functional predicates   2 (-3)  functionality >= 0.8 and subjects >= 3",
      "  min 2nd-value mentions  skipped",
    ]);
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
