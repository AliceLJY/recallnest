/**
 * Known-item eval —— 用 trigger 原话搜自己的宿主，量「宿主排第几」。
 *
 * 每条 trigger（memory_triggers 侧表的一行）天然是一条「问法 → 目标 id」的已知条目查询，零人工标注。
 * 它只回答一件事：一条记忆被它自己写下的问法问到时，能不能排在最前面。量不了答案质量——
 * 单一目标、查询就是 trigger 原文（余弦 1.0 的上限情形），不能拿来代替答案质量的判官。
 *
 * 来由：2026-09-24 诊断（open-loops「RecallNest 检索评分链」症状 C）：trigger 并入后 99% 的宿主
 * 已排第 1，打分链走完只剩 38%，名次被流行度信号拿走。本模块是改评分链时 shadow 判据的一部分。
 *
 * 只读约定：
 * - 读侧表与主表只用 query()，侧表不存在就返回空，绝不建表（TriggerStore.ensureInitialized 会建表，这里不用它）；
 * - 检索一律 source:"auto-recall"——retriever 里三处强化写入（频次台账、evolution 访问计数、AccessTracker）
 *   都以 source !== "auto-recall" 为条件，跑多少遍都不改库；
 * - 报告只含 id 与数字，不含 trigger 原文（原文是她的口语问法，不进仓库、不进报告）。
 * 审计日志不归这里管：调用方（eval/known-item.ts）负责把 retriever 的 audit logger 换成空实现。
 */

import { loadLanceDB } from "./store.js";
import { TRIGGER_TABLE_NAME } from "./trigger-store.js";
import { isActiveMemory } from "./memory-evolution.js";
import { shouldSkipRetrieval } from "./adaptive-retrieval.js";
import { matchesScopeFilter } from "./scope-policy.js";
import type { RetrievalContext, RetrievalResult } from "./retriever.js";

const MEMORY_TABLE_NAME = "memories";
const DAY_MS = 86_400_000;
/** 分数被 clamp01 截平在 1.0 的判定线（打分链每一环都 clamp，1.0 并列时按稳定排序定先后）。 */
const SATURATED_SCORE = 0.9999;

export interface KnownItemTriggerRow {
  id: string;
  memoryId: string;
  scope: string;
  text: string;
}

export interface KnownItemHostRow {
  id: string;
  scope: string;
  category: string;
  importance: number;
  timestamp: number;
  metadata?: string;
  text: string;
}

export interface KnownItemHost {
  id: string;
  scope: string;
  category: string;
  importance: number;
  timestamp: number;
  textLength: number;
}

export interface KnownItemCase {
  /** trigger 行 id（`<宿主 id>#<序号>`），比较两次运行时按它对齐 */
  triggerId: string;
  /** 报告里显示的短名：`<宿主 id 前 8 位>#<序号>` */
  label: string;
  query: string;
  hostId: string;
  /** 按宿主所在 scope 检索（search_memory 带 scope 时就是这么查的） */
  scope: string;
  /** trigger 行记的 scope 与宿主 scope 不一致（按宿主 scope 查时，这条 trigger 自己过不了 scope 过滤） */
  scopeMismatch: boolean;
}

export type KnownItemSkipReason = "host-missing" | "host-inactive";

export interface KnownItemLoad {
  cases: KnownItemCase[];
  hosts: Map<string, KnownItemHost>;
  triggerRows: number;
  skipped: Array<{ triggerId: string; reason: KnownItemSkipReason }>;
}

export interface KnownItemResult {
  triggerId: string;
  label: string;
  hostId: string;
  scope: string;
  /** 宿主在返回结果里的名次（1 起）；不在返回窗口里为 null */
  rank: number | null;
  score: number | null;
  top1: string | null;
  top1Score: number | null;
  returned: number;
  /** 排在宿主前面、分数被截平在 1.0 的条数（宿主不在窗口里时数整个窗口） */
  saturatedAbove: number;
  /** 检索入口 shouldSkipRetrieval 判成琐碎查询、整条跳过（这不是排序问题，单独计数） */
  gateSkipped: boolean;
  scopeMismatch: boolean;
}

export interface KnownItemCounts {
  n: number;
  at1: number;
  at3: number;
  at10: number;
  atLimit: number;
  notInWindow: number;
  gateSkipped: number;
}

export interface KnownItemSummary {
  limit: number;
  overall: KnownItemCounts;
  byAge: Record<string, KnownItemCounts>;
  byPopularity?: Record<string, KnownItemCounts>;
  /** 第 1 名终分恰好被截平在 1.0 的查询数 */
  top1Saturated: number;
  scopeMismatch: number;
}

