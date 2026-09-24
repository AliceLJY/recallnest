/**
 * KG 矛盾候选检测（影子期，只读）
 *
 * 在 kg_triples 上按 (scope, subject, predicate) 分组，组内 object 归一化去重后
 * 多于 1 个取值的，报为「候选」。候选不是判决：同一组的多个取值可能是合法多值
 * （同时用好几个工具）、先后变更（负责人换人）或同期互斥（真矛盾），区分它们
 * 靠人工抽样，不靠这里。
 *
 * 不做时间过滤：三元组层没有事实有效期，timestamp / first_seen 只原样附在输出里。
 * 不做同义词 / 语义合并：归一化只处理空白、大小写、全角、首尾标点。
 *
 * 另附对照工具：拿现有线上正则检测（memory-lint 的 findContradictions，原样复用）
 * 在同一 scope 的命中对，与分组候选做双向差异。
 *
 * 整个模块只用 query() 读库：不建表、不加列、不建索引、不写 conflict store。
 */

import type { KGTriple } from "./kg-store.js";
import { parseSourceIds, rowToTriple } from "./kg-store.js";
import { findContradictions } from "./memory-lint.js";
import { isActiveMemory } from "./memory-evolution.js";
import { loadLanceDB, type MemoryEntry } from "./store.js";

// ============================================================================
// Types
// ============================================================================

/** 组内一个（归一化后去重的）取值。 */
export interface KGCandidateValue {
  /** 代表写法：归一化到同一键的原始 object 里 mention_count 最高的那个 */
  object: string;
  /** 归一化键 */
  normalized: string;
  /** 归一化到同一键的全部原始写法（去重，按出现顺序） */
  rawObjects: string[];
  /** 支撑这个取值的不同来源记忆数（多个原始写法合并时取 max(并集大小, 单条最大值)） */
  mention_count: number;
  /** 来源记忆 id 并集 */
  source_memory_ids: string[];
  /** 最早一次抽取（合并时取最小） */
  first_seen: number;
  /** 最近一次抽取（合并时取最大） */
  timestamp: number;
}

/** 一个矛盾候选组：同一 (scope, subject, predicate) 下并存多个取值。 */
export interface KGContradictionCandidate {
  scope: string;
  subject: string;
  predicate: string;
  /** 按 mention_count 降序（并列按归一化键字典序） */
  values: KGCandidateValue[];
  /** 归一化去重后的取值个数（恒 ≥ 2） */
  distinctValueCount: number;
  /** 第二多的取值的 mention_count——排序主键 */
  secondMentionCount: number;
}

/** 正则检测命中的一对记忆。 */
export interface RegexHitPair {
  a: string;
  b: string;
  detail?: string;
}

export interface CoveredPair {
  pair: RegexHitPair;
  /** 让这对记忆在同一组里各自贡献不同取值的候选组 */
  groups: Array<{ subject: string; predicate: string }>;
}

export interface NoTriplePair {
  pair: RegexHitPair;
  /** 这对里在本 scope 没有任何三元组的记忆 id（1 或 2 个） */
  memoriesWithoutTriples: string[];
}

export interface BlindSpotPair {
  pair: RegexHitPair;
  aTripleCount: number;
  bTripleCount: number;
  /** 两条记忆都落进、但给的是同一个归一化取值的 (subject, predicate) */
  sharedSameValueGroups: Array<{ subject: string; predicate: string }>;
}

export interface UncaughtCandidate {
  candidate: KGContradictionCandidate;
  /** 候选的来源记忆里，不在正则检测输入集合（本 scope 活跃记忆）里的 id */
  sourcesOutsideRegexInput: string[];
}

export interface RegexVsGroupsComparison {
  regexPairCount: number;
  candidateCount: number;
  /** 两边都有：正则命中且被某个候选组覆盖 */
  regexCovered: CoveredPair[];
  /** 方向一 a：正则命中，至少一条记忆在本 scope 没有三元组（KG 抽取覆盖面缺口） */
  regexOnlyNoTriples: NoTriplePair[];
  /** 方向一 b：正则命中，两条都有三元组但没在同一组里对撞（分组方法盲区） */
  regexOnlyBlindSpot: BlindSpotPair[];
  /** 两边都有：候选组被至少一对正则命中覆盖 */
  candidatesCaught: KGContradictionCandidate[];
  /** 方向二：正则没抓到的候选组 */
  candidatesUncaught: UncaughtCandidate[];
}

