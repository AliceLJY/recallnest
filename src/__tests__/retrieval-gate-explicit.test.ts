import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shouldSkipRetrieval, shouldSkipRetrievalFor } from "../adaptive-retrieval.js";
import { MemoryStore } from "../store.js";
import { createRetriever, type MemoryRetriever, type RetrievalContext } from "../retriever.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import { runKnownItemEval, type KnownItemCase } from "../known-item-eval.js";
import { buildStructuredMetadata } from "../capture-engine.js";

// 「琐碎查询」闸只管自动召回：人主动发起的查询（search_memory / CLI / HTTP）只跳过空串与纯空白。
// 下面这些都是 2026-10-17 体检里在显式查询上被闸掉、返回空的真实写法。
const EXPLICIT_QUERIES = ["git push 规则", "docker 部署方式", "test 基线多少", "#22", "2780", "lancedb lock", "jina v5", "push rules"];

const cleanupPaths: string[] = [];
afterEach(async () => {
  // 显式检索会异步写回访问计数；等它落地再删临时库，免得写回撞上已删的目录
  await new Promise((r) => setTimeout(r, 300));
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

describe("shouldSkipRetrievalFor", () => {
  it("显式查询（不带 source / manual / cli）不过琐碎查询闸", () => {
    for (const query of EXPLICIT_QUERIES) {
      expect(shouldSkipRetrievalFor({ query })).toBe(false);
      expect(shouldSkipRetrievalFor({ query, source: "manual" })).toBe(false);
      expect(shouldSkipRetrievalFor({ query, source: "cli" })).toBe(false);
    }
  });

  it("自动召回照旧过闸（反向校准：同一批查询原规则都判跳过）", () => {
    for (const query of EXPLICIT_QUERIES) {
      expect(shouldSkipRetrieval(query)).toBe(true);
      expect(shouldSkipRetrievalFor({ query, source: "auto-recall" })).toBe(true);
    }
    expect(shouldSkipRetrievalFor({ query: "ok", source: "auto-recall" })).toBe(true);
    expect(shouldSkipRetrievalFor({ query: "推送规则 git push", source: "auto-recall" })).toBe(false);
  });

  it("trivialQueryGate 显式给了就按它，两个方向都认", () => {
    expect(shouldSkipRetrievalFor({ query: "git push 规则", source: "auto-recall", trivialQueryGate: false })).toBe(false);
    expect(shouldSkipRetrievalFor({ query: "git push 规则", source: "manual", trivialQueryGate: true })).toBe(true);
  });

  it("空串与纯空白不管哪条路都跳过", () => {
    for (const query of ["", "   ", "\n\t"]) {
      expect(shouldSkipRetrievalFor({ query })).toBe(true);
      expect(shouldSkipRetrievalFor({ query, source: "auto-recall", trivialQueryGate: false })).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 真实临时 LanceDB：库里一条与查询方向一致的记忆，显式查询要搜得到
// ---------------------------------------------------------------------------

const SCOPE = "project:recallnest";
const MEMORY_ID = "0f0f0f0f-0000-4000-8000-000000000001";
const MEMORY_TEXT = "git push 只推 origin（AliceLJY/recallnest），绝对不要 push 到 upstream，那是上游公开仓库。";
const HIT_VEC = [1, 0, 0];
const embedQuery = async (text: string) => (EXPLICIT_QUERIES.includes(text) ? HIT_VEC : [0, 0, 1]);
const embedder = { embedQuery, embedPassage: embedQuery } as never;

const SIBLING_SCOPE = "project:sibling";
const SIBLING_ID = "0f0f0f0f-0000-4000-8000-000000000002";
const SIBLING_TEXT = "sibling 仓库同样只推 origin，不直接 push 上游，要给上游提 PR 走 fork。";

async function seededRetriever(): Promise<MemoryRetriever> {
  const dbPath = mkdtempSync(join(tmpdir(), "rn-gate-explicit-"));
  cleanupPaths.push(dbPath);
  const store = new MemoryStore({ dbPath, vectorDim: 3 });
  const rows = [
    { id: MEMORY_ID, text: MEMORY_TEXT, scope: SCOPE, key: "git-push-rule" },
    { id: SIBLING_ID, text: SIBLING_TEXT, scope: SIBLING_SCOPE, key: "git-push-rule-sibling" },
  ];
  for (const row of rows) {
    await store.importEntry({
      id: row.id,
      text: row.text,
      vector: HIT_VEC,
      category: "patterns",
      scope: row.scope,
      importance: 0.8,
      timestamp: Date.now() - 86_400_000,
      metadata: buildStructuredMetadata({ source: "manual", capture: "test", category: "patterns", canonicalKey: row.key }),
    });
  }
  await store.ready();
  return createRetriever(store, embedder, {
    mode: "vector",
    rerank: "none",
    filterNoise: false,
    sourceDiversity: 0,
    hotnessWeight: 0,
    utilityWeight: 0,
  });
}

describe("retrieve() on a real LanceDB", () => {
  it("显式查询搜得到；同一查询标 auto-recall 仍被闸掉；auto-recall 加 trivialQueryGate:false 搜得到", async () => {
    const retriever = await seededRetriever();
    for (const query of EXPLICIT_QUERIES) {
      const explicit = await retriever.retrieve({ query, limit: 5, scopeFilter: [SCOPE] });
      expect(explicit.map((r) => r.entry.id)).toEqual([MEMORY_ID]);
      const cli = await retriever.retrieve({ query, limit: 5, scopeFilter: [SCOPE], source: "cli" });
      expect(cli.map((r) => r.entry.id)).toEqual([MEMORY_ID]);
    }
    expect(await retriever.retrieve({ query: "git push 规则", limit: 5, scopeFilter: [SCOPE], source: "auto-recall" })).toEqual([]);
    const ungated = await retriever.retrieve({
      query: "git push 规则", limit: 5, scopeFilter: [SCOPE], source: "auto-recall", trivialQueryGate: false,
    });
    expect(ungated.map((r) => r.entry.id)).toEqual([MEMORY_ID]);
    expect(await retriever.retrieve({ query: "   ", limit: 5, scopeFilter: [SCOPE] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 经注册的 search_memory handler：主查询、跨 scope 回退、相关 scope 旁路
// ---------------------------------------------------------------------------

function searchHandler(retriever: MemoryRetriever, calls: RetrievalContext[], scopeRelations: Record<string, string[]> = {}) {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
  const recording = {
    retrieve(context: RetrievalContext) {
      calls.push(context);
      return retriever.retrieve(context);
    },
    setKGStore() {},
    setLLMClient() {},
  };
  registerCoreTools({
    registerTool(name: string, _description: string, _schema: unknown, handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) {
      handlers.set(name, handler);
    },
    getComponents() {
      return {
        store: {
          async vectorSearch() { return []; },
          async update() { return null; },
          async getById() { return null; },
          async stats() { return { totalCount: 1, scopeCounts: { [SCOPE]: 1 }, categoryCounts: {} }; },
        },
        embedder,
        retriever: recording,
        profile: { name: "default" },
        accessTracker: null,
        frequencyTracker: null,
        llm: null,
      };
    },
    config: {
      dbPath: "data/memory.lance",
      embedding: { provider: "openai-compatible", apiKey: "test", model: "test" },
      sources: {},
      scopeRelations,
    },
    checkpointStore: {},
    conflictStore: {},
    workflowObservationStore: {},
    toolDescriptions: new Map(),
    toolTiers: {},
    getKGExtractor: () => null,
    getKGStore: () => null,
  } as never);
  const handler = handlers.get("search_memory");
  if (!handler) throw new Error("search_memory not registered");
  return handler;
}

describe("search_memory handler", () => {
  it("命令开头的查询在指定 scope 里直接命中，不需要跨 scope 回退", async () => {
    const calls: RetrievalContext[] = [];
    const search = searchHandler(await seededRetriever(), calls);
    const out = await search({ query: "git push 规则", scope: SCOPE, limit: 5 });
    expect(out.content[0]?.text).toContain("只推 origin");
    expect(calls).toHaveLength(1);
  });

  it("跨 scope 回退同样不被闸掉", async () => {
    const calls: RetrievalContext[] = [];
    const search = searchHandler(await seededRetriever(), calls);
    const out = await search({ query: "#22", scope: "project:typo", limit: 5 });
    expect(calls).toHaveLength(2);
    expect(calls[1].scopeFilter).toBeUndefined();
    expect(out.content[0]?.text).toContain("只推 origin");
  });

  it("相关 scope 旁路标 auto-recall 只为不写库，琐碎查询闸关着", async () => {
    const calls: RetrievalContext[] = [];
    const search = searchHandler(await seededRetriever(), calls, { [SCOPE]: [SIBLING_SCOPE] });
    const out = await search({ query: "jina v5", scope: SCOPE, limit: 5, includeRelatedScopes: true });
    const sidecar = calls.find((c) => c.scopeFilter?.[0] === SIBLING_SCOPE);
    expect(sidecar?.source).toBe("auto-recall");
    expect(sidecar?.trivialQueryGate).toBe(false);
    expect(out.content[0]?.text).toContain("Related scope results");
    expect(out.content[0]?.text).toContain("sibling 仓库");
  });
});

// ---------------------------------------------------------------------------
// known-item eval：量的是显式搜的样子，入口不再把命令开头的问法单独跳过
// ---------------------------------------------------------------------------

describe("known-item eval", () => {
  it("命令开头的问法照常排名、不计入入口跳过；检索仍标 auto-recall（不写库）", async () => {
    const retriever = await seededRetriever();
    const seen: RetrievalContext[] = [];
    const recording = {
      retrieve(context: RetrievalContext) {
        seen.push(context);
        return retriever.retrieve(context);
      },
    };
    const cases: KnownItemCase[] = [
      { triggerId: `${MEMORY_ID}#0`, label: "0f0f0f0f#0", hostId: MEMORY_ID, scope: SCOPE, query: "git push 规则", scopeMismatch: false },
    ];
    const results = await runKnownItemEval(recording, cases, { limit: 5 });
    expect(results[0].rank).toBe(1);
    expect(results[0].gateSkipped).toBe(false);
    expect(seen[0].source).toBe("auto-recall");
  });
});