// ---------------------------------------------------------------------------
// 构建用例（纯函数）
// ---------------------------------------------------------------------------

function parseMeta(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function triggerIndex(triggerId: string): string {
  const i = triggerId.lastIndexOf("#");
  return i >= 0 ? triggerId.slice(i + 1) : "0";
}

/**
 * 把 trigger 行与宿主行配成用例。宿主不存在、非 active（superseded / consolidated 等）或 archived 的剔除——
 * 它们本来就不该被检索到，算进来只会把「资格被正确拦下」误记成召回失败。
 */
export function buildKnownItemCases(
  triggerRows: readonly KnownItemTriggerRow[],
  hostRows: readonly KnownItemHostRow[],
): KnownItemLoad {
  const hostById = new Map(hostRows.map((h) => [h.id, h]));
  const hosts = new Map<string, KnownItemHost>();
  const cases: KnownItemCase[] = [];
  const skipped: KnownItemLoad["skipped"] = [];
  const rows = triggerRows
    .filter((t) => t.memoryId && t.memoryId !== "__schema__")
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const t of rows) {
    const host = hostById.get(t.memoryId);
    if (!host) {
      skipped.push({ triggerId: t.id, reason: "host-missing" });
      continue;
    }
    const meta = parseMeta(host.metadata);
    if (!isActiveMemory(host.metadata) || meta.archived === true) {
      skipped.push({ triggerId: t.id, reason: "host-inactive" });
      continue;
    }
    hosts.set(host.id, {
      id: host.id,
      scope: host.scope,
      category: host.category,
      importance: host.importance,
      timestamp: host.timestamp,
      textLength: host.text.length,
    });
    cases.push({
      triggerId: t.id,
      label: `${t.memoryId.slice(0, 8)}#${triggerIndex(t.id)}`,
      query: t.text,
      hostId: t.memoryId,
      scope: host.scope,
      scopeMismatch: t.scope !== host.scope,
    });
  }
  return { cases, hosts, triggerRows: rows.length, skipped };
}

// ---------------------------------------------------------------------------
// 只读加载
// ---------------------------------------------------------------------------

/**
 * 从库里读出 trigger 行与宿主行。只用 query()；侧表或主表不存在时返回空用例、不建表。
 * `scopes` 给了就只取这些 scope 的 trigger（与 search_memory 同一套 family 匹配）。
 */
