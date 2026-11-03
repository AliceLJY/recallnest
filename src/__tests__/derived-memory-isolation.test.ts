import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistMemory, type PersistMemoryDeps } from "../capture-engine.js";
import { clusterAndConsolidate, isDerivedInsight } from "../consolidation-engine.js";
import { forgetMemory } from "../forget-engine.js";
import { extractBoundaryMetadata } from "../memory-boundaries.js";
import { isActiveMemory, parseEvolution } from "../memory-evolution.js";
import { buildPromoteScanDeps, scanSynthesisPromotions, type SynthesisPromoteScanResult } from "../memory-promotion.js";
import { createRetriever } from "../retriever.js";
import { MemoryStore, type MemoryEntry } from "../store.js";
import type { SynthesisVerdict } from "../synthesis-contract.js";

/**
 * 派生记忆隔离验证（2026-11-03，sync-bridge `AI产出/2026-11-03-派生记忆隔离验证/`）。
 *
 * 问题：一条派生记忆（dream 写的 cluster insight D1，以及 promote_synthesis 从它复制出的 durable 副本 D2）
 * 的来源被修订或删除之后，它还会不会被当成当前事实召回？
 *
 * 全部走真实路径：临时 LanceDB + persistMemory（store_memory 的写入通道，同 canonicalKey 即修订）
 * + clusterAndConsolidate（dream 3b，LLM 换成固定回答）+ scanSynthesisPromotions/promoteMemory
 * + forgetMemory + createRetriever。向量是手写的 4 维假向量：第 0 维「部署」、第 3 维「番茄」。
 *
 * 召回分两种配置看（`recall` 的第二个参数）：
 * - prod：生产 MCP 的 mcp.env，RECALLNEST_LAYER_ADMISSION=on、MIN=2。派生物 D1 在 evidence 层，
 *   结论层命中够 2 条时被滤掉；不够时整池回退。
 * - off：关掉层准入。它同时就是 prod 在「结论层命中不足 2 条」时的回退形态（applyLayerAdmission 原样返回）。
 *   本夹具里 prod 永远凑得够 2 条，回退形态用 off 来看。
 *
 * 每个场景另有一簇不相关的健康记录（番茄 H1–H3）和它自己的派生物（DH，以及晋升出的 DH2）做对照。
 *
 * 断言分两种：
 * - 普通 `it`：钉住现状（含缺口本身），以及健康对照不受影响。
 * - `it.failing`：写的是「应当隔离」的性质。现状下它们按预期失败——这就是缺口的红证据，CI 仍是绿的。
 *   哪天修好了，`it.failing` 会因为断言通过而报错，那时把它改成普通 `it`，同时改掉对应的现状断言。
 */

const SCOPE = "project:derived-isolation-test";
const tmpDirs: string[] = [];
const savedEnv = {
  admission: process.env.RECALLNEST_LAYER_ADMISSION,
  admissionMin: process.env.RECALLNEST_LAYER_ADMISSION_MIN,
};

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  restoreEnv("RECALLNEST_LAYER_ADMISSION", savedEnv.admission);
  restoreEnv("RECALLNEST_LAYER_ADMISSION_MIN", savedEnv.admissionMin);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const A_V1 = "部署一律在 MacBook 上执行 deploy 脚本，mini 只负责跑 bot，不在 mini 上部署任何服务。";
const A_V2 = "部署改为一律在 mini 上执行 deploy 脚本，MacBook 只当随身终端，不再在 MacBook 上部署。";
const B = "部署前必须先跑完整测试套件，任何一项红了都不许继续部署，测试日志要留在本机。";
const C = "部署脚本统一放在 scripts 目录，改动部署脚本要先在临时目录演练一遍再提交。";
const H1 = "阳台上的番茄每周浇两次水就够，浇多了根会烂，这是去年夏天淹死三棵之后改的做法。";
const H2 = "番茄开花后要追一次磷钾肥，氮肥太多只长叶子不结果，追肥后隔三天再浇水。";
const H3 = "番茄长到一米高要搭架子绑枝，侧芽每周掐一次，不掐就会长成一大丛不结果。";