// ============================================================================
// Normalization
// ============================================================================

const EDGE_PUNCT = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

/** 全角 ASCII（U+FF01–U+FF5E）转半角，全角空格（U+3000）转普通空格。 */
function toHalfWidth(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) out += " ";
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else out += ch;
  }
  return out;
}

/**
 * 取值归一化：全角转半角 → 大小写折叠 → 去首尾空白与标点。
 * 不做同义词、语义、内部空白合并。结果为空串表示这个取值没有可比内容。
 */
export function normalizeKGValue(value: string): string {
  return toHalfWidth(value).toLowerCase().replace(EDGE_PUNCT, "");
}

// ============================================================================
// Grouping
// ============================================================================

function groupKey(scope: string, subject: string, predicate: string): string {
  return `${scope}\x00${subject}\x00${predicate}`;
}

function compareCandidates(a: KGContradictionCandidate, b: KGContradictionCandidate): number {
  if (b.secondMentionCount !== a.secondMentionCount) return b.secondMentionCount - a.secondMentionCount;
  if (b.distinctValueCount !== a.distinctValueCount) return b.distinctValueCount - a.distinctValueCount;
  return (
    a.scope.localeCompare(b.scope) ||
    a.subject.localeCompare(b.subject) ||
    a.predicate.localeCompare(b.predicate)
  );
}

/**
 * 按 (scope, subject, predicate) 精确分组，组内 object 归一化去重后多于 1 个取值的报为候选。
 * 一遍扫描，O(N)（外加候选组内的排序）。
 *
 * 排序：第二多取值的 mention_count 降序（两边都有多条证据的更可能是真问题），
 * 再按去重后取值个数降序，最后按 scope / subject / predicate 字典序保证稳定。
 */
export function findKGContradictionCandidates(triples: readonly KGTriple[]): KGContradictionCandidate[] {
  const groups = new Map<string, { scope: string; subject: string; predicate: string; values: Map<string, KGCandidateValue> }>();

  for (const t of triples) {
    const normalized = normalizeKGValue(t.object ?? "");
    if (normalized === "") continue;
    const key = groupKey(t.scope, t.subject, t.predicate);
    let g = groups.get(key);
    if (!g) {
      g = { scope: t.scope, subject: t.subject, predicate: t.predicate, values: new Map() };
      groups.set(key, g);
    }
    const sources = parseSourceIds(t.source_memory_ids, t.source_memory_id);
    const prev = g.values.get(normalized);
    if (!prev) {
      g.values.set(normalized, {
        object: t.object,
        normalized,
        rawObjects: [t.object],
        mention_count: t.mention_count,
        source_memory_ids: [...new Set(sources)],
        first_seen: t.first_seen,
        timestamp: t.timestamp,
      });
      continue;
    }
    if (!prev.rawObjects.includes(t.object)) prev.rawObjects.push(t.object);
    const maxSingle = Math.max(prev.mention_count, t.mention_count);
    // 代表写法跟着证据最多的那条原始 object 走
    if (t.mention_count > prev.mention_count) prev.object = t.object;
    const union = new Set([...prev.source_memory_ids, ...sources]);
    prev.source_memory_ids = [...union];
    prev.mention_count = Math.max(union.size, maxSingle);
    prev.first_seen = Math.min(prev.first_seen, t.first_seen);
    prev.timestamp = Math.max(prev.timestamp, t.timestamp);
  }

  const out: KGContradictionCandidate[] = [];
  for (const g of groups.values()) {
    if (g.values.size < 2) continue;
    const values = [...g.values.values()].sort(
      (a, b) => b.mention_count - a.mention_count || a.normalized.localeCompare(b.normalized),
    );
    out.push({
      scope: g.scope,
      subject: g.subject,
      predicate: g.predicate,
      values,
      distinctValueCount: values.length,
      secondMentionCount: values[1].mention_count,
    });
  }
  return out.sort(compareCandidates);
}

// ============================================================================
// Comparison with the existing regex detector
// ============================================================================

/**
 * 线上正则检测的命中对：原样调用 memory-lint 的 findContradictions（类别过滤、
 * scope+category 分组、组内按 importance 取前 100、向量相似度下限、否定词对 + 共享长词）。
 * entries 必须带真实向量，否则相似度恒为 0、一对都出不来。
 */