export async function loadKnownItemCases(
  dbPath: string,
  opts: { scopes?: string[] } = {},
): Promise<KnownItemLoad> {
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(dbPath);
  const names = await db.tableNames();
  if (!names.includes(TRIGGER_TABLE_NAME) || !names.includes(MEMORY_TABLE_NAME)) {
    return { cases: [], hosts: new Map(), triggerRows: 0, skipped: [] };
  }

  const triggerTable = await db.openTable(TRIGGER_TABLE_NAME);
  const rawTriggers = await triggerTable.query().select(["id", "memory_id", "scope", "text"]).toArray();
  const triggerRows: KnownItemTriggerRow[] = rawTriggers
    .map((r: Record<string, unknown>) => ({
      id: String(r.id ?? ""),
      memoryId: String(r.memory_id ?? ""),
      scope: String(r.scope ?? ""),
      text: String(r.text ?? ""),
    }))
    .filter((r) => r.id && r.memoryId && r.memoryId !== "__schema__")
    .filter((r) => !opts.scopes || opts.scopes.length === 0 || matchesScopeFilter(r.scope, opts.scopes));

  const memoryTable = await db.openTable(MEMORY_TABLE_NAME);
  const hostIds = [...new Set(triggerRows.map((t) => t.memoryId))];
  const hostRows: KnownItemHostRow[] = [];
  const CHUNK = 200;
  for (let i = 0; i < hostIds.length; i += CHUNK) {
    const list = hostIds
      .slice(i, i + CHUNK)
      .map((id) => `'${id.replace(/'/g, "''")}'`)
      .join(",");
    const rows = await memoryTable
      .query()
      .where(`id IN (${list})`)
      .select(["id", "scope", "category", "importance", "timestamp", "metadata", "text"])
      .toArray();
    for (const r of rows as Array<Record<string, unknown>>) {
      hostRows.push({
        id: String(r.id),
        scope: String(r.scope ?? ""),
        category: String(r.category ?? ""),
        importance: Number(r.importance),
        timestamp: Number(r.timestamp),
        metadata: typeof r.metadata === "string" ? r.metadata : "{}",
        text: String(r.text ?? ""),
      });
    }
  }
  return buildKnownItemCases(triggerRows, hostRows);
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

/** 只要 retrieve 这一个方法——测试可以传假的，CLI 传真的 MemoryRetriever。 */
export interface KnownItemRetriever {
  retrieve(context: RetrievalContext): Promise<RetrievalResult[]>;
}

export async function runKnownItemEval(
  retriever: KnownItemRetriever,
  cases: readonly KnownItemCase[],
  opts: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<KnownItemResult[]> {
  const limit = Math.max(1, Math.min(20, Math.floor(opts.limit ?? 20)));
  const out: KnownItemResult[] = [];
  for (const c of cases) {
    const results = await retriever.retrieve({
      query: c.query,
      limit,
      scopeFilter: [c.scope],
      source: "auto-recall",
    });
    const ids = results.map((r) => r.entry.id);
    const idx = ids.indexOf(c.hostId);
    const above = idx >= 0 ? results.slice(0, idx) : results;
    out.push({
      triggerId: c.triggerId,
      label: c.label,
      hostId: c.hostId,
      scope: c.scope,
      rank: idx >= 0 ? idx + 1 : null,
      score: idx >= 0 ? results[idx].score : null,
      top1: ids.length > 0 ? ids[0].slice(0, 8) : null,
      top1Score: results.length > 0 ? results[0].score : null,
      returned: results.length,
      saturatedAbove: above.filter((r) => r.score >= SATURATED_SCORE).length,
      gateSkipped: shouldSkipRetrieval(c.query),
      scopeMismatch: c.scopeMismatch,
    });
    opts.onProgress?.(out.length, cases.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 汇总与比较（纯函数）
// ---------------------------------------------------------------------------

function countOf(list: readonly KnownItemResult[], limit: number): KnownItemCounts {
  const within = (k: number) => list.filter((r) => r.rank !== null && r.rank <= k).length;
  return {
    n: list.length,
    at1: within(1),
    at3: within(3),
    at10: within(10),
    atLimit: within(limit),
    notInWindow: list.filter((r) => r.rank === null).length,
    gateSkipped: list.filter((r) => r.gateSkipped).length,
  };
}

export function ageBucket(ageDays: number): string {
  if (ageDays <= 1) return "a) ≤1 天";
  if (ageDays <= 3) return "b) 1–3 天";
  if (ageDays <= 7) return "c) 3–7 天";
  if (ageDays <= 30) return "d) 7–30 天";
  return "e) >30 天";
}

export function popularityBucket(multiplier: number): string {
  if (multiplier <= 1.0001) return "a) ×1.0";
  if (multiplier <= 1.3) return "b) ×1.0–1.3";
  return "c) >×1.3";
}

function groupCounts(
  results: readonly KnownItemResult[],
  keyOf: (r: KnownItemResult) => string | null,
  limit: number,
): Record<string, KnownItemCounts> {
  const groups = new Map<string, KnownItemResult[]>();
  for (const r of results) {
    const k = keyOf(r);
    if (k === null) continue;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => [k, countOf(g, limit)]));
}

/**
 * @param now 算宿主年龄用的「现在」（快照诊断时传快照时刻，保证重跑一致）
 * @param freqMultiplier 宿主自身的频次加成倍数（FrequencyTracker.getBoostMultiplier）；不给就不分热度组
 */
export function summarizeKnownItem(
  results: readonly KnownItemResult[],
  hosts: ReadonlyMap<string, KnownItemHost>,
  opts: { now: number; limit: number; freqMultiplier?: (id: string) => number },
): KnownItemSummary {
  const summary: KnownItemSummary = {
    limit: opts.limit,
    overall: countOf(results, opts.limit),
    byAge: groupCounts(results, (r) => {
      const h = hosts.get(r.hostId);
      return h ? ageBucket((opts.now - h.timestamp) / DAY_MS) : null;
    }, opts.limit),
    top1Saturated: results.filter((r) => r.top1Score !== null && r.top1Score >= SATURATED_SCORE).length,
    scopeMismatch: results.filter((r) => r.scopeMismatch).length,
  };
  if (opts.freqMultiplier) {
    const fm = opts.freqMultiplier;
    summary.byPopularity = groupCounts(results, (r) => popularityBucket(fm(r.hostId)), opts.limit);
  }
  return summary;
}

export interface KnownItemRankChange {
  triggerId: string;
  label: string;
  before: number | null;
  after: number | null;
}

export interface KnownItemComparison {
  shared: number;
  onlyBefore: string[];
  onlyAfter: string[];
  /** 之前不在第 1、之后第 1 */
  rescued: KnownItemRankChange[];
  /** 之前第 1、之后不在第 1——shadow 判据要求逐条说明性质的就是这一栏 */
  lost: KnownItemRankChange[];
  enteredTop10: KnownItemRankChange[];
  leftTop10: KnownItemRankChange[];
  at1: { before: number; after: number };
}

type RankRow = Pick<KnownItemResult, "triggerId" | "label" | "rank">;

export function compareKnownItemRuns(before: readonly RankRow[], after: readonly RankRow[]): KnownItemComparison {
  const a = new Map(before.map((r) => [r.triggerId, r]));
  const b = new Map(after.map((r) => [r.triggerId, r]));
  const sharedIds = [...a.keys()].filter((id) => b.has(id)).sort();
  const change = (id: string): KnownItemRankChange => ({
    triggerId: id,
    label: a.get(id)!.label,
    before: a.get(id)!.rank,
    after: b.get(id)!.rank,
  });
  const top = (rank: number | null, k: number) => rank !== null && rank <= k;
  const changes = sharedIds.map(change);
  return {
    shared: sharedIds.length,
    onlyBefore: [...a.keys()].filter((id) => !b.has(id)).sort(),
    onlyAfter: [...b.keys()].filter((id) => !a.has(id)).sort(),
    rescued: changes.filter((c) => !top(c.before, 1) && top(c.after, 1)),
    lost: changes.filter((c) => top(c.before, 1) && !top(c.after, 1)),
    enteredTop10: changes.filter((c) => !top(c.before, 10) && top(c.after, 10)),
    leftTop10: changes.filter((c) => top(c.before, 10) && !top(c.after, 10)),
    at1: {
      before: changes.filter((c) => top(c.before, 1)).length,
      after: changes.filter((c) => top(c.after, 1)).length,
    },
  };
}

// ---------------------------------------------------------------------------
// 文本输出
// ---------------------------------------------------------------------------

function pct(a: number, n: number): string {
  return n > 0 ? `${a}/${n}（${Math.round((a / n) * 100)}%）` : "0/0";
}

function countsLine(c: KnownItemCounts, limit: number): string {
  return `第 1 ${pct(c.at1, c.n)}｜前 3 ${pct(c.at3, c.n)}｜前 10 ${pct(c.at10, c.n)}｜前 ${limit} ${pct(c.atLimit, c.n)}｜不在窗口 ${c.notInWindow}｜入口跳过 ${c.gateSkipped}`;
}

export function formatKnownItemSummary(s: KnownItemSummary): string {
  const lines = [`总体：${countsLine(s.overall, s.limit)}`, `第 1 名终分截平在 1.0 的查询：${pct(s.top1Saturated, s.overall.n)}`];
  if (s.scopeMismatch > 0) lines.push(`trigger scope 与宿主 scope 不一致：${s.scopeMismatch} 条`);
  lines.push("按宿主存入天数：");
  for (const [k, c] of Object.entries(s.byAge)) lines.push(`  ${k}：${countsLine(c, s.limit)}`);
  if (s.byPopularity) {
    lines.push("按宿主自身频次倍数：");
    for (const [k, c] of Object.entries(s.byPopularity)) lines.push(`  ${k}：${countsLine(c, s.limit)}`);
  }
  return lines.join("\n");
}

export function formatKnownItemComparison(c: KnownItemComparison): string {
  const fmt = (x: KnownItemRankChange) => `${x.label}：${x.before ?? "—"} → ${x.after ?? "—"}`;
  const lines = [
    `共同用例 ${c.shared}；第 1：${c.at1.before} → ${c.at1.after}`,
    `救回第 1（${c.rescued.length}）`,
    ...c.rescued.map((x) => `  ${fmt(x)}`),
    `掉出第 1（${c.lost.length}，每条都要说明性质）`,
    ...c.lost.map((x) => `  ${fmt(x)}`),
    `进入前 10（${c.enteredTop10.length}）`,
    ...c.enteredTop10.map((x) => `  ${fmt(x)}`),
    `掉出前 10（${c.leftTop10.length}）`,
    ...c.leftTop10.map((x) => `  ${fmt(x)}`),
  ];
  if (c.onlyBefore.length || c.onlyAfter.length) {
    lines.push(`用例集不一致：只在前一次 ${c.onlyBefore.length} 条，只在后一次 ${c.onlyAfter.length} 条（两次跑的不是同一个库或同一批 trigger，比较只看共同用例）`);
  }
  return lines.join("\n");
}