/** 假 LLM 依据的结论：读到哪一版 A，就照哪一版写。 */
const D_FROM_V1 = "部署流程：在 MacBook 上执行 deploy 脚本，部署前先跑完整测试，脚本改动先演练。";
const D_FROM_V2 = "部署流程：在 mini 上执行 deploy 脚本，部署前先跑完整测试，脚本改动先演练。";
const DH = "番茄照料：每周浇两次水、开花后追磷钾肥、一米高搭架并每周掐侧芽。";

/** 只有依据 A 第一版写出来的文本才含这一句（A_V2 写的是「在 mini 上执行」）。 */
const STALE_MARK = "在 MacBook 上执行";

const Q_DEPLOY = "部署应该在哪台机器上执行";
const Q_TOMATO = "番茄多久浇一次水";

const VECTORS: Record<string, number[]> = {
  [A_V1]: [1, 0, 0, 0],
  [A_V2]: [1, 0, 0, 0],
  [B]: [0.85, 0.5, 0.15, 0],
  [C]: [0.85, 0.15, 0.5, 0],
  [D_FROM_V1]: [0.9, 0.3, 0.3, 0],
  [D_FROM_V2]: [0.9, 0.3, 0.3, 0],
  [H1]: [0, 0, 0, 1],
  [H2]: [0, 0.15, 0, 0.99],
  [H3]: [0, 0, 0.15, 0.99],
  [DH]: [0, 0.1, 0.1, 0.99],
  [Q_DEPLOY]: [1, 0, 0, 0],
  [Q_TOMATO]: [0, 0, 0, 1],
};

/** 夹具外的文本一律报错：宁可测试挂掉，也不要拿一个默认向量悄悄算出没意义的分数。 */
async function vec(text: string): Promise<number[]> {
  const v = VECTORS[text];
  if (!v) throw new Error(`fixture has no vector for: ${text.slice(0, 40)}`);
  return v;
}

const embedder = { embedPassage: vec, embedQuery: vec };

interface FakeLlmHooks {
  /** 在 LLM「思考」期间执行（模拟 dream 合成调用在途时，别的进程修订了来源）。 */
  duringInsightCall?: () => Promise<void>;
}

function fakeLlm(hooks: FakeLlmHooks = {}) {
  return {
    async synthesizeClusterInsight(texts: string[]): Promise<SynthesisVerdict> {
      await hooks.duringInsightCall?.();
      if (texts.some((t) => t.includes("番茄"))) {
        return { status: "ok", output: { text: DH, evidence: [1, 2, 3] } };
      }
      const text = texts.includes(A_V2) ? D_FROM_V2 : D_FROM_V1;
      return { status: "ok", output: { text, evidence: [1, 2, 3] } };
    },
    async synthesizeClusterPattern(): Promise<SynthesisVerdict> {
      return { status: "abstained" };
    },
  };
}

type Label = "A" | "B" | "C" | "H1" | "H2" | "H3" | "D1" | "D2" | "DH" | "DH2";
const HEALTH_LABELS: readonly string[] = ["H1", "H2", "H3", "DH", "DH2"];

