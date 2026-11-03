import { afterEach, describe, expect, it } from "bun:test";

import { persistMemory } from "../capture-engine.js";
import { buildDerivedBoundary } from "../consolidation-engine.js";
import type { Embedder } from "../embedder.js";
import { defaultEvolution, parseEvolution, patchEvolution } from "../memory-evolution.js";
import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { createRetriever, type RetrievalResultSet } from "../retriever.js";
import type { MemoryEntry } from "../store.js";
import { createToolHarness, fakeEmbedder, type ToolHarness } from "./helpers/mcp-tool-harness.js";

/**
 * 当前行为：未隔离。绿灯表示复现了缺口，不表示来源失效后的派生物已经安全。
 *
 * 复用 store-receipts 同类 harness：mkdtempSync 临时 LanceDB + 本地假向量；所有辅助路径也在临时目录。
 * 修订走 persistMemory（store_memory 共用路径），删除走真实 forget_memory handler、默认 cascadeMode=auto。
 * 派生物按 consolidation-engine 的入库形状登记，不调用 LLM；不声称验证了生产排名、brief 文件或模型错答。
 * sourceMemories 只保存 ID。保留修订前的快照，才能区分“基于 V1 的派生物”与同 ID 下的 V2。
 */

const SCOPE = "project:derived-source-invalidation-test";
const SOURCE_KEY = "entities:deployment-region";
const V1 = "The deployment region for the service is Singapore.";
const V2 = "The deployment region for the service is Frankfurt.";
const SOURCE_VECTOR = [1, 0, 0];
const DERIVED_VECTOR = [0.9, Math.sqrt(1 - 0.9 ** 2), 0];
const HEALTHY_VECTOR = [0, 0, 1];
const DERIVED_QUERY = "Which region should the deployment plan use?";
const HEALTHY_QUERY = "What is the unrelated backup retention policy?";
const harnesses: ToolHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()!.cleanup();
});

function harness() {
  const h = createToolHarness((deps) => registerAdvancedTools({
    ...deps,
    // memory-assets 的默认 pins 路径硬编码在生产 data/，不能只靠 RECALLNEST_DATA_DIR 隔离。
    // 本测试没有 pin 文件；显式注入空 pin 层，真实 primary / cascade / read-back 仍照常执行。
    forgetPins: { archiveForMemory: () => 0, countForMemory: () => 0 },
  }));
  harnesses.push(h);
  const embedder = {
    ...fakeEmbedder,
    embedQuery: async (query: string) => query === HEALTHY_QUERY ? HEALTHY_VECTOR : DERIVED_VECTOR,
  } as unknown as Embedder;
  const retriever = createRetriever(h.store, embedder, { mode: "vector", rerank: "none" });
  const recall = (query = DERIVED_QUERY) => retriever.retrieve({
    query,
    scopeFilter: [SCOPE],
    limit: 10,
    // 普通自动召回：不打开 includeArchived / includeExpired；避免异步访问计数影响快照与清理。
    source: "auto-recall",
  });
  return { ...h, recall };
}

type Harness = ReturnType<typeof harness>;

async function source(h: Harness, text = V1) {
  const saved = await persistMemory({
    store: h.store,
    embedder: { embedPassage: async () => SOURCE_VECTOR },
    noisePrototypeBank: null,
  }, {
    text, category: "entities", scope: SCOPE, canonicalKey: SOURCE_KEY,
    source: "manual", privacyTier: "durable", importance: 0.8,
  });
  expect(saved.disposition).toBe("stored");
  const entry = await h.store.getById(saved.id);
  expect(entry).not.toBeNull();
  expect(parseEvolution(entry!.metadata).version).toBe(1);
  return entry!;
}