export function regexHitPairs(entries: MemoryEntry[]): RegexHitPair[] {
  return findContradictions(entries)
    .filter((f) => f.memoryIds.length === 2)
    .map((f) => ({ a: f.memoryIds[0], b: f.memoryIds[1], detail: f.detail }));
}

/** 候选组里 a、b 是否各自贡献了不同的取值。 */
function candidateCoversPair(c: KGContradictionCandidate, a: string, b: string): boolean {
  for (let i = 0; i < c.values.length; i++) {
    if (!c.values[i].source_memory_ids.includes(a)) continue;
    for (let j = 0; j < c.values.length; j++) {
      if (j !== i && c.values[j].source_memory_ids.includes(b)) return true;
    }
  }
  return false;
}

/**
 * 双向对照。「覆盖」= 两条记忆在同一个 (S,P) 候选组里各自贡献了不同的取值。
 *
 * - 方向一（正则有、分组没覆盖）拆两类：有记忆在 `triples` 里没有三元组的（抽取覆盖面缺口），
 *   和两条都有三元组却没在同一组对撞的（分组方法盲区）。
 * - 方向二（分组有、正则没抓到）：任何一对正则命中都没覆盖的候选组。
 *
 * `triples` 应是与候选同一批的全部三元组（含单值组），用来判断一条记忆有没有三元组。
 * `regexInputIds` 是正则检测实际看过的记忆 id，用来标出候选里正则根本没机会看到的来源。
 */
export function compareRegexWithCandidates(
  pairs: readonly RegexHitPair[],
  candidates: readonly KGContradictionCandidate[],
  triples: readonly KGTriple[],
  regexInputIds?: ReadonlySet<string>,
): RegexVsGroupsComparison {
  // 每条记忆贡献过的 (S,P) → 归一化取值集合
  const byMemory = new Map<string, Map<string, { subject: string; predicate: string; values: Set<string> }>>();
  const tripleCount = new Map<string, number>();
  for (const t of triples) {
    const normalized = normalizeKGValue(t.object ?? "");
    for (const mid of parseSourceIds(t.source_memory_ids, t.source_memory_id)) {
      tripleCount.set(mid, (tripleCount.get(mid) ?? 0) + 1);
      if (normalized === "") continue;
      let sp = byMemory.get(mid);
      if (!sp) {
        sp = new Map();
        byMemory.set(mid, sp);
      }
      const key = groupKey(t.scope, t.subject, t.predicate);
      const entry = sp.get(key) ?? { subject: t.subject, predicate: t.predicate, values: new Set<string>() };
      entry.values.add(normalized);
      sp.set(key, entry);
    }
  }

  const regexCovered: CoveredPair[] = [];
  const regexOnlyNoTriples: NoTriplePair[] = [];
  const regexOnlyBlindSpot: BlindSpotPair[] = [];
  const caught = new Set<KGContradictionCandidate>();

  for (const pair of pairs) {
    const covering = candidates.filter((c) => candidateCoversPair(c, pair.a, pair.b));
    if (covering.length > 0) {
      for (const c of covering) caught.add(c);
      regexCovered.push({ pair, groups: covering.map((c) => ({ subject: c.subject, predicate: c.predicate })) });
      continue;
    }
    const missing = [pair.a, pair.b].filter((id) => (tripleCount.get(id) ?? 0) === 0);
    if (missing.length > 0) {
      regexOnlyNoTriples.push({ pair, memoriesWithoutTriples: missing });
      continue;
    }
    const spA = byMemory.get(pair.a) ?? new Map();
    const spB = byMemory.get(pair.b);
    const sharedSameValueGroups: Array<{ subject: string; predicate: string }> = [];
    if (spB) {
      for (const [key, ea] of spA) {
        const eb = spB.get(key);
        if (!eb) continue;
        if ([...ea.values].some((v) => eb.values.has(v))) {
          sharedSameValueGroups.push({ subject: ea.subject, predicate: ea.predicate });
        }
      }
    }
    regexOnlyBlindSpot.push({
      pair,
      aTripleCount: tripleCount.get(pair.a) ?? 0,
      bTripleCount: tripleCount.get(pair.b) ?? 0,
      sharedSameValueGroups,
    });
  }

  const candidatesCaught: KGContradictionCandidate[] = [];
  const candidatesUncaught: UncaughtCandidate[] = [];
  for (const c of candidates) {
    if (caught.has(c)) {
      candidatesCaught.push(c);
      continue;
    }
    const sources = new Set(c.values.flatMap((v) => v.source_memory_ids));
    candidatesUncaught.push({
      candidate: c,
      sourcesOutsideRegexInput: regexInputIds ? [...sources].filter((id) => !regexInputIds.has(id)) : [],
    });
  }

  return {
    regexPairCount: pairs.length,
    candidateCount: candidates.length,
    regexCovered,
    regexOnlyNoTriples,
    regexOnlyBlindSpot,
    candidatesCaught,
    candidatesUncaught,
  };
}