interface Hit {
  rank: number;
  label: string;
  status: string;
  layer: string;
  stale: boolean;
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "rn-derived-isolation-"));
  tmpDirs.push(dir);
  const store = new MemoryStore({ dbPath: join(dir, "db"), vectorDim: 4 });
  const deps: PersistMemoryDeps = { store, embedder, noisePrototypeBank: null };
  const ids = {} as Record<Label, string>;
  const labels = new Map<string, Label>();
  const name = (label: Label, id: string) => {
    ids[label] = id;
    labels.set(id, label);
  };

  const write = async (label: Label, text: string, key: string) => {
    const rec = await persistMemory(deps, { text, category: "events", scope: SCOPE, canonicalKey: key, importance: 0.8 });
    expect(rec.disposition).toBe("stored");
    name(label, rec.id);
  };

  /** store_memory 同 canonicalKey 再写一次 = 修订（原 id 原地覆盖，旧文本另存成 superseded 历史行）。 */
  const reviseA = async () => {
    const rec = await persistMemory(deps, { text: A_V2, category: "events", scope: SCOPE, canonicalKey: "deploy-host", importance: 0.8 });
    expect(rec.id).toBe(ids.A);
    return Date.now();
  };

  /** 照 dream-pipeline 的 gather：取活跃行、回填向量、排除派生物，再交给 clusterAndConsolidate。 */
  const gather = async (): Promise<MemoryEntry[]> => {
    const rows = (await store.list([SCOPE], undefined, 100, 0, "exact"))
      .filter((e) => isActiveMemory(e.metadata) && !isDerivedInsight(e.metadata));
    const vectors = await store.getVectors(rows.map((e) => e.id));
    return rows.map((e) => ({ ...e, vector: vectors.get(e.id) ?? [] }));
  };

  /** dream 3b，参数取生产 DEFAULT_DREAM_CONFIG（minClusterSize 3、semanticClusterThreshold 0.68）。 */
  const dream = async (entries: MemoryEntry[], hooks: FakeLlmHooks = {}) => {
    const result = await clusterAndConsolidate({
      entries,
      embedder,
      llm: fakeLlm(hooks) as never,
      store,
      scope: SCOPE,
      minClusterSize: 3,
      clusterThreshold: 0.68,
      extractPatterns: false,
    });
    expect(result.insightsGenerated).toBe(2);
    const derived = (await store.list([SCOPE], undefined, 100, 0, "exact")).filter((e) => isDerivedInsight(e.metadata));
    for (const d of derived) name(d.text.startsWith("番茄") ? "DH" : "D1", d.id);
  };

  /** promote_synthesis(dryRun=false)，走 MCP 工具同一个 buildPromoteScanDeps → promoteMemory。 */
  const promote = async (): Promise<SynthesisPromoteScanResult> => {
    const result = await scanSynthesisPromotions(buildPromoteScanDeps({ ...deps, store }), SCOPE, { dryRun: false });
    for (const c of result.candidates) {
      if (c.promoted) name(labels.get(c.seedId) === "DH" ? "DH2" : "D2", c.promoted.id);
    }
    return result;
  };

  const retriever = createRetriever(store, embedder as never, {
    mode: "vector",
    rerank: "none",
    filterNoise: false,
    hardMinScore: 0.38,
    sourceDiversity: 0,
    hotnessWeight: 0,
    utilityWeight: 0,
  });

  const recall = async (query: string, admission: "off" | "prod"): Promise<Hit[]> => {
    process.env.RECALLNEST_LAYER_ADMISSION = admission === "prod" ? "on" : "off";
    process.env.RECALLNEST_LAYER_ADMISSION_MIN = "2";
    const results = await retriever.retrieve({ query, limit: 10, scopeFilter: [SCOPE], source: "auto-recall", trivialQueryGate: false });
    return results.map((r, rank) => ({
      rank,
      label: labels.get(r.entry.id) ?? "?",
      status: parseEvolution(r.entry.metadata).status,
      layer: extractBoundaryMetadata(r.entry.metadata)?.layer ?? "-",
      stale: r.entry.text.includes(STALE_MARK),
    }));
  };

  const row = async (label: Label) => {
    const e = await store.getById(ids[label]);
    if (!e) return null;
    const evo = parseEvolution(e.metadata);
    const meta = JSON.parse(e.metadata || "{}") as Record<string, unknown>;
    return {
      text: e.text,
      importance: e.importance,
      status: evo.status,
      version: evo.version,
      sourceMemories: evo.sourceMemories,
      consolidatedInto: evo.consolidatedInto,
      validFrom: evo.validFrom,
      layer: extractBoundaryMetadata(e.metadata)?.layer ?? "-",
      promotedFrom: (meta.promotedFrom as { memoryId?: string } | undefined)?.memoryId ?? null,
    };
  };

  /** 健康对照：番茄簇各行的正文 / 重要度 / 状态 / 版本，以及番茄问题里健康行之间的先后。 */
  const healthSnapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const label of HEALTH_LABELS as Label[]) {
      if (!ids[label]) continue;
      const r = await row(label);
      rows[label] = r && { text: r.text, importance: r.importance, status: r.status, version: r.version };
    }
    const order = async (mode: "off" | "prod") =>
      (await recall(Q_TOMATO, mode)).filter((h) => HEALTH_LABELS.includes(h.label)).map((h) => `${h.label}:${h.status}`);
    return { rows, tomatoOff: await order("off"), tomatoProd: await order("prod") };
  };

  const seed = async () => {
    await write("A", A_V1, "deploy-host");
    await write("B", B, "deploy-tests-first");
    await write("C", C, "deploy-script-rehearsal");
    await write("H1", H1, "tomato-water");
    await write("H2", H2, "tomato-fertilizer");
    await write("H3", H3, "tomato-stake");
  };

  return { store, ids, labels, reviseA, gather, dream, promote, recall, row, healthSnapshot, seed };
}

