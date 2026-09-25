/**
 * 排序上把相关度与流行度拆开（第二步 plan v2.1，open-loops「RecallNest 检索评分链」症状 C）。
 *
 * 两个开关（2026-09-25 起默认都开，Alice 看过正式 shadow 后拍板；显式设 legacy / false 回到切默认之前的行为）：
 *   RECALLNEST_POPULARITY_RANKING=bounded —— 三个流行度加成合成链尾一步 ×(1+γh)、只加不减、不截平，
 *                                           retrieve() 出口才截到 1；下游「给全文」档 0.80
 *   RECALLNEST_TRIGGER_LENGTH_EXEMPT=true —— trigger 那一路走完前置环节、不做长度归一，与正文那一路取大
 *
 * 编号对应 plan §四.3。每条都做过反向验证（改坏对应的实现让它变红，还原即绿），记录在 CLAUDE.md 测试基线行。
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRetriever, type RetrievalResult } from "../retriever.js";
import { buildStructuredMetadata } from "../capture-engine.js";
import { MemoryStore } from "../store.js";
import { TriggerStore } from "../trigger-store.js";
import * as envConfig from "../env-config.js";
import { collapseResults, DEFAULT_COLLAPSE_CONFIG } from "../context-collapse-renderer.js";
import { formatCollapsedResults } from "../memory-output.js";
import { extractErrorSignatures } from "../error-signature.js";

const FLAGS = [
  "RECALLNEST_POPULARITY_RANKING",
  "RECALLNEST_TRIGGER_LENGTH_EXEMPT",
  "RECALLNEST_ERROR_SIGNATURE_BOOST",
  "RECALLNEST_TRIGGER_RECALL",
] as const;
const saved: Record<string, string | undefined> = {};
const cleanupPaths: string[] = [];

beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setSystemTime();
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

const bounded = () => { process.env.RECALLNEST_POPULARITY_RANKING = "bounded"; };
const legacy = () => { process.env.RECALLNEST_POPULARITY_RANKING = "legacy"; };
const lenExemptOff = () => { process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT = "false"; };

const NOW = Date.parse("2026-09-25T00:00:00.000Z");
const DAY = 86_400_000;
const QUERY = "新条目 排序 流行度 测试查询";
const SHORT = "一条够长、不会被噪声过滤当成碎片的正文，只用来测排序。";
const LONG_1600 = "长".repeat(1600); // 锚点 800 → 长度系数 1/(1+0.5·log2 2) = 2/3

type Mem = {
  id: string;
  text: string;
  vector: number[];
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
};

/** 默认：importance 1、confidence 1、scope 不是 durable / transcript（boundary 系数 1）、pinned（演化混合按豁免算，每条一样）——
 *  于是长度归一之前的乘法环节全是 ×1，演化混合是 0.9·s + 0.1，下面的算术都按这个来 */
function mem(
  id: string,
  vector: number[],
  opts: { text?: string; importance?: number; ageDays?: number; category?: string; scope?: string; meta?: Record<string, unknown> } = {},
): Mem {
  return {
    id,
    text: opts.text ?? `${id} ${SHORT}`,
    vector,
    category: opts.category ?? "events",
    scope: opts.scope ?? "test",
    importance: opts.importance ?? 1,
    timestamp: NOW - (opts.ageDays ?? 400) * DAY,
    metadata: JSON.stringify({ tags: ["pinned"], confidence: 1, ...(opts.meta ?? {}) }),
  };
}

const evo = (accessCount: number, lastAccessedAt = NOW - 100 * DAY) => ({ evolution: { accessCount, lastAccessedAt } });

type Hit = { entry: Mem; score: number };

function fakeStore(pool: Hit[], opts: { fts?: boolean; byQueryVector?: (v: number[]) => Hit[]; extra?: Mem[] } = {}) {
  const all = new Map<string, Mem>([...pool.map((p) => p.entry), ...(opts.extra ?? [])].map((e) => [e.id, e]));
  return {
    hasFtsSupport: opts.fts ?? false,
    async vectorSearch(v: number[]) {
      return (opts.byQueryVector ? opts.byQueryVector(v) : pool).map((p) => ({ entry: p.entry, score: p.score }));
    },
    async bm25Search() {
      return [];
    },
    async getById(id: string) {
      return all.get(id) ?? null;
    },
    async hasId(id: string) {
      return all.has(id);
    },
  } as never;
}