async function revise(h: Harness, original: MemoryEntry) {
  const saved = await persistMemory({
    store: h.store,
    embedder: { embedPassage: async () => SOURCE_VECTOR },
    noisePrototypeBank: null,
  }, {
    text: V2, category: "entities", scope: SCOPE, canonicalKey: SOURCE_KEY,
    source: "manual", privacyTier: "durable", importance: 0.8,
  });
  expect(saved.disposition).toBe("updated");
  expect(saved.id).toBe(original.id);
  const current = await h.store.getById(saved.id);
  expect(current!.text).toBe(V2);
  expect(parseEvolution(current!.metadata)).toMatchObject({ status: "active", version: 2 });
  const history = (await h.store.list([SCOPE], undefined, 100, 0, "exact"))
    .filter((row) => row.id !== original.id && row.text === V1);
  expect(history).toHaveLength(1);
  expect(parseEvolution(history[0].metadata)).toMatchObject({ status: "superseded", version: 1 });
  return history[0];
}

async function derived(h: Harness, from: MemoryEntry, secondHop = false) {
  return h.store.store({
    text: secondHop
      ? "The disaster recovery plan assumes the service runs in Singapore."
      : "The rollout plan must provision the service in Singapore.",
    vector: DERIVED_VECTOR,
    category: "patterns",
    scope: SCOPE,
    importance: 0.8,
    metadata: JSON.stringify({
      ...(secondHop ? { cross_memory_pattern: true } : { cluster_insight: true }),
      boundary: buildDerivedBoundary("patterns"),
      evolution: { ...defaultEvolution(), sourceMemories: [from.id] },
      evidenceMemories: [from.id],
    }),
  });
}

async function healthy(h: Harness) {
  const row = await h.store.store({
    text: "The unrelated backup retention policy keeps snapshots for thirty days.",
    vector: HEALTHY_VECTOR,
    category: "events",
    scope: SCOPE,
    importance: 0.8,
    metadata: JSON.stringify({ evolution: defaultEvolution() }),
  });
  // 从库回读基线，避免 Arrow 的 float32 / 容器类型差异被误判成业务变更。
  const baseline = (await h.store.getById(row.id))!;
  expect((await h.recall(HEALTHY_QUERY))[0].entry.id).toBe(row.id);
  return baseline;
}

async function expectHealthy(h: Harness, baseline: MemoryEntry) {
  expect(await h.store.getById(baseline.id)).toEqual(baseline);
  expect((await h.recall(HEALTHY_QUERY))[0].entry.id).toBe(baseline.id);
}

function expectRecalled(results: RetrievalResultSet, entry: MemoryEntry, sourceId: string, rank = 2) {
  // 当前行为：未隔离。将来修复后应把此断言改成默认召回中不存在，不能把失败视作修复的回归。
  expect(results.findIndex((r) => r.entry.id === entry.id) + 1).toBe(rank);
  expect(results[rank - 1].entry.text).toBe(entry.text);
  expect(parseEvolution(results[rank - 1].entry.metadata)).toMatchObject({
    status: "active", version: 1, sourceMemories: [sourceId],
  });
}

