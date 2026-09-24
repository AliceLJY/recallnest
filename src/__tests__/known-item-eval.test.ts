import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, loadLanceDB } from "../store.js";
import { TriggerStore, TRIGGER_TABLE_NAME } from "../trigger-store.js";
import { createRetriever } from "../retriever.js";
import { buildStructuredMetadata } from "../capture-engine.js";
import {
  ageBucket,
  buildKnownItemCases,
  compareKnownItemRuns,
  formatKnownItemComparison,
  formatKnownItemSummary,
  loadKnownItemCases,
  popularityBucket,
  runKnownItemEval,
  summarizeKnownItem,
  type KnownItemHost,
  type KnownItemHostRow,
  type KnownItemResult,
} from "../known-item-eval.js";

const cleanupPaths: string[] = [];
afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

const DAY = 86_400_000;
const LONG = "这条正文足够长，不会被噪声过滤当成碎片：讲的是否决把两个记忆库合成一个的那次判断，理由是两边的真相源不同、合并只会让写入路径变成两套。";

function hostRow(id: string, extra: Partial<KnownItemHostRow> & { meta?: Record<string, unknown> } = {}): KnownItemHostRow {
  const { meta, ...rest } = extra;
  return {
    id,
    scope: "memory:pivot",
    category: "patterns",
    importance: 0.8,
    timestamp: Date.now() - DAY,
    metadata: JSON.stringify(meta ?? {}),
    text: LONG,
    ...rest,
  };
}

describe("buildKnownItemCases", () => {
  it("每条 trigger 一个用例；宿主不存在 / 非 active / archived 的剔除并记原因；按宿主 scope 查并标出不一致", () => {
    const triggers = [
      { id: "aaaaaaaa-1#0", memoryId: "aaaaaaaa-1", scope: "memory:pivot", text: "问法一" },
      { id: "aaaaaaaa-1#1", memoryId: "aaaaaaaa-1", scope: "memory:pivot", text: "问法二" },
      { id: "bbbbbbbb-2#0", memoryId: "bbbbbbbb-2", scope: "memory:pivot", text: "归档了的" },
      { id: "cccccccc-3#0", memoryId: "cccccccc-3", scope: "memory:pivot", text: "被取代了的" },
      { id: "dddddddd-4#0", memoryId: "dddddddd-4", scope: "memory:pivot", text: "宿主没了的" },
      { id: "__schema__", memoryId: "__schema__", scope: "__schema__", text: "" },
      { id: "eeeeeeee-5#0", memoryId: "eeeeeeee-5", scope: "memory:pivot", text: "宿主挪了 scope 的" },
    ];
    const hosts = [
      hostRow("aaaaaaaa-1"),
      hostRow("bbbbbbbb-2", { meta: { archived: true } }),
      hostRow("cccccccc-3", { meta: { evolution: { status: "superseded" } } }),
      hostRow("eeeeeeee-5", { scope: "memory" }),
    ];
    const load = buildKnownItemCases(triggers, hosts);
    expect(load.triggerRows).toBe(6);
    expect(load.cases.map((c) => c.label)).toEqual(["aaaaaaaa#0", "aaaaaaaa#1", "eeeeeeee#0"]);
    expect(load.cases[0].query).toBe("问法一");
    const moved = load.cases.find((c) => c.hostId === "eeeeeeee-5")!;
    expect(moved.scope).toBe("memory");
    expect(moved.scopeMismatch).toBe(true);
    expect(load.cases[0].scopeMismatch).toBe(false);
    expect(load.skipped).toEqual([
      { triggerId: "bbbbbbbb-2#0", reason: "host-inactive" },
      { triggerId: "cccccccc-3#0", reason: "host-inactive" },
      { triggerId: "dddddddd-4#0", reason: "host-missing" },
    ]);
    expect([...load.hosts.keys()].sort()).toEqual(["aaaaaaaa-1", "eeeeeeee-5"]);
    expect(load.hosts.get("aaaaaaaa-1")!.textLength).toBe(LONG.length);
  });
});