const embedder = (fn: (q: string) => number[] = () => [1, 0, 0]) =>
  ({
    async embedQuery(q: string) {
      return fn(q);
    },
    async embedPassage() {
      return [1, 0, 0];
    },
  }) as never;

/** 其余环节都关掉或恒定，只留下要测的那几环 */
const CFG = {
  mode: "vector" as const,
  rerank: "none" as const,
  filterNoise: false,
  sourceDiversity: 0,
  hotnessWeight: 0,
  utilityWeight: 0,
  recencyHalfLifeDays: 0,
  timeDecayHalfLifeDays: 0,
};

const byId = (results: RetrievalResult[]) => new Map(results.map((r) => [r.entry.id, r]));
const ids = (results: RetrievalResult[]) => results.map((r) => r.entry.id);
const search = (retriever: ReturnType<typeof createRetriever>, extra: Record<string, unknown> = {}) =>
  retriever.retrieve({ query: QUERY, limit: 10, source: "auto-recall", ...extra });

/** 在实例上包一层 finalizeResults，记下截平之前的原值（出口截平在它之后） */
function captureRaw(retriever: ReturnType<typeof createRetriever>): Map<string, number> {
  const raw = new Map<string, number>();
  const r = retriever as unknown as { finalizeResults: (res: RetrievalResult[], o: unknown) => RetrievalResult[] };
  const orig = r.finalizeResults.bind(retriever);
  r.finalizeResults = (res, o) => {
    const out = orig(res, o);
    for (const x of out) raw.set(x.entry.id, x.score);
    return out;
  };
  return raw;
}

// ---------------------------------------------------------------------------
// 1 · 开关默认值
// ---------------------------------------------------------------------------

