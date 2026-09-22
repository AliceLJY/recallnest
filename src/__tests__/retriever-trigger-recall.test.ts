import { afterEach, describe, expect, it } from "bun:test";

import { createRetriever } from "../retriever.js";
import { buildStructuredMetadata } from "../capture-engine.js";

const LONG = "这条正文足够长，不会被噪声过滤当成碎片：讲的是 2026-07-25 那条不跑公开 benchmark 的否决，理由是那不是这个系统的分，优化出来的是别人的提取器。";

function entry(id: string, vector: number[], extra: Record<string, unknown> = {}) {
  const base = JSON.parse(buildStructuredMetadata({
    source: "manual",
    tags: ["pinned"],
    capture: "test",
    category: "events",
    canonicalKey: `key-${id}`,
  }));
  return {
    id,
    text: `${id} ${LONG}`,
    vector,
    category: "events" as const,
    scope: "memory:pivot",
    importance: 0.8,
    timestamp: Date.now() - 86_400_000,
    metadata: JSON.stringify({ ...base, ...extra }),
  };
}

const candA = entry("aaaaaaaa-0000-0000-0000-000000000001", [1, 0, 0]);
const hostB = entry("bbbbbbbb-0000-0000-0000-000000000002", [0, 1, 0]);
const hostC = entry("cccccccc-0000-0000-0000-000000000003", [0, 0, 1], { archived: true });
const hostD = entry("dddddddd-0000-0000-0000-000000000004", [0.5, 0.5, 0]);
hostD.scope = "project:elsewhere";

function makeRetriever(triggerSearch: () => Promise<unknown[]>) {
  const store = {
    hasFtsSupport: false,
    async vectorSearch() {
      return [{ entry: candA, score: 0.8 }];
    },
    async getById(id: string) {
      return [candA, hostB, hostC, hostD].find((e) => e.id === id) ?? null;
    },
    async hasId() {
      return true;
    },
  } as any;
  const embedder = {
    async embedQuery() {
      return [1, 0, 0];
    },
    async embedPassage() {
      return [1, 0, 0];
    },
  } as any;
  const retriever = createRetriever(store, embedder, {
    mode: "vector",
    rerank: "none",
    filterNoise: false,
    sourceDiversity: 0,
    hotnessWeight: 0,
    utilityWeight: 0,
  });
  retriever.setTriggerStore({ search: triggerSearch } as any);
  return retriever;
}

const HITS = [
  { memoryId: hostB.id, text: "别人的榜我们要不要也去排个名", cosine: 0.9, score: 0.9, scope: "memory:pivot" },
  { memoryId: hostC.id, text: "已归档的宿主", cosine: 0.9, score: 0.9, scope: "memory:pivot" },
  { memoryId: hostD.id, text: "别的 scope 的宿主", cosine: 0.9, score: 0.9, scope: "project:elsewhere" },
  { memoryId: candA.id, text: "已在候选里的宿主", cosine: 0.95, score: 0.95, scope: "memory:pivot" },
];

describe("T-Mem trigger recall（vector 路径）", () => {
  const original = process.env.RECALLNEST_TRIGGER_RECALL;
  afterEach(() => {
    if (original === undefined) delete process.env.RECALLNEST_TRIGGER_RECALL;
    else process.env.RECALLNEST_TRIGGER_RECALL = original;
  });

  it("不在候选里的宿主经 trigger 入池；已在候选的取 max 并记 sources.trigger；archived / 越 scope 的进不来", async () => {
    delete process.env.RECALLNEST_TRIGGER_RECALL;
    const retriever = makeRetriever(async () => HITS);
    const results = await retriever.retrieve({
      query: "腾讯那篇论文的榜我们要不要也去排个名",
      limit: 5,
      scopeFilter: ["memory:pivot"],
    });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain(hostB.id);
    expect(ids).not.toContain(hostC.id);
    expect(ids).not.toContain(hostD.id);

    const b = results.find((r) => r.entry.id === hostB.id)!;
    expect(b.sources.trigger?.text).toBe("别人的榜我们要不要也去排个名");
    expect(b.sources.vector).toBeUndefined(); // 纯靠 trigger 到达

    const a = results.find((r) => r.entry.id === candA.id)!;
    expect(a.sources.vector).toBeDefined();
    expect(a.sources.trigger?.cosine).toBe(0.95);
  });

  it("RECALLNEST_TRIGGER_RECALL=false 时行为与接线前完全一致", async () => {
    process.env.RECALLNEST_TRIGGER_RECALL = "false";
    const retriever = makeRetriever(async () => HITS);
    const results = await retriever.retrieve({ query: "任意", limit: 5, scopeFilter: ["memory:pivot"] });
    expect(results.map((r) => r.entry.id)).toEqual([candA.id]);
    expect(results[0].sources.trigger).toBeUndefined();
  });

  it("侧表查询抛错 → fail-open，主路径结果不受影响", async () => {
    delete process.env.RECALLNEST_TRIGGER_RECALL;
    const retriever = makeRetriever(async () => {
      throw new Error("lance exploded");
    });
    const results = await retriever.retrieve({ query: "任意", limit: 5, scopeFilter: ["memory:pivot"] });
    expect(results.map((r) => r.entry.id)).toEqual([candA.id]);
  });
});