describe("summarizeKnownItem", () => {
  const now = Date.UTC(2026, 8, 25);
  const hosts = new Map<string, KnownItemHost>(
    [0.5, 2, 5, 10, 40].map((days, i) => [
      `h${i}`,
      { id: `h${i}`, scope: "memory:pivot", category: "patterns", importance: 0.8, timestamp: now - days * DAY, textLength: 100 },
    ]),
  );
  const result = (i: number, rank: number | null, extra: Partial<KnownItemResult> = {}): KnownItemResult => ({
    triggerId: `h${i}#0`,
    label: `h${i}#0`,
    hostId: `h${i}`,
    scope: "memory:pivot",
    rank,
    score: rank === null ? null : 0.8,
    top1: "x",
    top1Score: 0.9,
    returned: 20,
    saturatedAbove: 0,
    gateSkipped: false,
    scopeMismatch: false,
    ...extra,
  });
  const results = [
    result(0, 1, { top1Score: 1 }),
    result(1, 2, { top1Score: 1 }),
    result(2, 5),
    result(3, 12),
    result(4, null, { gateSkipped: true, returned: 0, top1: null, top1Score: null }),
  ];
  const multiplier: Record<string, number> = { h0: 1, h1: 1.2, h2: 1.5, h3: 1, h4: 1 };

  it("总体、按存入天数、按宿主自身频次倍数分组，入口跳过单独计数", () => {
    const s = summarizeKnownItem(results, hosts, { now, limit: 20, freqMultiplier: (id) => multiplier[id] });
    expect(s.overall).toEqual({ n: 5, at1: 1, at3: 2, at10: 3, atLimit: 4, notInWindow: 1, gateSkipped: 1 });
    expect(Object.keys(s.byAge)).toEqual(["a) ≤1 天", "b) 1–3 天", "c) 3–7 天", "d) 7–30 天", "e) >30 天"]);
    expect(s.byAge["d) 7–30 天"].at10).toBe(0);
    expect(s.byPopularity!["a) ×1.0"]).toEqual({ n: 3, at1: 1, at3: 1, at10: 1, atLimit: 2, notInWindow: 1, gateSkipped: 1 });
    expect(s.byPopularity!["b) ×1.0–1.3"].at3).toBe(1);
    expect(s.byPopularity!["c) >×1.3"].at10).toBe(1);
    expect(s.top1Saturated).toBe(2);
    expect(formatKnownItemSummary(s)).toContain("第 1 1/5（20%）");
  });

  it("不给频次倍数就不分热度组", () => {
    expect(summarizeKnownItem(results, hosts, { now, limit: 20 }).byPopularity).toBeUndefined();
  });

  it("分组边界", () => {
    expect(ageBucket(1)).toBe("a) ≤1 天");
    expect(ageBucket(1.01)).toBe("b) 1–3 天");
    expect(ageBucket(30)).toBe("d) 7–30 天");
    expect(ageBucket(30.5)).toBe("e) >30 天");
    expect(popularityBucket(1)).toBe("a) ×1.0");
    expect(popularityBucket(1.3)).toBe("b) ×1.0–1.3");
    expect(popularityBucket(1.31)).toBe("c) >×1.3");
  });
});

describe("compareKnownItemRuns", () => {
  it("按 triggerId 对齐，列出救回、掉出第 1、进出前 10；用例集不一致的单列", () => {
    const row = (id: string, rank: number | null) => ({ triggerId: id, label: id, rank });
    const before = [row("x#0", 1), row("y#0", 3), row("z#0", 1), row("w#0", 11), row("v#0", 2)];
    const after = [row("x#0", 1), row("y#0", 1), row("z#0", 4), row("w#0", 9), row("u#0", 1)];
    const c = compareKnownItemRuns(before, after);
    expect(c.shared).toBe(4);
    expect(c.rescued.map((r) => r.triggerId)).toEqual(["y#0"]);
    expect(c.lost).toEqual([{ triggerId: "z#0", label: "z#0", before: 1, after: 4 }]);
    expect(c.enteredTop10.map((r) => r.triggerId)).toEqual(["w#0"]);
    expect(c.leftTop10).toEqual([]);
    expect(c.onlyBefore).toEqual(["v#0"]);
    expect(c.onlyAfter).toEqual(["u#0"]);
    expect(c.at1).toEqual({ before: 2, after: 2 });
    expect(formatKnownItemComparison(c)).toContain("z#0：1 → 4");
  });
});

// ---------------------------------------------------------------------------
// 真实临时 LanceDB：端到端名次 + 只读（表版本号不变），并用 source:"manual" 反向校准这条检查
// ---------------------------------------------------------------------------

const QUERY = "两个记忆库要不要合成一个";
const QUERY_VEC = [1, 0, 0];
const embedQuery = async (text: string) => (text === QUERY ? QUERY_VEC : [0.33, 0.33, 0.33]);
const embedder = { embedQuery, embedPassage: embedQuery } as never;