describe("1 · 开关默认值", () => {
  it("环境变量不设：bounded / 开 / 0.80（2026-09-25 切默认）；显式 legacy / false 才回旧行为；乱写回落默认", () => {
    expect(envConfig.popularityRanking()).toBe("bounded");
    expect(envConfig.triggerLengthExempt()).toBe(true);
    expect(envConfig.fullTextScoreThreshold()).toBe(0.8);

    process.env.RECALLNEST_POPULARITY_RANKING = "legacy";
    process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT = "false";
    expect(envConfig.popularityRanking()).toBe("legacy");
    expect(envConfig.triggerLengthExempt()).toBe(false);
    expect(envConfig.fullTextScoreThreshold()).toBe(0.85);

    // 切默认之前就显式写成开启值的配置，切了之后照样是开
    process.env.RECALLNEST_POPULARITY_RANKING = "bounded";
    process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT = "true";
    expect(envConfig.popularityRanking()).toBe("bounded");
    expect(envConfig.triggerLengthExempt()).toBe(true);

    // 只认精确的关闭值（同 RECALLNEST_TRIGGER_RECALL 的写法）：大小写不对、写成 0 都回落默认
    process.env.RECALLNEST_POPULARITY_RANKING = "Legacy";
    process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT = "0";
    expect(envConfig.popularityRanking()).toBe("bounded");
    expect(envConfig.triggerLengthExempt()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2–6 · bounded 流行度
// ---------------------------------------------------------------------------

describe("bounded 流行度", () => {
  it("2 · 零访问的条目分数与加成前相同（与 legacy 逐位一致——零访问时 legacy 三环都是空操作）", async () => {
    const a = mem("aaaaaaaa-0000-4000-8000-000000000001", [1, 0, 0]);
    const retriever = createRetriever(fakeStore([{ entry: a, score: 0.7 }]), embedder(), CFG);
    legacy();
    const l = await search(retriever);
    bounded();
    const b = await search(retriever);
    expect(b[0].score).toBe(l[0].score);
  });

  it("3 · 只加不减：访问过一次、上次访问在 100 天前的条目不低于同分的零访问条目；legacy 下它确实被热度混合扣分（反向校准）", async () => {
    const x = mem("aaaaaaaa-0000-4000-8000-000000000003", [1, 0, 0], {
      meta: { ...evo(1), accessCount: 1, lastAccessedAt: NOW - 100 * DAY },
    });
    const y = mem("bbbbbbbb-0000-4000-8000-000000000003", [0, 1, 0]);
    const retriever = createRetriever(
      fakeStore([{ entry: x, score: 0.7 }, { entry: y, score: 0.7 }]),
      embedder(),
      { ...CFG, hotnessWeight: 0.15 },
    );
    retriever.setAccessTracker({ recordAccess() {}, computeEffectiveHalfLife: (b: number) => b } as never);
    setSystemTime(new Date(NOW));

    legacy();
    const l = byId(await search(retriever));
    expect(l.get(x.id)!.score).toBeLessThan(l.get(y.id)!.score); // §二.2 的「被搜过一次反而吃亏」

    bounded();
    const b = byId(await search(retriever));
    expect(b.get(x.id)!.score).toBeGreaterThan(b.get(y.id)!.score);
    expect(b.get(y.id)!.score).toBe(l.get(y.id)!.score);
  });

  it("3b · h 只读 evolution.accessCount：顶层 accessCount 很大、evolution 为 0 的条目不加分", async () => {
    const z = mem("aaaaaaaa-0000-4000-8000-00000000003b", [1, 0, 0], {
      meta: { accessCount: 50, lastAccessedAt: NOW - 100 * DAY },
    });
    const y = mem("bbbbbbbb-0000-4000-8000-00000000003b", [0, 1, 0]);
    const retriever = createRetriever(fakeStore([{ entry: z, score: 0.7 }, { entry: y, score: 0.7 }]), embedder(), CFG);
    setSystemTime(new Date(NOW));
    bounded();
    const b = byId(await search(retriever));
    expect(b.get(z.id)!.score).toBe(b.get(y.id)!.score);
  });

  it("4 · 加成上限：终分 / 加成前 ≤ 1 + γ；31 次起封顶，h 按 log2(1+n)/5", async () => {
    const counts = [0, 1, 5, 31, 100, 1000];
    const hits = counts.map((n, i) => ({
      entry: mem(`cccccccc-0000-4000-8000-00000000000${i}`, [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i >= 2 ? 1 / i : 0], {
        meta: n > 0 ? evo(n) : {},
      }),
      score: 0.6,
    }));
    bounded();
    const withBonus = byId(await search(createRetriever(fakeStore(hits), embedder(), CFG)));
    const noBonus = byId(await search(createRetriever(fakeStore(hits), embedder(), { ...CFG, popularityBonusMax: 0 })));
    counts.forEach((n, i) => {
      const id = hits[i].entry.id;
      const ratio = withBonus.get(id)!.score / noBonus.get(id)!.score;
      expect(ratio).toBeLessThanOrEqual(1.2 + 1e-12);
      expect(ratio).toBeCloseTo(1 + 0.2 * Math.min(1, Math.log2(1 + n) / 5), 12);
    });
  });

  it("4b · 访问计数不是有限非负数（字符串、数字字符串、负数）时按零访问：分数与零访问条目相同、是有限数", async () => {
    const zero = mem("dddddddd-0000-4000-8000-00000000004b", [0, 0, 1]);
    const bad = ["broken", "5", -3].map((n, i) =>
      mem(`bbbbbbbb-0000-4000-8000-0000000004b${i}`, [i === 0 ? 1 : 0, i === 1 ? 1 : 0, 0.1 * (i + 1)], { meta: { evolution: { accessCount: n } } }),
    );
    bounded();
    const out = byId(await search(createRetriever(fakeStore([zero, ...bad].map((entry) => ({ entry, score: 0.7 }))), embedder(), CFG)));
    for (const e of bad) {
      expect(Number.isFinite(out.get(e.id)!.score)).toBe(true);
      expect(out.get(e.id)!.score).toBe(out.get(zero.id)!.score);
    }
  });

  it("5 · 链尾不截平、出口截平：加成把两条都推过 1 且改变先后——按原值排；返回分数截到 1；omitted 仍在", async () => {
    // p 加成前更高（0.99）但只访问 3 次，q 加成前 0.95、访问 40 次：原值 q 1.146 > p 1.070，都 > 1。
    // 要是链里哪一环把它们截成 1.0，两条就会并列、按加成前的先后留下 p 在前。
    const p = mem("pppppppp-0000-4000-8000-000000000005", [1, 0, 0], { meta: evo(3) });
    const q = mem("qqqqqqqq-0000-4000-8000-000000000005", [0, 1, 0], { meta: evo(40) });
    const r = mem("rrrrrrrr-0000-4000-8000-000000000005", [0, 0, 1]);
    const retriever = createRetriever(
      fakeStore([{ entry: p, score: 0.99 }, { entry: q, score: 0.95 }, { entry: r, score: 0.5 }]),
      embedder(),
      CFG,
    );
    const raw = captureRaw(retriever);
    bounded();
    const out = await retriever.retrieve({ query: QUERY, limit: 2, source: "auto-recall" });
    expect(raw.get(q.id)!).toBeGreaterThan(raw.get(p.id)!);
    expect(raw.get(p.id)!).toBeGreaterThan(1);
    expect(ids(out)).toEqual([q.id, p.id]);
    expect(out.map((x) => x.score)).toEqual([1, 1]);
    expect((out as { omitted?: { count: number } }).omitted?.count).toBe(1);
  });

  it("5b · bounded + multiHop：首轮原值约 1.157、跟进检索原值约 1.189、limit=1 → 返回跟进那条（截在 finalize 里会留下首轮那条）", async () => {
    const first = mem("11111111-0000-4000-8000-00000000005b", [1, 0, 0], {
      text: `Zephyrine archive note, plain lowercase words only for the rest of this entry.`,
      meta: evo(40),
    });
    const hop = mem("22222222-0000-4000-8000-00000000005b", [0, 1, 0], {
      text: `hop result entry, plain lowercase words only for the rest of this entry.`,
      meta: evo(40),
    });
    const HOP_VEC = [0, 1, 0];
    const store = fakeStore([], {
      byQueryVector: (v) => (v[1] === 1 ? [{ entry: hop, score: 0.99 }] : [{ entry: first, score: 0.96 }]),
      extra: [first, hop],
    });
    const retriever = createRetriever(
      store,
      embedder((q) => (q.includes("Zephyrine") ? HOP_VEC : [1, 0, 0])),
      CFG,
    );
    const raw = captureRaw(retriever);
    bounded();
    const out = await retriever.retrieve({ query: QUERY, limit: 1, source: "auto-recall", multiHop: true });
    expect(raw.get(first.id)!).toBeGreaterThan(1);
    expect(raw.get(hop.id)!).toBeGreaterThan(raw.get(first.id)!);
    expect(ids(out)).toEqual([hop.id]);
    expect(out[0].score).toBe(1);
  });

  it("6 · bounded 不读频次台账（legacy 会读——反向校准）", async () => {
    const a = mem("aaaaaaaa-0000-4000-8000-000000000006", [1, 0, 0], { meta: evo(5) });
    const retriever = createRetriever(fakeStore([{ entry: a, score: 0.7 }]), embedder(), CFG);
    retriever.setFrequencyTracker({
      getBoostMultiplier() {
        throw new Error("frequency ledger was read");
      },
      recordHits() {},
    } as never);
    legacy();
    await expect(search(retriever)).rejects.toThrow("frequency ledger was read");
    bounded();
    const out = await search(retriever);
    expect(ids(out)).toEqual([a.id]);
  });

  it("6b · RECALLNEST_ERROR_SIGNATURE_BOOST=true：bounded 下精确命中的 1.14 排在未命中的 1.08 之前", async () => {
    process.env.RECALLNEST_ERROR_SIGNATURE_BOOST = "true";
    const errQuery = "上次一模一样的报错 xmlsec1 not found"; // 纯英文的 "build broke: …" 会被 shouldSkipRetrieval 当命令跳过
    const sig = "xmlsec1 not found";
    expect(extractErrorSignatures({ problem: errQuery })).toContain(sig);
    // 加成前 = 0.9·v + 0.1（见 mem 的默认值）；h = 1（访问 40 次）→ ×1.2
    const vx = (1.14 / 1.2 / 1.5 - 0.1) / 0.9; // 精确命中：×1.2 ×1.5 → 1.14
    const vy = (1.08 / 1.2 - 0.1) / 0.9; //       未命中：×1.2 → 1.08
    const x = mem("xxxxxxxx-0000-4000-8000-00000000006b", [1, 0, 0], { category: "cases", meta: { ...evo(40), error_signature: [sig] } });
    const y = mem("yyyyyyyy-0000-4000-8000-00000000006b", [0, 1, 0], { category: "cases", meta: evo(40) });
    const retriever = createRetriever(fakeStore([{ entry: x, score: vx }, { entry: y, score: vy }]), embedder(), CFG);
    const raw = captureRaw(retriever);
    bounded();
    const out = await retriever.retrieve({ query: errQuery, limit: 5, source: "auto-recall" });
    expect(raw.get(x.id)!).toBeCloseTo(1.14, 9);
    expect(raw.get(y.id)!).toBeCloseTo(1.08, 9);
    expect(ids(out)).toEqual([x.id, y.id]);
  });
});

// ---------------------------------------------------------------------------
// 5c · sources 不多任何字段
// ---------------------------------------------------------------------------

describe("5c · 返回条目的 sources 键集合与改前一致", () => {
  it("legacy、只开开关 2、两个都开：trigger 并入的条目 sources 与 sources.trigger 的键都不变", async () => {
    const host = mem("hhhhhhhh-0000-4000-8000-00000000005c", [0, 0, 1], { text: LONG_1600 });
    const cand = mem("cccccccc-0000-4000-8000-00000000005c", [1, 0, 0]);
    const retriever = createRetriever(fakeStore([{ entry: host, score: 0.6 }, { entry: cand, score: 0.7 }]), embedder(), CFG);
    retriever.setTriggerStore({
      search: async () => [{ memoryId: host.id, text: "那句 trigger", cosine: 0.8, score: 0.8, scope: "test", admittedBy: "hard" }],
    } as never);
    const keysOf = (out: RetrievalResult[]) =>
      out.map((r) => ({ id: r.entry.id, top: Object.keys(r.sources).sort(), trigger: r.sources.trigger ? Object.keys(r.sources.trigger).sort() : null }))
        .sort((a, b) => a.id.localeCompare(b.id));

    legacy();
    lenExemptOff();
    const base = keysOf(await search(retriever));
    // 钉死改前（origin/main）的形状，不只做三种模式之间互比——互比抓不到「所有模式都多了同一个字段」（实现互审 Codex）
    expect(base).toEqual([
      { id: cand.id, top: ["vector"], trigger: null },
      { id: host.id, top: ["trigger", "vector"], trigger: ["admittedBy", "cosine", "overlap", "score", "text"] },
    ]);
    process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT = "true";
    expect(keysOf(await search(retriever))).toEqual(base);
    bounded();
    expect(keysOf(await search(retriever))).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// 7 · 开关 2：trigger 那一路不做长度归一
// ---------------------------------------------------------------------------

describe("开关 2 · RECALLNEST_TRIGGER_LENGTH_EXEMPT", () => {
  // 当日新存（新近度 +0.1）、importance 0.7（×0.85）：前置环节不是恒等的，「trigger 那一路」要是没走前置环节就对不上
  function scene() {
    setSystemTime(new Date(NOW));
    const o = { importance: 0.7, ageDays: 0 };
    const host = mem("hhhhhhhh-0000-4000-8000-000000000007", [0, 0, 1], { ...o, text: LONG_1600 }); // 只经 trigger 到达
    const control = mem("cccccccc-0000-4000-8000-000000000007", [1, 0, 0], o); //                    短正文、向量 0.8
    const longVec = mem("dddddddd-0000-4000-8000-000000000007", [0, 1, 0], { ...o, text: "短".repeat(1600) }); // 同样 1600 字、向量 0.8、没有 trigger
    const retriever = createRetriever(
      fakeStore([{ entry: control, score: 0.8 }, { entry: longVec, score: 0.8 }], { extra: [host] }),
      embedder(),
      { ...CFG, recencyHalfLifeDays: 30, recencyWeight: 0.1 },
    );
    retriever.setTriggerStore({
      search: async () => [{ memoryId: host.id, text: "那句 trigger", cosine: 0.8, score: 0.8, scope: "test", admittedBy: "hard" }],
    } as never);
    return { host, control, longVec, retriever };
  }

  it("7 · 开：trigger 独自带入的长宿主不打折（与同底分的短条目一样），没有 trigger 的长条目照常打折；关：两者都打折", async () => {
    const { host, control, longVec, retriever } = scene();
    legacy(); // 只看开关 2
    process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT = "true";
    const on = byId(await search(retriever));
    expect(on.get(host.id)!.score).toBe(on.get(control.id)!.score);
    expect(on.get(longVec.id)!.score).toBeLessThan(on.get(control.id)!.score);

    lenExemptOff();
    const off = byId(await search(retriever));
    expect(off.get(host.id)!.score).toBeLessThan(off.get(control.id)!.score);
    expect(off.get(host.id)!.score).toBe(off.get(longVec.id)!.score);
  });

  it("7b · 单调：当日新存（新近度不为 0）的 1600 字宿主、trigger 0.80，向量分 0.70→0.99 终分不下降；trigger 0.99 的 durable 宿主在高分区也不下降", async () => {
    setSystemTime(new Date(NOW));
    legacy(); // 只看开关 2
    process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT = "true";
    const durableMeta = JSON.parse(
      buildStructuredMetadata({ source: "manual", tags: [], capture: "test", category: "events", canonicalKey: "key-7b" }),
    );
    const sweeps = [
      {
        trigger: 0.8,
        entry: { ...mem("77777777-0000-4000-8000-00000000007b", [1, 0, 0], { text: LONG_1600, importance: 0.7, ageDays: 0 }), metadata: "{}" },
        from: 70,
        to: 99,
      },
      {
        trigger: 0.99,
        entry: {
          ...mem("88888888-0000-4000-8000-00000000007b", [1, 0, 0], { text: LONG_1600, importance: 0.7, ageDays: 0, scope: "memory:pivot" }),
          metadata: JSON.stringify(durableMeta),
        },
        from: 90,
        to: 99,
      },
    ];
    for (const s of sweeps) {
      const finals: number[] = [];
      for (let v = s.from; v <= s.to; v++) {
        const retriever = createRetriever(fakeStore([{ entry: s.entry, score: v / 100 }]), embedder(), {
          ...CFG,
          recencyHalfLifeDays: 30,
          recencyWeight: 0.1,
        });
        retriever.setTriggerStore({
          search: async () => [{ memoryId: s.entry.id, text: "那句 trigger", cosine: s.trigger, score: s.trigger, scope: s.entry.scope, admittedBy: "hard" }],
        } as never);
        const out = await search(retriever);
        finals.push(out[0].score);
      }
      for (let i = 1; i < finals.length; i++) expect(finals[i]).toBeGreaterThanOrEqual(finals[i - 1]);
    }
  });

  it("7c · hybrid 路径：trigger 那一路以 0.9×trigger 分为底（与 applyTriggerFloor 同口径）", async () => {
    legacy(); // 只看开关 2
    process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT = "true";
    const host = mem("hhhhhhhh-0000-4000-8000-00000000007c", [0, 0, 1], { text: LONG_1600 });
    const control = mem("cccccccc-0000-4000-8000-00000000007c", [1, 0, 0]); // 短正文、向量分 = 0.9 × 0.8
    const retriever = createRetriever(fakeStore([{ entry: control, score: 0.72 }], { fts: true, extra: [host] }), embedder(), {
      ...CFG,
      mode: "hybrid",
    });
    retriever.setTriggerStore({
      search: async () => [{ memoryId: host.id, text: "那句 trigger", cosine: 0.8, score: 0.8, scope: "test", admittedBy: "hard" }],
    } as never);
    const on = byId(await search(retriever));
    expect(on.get(host.id)!.score).toBeCloseTo(on.get(control.id)!.score, 12);
    lenExemptOff();
    const off = byId(await search(retriever));
    expect(off.get(host.id)!.score).toBeLessThan(off.get(control.id)!.score);
  });
});

// ---------------------------------------------------------------------------
// 8 · 真实临时 LanceDB：症状 C 的最小复现
// ---------------------------------------------------------------------------

describe("8 · 真实临时 LanceDB", () => {
  const TRIGGER_Q = "两个记忆库要不要合成一个";
  const QVEC = [1, 0, 0];
  const embed = async (text: string) => (text === TRIGGER_Q ? QVEC : [0.33, 0.33, 0.33]);
  const realEmbedder = { embedQuery: embed, embedPassage: embed } as never;

  function row(id: string, vector: number[], ageDays: number, extra: Record<string, unknown> = {}) {
    const base = JSON.parse(
      buildStructuredMetadata({ source: "manual", tags: ["pinned"], capture: "test", category: "patterns", canonicalKey: `key-${id}` }),
    );
    return {
      id,
      text: `${id} ${SHORT}`,
      vector,
      category: "patterns" as const,
      scope: "memory:pivot",
      importance: 0.8,
      timestamp: Date.now() - ageDays * DAY,
      metadata: JSON.stringify({ ...base, ...extra }),
    };
  }

  it("新存、带 trigger、零访问的宿主，对一条弱相关、被访问多次的老条目：bounded 下宿主第 1；同一数据 legacy 下老条目第 1（反向校准）", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "rn-popularity-bounded-"));
    cleanupPaths.push(dbPath);
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    const triggers = new TriggerStore({ dbPath, vectorDim: 3 });
    const host = row("0bd50a9b-0000-4000-8000-000000000008", [0, 0, 1], 1);
    const old = row("0e1d0e1d-0000-4000-8000-000000000008", [0.6, 0.8, 0], 120, {
      evolution: { accessCount: 40, lastAccessedAt: Date.now() - 20 * DAY },
    });
    for (const e of [host, old]) await store.importEntry(e);
    await triggers.upsertForMemory(host.id, "memory:pivot", [TRIGGER_Q], async (texts: string[]) => Promise.all(texts.map(embed)));

    const retriever = createRetriever(store as never, realEmbedder, {
      mode: "vector",
      rerank: "none",
      filterNoise: false,
      sourceDiversity: 0,
      hotnessWeight: 0,
      utilityWeight: 0,
      recencyHalfLifeDays: 0,
    });
    retriever.setTriggerStore(triggers);
    // legacy 下分量最重的那一环：老条目在频次台账里 ×1.8（bounded 不读它，见 6）
    retriever.setFrequencyTracker({ getBoostMultiplier: (id: string) => (id === old.id ? 1.8 : 1), recordHits() {} } as never);
    await store.ready();
    await triggers.ready();

    const run = () => retriever.retrieve({ query: TRIGGER_Q, limit: 5, scopeFilter: ["memory:pivot"], source: "auto-recall" });
    legacy();
    expect(ids(await run())[0]).toBe(old.id);
    bounded();
    const out = await run();
    expect(ids(out)[0]).toBe(host.id);
    expect(ids(out)).toContain(old.id);
    // 生产默认路径：两个变量都不设（2026-09-25 切默认之后就是这样跑的）
    delete process.env.RECALLNEST_POPULARITY_RANKING;
    delete process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT;
    expect(ids(await run())[0]).toBe(host.id);
  });
});

// ---------------------------------------------------------------------------
// 9 · 下游「给全文」档
// ---------------------------------------------------------------------------

describe("9 · 全文档跟着流行度模式走", () => {
  // 正文要长过 adaptive 的片段窗口，否则「给全文」与「给片段」看起来一样（实现互审 Codex：只看标签的断言抓不到只给片段的实现）
  const LONG_TEXT = `开头一句只在全文里有。${"中间的铺垫文字，".repeat(80)}这一条的分数落在 0.80 与 0.85 之间。${"结尾的补充说明，".repeat(20)}最后一句也只在全文里有。`;
  const result = (score: number): RetrievalResult =>
    ({
      entry: {
        id: "99999999-0000-4000-8000-000000000009",
        text: LONG_TEXT,
        vector: [1, 0, 0],
        category: "events",
        scope: "test",
        importance: 0.8,
        timestamp: NOW,
        metadata: "{}",
      },
      score,
      sources: { vector: { score, rank: 1 } },
    }) as unknown as RetrievalResult;

  it("adaptive：0.82 在 legacy 下给片段、bounded 下给全文；Mode 行印出的阈值跟着变", () => {
    legacy();
    const l = formatCollapsedResults([result(0.82)], { query: "分数", profile: "default" } as never);
    expect(l).toContain("[SNIP]");
    expect(l).toContain("full text for score ≥ 0.85,");
    expect(l).not.toContain(LONG_TEXT);
    bounded();
    const b = formatCollapsedResults([result(0.82)], { query: "分数", profile: "default" } as never);
    expect(b).toContain("[FULL]");
    expect(b).toContain("full text for score ≥ 0.8,");
    expect(b).toContain(LONG_TEXT);
  });

  it("折叠视图：默认配置下 0.82 legacy 是 L1、bounded 是 L2；调用方显式传 thresholds 的不受模式影响；导出的默认常量不变", () => {
    const item = { entryId: "e", text: "正文", score: 0.82, timestamp: NOW };
    const explicit = { thresholds: { l2: 0.9, l1: 0.6, l0: 0.5 } };
    legacy();
    expect(collapseResults([item])[0].renderLevel).toBe("L1");
    expect(collapseResults([item], explicit)[0].renderLevel).toBe("L1");
    bounded();
    expect(collapseResults([item])[0].renderLevel).toBe("L2");
    expect(collapseResults([item], explicit)[0].renderLevel).toBe("L1");
    expect(DEFAULT_COLLAPSE_CONFIG.thresholds.l2).toBe(0.85);
  });
});
