import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { detectLang, tokenizeFts } from "../language-hook.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { expandQuery } from "../query-expander.js";
import { candidateAcceptor, explicitTimeRange, matchesPoolCriteria } from "../candidate-filter.js";
import { createRetriever, type RetrievalConfig } from "../retriever.js";
import { MemoryStore, type MemoryEntry, type MemorySearchResult } from "../store.js";

/**
 * 体检 #10（2026-10-17）：category / archived / superseded / topicTag / after-before 过滤挪到候选截断之前。
 * 向量腿多取 200 行、截到 ≤ 20 条交给评分链；过滤原先在截断之后才跑，前 20 条全不合格时返回 0 条。
 * 返回给评分链的仍是最多 20 条（不扩池，2026-08-22 否决记录），只是变成 20 条合格的。
 * 库一律是临时目录里的真实 LanceDB；嵌入是本地假向量，不调接口。
 */

const DIM = 64;
const QUERY_VEC = unit(0, 1);

/** cosine(row, query) = c; rows built on different axes have cosine c_i·c_j with each other (< MMR's 0.85). */
function unit(axis: number, c: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = c;
  if (axis > 0) v[axis] = Math.sqrt(1 - c * c);
  return v;
}

const tmpDirs: string[] = [];
function tempStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "rn-filter-trunc-"));
  tmpDirs.push(dir);
  return new MemoryStore({ dbPath: join(dir, "db"), vectorDim: DIM });
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const embedder = { embedQuery: async () => QUERY_VEC, embedPassage: async () => QUERY_VEC } as never;
const CONFIG: Partial<RetrievalConfig> = {
  mode: "vector", rerank: "none", filterNoise: false, sourceDiversity: 0, hotnessWeight: 0, utilityWeight: 0,
};
type StoreLike = ConstructorParameters<typeof import("../retriever.js").MemoryRetriever>[0];
const retrieverOf = (store: StoreLike) => createRetriever(store as MemoryStore, embedder, CONFIG);

const NOW = Date.now();
let seq = 0;
function row(overrides: Partial<MemoryEntry> & { vector: number[] }): MemoryEntry {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    text: `记录 ${seq}：部署流程里第 ${seq} 个步骤的详细说明`,
    category: "events",
    scope: "memory:pivot",
    importance: 0.6,
    timestamp: NOW,
    metadata: "{}",
    ...overrides,
  };
}

/** 20 rows closer to the query than anything else (cosine 0.99 → 0.95), all events, all active. */
function closeCrowd(overrides: (i: number) => Partial<MemoryEntry> = () => ({})): MemoryEntry[] {
  return Array.from({ length: 20 }, (_, i) => row({ vector: unit(i + 1, 0.99 - i * 0.002), ...overrides(i) }));
}

/** A store whose vectorSearch drops the filter argument — i.e. the store as it was before this change. */
function withoutStoreFilter(store: MemoryStore): StoreLike {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "vectorSearch") {
        return (v: number[], l?: number, m?: number, s?: string[], mode?: never, ex?: string[]) =>
          target.vectorSearch(v, l, m, s, mode, ex);
      }
      if (prop === "bm25Search") {
        return (q: string, l?: number, s?: string[], ex?: string[]) => target.bm25Search(q, l, s, ex);
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as StoreLike;
}

/** importEntry keeps id and timestamp (storeBatch stamps Date.now()). */
async function put(store: MemoryStore, rows: MemoryEntry[]): Promise<void> {
  for (const r of rows) await store.importEntry(r);
}

const ids = (rs: MemorySearchResult[]) => rs.map(r => r.entry.id);

