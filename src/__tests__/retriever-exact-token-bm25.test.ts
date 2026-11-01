/**
 * exact-token BM25 补偿不再无条件插到最前（体检 14 的 BM25 那半）。
 *
 * 改动前：retrieve() 在 finalize 之后 `[...supplements, ...vectorResults]`，query 带文件名 / 全大写常量 /
 * snake_case / commit hash 时，最多 3 条 BM25 命中无条件排到最前，且不经过打分链、分数下限、噪声与去重。
 * 体检复现：`how is length normalization computed in retriever.ts`，答案（向量分 0.770）排第 4，
 * 第 1–3 是三条不相关的「Edited retriever.ts today…」（cosine 0.40）。
 *
 * 改动后：补偿条目在 vector 路径的打分链之前作为候选并入，分数 = 它自己的向量分（与 store 同口径）与
 * BM25 分按 vectorWeight / bm25Weight 加权平均，之后与 vector 候选走同一条打分链与 finalize。
 * hybrid 路径的 BM25 本来就参与融合，不再另补。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRetriever, type RetrievalResult } from "../retriever.js";
import { MemoryStore } from "../store.js";

const QUERY = "how is length normalization computed in retriever.ts";
const QVEC = [1, 0, 0];
const NOW = Date.now();

/** 与 store.vectorSearch 同口径的向量分：1 / (1 + (1 − cos)) */
const vecScore = (cos: number) => 1 / (2 - cos);
/** 与 QVEC 夹角余弦为 cos 的单位向量 */
const vecAt = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];

interface Row {
  id: string;
  text: string;
  vector: number[];
  category: "patterns";
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
}

function row(id: string, text: string, cos: number | null): Row {
  return {
    id,
    text,
    vector: cos === null ? [] : vecAt(cos),
    category: "patterns",
    scope: "memory:test",
    importance: 0.8,
    timestamp: NOW - 3_600_000,
    metadata: "{}",
  };
}

const ANSWER = row(
  "a0000000-0000-4000-8000-000000000001",
  "Length normalization divides the score by log2 of the text length relative to the 800-char anchor, so long entries are damped.",
  0.7013, // 向量分 ≈ 0.770
);
const EDITED = [1, 2, 3].map((n) =>
  row(
    `e000000${n}-0000-4000-8000-000000000001`,
    `Edited retriever.ts today: renamed helper number ${n} in the trace utilities.`,
    0.4,
  ),
);

const embedder = {
  async embedQuery() {
    return QVEC;
  },
  async embedPassage() {
    return QVEC;
  },
} as never;

/** 鸭子类型 store：vector 池只有 vectorHits；bm25Search 返回 bm25Hits（BM25 分已是 store 归一化后的 0–1） */
function fakeStore(vectorHits: Row[], bm25Hits: Array<{ entry: Row; score: number }>) {
  const calls = { bm25: 0 };
  const store = {
    hasFtsSupport: true,
    async ready() {},
    async hasId() {
      return true;
    },
    async vectorSearch(_v: number[], _limit: number, minScore = 0) {
      return vectorHits
        .map((entry) => {
          let dot = 0;
          for (let i = 0; i < QVEC.length; i++) dot += QVEC[i] * (entry.vector[i] ?? 0);
          return { entry, score: vecScore(dot) };
        })
        .filter((r) => r.score >= minScore);
    },
    async bm25Search() {
      calls.bm25 += 1;
      return bm25Hits;
    },
  };
  return { store, calls };
}

const CFG = {
  mode: "vector" as const,
  rerank: "none" as const,
  sourceDiversity: 0,
  recencyWeight: 0,
  recencyHalfLifeDays: 0,
  timeDecayHalfLifeDays: 0,
  hotnessWeight: 0,
  utilityWeight: 0,
};

const ids = (rs: RetrievalResult[]) => rs.map((r) => r.entry.id);