type Harness = ReturnType<typeof harness>;

/** 测试输出里留一行可读的召回表，作为结论的原始证据（`*` = 文本是依据 A 第一版写的）。 */
function show(title: string, hits: Hit[]): void {
  console.log(`[${title}] ${hits.map((h) => `${h.rank}:${h.label}${h.stale ? "*" : ""}(${h.status}/${h.layer})`).join("  ")}`);
}

const labelsOf = (hits: Hit[]) => hits.map((h) => h.label);

// ---------------------------------------------------------------------------
// 场景搭建（现状断言与 it.failing 共用）
// ---------------------------------------------------------------------------

/** 场景 1：A → D1（dream），然后修订 A。 */
async function scenario1() {
  const h = harness();
  await h.seed();
  await h.dream(await h.gather());
  const health = await h.healthSnapshot();
  await h.reviseA();
  return { h, health };
}

/** 场景 2：A → D1，然后 forget_memory(A)（默认 cascadeMode=auto）。 */
async function scenario2() {
  const h = harness();
  await h.seed();
  await h.dream(await h.gather());
  const health = await h.healthSnapshot();
  const forgot = await forgetMemory({ store: h.store }, { memoryId: h.ids.A, confirm: true, reason: "isolation test" });
  expect(forgot.success).toBe(true);
  return { h, health, forgot };
}

/** 场景 3：A → D1 → D2（promote_synthesis 晋升成 durable 副本），然后修订 A。 */
async function scenario3() {
  const h = harness();
  await h.seed();
  await h.dream(await h.gather());
  const promoted = await h.promote();
  expect(promoted.promoted).toBe(2);
  const health = await h.healthSnapshot();
  await h.reviseA();
  return { h, health };
}

/** 场景 4a：dream 取料之后、合成结果写库之前，A 被修订（迟到登记：依赖在来源改完之后才写下）。 */
async function scenario4a() {
  const h = harness();
  await h.seed();
  const snapshot = await h.gather();
  let revisedAt = 0;
  await h.dream(snapshot, {
    duringInsightCall: async () => {
      if (!revisedAt) revisedAt = await h.reviseA();
    },
  });
  return { h, revisedAt };
}

/** 场景 4b：D1 已生成，A 被修订之后才跑 promote_synthesis（迟到登记：晋升这条依赖在来源改完之后才写下）。 */
async function scenario4b() {
  const h = harness();
  await h.seed();
  await h.dream(await h.gather());
  await h.reviseA();
  const promoted = await h.promote();
  return { h, promoted };
}