describe("category filter runs before the candidate cut", () => {
  it("a preferences row ranked 21st is found by category=preferences (repro: 20 closer events → 0 hits)", async () => {
    const store = tempStore();
    const target = row({ vector: unit(40, 0.93), category: "preferences", text: "偏好：部署前先跑全量测试再推送" });
    await put(store, [...closeCrowd(), target]);

    // Calibration: the 20-row pool is all events, so the target is not even fetched without the push-down.
    expect(ids(await store.vectorSearch(QUERY_VEC, 20, 0.1)).includes(target.id)).toBe(false);

    const results = await retrieverOf(store).retrieve({ query: "部署", limit: 5, category: "preferences", source: "auto-recall" });
    expect(ids(results)).toEqual([target.id]);
  });

  it("store.vectorSearch pushes category into the query and bm25Search does too", async () => {
    const store = tempStore();
    const crowd = closeCrowd(i => ({ text: `deploy deploy deploy rollout step ${i}` }));
    const target = row({ vector: unit(40, 0.93), category: "preferences", text: "prefer to deploy after the full test run" });
    await put(store, [...crowd, target]);
    const viaStore = await store.vectorSearch(QUERY_VEC, 20, 0.1, undefined, undefined, undefined, { category: "preferences" });
    expect(ids(viaStore)).toEqual([target.id]);

    await store.ready();
    expect(store.hasFtsSupport).toBe(true);
    // Calibration: BM25 has no over-fetch; the 5 strongest "deploy" matches are all events.
    expect(ids(await store.bm25Search("deploy", 5)).includes(target.id)).toBe(false);
    expect(ids(await store.bm25Search("deploy", 5, undefined, undefined, { category: "preferences" }))).toEqual([target.id]);
  });

  it("the category condition is in the SQL: 210 closer events exceed the 200-row over-fetch and the target still comes back", async () => {
    const store = tempStore();
    const flood = Array.from({ length: 210 }, (_, i) => row({ vector: unit((i % 60) + 1, 0.99 - i * 0.0001) }));
    const target = row({ vector: unit(61, 0.9), category: "preferences" });
    await store.storeBatch([...flood, target]);
    // Calibration: the target is not among the 200 rows fetched without the push-down.
    expect(ids(await store.vectorSearch(QUERY_VEC, 20, 0.1, undefined, undefined, undefined, { accept: e => e.category === "preferences" }))).toEqual([]);
    expect(ids(await store.vectorSearch(QUERY_VEC, 20, 0.1, undefined, undefined, undefined, { category: "preferences" }))).toEqual([target.id]);
  });
});

describe("archived / superseded rows do not take candidate slots", () => {
  it("an active row behind 20 superseded history rows is returned (repro: → 0 hits)", async () => {
    const store = tempStore();
    const history = closeCrowd(i => ({
      text: `旧版本 ${i}：部署脚本先停服再更新`,
      metadata: JSON.stringify({ evolution: { status: "superseded", supersededBy: "current" } }),
    }));
    const current = row({ vector: unit(40, 0.93), text: "当前版本：部署脚本滚动更新、不停服" });
    await put(store, [...history, current]);

    expect(ids(await store.vectorSearch(QUERY_VEC, 20, 0.1)).includes(current.id)).toBe(false);

    const results = await retrieverOf(store).retrieve({ query: "部署脚本", limit: 5, source: "auto-recall" });
    expect(ids(results)).toEqual([current.id]);
  });

  it("archived-flag rows are skipped the same way, and includeArchived still returns them", async () => {
    const store = tempStore();
    const archived = closeCrowd(() => ({ metadata: JSON.stringify({ archived: true }) }));
    const live = row({ vector: unit(40, 0.93), text: "仍然有效的部署记录" });
    await put(store, [...archived, live]);

    const active = await retrieverOf(store).retrieve({ query: "部署", limit: 5, source: "auto-recall" });
    expect(ids(active)).toEqual([live.id]);
    const all = await retrieverOf(store).retrieve({ query: "部署", limit: 5, includeArchived: true, source: "auto-recall" });
    expect(ids(all)).not.toContain(live.id);
    expect(all.length).toBe(5);
  });
});