function entry(id: string, vector: number[], extra: Record<string, unknown> = {}) {
  const base = JSON.parse(
    buildStructuredMetadata({ source: "manual", tags: ["pinned"], capture: "test", category: "patterns", canonicalKey: `key-${id}` }),
  );
  return {
    id,
    text: `${id} ${LONG}`,
    vector,
    category: "patterns" as const,
    scope: "memory:pivot",
    importance: 0.8,
    timestamp: Date.now() - DAY,
    metadata: JSON.stringify({ ...base, ...extra }),
  };
}

async function tableVersions(dbPath: string): Promise<Record<string, number>> {
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(dbPath);
  const out: Record<string, number> = {};
  for (const name of await db.tableNames()) out[name] = await (await db.openTable(name)).version();
  return out;
}

describe("known-item eval on a real LanceDB", () => {
  const originalTrigger = process.env.RECALLNEST_TRIGGER_RECALL;
  afterEach(() => {
    if (originalTrigger === undefined) delete process.env.RECALLNEST_TRIGGER_RECALL;
    else process.env.RECALLNEST_TRIGGER_RECALL = originalTrigger;
  });

  it("经 trigger 到达的宿主排第 1；跑完两张表版本号不变；同一检索换成 manual 版本号会变（证明这条检查抓得到写入）", async () => {
    delete process.env.RECALLNEST_TRIGGER_RECALL;
    const dbPath = mkdtempSync(join(tmpdir(), "rn-known-item-"));
    cleanupPaths.push(dbPath);
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    const triggers = new TriggerStore({ dbPath, vectorDim: 3 });

    const host = entry("0bd50a9b-0000-4000-8000-000000000001", [0, 0, 1]);
    const near = entry("0e0e0e0e-0000-4000-8000-000000000002", [0.8, 0.6, 0]);
    const archived = entry("0a0a0a0a-0000-4000-8000-000000000003", [0, 1, 0], { archived: true });
    for (const e of [host, near, archived]) await store.importEntry(e);
    const embedMany = async (texts: string[]) => Promise.all(texts.map(embedQuery));
    await triggers.upsertForMemory(host.id, "memory:pivot", [QUERY], embedMany);
    await triggers.upsertForMemory(archived.id, "memory:pivot", ["归档那条的问法"], embedMany);

    const retriever = createRetriever(store, embedder, {
      mode: "vector",
      rerank: "none",
      filterNoise: false,
      sourceDiversity: 0,
      hotnessWeight: 0,
      utilityWeight: 0,
    });
    retriever.setTriggerStore(triggers);
    await store.ready();
    await triggers.ready();

    const load = await loadKnownItemCases(dbPath);
    expect(load.cases.map((c) => c.hostId)).toEqual([host.id]);
    expect(load.skipped).toEqual([{ triggerId: `${archived.id}#0`, reason: "host-inactive" }]);

    const before = await tableVersions(dbPath);
    const results = await runKnownItemEval(retriever, load.cases, { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].rank).toBe(1);
    expect(results[0].gateSkipped).toBe(false);
    await new Promise((r) => setTimeout(r, 300)); // 访问计数写回是异步的，给它时间——若真写了就会在这之前落地
    expect(await tableVersions(dbPath)).toEqual(before);
    const hostAfter = await store.getById(host.id);
    expect(JSON.parse(hostAfter!.metadata || "{}").evolution?.accessCount ?? 0).toBe(0);

    // 反向校准：同一条检索用 manual，retriever 会写回访问计数，memories 版本号应当变
    await retriever.retrieve({ query: QUERY, limit: 5, scopeFilter: ["memory:pivot"], source: "manual" });
    let changed = false;
    for (let i = 0; i < 60 && !changed; i++) {
      await new Promise((r) => setTimeout(r, 50));
      changed = (await tableVersions(dbPath)).memories !== before.memories;
    }
    expect(changed).toBe(true);
  });

  it("库里没有 trigger 侧表时返回空用例，而且不建表", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "rn-known-item-empty-"));
    cleanupPaths.push(dbPath);
    const store = new MemoryStore({ dbPath, vectorDim: 3 });
    await store.importEntry(entry("0c0c0c0c-0000-4000-8000-000000000009", [0, 0, 1]));
    const load = await loadKnownItemCases(dbPath);
    expect(load.cases).toEqual([]);
    expect(load.triggerRows).toBe(0);
    const lancedb = await loadLanceDB();
    expect(await (await lancedb.connect(dbPath)).tableNames()).not.toContain(TRIGGER_TABLE_NAME);
  });
});