async function expectHealthUnchanged(h: Harness, before: Awaited<ReturnType<Harness["healthSnapshot"]>>) {
  expect(await h.healthSnapshot()).toEqual(before);
}

// ---------------------------------------------------------------------------
// 现状
// ---------------------------------------------------------------------------

describe("现状：来源修订或删除后，派生记忆仍按当前事实参与召回", () => {
  it("场景 1 直接依赖：修订 A 后 D1 原样保持 active，回退形态下只剩 D1、新版 A 被去重藏掉", async () => {
    const { h, health } = await scenario1();

    const a = await h.row("A");
    expect(a?.text).toBe(A_V2);
    expect(a?.version).toBe(2);
    // 原地修订把 A 指向 D1 的正向链接清掉了，反向链接（D1.sourceMemories）还在
    expect(a?.consolidatedInto).toBeNull();

    const d1 = await h.row("D1");
    expect(d1?.status).toBe("active");
    expect(d1?.text).toContain(STALE_MARK);
    expect(d1?.sourceMemories).toContain(h.ids.A);

    const off = await h.recall(Q_DEPLOY, "off");
    show("S1 修订后 off/回退", off);
    expect(off[0]).toMatchObject({ label: "D1", stale: true, status: "active" });
    expect(labelsOf(off)).not.toContain("A");

    const prod = await h.recall(Q_DEPLOY, "prod");
    show("S1 修订后 prod", prod);
    expect(labelsOf(prod)).toContain("A");
    expect(labelsOf(prod)).not.toContain("D1");
    expect(prod.filter((x) => x.stale)).toEqual([]);

    await expectHealthUnchanged(h, health);
  }, 60_000);

  it("场景 2 删除来源：forget A 后 D1 仍 active、只按相似度降权，同簇健康兄弟 B / C 一起被降", async () => {
    const { h, health, forgot } = await scenario2();

    expect(await h.row("A")).toBeNull();
    const d1 = await h.row("D1");
    expect(d1?.status).toBe("active");
    expect(d1?.sourceMemories).toContain(h.ids.A); // 悬空指针，没有任何地方去读它
    expect(d1?.importance).toBeLessThan(0.8);
    expect(d1?.importance).toBeGreaterThan(0.5);
    // 级联是向量相似度降权：内容仍然成立的 B、C 和派生物 D1 吃的是同一种处理
    const demoted = new Set(forgot.cascadeResult?.demotedIds ?? []);
    expect([...demoted].map((id) => h.labels.get(id)).sort()).toEqual(["B", "C", "D1"]);

    const off = await h.recall(Q_DEPLOY, "off");
    show("S2 删除后 off/回退", off);
    expect(off[0]).toMatchObject({ label: "D1", stale: true, status: "active" });

    const prod = await h.recall(Q_DEPLOY, "prod");
    show("S2 删除后 prod", prod);
    expect(labelsOf(prod)).not.toContain("D1");

    await expectHealthUnchanged(h, health);

    // 之后再跑 promote_synthesis：D1 没被晋升，原因只是降权后 importance 恰好落到 0.6 以下，
    // 不是因为发现它的来源没了（B、C 两条活证据已够 minDistinctEvidence=2）。
    const promoted = await h.promote();
    expect(promoted.skipped.below_importance).toBe(1);
    expect(promoted.skipped.evidence_unresolvable).toBe(0);
    expect(promoted.candidates.map((c) => h.labels.get(c.seedId))).toEqual(["DH"]);
  }, 60_000);

  it("场景 3 两层依赖：修订 A 后 durable 副本 D2 照样进生产配置的召回，与新版 A 并列", async () => {
    const { h, health } = await scenario3();

    const d2 = await h.row("D2");
    expect(d2).toMatchObject({ status: "active", layer: "durable", promotedFrom: h.ids.D1, sourceMemories: [] });
    expect(d2?.text).toContain(STALE_MARK);
    expect((await h.row("D1"))?.status).toBe("active");

    const prod = await h.recall(Q_DEPLOY, "prod");
    show("S3 修订后 prod", prod);
    expect(labelsOf(prod)).toContain("A");
    expect(prod.find((x) => x.label === "D2")).toMatchObject({ stale: true, status: "active", layer: "durable" });

    const off = await h.recall(Q_DEPLOY, "off");
    show("S3 修订后 off/回退", off);
    expect(off[0]).toMatchObject({ label: "D2", stale: true });
    expect(labelsOf(off)).not.toContain("A");

    await expectHealthUnchanged(h, health);
  }, 60_000);

  it("场景 4a 迟到登记（dream 在途）：依据旧版写成的 D1 在修订之后才落库，时间戳比修订还新", async () => {
    const { h, revisedAt } = await scenario4a();

    expect(revisedAt).toBeGreaterThan(0);
    const d1 = await h.row("D1");
    expect(d1?.text).toContain(STALE_MARK);
    expect(d1?.status).toBe("active");
    expect(d1?.sourceMemories).toContain(h.ids.A);
    // 「来源修订时间晚于派生物」这种按时间比较的判据在这条路径上判不出来
    expect(d1?.validFrom ?? 0).toBeGreaterThanOrEqual(revisedAt);
    // 新版 A 反倒挂上了指向这条旧结论的 consolidatedInto
    expect((await h.row("A"))?.consolidatedInto).toBe(h.ids.D1);

    const off = await h.recall(Q_DEPLOY, "off");
    show("S4a off/回退", off);
    expect(off[0]).toMatchObject({ label: "D1", stale: true });
  }, 60_000);

  it("场景 4b 迟到登记（晋升）：A 修订之后跑 promote_synthesis，A 仍算活证据，旧结论被晋升成 durable", async () => {
    const { h, promoted } = await scenario4b();

    const d1Candidate = promoted.candidates.find((c) => h.labels.get(c.seedId) === "D1");
    expect(d1Candidate?.evidenceIds).toContain(h.ids.A);
    const d2 = await h.row("D2");
    expect(d2).toMatchObject({ status: "active", layer: "durable", promotedFrom: h.ids.D1 });
    expect(d2?.text).toContain(STALE_MARK);

    const prod = await h.recall(Q_DEPLOY, "prod");
    show("S4b prod", prod);
    expect(prod.find((x) => x.label === "D2")).toMatchObject({ stale: true, status: "active" });
  }, 60_000);

  it("场景 5a 下一轮 dream（没晋升过）：簇成员不变，D1 按确定性 id 原地重写成新版", async () => {
    const { h } = await scenario1();
    const d1Id = h.ids.D1;
    const second = await h.gather();
    expect(second.map((e) => h.labels.get(e.id)).sort()).toEqual(["A", "B", "C", "H1", "H2", "H3"]);
    await h.dream(second);
    // cluster insight 的 id = deterministicId(scope, 排序后的来源 id)，来源 id 没变就原地覆盖
    expect(h.ids.D1).toBe(d1Id);
    expect((await h.row("D1"))?.text).toBe(D_FROM_V2);
    const off = await h.recall(Q_DEPLOY, "off");
    show("S5a 重跑 dream 后 off/回退", off);
    expect(off.filter((x) => x.stale)).toEqual([]);
  }, 60_000);

  it("场景 5b 下一轮 dream（晋升过）：D2 被当成原始素材重新聚类，旧 D1 留着不变，D2 也不变", async () => {
    const { h } = await scenario3();
    const d1Id = h.ids.D1;
    const second = await h.gather();
    // 晋升出的 durable 副本没有 cluster_insight / cross_memory_pattern 标记，dream 取料不排除它
    expect(second.map((e) => h.labels.get(e.id)).sort()).toEqual(["A", "B", "C", "D2", "DH2", "H1", "H2", "H3"]);
    await h.dream(second);

    const derived = (await h.store.list([SCOPE], undefined, 100, 0, "exact")).filter((e) => isDerivedInsight(e.metadata));
    const deploy = derived.filter((e) => e.text.startsWith("部署"));
    expect(deploy).toHaveLength(2);
    // 旧 D1 原样留着：簇成员多了 D2，排序后的来源 id 变了，新结论落在另一个 id 上
    const oldD1 = deploy.find((e) => e.id === d1Id);
    expect(oldD1?.text).toBe(D_FROM_V1);
    expect(isActiveMemory(oldD1?.metadata)).toBe(true);
    // 新结论的来源里有 D2——总结的总结
    const newer = deploy.find((e) => e.id !== d1Id);
    expect(parseEvolution(newer?.metadata).sourceMemories).toContain(h.ids.D2);

    expect((await h.row("D2"))).toMatchObject({ status: "active" });
    expect((await h.row("D2"))?.text).toContain(STALE_MARK);
    const prod = await h.recall(Q_DEPLOY, "prod");
    show("S5b 重跑 dream 后 prod", prod);
    expect(prod.find((x) => x.label === "D2")).toMatchObject({ stale: true, status: "active" });
  }, 60_000);
  it("对照：来源没被动过时，修订一条无关记录不影响派生物与它的晋升（健康簇 DH / DH2 全程不变）", async () => {
    const { h, health } = await scenario3();
    const dh = await h.row("DH");
    const dh2 = await h.row("DH2");
    expect(dh).toMatchObject({ status: "active", layer: "evidence", text: DH });
    expect(dh2).toMatchObject({ status: "active", layer: "durable", promotedFrom: h.ids.DH, text: DH });
    const tomato = await h.recall(Q_TOMATO, "prod");
    show("对照 番茄 prod", tomato);
    // 假向量下正交的行在 LanceDB 里也有约 0.41 分（过 hardMinScore 0.38），部署簇会混进番茄问题的尾部；
    // 这里只看健康行自己：evidence 层的 DH 被层准入滤掉，其余四行都在、都还是 active。
    const healthHits = tomato.filter((x) => HEALTH_LABELS.includes(x.label));
    expect(healthHits.map((x) => x.label).sort()).toEqual(["DH2", "H1", "H2", "H3"]);
    expect(healthHits.every((x) => x.status === "active")).toBe(true);
    await expectHealthUnchanged(h, health);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 应当隔离（现状下按预期失败）
// ---------------------------------------------------------------------------

describe("应当隔离：来源失效后，依据旧版本的派生物退出普通召回", () => {
  it.failing("场景 1：修订 A 后，回退形态下召回里出现新版 A、不出现仍为 active 的 D1", async () => {
    const { h } = await scenario1();
    const off = await h.recall(Q_DEPLOY, "off");
    expect(labelsOf(off)).toContain("A");
    expect(off.filter((x) => x.stale)).toEqual([]);
  }, 60_000);

  it.failing("场景 2：forget A 后，依赖 A 的 D1 不再是 active", async () => {
    const { h } = await scenario2();
    expect((await h.row("D1"))?.status).not.toBe("active");
  }, 60_000);

  it.failing("场景 3：修订 A 后，生产配置召回里没有依据旧版的 durable 副本 D2", async () => {
    const { h } = await scenario3();
    const prod = await h.recall(Q_DEPLOY, "prod");
    expect(prod.filter((x) => x.stale)).toEqual([]);
  }, 60_000);

  it.failing("场景 4a：取料后来源被修订，合成结果不以 active 落库", async () => {
    const { h } = await scenario4a();
    expect((await h.row("D1"))?.status).not.toBe("active");
  }, 60_000);

  it.failing("场景 4b：修订过的来源不算晋升证据，旧结论不被晋升", async () => {
    const { h, promoted } = await scenario4b();
    expect(promoted.candidates.map((c) => h.labels.get(c.seedId))).not.toContain("D1");
  }, 60_000);
});