describe("topicTag and explicit time window filter the pool, not the cut result", () => {
  it("topicTag=deploy finds a target ranked 19th with limit 15 (repro: → 0 hits)", async () => {
    const store = tempStore();
    const rows = Array.from({ length: 25 }, (_, i) => row({
      vector: unit(i + 1, 0.99 - i * 0.004),
      metadata: JSON.stringify({ topicTag: i === 18 ? "deploy" : "testing" }),
    }));
    const target = rows[18];
    await put(store, rows);

    // Calibration: without the filter the target is 19th — inside the pool, outside limit 15.
    const unfiltered = await retrieverOf(store).retrieve({ query: "部署", limit: 20, source: "auto-recall" });
    expect(ids(unfiltered).indexOf(target.id)).toBe(18);

    const results = await retrieverOf(store).retrieve({ query: "部署", limit: 15, topicTag: "Deploy", source: "auto-recall" });
    expect(ids(results)).toEqual([target.id]);
  });

  it("the retriever filters its pool before finalize even when the store ignores the filter argument", async () => {
    const store = tempStore();
    const rows = Array.from({ length: 25 }, (_, i) => row({
      vector: unit(i + 1, 0.99 - i * 0.004),
      metadata: JSON.stringify({ topicTag: i === 18 ? "deploy" : "testing" }),
    }));
    await put(store, rows);
    const results = await retrieverOf(withoutStoreFilter(store)).retrieve({ query: "部署", limit: 15, topicTag: "deploy", source: "auto-recall" });
    expect(ids(results)).toEqual([rows[18].id]);
  });

  it("topicTag reaches past the 20-row pool through the store loop (target ranked 30th)", async () => {
    const store = tempStore();
    const rows = Array.from({ length: 35 }, (_, i) => row({
      vector: unit(i + 1, 0.99 - i * 0.004),
      metadata: JSON.stringify({ topicTag: i === 29 ? "deploy" : "testing" }),
    }));
    await put(store, rows);
    const results = await retrieverOf(store).retrieve({ query: "部署", limit: 5, topicTag: "deploy", source: "auto-recall" });
    expect(ids(results)).toEqual([rows[29].id]);
  });

  it("an after= window finds a newer row behind 20 closer old rows", async () => {
    const store = tempStore();
    const old = closeCrowd(() => ({ timestamp: Date.parse("2025-01-01T00:00:00Z") }));
    const recent = row({ vector: unit(40, 0.93), timestamp: Date.parse("2026-06-01T00:00:00Z") });
    await put(store, [...old, recent]);
    const results = await retrieverOf(store).retrieve({
      query: "部署", limit: 5, timeRange: explicitTimeRange("2026-01-01"), source: "auto-recall",
    });
    expect(ids(results)).toEqual([recent.id]);
  });

  it("explicitTimeRange keeps the old after/before parsing rules", () => {
    expect(explicitTimeRange()).toBeUndefined();
    expect(explicitTimeRange("最近30天")).toBeUndefined();
    expect(explicitTimeRange("2026-01-01")).toMatchObject({ type: "after", startMs: Date.parse("2026-01-01") });
    expect(explicitTimeRange(undefined, "2026-01-01")).toMatchObject({ type: "before", endMs: Date.parse("2026-01-01") });
    expect(explicitTimeRange("2026-01-01", "2026-02-01")).toMatchObject({ type: "range" });
    const range = explicitTimeRange("2026-01-01", "2026-02-01")!;
    expect(matchesPoolCriteria({ metadata: "{}", timestamp: Date.parse("2026-01-15") }, { timeRange: range })).toBe(true);
    expect(matchesPoolCriteria({ metadata: "{}", timestamp: Date.parse("2026-03-01") }, { timeRange: range })).toBe(false);
  });

  it("candidateAcceptor: inactive / archived / tag mismatch rejected, includeArchived lets status through", () => {
    const e = (metadata: string): MemoryEntry => ({ id: "x", text: "t", vector: [], category: "events", scope: "s", importance: 0.5, timestamp: NOW, metadata });
    const accept = candidateAcceptor({});
    expect(accept(e("{}"))).toBe(true);
    expect(accept(e("not json"))).toBe(true);
    expect(accept(e(JSON.stringify({ evolution: { status: "pending_review" } })))).toBe(true);
    expect(accept(e(JSON.stringify({ evolution: { status: "superseded" } })))).toBe(false);
    expect(accept(e(JSON.stringify({ evolution: { status: "consolidated" } })))).toBe(false);
    expect(accept(e(JSON.stringify({ archived: true })))).toBe(false);
    expect(candidateAcceptor({ includeArchived: true })(e(JSON.stringify({ archived: true })))).toBe(true);
    expect(candidateAcceptor({ topicTag: "deploy" })(e(JSON.stringify({ topicTag: "DEPLOY" })))).toBe(true);
    expect(candidateAcceptor({ topicTag: "deploy" })(e("{}"))).toBe(false);
  });
});