describe("exact-token BM25 补偿按分数并入", () => {
  it("体检复现：向量分 0.770 的答案不被三条 cosine 0.40 的 BM25 补偿压到第 4", async () => {
    const { store, calls } = fakeStore(
      [ANSWER],
      EDITED.map((entry) => ({ entry, score: 0.88 })),
    );
    const retriever = createRetriever(store as never, embedder, CFG);
    const out = await retriever.retrieve({ query: QUERY, limit: 5 });

    expect(calls.bm25).toBe(1); // 确实走到了补偿（不是空跑）
    expect(ids(out)[0]).toBe(ANSWER.id);
    // 补偿条目仍能作为候选出现，只是排在答案后面
    for (const e of EDITED) expect(ids(out).indexOf(e.id)).toBeGreaterThan(0);
  });

  it("按分数并入而不是一律垫底：向量分更高、又精确命中的补偿条目排到前面", async () => {
    const strong = row("b0000000-0000-4000-8000-000000000001", "retriever.ts computes length normalization in applyLengthNormalization.", 0.8);
    const { store } = fakeStore([ANSWER], [{ entry: strong, score: 0.9 }]);
    const out = await createRetriever(store as never, embedder, CFG).retrieve({ query: QUERY, limit: 5 });
    expect(ids(out).slice(0, 2)).toEqual([strong.id, ANSWER.id]);
  });

  it("补偿的本意还在：语义上 vector 完全没认出来（cos 0）、但精确命中的条目仍进结果，排在答案之后", async () => {
    // 向量分与 store 同口径：cos 0 → 0.5（不是 0），0.7×0.5 + 0.3×0.9 = 0.62，过 0.35 的下限
    const orthogonal = row("b0000000-0000-4000-8000-000000000002", "retriever.ts: LENGTH_NORM_ANCHOR is 800.", 0);
    const { store } = fakeStore([ANSWER], [{ entry: orthogonal, score: 0.9 }]);
    const out = await createRetriever(store as never, embedder, CFG).retrieve({ query: QUERY, limit: 5 });
    expect(ids(out)).toEqual([ANSWER.id, orthogonal.id]);
  });

  it("补偿条目过分数下限：没有向量、只靠 BM25 的命中（0.3 × 0.88 ≈ 0.26 < 0.35）被拦下", async () => {
    const bare = row("c0000000-0000-4000-8000-000000000001", "Edited retriever.ts today: no vector on this row.", null);
    const { store } = fakeStore([ANSWER], [{ entry: bare, score: 0.88 }]);
    const out = await createRetriever(store as never, embedder, CFG).retrieve({ query: QUERY, limit: 5 });
    expect(ids(out)).toEqual([ANSWER.id]);
  });

  it("补偿条目过噪声过滤", async () => {
    const noise = row("d0000000-0000-4000-8000-000000000001", "I don't have any memory of retriever.ts", 0.9);
    const { store } = fakeStore([ANSWER], [{ entry: noise, score: 0.95 }]);
    const out = await createRetriever(store as never, embedder, CFG).retrieve({ query: QUERY, limit: 5 });
    expect(ids(out)).not.toContain(noise.id);
    expect(ids(out)[0]).toBe(ANSWER.id);
  });

  it("vector 池里已有的条目不重复补", async () => {
    const { store } = fakeStore([ANSWER], [{ entry: ANSWER, score: 0.9 }]);
    const out = await createRetriever(store as never, embedder, CFG).retrieve({ query: QUERY, limit: 5 });
    expect(ids(out)).toEqual([ANSWER.id]);
  });

  it("不含精确 token 的 query 不跑 BM25", async () => {
    const { store, calls } = fakeStore([ANSWER], EDITED.map((entry) => ({ entry, score: 0.88 })));
    await createRetriever(store as never, embedder, CFG).retrieve({ query: "how is length normalization computed", limit: 5 });
    expect(calls.bm25).toBe(0);
  });

  // hybrid 里 BM25-only 条目怎么融合（fuseResults 的 bm25 × 1.0）是 hybrid 自己的语义，这次不动；
  // 这里只钉住「finalize 之后不再另跑一遍补偿」。
  it("hybrid 路径不再在 finalize 之后另补：BM25 只在融合里跑一次", async () => {
    const { store, calls } = fakeStore([ANSWER], EDITED.map((entry) => ({ entry, score: 0.88 })));
    await createRetriever(store as never, embedder, { ...CFG, mode: "hybrid" }).retrieve({ query: QUERY, limit: 5 });
    expect(calls.bm25).toBe(1);
  });
});

describe("真实临时 LanceDB：带文件名的 query", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  it("vector 池放不下的三条「Edited retriever.ts」不排到答案前面", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "rn-exact-token-bm25-"));
    cleanup.push(dbPath);
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    // 4 条填充行把 vector 池（candidatePoolSize 5）和答案一起占满，三条 cosine 0.40 的只能经 BM25 进来
    const fillers = [0.62, 0.6, 0.58, 0.56].map((c, i) =>
      row(`f000000${i}-0000-4000-8000-000000000001`, `Unrelated note ${i} about scoring weights and recency decay.`, c),
    );
    for (const e of [ANSWER, ...fillers, ...EDITED]) await store.importEntry(e);
    await store.ready();
    expect(store.hasFtsSupport).toBe(true);

    // 记下真实 FTS 交给检索器的条目与 vector 池里的条目，证明三条「Edited」是经 BM25 到达的（不是空跑）
    const bm25Seen = new Set<string>();
    const vectorSeen = new Set<string>();
    const spied = Object.create(store) as MemoryStore;
    spied.bm25Search = async (...args: Parameters<MemoryStore["bm25Search"]>) => {
      const rs = await store.bm25Search(...args);
      for (const r of rs) bm25Seen.add(r.entry.id);
      return rs;
    };
    spied.vectorSearch = async (...args: Parameters<MemoryStore["vectorSearch"]>) => {
      const rs = await store.vectorSearch(...args);
      for (const r of rs) vectorSeen.add(r.entry.id);
      return rs;
    };

    const retriever = createRetriever(spied, embedder, { ...CFG, candidatePoolSize: 5, filterNoise: false });
    const out = await retriever.retrieve({ query: QUERY, limit: 5, scopeFilter: ["memory:test"] });

    for (const e of EDITED) {
      expect(bm25Seen.has(e.id)).toBe(true);
      expect(vectorSeen.has(e.id)).toBe(false);
    }
    expect(ids(out)[0]).toBe(ANSWER.id);
    // 前 3 名里一条「Edited retriever.ts」都没有（改动前正好是它们三条，答案落到第 4）
    for (const e of EDITED) expect(ids(out).slice(0, 3)).not.toContain(e.id);
  });
});