// ============================================================================
// Sampling
// ============================================================================

/** 确定性抽样（mulberry32 + Fisher–Yates），同一 seed 同一输入得到同一批。 */
export function sampleCandidates<T>(items: readonly T[], n: number, seed: number): T[] {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.max(0, n));
}

// ============================================================================
// Read-only loaders
// ============================================================================

const KG_TABLE_NAME = "kg_triples";
const MEMORY_TABLE_NAME = "memories";
/** 与 runMemoryLint 的扫描上限一致 */
const LINT_SCAN_LIMIT = 10000;

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 读出某个 scope（精确匹配）的全部三元组。表不存在返回空，不建表。 */
export async function loadScopeTriples(dbPath: string, scope: string): Promise<KGTriple[]> {
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(dbPath);
  const names = await db.tableNames();
  if (!names.includes(KG_TABLE_NAME)) return [];
  const table = await db.openTable(KG_TABLE_NAME);
  const rows = await table.query().where(`scope = ${sqlLiteral(scope)}`).toArray();
  return (rows as Array<Record<string, unknown>>)
    .map(rowToTriple)
    .filter((t) => t.id !== "__schema__");
}

export interface RegexInputLoad {
  entries: MemoryEntry[];
  /** 与 runMemoryLint 相同：按时间取最新 10000 条后才过滤活跃，触顶即为 true */
  scanLimited: boolean;
}

/**
 * 读出正则检测的输入：本 scope（精确匹配）的记忆，按 runMemoryLint 的口径取最新 10000 条、
 * 只留活跃记忆、带真实向量。表不存在返回空，不建表。
 */
export async function loadRegexInput(dbPath: string, scope: string): Promise<RegexInputLoad> {
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(dbPath);
  const names = await db.tableNames();
  if (!names.includes(MEMORY_TABLE_NAME)) return { entries: [], scanLimited: false };
  const table = await db.openTable(MEMORY_TABLE_NAME);
  const rows = await table
    .query()
    .where(`scope = ${sqlLiteral(scope)}`)
    .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata", "vector"])
    .toArray();
  const all: MemoryEntry[] = (rows as Array<Record<string, unknown>>)
    .map((row): MemoryEntry => ({
      id: String(row.id),
      text: String(row.text ?? ""),
      vector: row.vector ? Array.from(row.vector as Iterable<number>) : [],
      category: row.category as MemoryEntry["category"],
      scope: String(row.scope ?? ""),
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: typeof row.metadata === "string" && row.metadata ? row.metadata : "{}",
    }))
    .filter((e) => e.id !== "__schema__")
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const scanLimited = all.length >= LINT_SCAN_LIMIT;
  const entries = all.slice(0, LINT_SCAN_LIMIT).filter((e) => isActiveMemory(e.metadata));
  return { entries, scanLimited };
}

// ============================================================================
// Formatting
// ============================================================================

function fmtDate(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "?";
}

function shortIds(ids: readonly string[], max = 4): string {
  const shown = ids.slice(0, max).map((id) => id.slice(0, 8)).join(",");
  return ids.length > max ? `${shown},+${ids.length - max}` : shown;
}

export function formatCandidate(c: KGContradictionCandidate, index: number): string {
  const lines = [`${index}. [${c.subject}] —${c.predicate}→ ${c.distinctValueCount} values (2nd mentions=${c.secondMentionCount})`];
  for (const v of c.values) {
    const raw = v.rawObjects.length > 1 ? ` (raw: ${v.rawObjects.map((r) => JSON.stringify(r)).join(" | ")})` : "";
    lines.push(
      `     - ${JSON.stringify(v.object)}${raw}  mentions=${v.mention_count}  first_seen=${fmtDate(v.first_seen)}  last=${fmtDate(v.timestamp)}  src=${shortIds(v.source_memory_ids)}`,
    );
  }
  return lines.join("\n");
}