describe("exact-token BM25 supplements (vector path) go through the same pool filter", () => {
  // BM25 has no over-fetch (it reads max(limit, 5) rows), so a metadata filter can only choose among those
  // rows. What the filter buys is the 3 supplement slots: without it they go to untagged rows that the pool
  // filter then drops, and a tagged row ranked behind them never gets in.
  it("topicTag gives the supplement slots to a tagged BM25-only row ranked behind 4 untagged ones", async () => {
    const store = tempStore();
    // 210 closer untagged rows fill the 200-row vector over-fetch, so the target is reachable only via BM25.
    const crowd = Array.from({ length: 210 }, (_, i) => row({ vector: unit((i % 60) + 1, 0.99 - i * 0.0001), text: `部署笔记 ${i}` }));
    // The distractors match both query terms, the target only one. Ties between near-identical rows break
    // differently across platforms (owner's macOS ranked the target top 3 when everything matched one term),
    // so the ordering below is a matching-terms gap, not a tie.
    const QUERY = "retriever.ts zebrafold";
    const loud = Array.from({ length: 4 }, (_, i) => row({
      vector: unit(62, 0.3), text: `zebrafold helper ${i} lives in retriever.ts next to the ranking code`,
    }));
    const target = row({
      vector: unit(63, 0.3),
      text: "rollout sequencing notes for the weekly release train, written down after the incident review and kept beside retriever.ts so that the ordering of staged canaries, database migrations and cache warmups stays documented",
      metadata: JSON.stringify({ topicTag: "deploy" }),
    });
    await store.storeBatch([...crowd, ...loud, target]);
    await store.ready();
    expect(store.hasFtsSupport).toBe(true);

    // Order-independent precondition: these 5 rows are the only BM25 matches, so the supplement's 5-row read is
    // exactly them and the target is always inside it.
    const ftsQuery = tokenizeFts(expandQuery(QUERY), detectLang(QUERY));
    const read = await store.bm25Search(ftsQuery, 5);
    expect(new Set(ids(read))).toEqual(new Set([...loud.map(r => r.id), target.id]));
    // Calibration for the reverse check only (not asserted — BM25 scores of near-identical rows are platform-
    // dependent): without the pool filter the 3 supplement slots should all go to distractors.
    const rank = ids(read).indexOf(target.id);
    if (rank < 3) {
      console.warn(
        `[retrieval-filter-before-truncation] BM25 ranked the target #${rank + 1} of 5 on this platform; ` +
        `this case still checks the result but cannot catch a supplement that skips the pool filter here. ` +
        `scores: ${read.map(r => `${r.entry.id === target.id ? "target" : "distractor"}=${r.score.toFixed(3)}`).join(" ")}`,
      );
    }

    const results = await retrieverOf(store).retrieve({
      query: QUERY, limit: 5, topicTag: "deploy", source: "auto-recall",
    });
    expect(ids(results)).toEqual([target.id]);
  });
});

describe("hybrid mode uses the same pre-cut filters", () => {
  const hybridOf = (store: MemoryStore) => createRetriever(store, embedder, { ...CONFIG, mode: "hybrid" });

  it("category and superseded repros also hold in hybrid mode", async () => {
    const store = tempStore();
    const history = closeCrowd(i => ({
      text: `old rollout note ${i}`,
      metadata: JSON.stringify({ evolution: { status: "superseded" } }),
    }));
    const current = row({ vector: unit(40, 0.93), text: "current rollout note: rolling update" });
    const pref = row({ vector: unit(41, 0.92), category: "preferences", text: "preference: rollout after tests" });
    await put(store, [...history, current, pref]);
    await store.ready();
    expect(store.hasFtsSupport).toBe(true);

    const active = await hybridOf(store).retrieve({ query: "rollout", limit: 5, source: "auto-recall" });
    expect(ids(active).sort()).toEqual([current.id, pref.id].sort());
    const prefs = await hybridOf(store).retrieve({ query: "rollout", limit: 5, category: "preferences", source: "auto-recall" });
    expect(ids(prefs)).toEqual([pref.id]);
  });
});