describe("派生记忆来源失效：现状证据（绿色不代表缺口已修复）", () => {
  it("直接依赖修订 — 当前行为：未隔离；D 第 2 名，仍 active，且遮住同 ID 的 A V2", async () => {
    const h = harness();
    const a = await source(h);
    const d = await derived(h, a);
    const control = await healthy(h);
    expectRecalled(await h.recall(), d, a.id);

    const history = await revise(h, a);
    const results = await h.recall();
    expectRecalled(results, d, a.id);
    expect(results.map((r) => r.entry.id)).not.toContain(history.id);
    // cluster insight 去重按 sourceMemories 的 ID 覆盖来源，连修订后的 A V2 也会被压掉。
    expect(results.map((r) => r.entry.id)).not.toContain(a.id);
    await expectHealthy(h, control);
  }, 30_000);

  it("直接依赖删除 — 当前行为：未隔离；forget_memory 真删 A，D 降权后仍第 1 名且 active", async () => {
    const h = harness();
    const a = await source(h);
    const d = await derived(h, a);
    const control = await healthy(h);
    expectRecalled(await h.recall(), d, a.id);

    // 派生写入不登记为本会话用户写入，与 dream / consolidation 的当前入口一致。
    // 不传 skip / force 绕过 guard；不同 key 的派生物在默认 auto 路径中可降权、不会被隔离。
    const result = await h.call("forget_memory", { memoryId: a.id, confirm: true, scope: SCOPE });
    expect(result.isError).not.toBe(true);
    const receipt = result.content.map((c) => c.text).join("\n");
    expect(receipt).toContain("Read-back: gone");
    expect(receipt).toContain("Cascade demoted: 1 related memories");
    expect(await h.store.getById(a.id)).toBeNull();
    const remaining = (await h.store.getById(d.id))!;
    expect(remaining.importance).toBeLessThan(d.importance);
    const meta = JSON.parse(remaining.metadata!) as { cascade_forget: { forgottenId: string }[] };
    expect(meta.cascade_forget.map((item) => item.forgottenId)).toEqual([a.id.slice(0, 8)]);
    const results = await h.recall();
    expectRecalled(results, d, a.id, 1);
    expect(results.map((r) => r.entry.id)).not.toContain(a.id);
    await expectHealthy(h, control);
  }, 30_000);

  it("两层依赖修订 — 当前行为：未隔离；A → D1 → D2 中 D2 仍第 2 名且 active", async () => {
    const h = harness();
    const a = await source(h);
    const d1 = await derived(h, a);
    const d2 = await derived(h, d1, true);
    const control = await healthy(h);
    expectRecalled(await h.recall(), d2, d1.id);

    const history = await revise(h, a);
    const results = await h.recall();
    expectRecalled(results, d2, d1.id);
    expect(parseEvolution((await h.store.getById(d1.id))!.metadata)).toMatchObject({
      status: "active", sourceMemories: [a.id],
    });
    expect(results.map((r) => r.entry.id)).not.toContain(history.id);
    await expectHealthy(h, control);
  }, 30_000);

  it("迟到登记 — 当前行为：未隔离；A 已修订，基于旧快照登记的 D 仍第 2 名且 active", async () => {
    const h = harness();
    const aV1Snapshot = await source(h);
    const control = await healthy(h);
    const history = await revise(h, aV1Snapshot);
    // 登记 D 之前 V2 本来可以正常召回，排除“修订没生效”的假阳性。
    const before = await h.recall();
    expect(before[0].entry.id).toBe(aV1Snapshot.id);
    expect(before[0].entry.text).toBe(V2);
    expect(before.map((r) => r.entry.id)).not.toContain(history.id);
    expect(aV1Snapshot.text).toBe(V1);

    const d = await derived(h, aV1Snapshot);
    const results = await h.recall();
    expectRecalled(results, d, aV1Snapshot.id);
    expect(results.map((r) => r.entry.id)).not.toContain(aV1Snapshot.id);
    await expectHealthy(h, control);
  }, 30_000);

  it("隔离判据校准 — 当前行为：未隔离；pending_review 仍可召回，archived 才退出", async () => {
    const h = harness();
    const a = await source(h);
    const d = await derived(h, a);
    const control = await healthy(h);
    await revise(h, a);

    await h.store.update(d.id, { metadata: patchEvolution(d.metadata, { status: "pending_review" }) });
    const pending = await h.recall();
    expect(pending[1].entry.id).toBe(d.id);
    expect(parseEvolution(pending[1].entry.metadata).status).toBe("pending_review");
    await expectHealthy(h, control);

    await h.store.update(d.id, { metadata: patchEvolution(d.metadata, { status: "archived" }) });
    const archived = await h.recall();
    expect(archived.map((r) => r.entry.id)).not.toContain(d.id);
    expect(archived[0].entry.id).toBe(a.id);
    expect(archived[0].entry.text).toBe(V2);
    await expectHealthy(h, control);
  }, 30_000);
});