export function formatCandidateReport(
  scope: string,
  tripleCount: number,
  total: number,
  shown: readonly KGContradictionCandidate[],
  mode: string,
): string {
  const lines = [
    `KG contradiction candidates — scope=${scope}`,
    `候选，不是判决：同组多值可能是合法多值、先后变更或真矛盾，需人工判断。未做时间过滤。`,
    `triples=${tripleCount}  candidate groups=${total}  showing=${shown.length} (${mode})`,
    "",
  ];
  shown.forEach((c, i) => lines.push(formatCandidate(c, i + 1)));
  return lines.join("\n");
}

function pairLine(p: RegexHitPair): string {
  return `${p.a.slice(0, 8)} × ${p.b.slice(0, 8)}${p.detail ? `  ${p.detail}` : ""}`;
}

function capped<T>(items: readonly T[], limit: number): { items: readonly T[]; more: number } {
  if (limit <= 0 || items.length <= limit) return { items, more: 0 };
  return { items: items.slice(0, limit), more: items.length - limit };
}

export function formatComparisonReport(
  scope: string,
  meta: { tripleCount: number; regexInputCount: number; scanLimited: boolean },
  cmp: RegexVsGroupsComparison,
  limit: number,
): string {
  const lines: string[] = [
    `Regex vs KG-group candidates — scope=${scope}`,
    `regex input: ${meta.regexInputCount} active memories${meta.scanLimited ? " (hit lint scan cap 10000)" : ""}; triples: ${meta.tripleCount}`,
    `regex pairs=${cmp.regexPairCount}  candidate groups=${cmp.candidateCount}`,
    `  both (regex pair covered by a group): ${cmp.regexCovered.length} pairs / ${cmp.candidatesCaught.length} groups`,
    `  direction 1 — regex only: ${cmp.regexOnlyNoTriples.length + cmp.regexOnlyBlindSpot.length}` +
      ` (no triples: ${cmp.regexOnlyNoTriples.length}, method blind spot: ${cmp.regexOnlyBlindSpot.length})`,
    `  direction 2 — group candidates regex missed: ${cmp.candidatesUncaught.length}`,
    "",
  ];

  const section = <T>(title: string, items: readonly T[], render: (item: T, i: number) => string) => {
    lines.push(`## ${title} (${items.length})`);
    const { items: shown, more } = capped(items, limit);
    shown.forEach((item, i) => lines.push(render(item, i + 1)));
    if (more > 0) lines.push(`  … ${more} more (raise --limit or use --json)`);
    lines.push("");
  };

  section("Direction 1a — regex only, memory has no triples (KG extraction gap)", cmp.regexOnlyNoTriples, (x, i) =>
    `${i}. ${pairLine(x.pair)}\n     without triples: ${shortIds(x.memoriesWithoutTriples)}`,
  );
  section("Direction 1b — regex only, both have triples but no collision (grouping blind spot)", cmp.regexOnlyBlindSpot, (x, i) => {
    const shared = x.sharedSameValueGroups.map((g) => `[${g.subject}]—${g.predicate}`).join("; ");
    return `${i}. ${pairLine(x.pair)}\n     triples: ${x.aTripleCount} / ${x.bTripleCount}${shared ? `  same value in: ${shared}` : ""}`;
  });
  section("Direction 2 — group candidates the regex missed", cmp.candidatesUncaught, (x, i) => {
    const outside = x.sourcesOutsideRegexInput.length > 0
      ? `\n     sources outside regex input (inactive/unscanned): ${shortIds(x.sourcesOutsideRegexInput)}`
      : "";
    return `${formatCandidate(x.candidate, i)}${outside}`;
  });
  section("Both — regex pairs covered by a group", cmp.regexCovered, (x, i) =>
    `${i}. ${pairLine(x.pair)}\n     groups: ${x.groups.map((g) => `[${g.subject}]—${g.predicate}`).join("; ")}`,
  );

  return lines.join("\n");
}