describe("queries without filters are unchanged", () => {
  it("top N (ids and scores) equal the pre-change store's when no filter applies and the pool has no inactive rows", async () => {
    const store = tempStore();
    const rows = Array.from({ length: 40 }, (_, i) => row({
      vector: unit(i + 1, 0.99 - i * 0.005),
      category: (["events", "preferences", "cases", "entities"] as const)[i % 4],
      importance: 0.4 + (i % 5) * 0.1,
      timestamp: NOW - i * 86_400_000,
    }));
    // Inactive rows exist in the table but rank below the 20-row pool, so they never reached it anyway.
    const deep = Array.from({ length: 5 }, (_, i) => row({
      vector: unit(50 + i, 0.5), metadata: JSON.stringify({ evolution: { status: "superseded" } }),
    }));
    await put(store, [...rows, ...deep]);

    for (const limit of [5, 10, 20]) {
      const now = await retrieverOf(store).retrieve({ query: "部署", limit, source: "auto-recall" });
      const before = await retrieverOf(withoutStoreFilter(store)).retrieve({ query: "部署", limit, source: "auto-recall" });
      expect(now.length).toBe(limit);
      // Scores to 6 places: the recency term reads Date.now(), which moves a few ms between the two calls.
      const shape = (rs: MemorySearchResult[]) => rs.map(r => [r.entry.id, r.score.toFixed(6)]);
      expect(shape(now)).toEqual(shape(before));
    }
  });
});

describe("search_memory passes topicTag / after / before to the retriever's pool", () => {
  type Handler = (input: unknown) => Promise<{ content: Array<{ text: string }> }>;
  function searchTool(store: MemoryStore): (input: Record<string, unknown>) => Promise<string> {
    const tools = new Map<string, { schema: z.ZodRawShape; handler: Handler }>();
    const retriever = retrieverOf(store);
    registerCoreTools({
      registerTool(name: string, _d: string, schema: z.ZodRawShape, handler: Handler) { tools.set(name, { schema, handler }); },
      getComponents: () => ({ retriever, profile: { name: "default" }, store, embedder, llm: null }),
      config: {},
      checkpointStore: { async listRecent() { return []; } },
      workflowObservationStore: { async save() {}, async listRecent() { return []; } },
      toolDescriptions: new Map(),
      toolTiers: {},
      getKGExtractor: () => null,
      getKGStore: () => null,
    } as never);
    const tool = tools.get("search_memory")!;
    return async (input) => (await tool.handler(z.object(tool.schema).parse(input))).content.map(c => c.text).join("\n");
  }

  it("after= returns the newer row behind 20 closer old rows, and topicTag returns at most `limit` hits", async () => {
    const store = tempStore();
    const old = closeCrowd(i => ({
      timestamp: Date.parse("2025-01-01T00:00:00Z"),
      metadata: JSON.stringify({ topicTag: "deploy" }),
      text: `旧部署记录 ${i}`,
    }));
    const recent = row({ vector: unit(40, 0.93), timestamp: Date.parse("2026-06-01T00:00:00Z"), text: "新部署记录：滚动更新" });
    await put(store, [...old, recent]);
    const search = searchTool(store);

    const afterOut = await search({ query: "部署", limit: 3, scope: "memory:pivot", after: "2026-01-01" });
    expect(afterOut).toContain("新部署记录：滚动更新");
    expect(afterOut).not.toContain("旧部署记录");

    // topicTag no longer asks the retriever for limit×3 (that over-ask returned up to 3× the hits asked for).
    const tagOut = await search({ query: "部署", limit: 2, scope: "memory:pivot", topicTag: "deploy", detail_level: "brief" });
    expect(tagOut.match(/旧部署记录 \d+/g)?.length).toBe(2);
  });
});
