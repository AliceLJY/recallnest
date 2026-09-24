/**
 * 记忆文件对账：让 memory 源的文档切片与现行记忆文件一一对应。
 *
 * 为什么有这个模块：`ingestMarkdownFiles` 只增不删、每段新文本都要过全库判重，于是记忆文件改过以后
 * 旧版切片永远留在库里被召回，新版又常被自己的旧版判重挡在门外（2026-09-24 实测：活跃的记忆文档切片
 * 68% 对不上任何现行切片；现行文字 687 种没有活跃代表）。
 *
 * 做法：每轮全量规划——记忆目录顶层 *.md 的现行切片（parseMarkdown → redactSecrets → toWellFormed →
 * normalizeDedupText）对 scope "memory"（精确，不含 memory:pivot）的全部行：
 *   - 现行文本已有活跃行 → 保留一条，多余的文档切片以 duplicate-text 下架；
 *   - 活跃文档切片的文本不在任何现行文件里 → 软下架（evolution.status = "archived" + reconcile 标记，不删行）；
 *   - 现行文本没有活跃行 → 按 planMemoryReconcile() 第二遍的顺序：合并链完好算有代表 / forget 过的不补回 /
 *     恢复对账下架过的行 / 恢复合并链已断的行 / 被别的机制下架的不推翻 / 否则插入（不过 dedupCheck，
 *     只插库里不存在的 id）。
 *
 * 执行顺序是「插入 → 恢复 → 下架」：先把代表补齐再撤旧的。下架还要等两件事都成立——所在文件的新段落都有了着落、
 * 依赖它的合并链成员已经恢复成功——否则延后到下一轮。
 * 写入时整轮持有三把锁：自己的 memory-reconcile、dream 合并用的 consolidate-memory、GC 用的 gc-run（都是忙就跳过，
 * 持有者进程还活着就绝不抢），所以规划到提交之间 dream / GC 不会插进来拿旧判断写入；其余写方（MCP 写入、访问计数）
 * 由提交时核对兜住。每批写库前先落一条意图日志，写库后再落前后值，崩溃在中间也能撤销。
 *
 * 只在 sources.memory.path 显式配置时使用（auto 路径仍走 ingestMarkdownFiles，行为不变）。
 * 方案、三方互审与上线前的代码单审：sync-bridge AI产出/2026-09-24-recallnest-文档切片不下架/plan.md、mr-plan/。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AuditLogger } from "./audit-log.js";
import { inspectLock, lockPathForKey, withLock } from "./distill-lock.js";
import type { Embedder } from "./embedder.js";
import * as envConfig from "./env-config.js";
import { buildIngestedEntry, generateCoreSummaries, parseMarkdown, smartExtractBatch } from "./ingest.js";
import type { LLMClient } from "./llm-client.js";
import { patchEvolutionOnMeta, type EvolutionMetadata } from "./memory-evolution.js";
import { redactSecrets } from "./pii-detector.js";
import { deterministicId, type MemoryEntry, type MemoryStore } from "./store.js";
import { fingerprintNormalized, normalizeDedupText, textFingerprint } from "./text-fingerprint.js";

export const MEMORY_DOC_SCOPE = "memory";
export const DEFAULT_MAX_RETIRE_FLOOR = 300;
export const DEFAULT_MAX_RETIRE_FRACTION = 0.25;
export const DIR_SANITY_MIN_RATIO = 0.5;
/** 同一种护栏原因多久再报一次警（在此之间照常在日志里写 ⚠️，但不以退出码 3 结束） */
export const GUARD_ALERT_INTERVAL_MS = 24 * 3_600_000;
/** 锁被一个活着的进程占着超过这么久没更新，就不只是「本轮跳过」，要报警（不然对账会一直静默跳过） */
export const LOCK_STALE_ALERT_MS = 6 * 3_600_000;
const INSERT_BATCH = 32;
const PATCH_BATCH = 200;
const RECONCILE_NOTE_PREFIX = "memory-reconcile:";
const LOCK_HEARTBEAT_MS = 60_000;

/**
 * 写入时与对账互斥的锁。键名必须与持锁方逐字一致：
 * - `consolidate-memory`：dream 的合并阶段（dream-pipeline.ts `consolidate-${scope}`）与 MCP
 *   consolidate_memories（mcp-tools-governance.ts）对 scope "memory" 用的同一把锁；
 * - `gc-run`：auto-gc.ts 全库归档扫描的运行锁。
 * 对账整轮持有它们（忙就跳过本轮），dream / GC 也就不会在对账的规划与提交之间拿旧判断写入。
 */
export const RECONCILE_LOCK_KEYS = ["memory-reconcile", `consolidate-${MEMORY_DOC_SCOPE}`, "gc-run"] as const;
/**
 * 判断别人的锁是否过期时用的时限：一律视为永不过期——持有者进程还活着就绝不抢（死进程留下的锁照常回收）。
 * dream / GC 自己不续期，按修改时间回收会在它们跑得久时把锁抢过来、让它们在对账之后拿旧判断提交（上线前代码单审 C2）。
 * 活着却长期不动的持有者由 LOCK_STALE_ALERT_MS 报警兜住。
 */
const NEVER_EXPIRE_MS = Number.MAX_SAFE_INTEGER;

export type RetireReason =
  | "not-in-current-files"
  | "duplicate-text"
  | "orphan-file"
  | "sync-conflict-file";

export type ReactivateKind = "reconcile-retired" | "broken-consolidation";

export interface CurrentChunk {
  file: string;
  idx: number;
  heading: string;
  /** redactSecrets + toWellFormed 之后的原文，也是入库文本 */
  text: string;
  norm: string;
}

export interface ExistingRow {
  id: string;
  scope: string;
  text: string;
  timestamp: number;
  meta: Record<string, unknown>;
}

/** 规划时看到的、提交前要核对的状态 */
export interface RowState {
  status: string;
  evolutionNote: string | null;
  consolidatedInto: string | null;
  reconcileAction: string | null;
}

/** 撤销要用的改动字段（前值 / 后值） */
export interface JournalFields {
  status: string;
  validUntil: unknown;
  evolutionNote: string | null;
  consolidatedInto: string | null;
  reconcile: unknown;
}

export interface PlannedRetire {
  id: string;
  file: string | null;
  reason: RetireReason;
  norm: string;
  expect: RowState;
  /** 规划时这一行的改动字段，写进意图日志，崩溃在写库与写结果之间时撤销靠它 */
  before: JournalFields;
}

export interface PlannedReactivate {
  id: string;
  file: string | null;
  kind: ReactivateKind;
  /**
   * 同一段文字的全部合并成员里，合并目标本轮要被下架的那些目标 id。这段文字此刻还靠它们撑着（链还没断），
   * 恢复没成功就不能下架它们（上线前代码单审 N3、第二次单审 F2：不只看被选中的那一行）。
   */
  dependentRetireIds: string[];
  /** 等价于 dependentRetireIds 非空：链是本轮下架才断的（下架被护栏拦下时，broken-consolidation 不恢复） */
  targetRetiredThisRun: boolean;
  norm: string;
  expect: RowState;
  before: JournalFields;
}

export interface PlannedInsert {
  id: string;
  chunk: CurrentChunk;
  /** 这段文字出现在的全部现行文件（同一段可能出现在几个文件里；插入失败时这些文件的旧切片都要等） */
  files: string[];
  /** 这段文字的确定性 id 已被另一段正文占着（见 altInsertId），此时 id 是备用 id，这里记原 id */
  occupiedPrimaryId?: string;
}

export interface MemoryReconcilePlan {
  currentFiles: number;
  currentChunks: number;
  currentDistinct: number;
  existingRows: number;
  activeDocRows: number;
  filesWithActiveDocRows: number;
  keep: number;
  insert: PlannedInsert[];
  retire: PlannedRetire[];
  reactivate: PlannedReactivate[];
  /** 现行文本只剩被合并的行，但它合并进的那一行本轮之后仍活跃 */
  representedByConsolidation: number;
  /** 例外①：forget 过的文本，不补回 */
  exceptionForgotten: number;
  /** 例外②：同文只剩被别的机制（GC 归档、superseded 等）下架的行，不推翻 */
  exceptionOtherInactive: number;
  exceptionOtherInactiveIds: string[];
  /** 插入里有几段的确定性 id 被另一段正文占着、改用备用 id */
  insertAltId: number;
}

// ---------------------------------------------------------------------------
// 行状态小工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function evolutionOf(meta: Record<string, unknown>): Record<string, unknown> {
  return asRecord(meta.evolution) ?? {};
}

export function rowState(meta: Record<string, unknown>): RowState {
  const evo = evolutionOf(meta);
  const action = asRecord(meta.reconcile)?.action;
  return {
    status: typeof evo.status === "string" ? evo.status : "active",
    evolutionNote: typeof evo.evolutionNote === "string" ? evo.evolutionNote : null,
    consolidatedInto: typeof evo.consolidatedInto === "string" ? evo.consolidatedInto : null,
    reconcileAction: typeof action === "string" ? action : null,
  };
}

export function journalFields(meta: Record<string, unknown>): JournalFields {
  const evo = evolutionOf(meta);
  return {
    status: typeof evo.status === "string" ? evo.status : "active",
    validUntil: evo.validUntil ?? null,
    evolutionNote: typeof evo.evolutionNote === "string" ? evo.evolutionNote : null,
    consolidatedInto: typeof evo.consolidatedInto === "string" ? evo.consolidatedInto : null,
    reconcile: meta.reconcile ?? null,
  };
}

export function isActiveStatus(status: string): boolean {
  return status === "active" || status === "pending_review";
}

export function isMemoryDocSlice(meta: Record<string, unknown>): boolean {
  return meta.source === MEMORY_DOC_SCOPE && asRecord(meta.boundary)?.authority === "document-ingest";
}

export function isSyncConflictFile(name: string): boolean {
  return /sync-conflict/i.test(name);
}

function isReconcileRetired(state: RowState): boolean {
  return state.status === "archived"
    && (state.evolutionNote ?? "").startsWith(RECONCILE_NOTE_PREFIX)
    && state.reconcileAction === "retired";
}

function isForgottenNote(state: RowState): boolean {
  return (state.evolutionNote ?? "").startsWith("forgotten:");
}

function fileOf(meta: Record<string, unknown>): string | null {
  return typeof meta.file === "string" ? meta.file : null;
}

function accessCountOf(meta: Record<string, unknown>): number {
  const n = Number(evolutionOf(meta).accessCount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 多条候选里挑一条：原文与现行切片逐字相同者优先，其次访问多者，再次时间早者，最后按 id 定序。 */
function pickPreferred(rows: ExistingRow[], exactText: string): ExistingRow {
  return [...rows].sort((a, b) => {
    const ea = a.text === exactText ? 1 : 0;
    const eb = b.text === exactText ? 1 : 0;
    if (ea !== eb) return eb - ea;
    const ca = accessCountOf(a.meta);
    const cb = accessCountOf(b.meta);
    if (ca !== cb) return cb - ca;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/**
 * 备用插入 id。现行文字的确定性 id 可能已被另一段正文占着（某个子系统原地改写过那一行的正文、id 不变）。
 * 这时插入会撞 id 被跳过、那一行又因正文不在现行文件而下架，这段文字就一个活跃代表都没有。
 * 用固定推导的备用 id 插入：可重跑、下一轮同文已有活跃行就不会再插。
 */
export function altInsertId(text: string): string {
  return deterministicId(MEMORY_DOC_SCOPE, `${text}\u0000memory-reconcile:alt-id`);
}

function parseMeta(raw: string | undefined): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw || "{}")) ?? {};
  } catch {
    return {}; // 坏 metadata 按空处理：isMemoryDocSlice 为 false，永不被下架
  }
}

/** 行上存的前值里再带前值会越套越深：只留一层 */
function stripPrev(reconcile: unknown): unknown {
  const r = asRecord(reconcile);
  if (!r) return reconcile ?? null;
  const rest: Record<string, unknown> = { ...r };
  delete rest.prev;
  return rest;
}

// ---------------------------------------------------------------------------
// 规划（纯函数）
// ---------------------------------------------------------------------------

export interface ForgetSet {
  /** forget 事件的 memoryId */
  ids: Set<string>;
  /** forget 事件记下的归一文本指纹（2026-09-24 起 forget 引擎在 details 里写 `norm=<指纹>`；更早的事件没有） */
  norms: Set<string>;
}

export interface PlanInput {
  /** 现行切片（已跳过 sync-conflict 文件） */
  current: CurrentChunk[];
  /** 现行记忆目录顶层 *.md 文件名（含 sync-conflict 文件，用来区分「文件已删」与「冲突副本」） */
  currentFileNames: Set<string>;
  /** scope 恰为 "memory" 的全部行（任何来源、任何状态） */
  existing: ExistingRow[];
  /** 审计日志里 scope "memory" 的 forget 事件 id */
  forgottenIds: Set<string>;
  /** 同上事件里的归一文本指纹 */
  forgottenNorms?: Set<string>;
  /** existing 之外、被 consolidatedInto 指到的行的状态（比如合并进了别的 scope） */
  externalStatus?: Map<string, string>;
}

export function planMemoryReconcile(input: PlanInput): MemoryReconcilePlan {
  const { current, currentFileNames, existing, forgottenIds } = input;
  const forgottenNorms = input.forgottenNorms ?? new Set<string>();
  const externalStatus = input.externalStatus ?? new Map<string, string>();

  const curByNorm = new Map<string, CurrentChunk>();
  const filesByNorm = new Map<string, Set<string>>();
  for (const chunk of current) {
    if (!curByNorm.has(chunk.norm)) curByNorm.set(chunk.norm, chunk);
    const files = filesByNorm.get(chunk.norm) ?? new Set<string>();
    files.add(chunk.file);
    filesByNorm.set(chunk.norm, files);
  }

  const rowsByNorm = new Map<string, ExistingRow[]>();
  const existingIds = new Set(existing.map((r) => r.id));
  const statusById = new Map<string, string>();
  const normById = new Map<string, string>();
  const activeDocFiles = new Set<string>();
  let activeDocRows = 0;
  for (const row of existing) {
    const norm = normalizeDedupText(row.text);
    normById.set(row.id, norm);
    const list = rowsByNorm.get(norm) ?? [];
    list.push(row);
    rowsByNorm.set(norm, list);
    const state = rowState(row.meta);
    statusById.set(row.id, state.status);
    if (isActiveStatus(state.status) && isMemoryDocSlice(row.meta)) {
      activeDocRows++;
      const file = fileOf(row.meta);
      if (file) activeDocFiles.add(file);
    }
  }

  const retire: PlannedRetire[] = [];
  const retireIds = new Set<string>();
  const addRetire = (row: ExistingRow, reason: RetireReason, norm: string) => {
    if (retireIds.has(row.id)) return;
    retireIds.add(row.id);
    retire.push({ id: row.id, file: fileOf(row.meta), reason, norm, expect: rowState(row.meta), before: journalFields(row.meta) });
  };

  // 第一遍：现行文本的活跃行——留一条，多余的文档切片下架
  let keep = 0;
  for (const [norm, chunk] of curByNorm) {
    const active = (rowsByNorm.get(norm) ?? []).filter((r) => isActiveStatus(rowState(r.meta).status));
    if (active.length === 0) continue;
    keep++;
    const keeper = pickPreferred(active, chunk.text);
    for (const row of active) {
      if (row.id !== keeper.id && isMemoryDocSlice(row.meta)) addRetire(row, "duplicate-text", norm);
    }
  }
  // 第一遍（续）：文本已不在任何现行文件里的活跃文档切片
  for (const row of existing) {
    const norm = normById.get(row.id)!;
    if (curByNorm.has(norm)) continue;
    if (!isMemoryDocSlice(row.meta) || !isActiveStatus(rowState(row.meta).status)) continue;
    const file = fileOf(row.meta);
    const reason: RetireReason = file && isSyncConflictFile(file)
      ? "sync-conflict-file"
      : file && !currentFileNames.has(file)
        ? "orphan-file"
        : "not-in-current-files";
    addRetire(row, reason, norm);
  }

  // 第二遍：没有活跃行的现行文本
  const insert: PlannedInsert[] = [];
  const reactivate: PlannedReactivate[] = [];
  let representedByConsolidation = 0;
  let exceptionForgotten = 0;
  let exceptionOtherInactive = 0;
  const exceptionOtherInactiveIds: string[] = [];
  let insertAltId = 0;

  const targetStaysActive = (targetId: string | null): boolean => {
    if (!targetId || retireIds.has(targetId)) return false;
    const status = statusById.get(targetId) ?? externalStatus.get(targetId);
    return status !== undefined && isActiveStatus(status);
  };

  for (const [norm, chunk] of curByNorm) {
    const rows = rowsByNorm.get(norm) ?? [];
    if (rows.some((r) => isActiveStatus(rowState(r.meta).status))) continue;

    // 1. 合并链完好：合并目标本轮之后仍活跃 → 已有代表
    const consolidated = rows.filter((r) => rowState(r.meta).status === "consolidated");
    if (consolidated.some((r) => targetStaysActive(rowState(r.meta).consolidatedInto))) {
      representedByConsolidation++;
      continue;
    }
    // 2. forget 过：审计里有这段文字的确定性 id / 备用 id / 归一指纹，或还没删掉的同文行带 forgotten: 标记
    //    → 不补回，也不恢复同文的别的行（forget 删的是一行，要忘的是这段文字）
    const id = deterministicId(MEMORY_DOC_SCOPE, chunk.text);
    const altId = altInsertId(chunk.text);
    if (forgottenIds.has(id) || forgottenIds.has(altId) || forgottenNorms.has(fingerprintNormalized(norm))
      || rows.some((r) => isForgottenNote(rowState(r.meta)))) {
      exceptionForgotten++;
      continue;
    }
    // 同文组全部合并成员里、本轮要被下架的合并目标：恢复没成功时它们要延后下架
    const dependentRetireIds = [...new Set(consolidated
      .map((r) => rowState(r.meta).consolidatedInto)
      .filter((t): t is string => t !== null && retireIds.has(t)))];
    // 3. 对账下架过的 → 恢复
    const retiredByUs = rows.filter((r) => isMemoryDocSlice(r.meta) && isReconcileRetired(rowState(r.meta)));
    if (retiredByUs.length > 0) {
      const row = pickPreferred(retiredByUs, chunk.text);
      reactivate.push({ id: row.id, file: fileOf(row.meta), kind: "reconcile-retired", dependentRetireIds, targetRetiredThisRun: dependentRetireIds.length > 0, norm, expect: rowState(row.meta), before: journalFields(row.meta) });
      continue;
    }
    // 4. 合并链已断（目标不活跃、不存在，或本轮要被下架）→ 恢复被合并的那一行
    const brokenConsolidation = consolidated.filter((r) => isMemoryDocSlice(r.meta));
    if (brokenConsolidation.length > 0) {
      const row = pickPreferred(brokenConsolidation, chunk.text);
      reactivate.push({
        id: row.id,
        file: fileOf(row.meta),
        kind: "broken-consolidation",
        dependentRetireIds,
        targetRetiredThisRun: dependentRetireIds.length > 0,
        norm,
        expect: rowState(row.meta),
        before: journalFields(row.meta),
      });
      continue;
    }
    // 5. 只剩被别的机制下架的行 → 不推翻，计数
    if (rows.length > 0) {
      exceptionOtherInactive++;
      exceptionOtherInactiveIds.push(...rows.map((r) => r.id));
      continue;
    }
    // 6. 库里没有 → 插入。走到这里说明 scope 内没有同文行，确定性 id 若已存在，必是被另一段正文占着 → 用备用 id
    const files = [...(filesByNorm.get(norm) ?? new Set([chunk.file]))].sort();
    if (existingIds.has(id)) {
      insert.push({ id: altId, chunk, files, occupiedPrimaryId: id });
      insertAltId++;
    } else {
      insert.push({ id, chunk, files });
    }
  }

  return {
    currentFiles: [...currentFileNames].filter((f) => !isSyncConflictFile(f)).length,
    currentChunks: current.length,
    currentDistinct: curByNorm.size,
    existingRows: existing.length,
    activeDocRows,
    filesWithActiveDocRows: activeDocFiles.size,
    keep,
    insert,
    retire,
    reactivate,
    representedByConsolidation,
    exceptionForgotten,
    exceptionOtherInactive,
    exceptionOtherInactiveIds,
    insertAltId,
  };
}

// ---------------------------------------------------------------------------
// 收集输入
// ---------------------------------------------------------------------------

export function collectCurrentChunks(memDir: string): { chunks: CurrentChunk[]; fileNames: Set<string> } {
  const fileNames = new Set(readdirSync(memDir).filter((f) => f.endsWith(".md")));
  const chunks: CurrentChunk[] = [];
  for (const file of [...fileNames].sort()) {
    if (isSyncConflictFile(file)) continue;
    const sections = parseMarkdown(join(memDir, file));
    sections.forEach((section, idx) => {
      // F-3b：与 ingestMarkdownFiles 一样先脱敏再入库，比对也用脱敏后的文本。
      // toWellFormed：切片器按 UTF-16 下标切、带重叠回退，会把 emoji 等四字节字符切成半截；库存储时把半截换成
      // U+FFFD，id 的哈希编码也同样替换，于是「id 相同、正文差一个字」——不先换掉，这段文字每轮都认不出自己在库里的那一行
      // （2026-09-24 快照彩排：open-loops.md 一段开头是半截字符，按原文比对永远缺代表，所在文件的旧切片就永远下不掉）。
      const text = redactSecrets(section.text).text.toWellFormed();
      chunks.push({ file, idx, heading: section.heading, text, norm: normalizeDedupText(text) });
    });
  }
  return { chunks, fileNames };
}

export async function loadMemoryScopeRows(store: MemoryStore): Promise<ExistingRow[]> {
  const entries = await store.listPage({
    scopeFilter: [MEMORY_DOC_SCOPE],
    scopeMatch: "exact",
    limit: 10_000_000,
  });
  return entries
    .filter((entry) => entry.scope === MEMORY_DOC_SCOPE)
    .map((entry) => ({ id: entry.id, scope: entry.scope, text: entry.text, timestamp: entry.timestamp, meta: parseMeta(entry.metadata) }));
}

const FORGET_NORM_RE = /(?:^|\s)norm=([0-9a-f]{16})(?:\s|$)/;

function collectForgets(chunk: string, into: ForgetSet): void {
  for (const line of chunk.split("\n")) {
    if (!line.includes("\"forget\"")) continue;
    try {
      const e = asRecord(JSON.parse(line));
      if (!e || e.operation !== "forget" || e.scope !== MEMORY_DOC_SCOPE) continue;
      if (typeof e.memoryId === "string") into.ids.add(e.memoryId);
      const m = typeof e.details === "string" ? FORGET_NORM_RE.exec(e.details) : null;
      if (m) into.norms.add(m[1]);
    } catch { /* 跳过坏行 */ }
  }
}

/** 这段文字是否已被 forget：行自己的 id、这段文字的确定性 id 或备用 id、归一指纹，任一在 forget 记录里都算 */
function isTextForgotten(forgets: ForgetSet, text: string, rowId?: string): boolean {
  return (rowId !== undefined && forgets.ids.has(rowId))
    || forgets.ids.has(deterministicId(MEMORY_DOC_SCOPE, text))
    || forgets.ids.has(altInsertId(text))
    || forgets.norms.has(textFingerprint(text));
}

/** 审计日志里 scope "memory" 的 forget 事件。文件不在就是空集（识别失效，不报错）。 */
export function loadForgetSet(auditPath: string): ForgetSet {
  const set: ForgetSet = { ids: new Set(), norms: new Set() };
  if (existsSync(auditPath)) collectForgets(readFileSync(auditPath, "utf-8"), set);
  return set;
}

/**
 * 跟着 audit.jsonl 往后读：每批插入写库前一刻刷新一次，规划之后才发生的 forget 也挡得住（互审 C3）。
 * 只读新追加的字节；文件变短（被轮转 / 截断）就从头重读。
 */
export class ForgetWatcher {
  private offset = 0;
  private carry = "";
  readonly set: ForgetSet = { ids: new Set(), norms: new Set() };

  constructor(private readonly auditPath: string) {
    this.refresh();
  }

  refresh(): ForgetSet {
    if (!existsSync(this.auditPath)) return this.set;
    const fd = openSync(this.auditPath, "r");
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.carry = "";
      }
      if (size === this.offset) return this.set;
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const text = this.carry + buf.toString("utf-8");
      const lastNl = text.lastIndexOf("\n");
      this.carry = lastNl >= 0 ? text.slice(lastNl + 1) : text;
      if (lastNl >= 0) collectForgets(text.slice(0, lastNl), this.set);
    } finally {
      closeSync(fd);
    }
    return this.set;
  }

  /** 这段文字（按它的入库 id 与归一文本）是否已被 forget */
  isForgotten(id: string, norm: string): boolean {
    return this.set.ids.has(id) || this.set.norms.has(fingerprintNormalized(norm));
  }
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

class Journal {
  constructor(private readonly path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }
  /** 追加失败直接抛错：意图日志写不进去就不许写库 */
  write(entries: object[]): void {
    if (!this.path || entries.length === 0) return;
    appendFileSync(this.path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

export interface ApplyDeps {
  store: MemoryStore;
  embedder: Pick<Embedder, "embedBatchPassage">;
  llm: LLMClient | null;
  auditLogger?: Pick<AuditLogger, "log"> | null;
}

export interface ApplyResult {
  inserted: number;
  insertSkippedExisting: number;
  insertSkippedForgotten: number;
  /** 没插进去的（嵌入失败、空向量、批次出错、id 被另一段文字占着）——它们所在的文件本轮不下架 */
  insertPending: number;
  insertErrors: string[];
  reactivatedReconcileRetired: number;
  reactivatedBrokenConsolidation: number;
  reactivateSkippedStateChanged: number;
  /** 规划之后这段文字被 forget 了：不恢复（第二次代码单审 F1） */
  reactivateSkippedForgotten: number;
  retired: number;
  /** 所在文件还有没插进去的段落，本轮先不下 */
  retireDeferredPendingInsert: number;
  /** 依赖它的合并链成员本轮没恢复成功，先不下 */
  retireDeferredDependency: number;
  retireSkippedStateChanged: number;
}

export interface ApplyContext {
  runId: string;
  journalPath: string | null;
  /** 下架是否被护栏（上限）拦下；拦下时只插入与恢复（因目标本轮下架而断的合并链也不恢复） */
  retireAllowed: boolean;
  forgetWatcher?: ForgetWatcher | null;
  now?: () => number;
}

interface InsertCandidate {
  item: PlannedInsert;
  vector: number[];
  extraction: Awaited<ReturnType<typeof smartExtractBatch>>[number];
  summary: string | null;
}

async function applyInserts(
  deps: ApplyDeps,
  inserts: PlannedInsert[],
  ctx: ApplyContext & { isoNow: string; journal: Journal },
  result: ApplyResult,
): Promise<Set<string>> {
  /** 已确认有着落的插入项（插进去了 / 库里已有同文 / forget 过不再插） */
  const settled = new Set<string>();
  for (let i = 0; i < inserts.length; i += INSERT_BATCH) {
    const batch = inserts.slice(i, i + INSERT_BATCH);
    try {
      const vectors = await deps.embedder.embedBatchPassage(batch.map((item) => item.chunk.text));
      const embedded: Array<{ item: PlannedInsert; vector: number[] }> = [];
      const emptyFiles = new Set<string>();
      batch.forEach((item, j) => {
        const vector = vectors[j];
        if (Array.isArray(vector) && vector.length > 0) embedded.push({ item, vector });
        else emptyFiles.add(item.chunk.file);
      });
      if (emptyFiles.size > 0) {
        result.insertErrors.push(`${batch.length - embedded.length} 段嵌入为空（${[...emptyFiles].join("、")}）`);
      }
      if (embedded.length === 0) continue;
      const texts = embedded.map(({ item }) => item.chunk.text);
      const extractions = await smartExtractBatch(texts, deps.llm);
      const summaries = await generateCoreSummaries(texts, deps.llm);
      // 规划之后才 forget 的也不插（互审 C3）：嵌入与 LLM 抽取都做完、写库前一刻再读一次审计日志
      ctx.forgetWatcher?.refresh();
      const toInsert: InsertCandidate[] = [];
      embedded.forEach(({ item, vector }, j) => {
        if (ctx.forgetWatcher?.isForgotten(item.id, item.chunk.norm)) {
          result.insertSkippedForgotten++;
          settled.add(item.id);
          return;
        }
        toInsert.push({ item, vector, extraction: extractions[j], summary: summaries[j] });
      });
      if (toInsert.length === 0) continue;
      const entries = toInsert.map(({ item, vector, extraction, summary }) => {
        const built = buildIngestedEntry({
          source: MEMORY_DOC_SCOPE,
          scope: MEMORY_DOC_SCOPE,
          text: item.chunk.text,
          vector,
          extraction,
          file: item.chunk.file,
          heading: item.chunk.heading,
          coreSummary: summary,
        });
        const meta = parseMeta(built.metadata);
        meta.reconcile = { v: 1, action: "inserted", at: ctx.isoNow, run: ctx.runId };
        return { ...built, category: built.category as MemoryEntry["category"], id: item.id, metadata: JSON.stringify(meta) };
      });
      // 写库前先落意图（含插入后应有的字段与正文指纹）：崩溃在写库与写结果之间时，撤销照样能核对这一行之后有没有被改过
      ctx.journal.write([{
        run: ctx.runId,
        phase: "intent",
        action: "insert",
        items: entries.map((e) => ({ id: e.id, after: journalFields(parseMeta(e.metadata)), textFp: textFingerprint(e.text) })),
      }]);
      const res = await deps.store.insertIfAbsent(entries);
      result.inserted += res.inserted.length;
      for (const id of res.inserted) settled.add(id);
      const itemById = new Map(toInsert.map(({ item }) => [item.id, item]));
      // 撞 id 被跳过：只有占着这个 id 的行正是同一段文字（别的写方刚插了同文），才算有了着落；
      // 正文不同说明 id 被另一段文字占着，这段文字仍没有代表——记为没插进去（所在文件本轮不下架、要人看）
      const skippedLines: object[] = [];
      for (const id of res.skippedExisting) {
        const item = itemById.get(id)!;
        const holder = await deps.store.getById(id);
        const sameText = !!holder && normalizeDedupText(holder.text) === item.chunk.norm;
        if (sameText) {
          result.insertSkippedExisting++;
          settled.add(id);
        } else {
          result.insertErrors.push(`id ${id.slice(0, 8)} 已被另一段文字占着，未插入（${item.chunk.file}）`);
        }
        // 没插进去也落一条结果：撤销据此知道这个 id 上的行不是本轮写的，不去动它
        skippedLines.push({ run: ctx.runId, action: "insert", id, file: item.chunk.file, inserted: false, skipped: sameText ? "same-text-exists" : "id-occupied" });
      }
      ctx.journal.write(skippedLines);
      const entryById = new Map(entries.map((e) => [e.id, e]));
      ctx.journal.write(res.inserted.map((id) => {
        const item = itemById.get(id)!;
        const entry = entryById.get(id)!;
        return {
          run: ctx.runId,
          action: "insert",
          id,
          file: item.chunk.file,
          inserted: true,
          after: journalFields(parseMeta(entry.metadata)),
          textFp: textFingerprint(entry.text),
          ...(item.occupiedPrimaryId ? { occupiedPrimaryId: item.occupiedPrimaryId } : {}),
        };
      }));
    } catch (err) {
      result.insertErrors.push(err instanceof Error ? err.message : String(err));
    }
  }
  result.insertPending = inserts.filter((item) => !settled.has(item.id)).length;
  return settled;
}

interface PatchItem {
  id: string;
  file: string | null;
  norm: string;
  expect: RowState;
  before: JournalFields;
}

async function applyPatches<T extends PatchItem>(
  deps: ApplyDeps,
  planned: T[],
  ctx: ApplyContext & { journal: Journal },
  check: (item: T, meta: Record<string, unknown>, text: string, scope: string) => boolean,
  mutate: (item: T, meta: Record<string, unknown>) => void,
  describe: (item: T) => { action: string; detail: string; auditOp: "archive" | "update" },
): Promise<{ applied: T[]; skipped: T[] }> {
  const applied: T[] = [];
  const skipped: T[] = [];
  for (let i = 0; i < planned.length; i += PATCH_BATCH) {
    const batch = planned.slice(i, i + PATCH_BATCH);
    const byId = new Map(batch.map((item) => [item.id, item]));
    const pending: object[] = [];
    const batchApplied: T[] = [];
    const seen = new Set<string>();
    // 写库前先落意图：崩溃在写库与写结果之间时，撤销据此知道这些行可能被本轮写过，再按行上的本轮标记
    // （提交时在写锁内记下的真实前值）核对与还原；这里的 before 是规划时的值，只供人工排查
    ctx.journal.write([{
      run: ctx.runId,
      phase: "intent",
      action: describe(batch[0]).action,
      items: batch.map((item) => ({ id: item.id, before: item.before })),
    }]);
    await deps.store.patchMetadataBatch(batch.map((item) => ({
      id: item.id,
      patchFn: (meta, entry) => {
        const planItem = byId.get(entry.id)!;
        seen.add(entry.id);
        if (!check(planItem, meta, entry.text, entry.scope)) {
          skipped.push(planItem);
          return meta;
        }
        const before = journalFields(meta);
        mutate(planItem, meta);
        const d = describe(planItem);
        pending.push({ run: ctx.runId, action: d.action, id: entry.id, file: planItem.file, detail: d.detail, before, after: journalFields(meta) });
        batchApplied.push(planItem);
        return meta;
      },
    })));
    for (const item of batch) if (!seen.has(item.id)) skipped.push(item); // 行已不在库
    ctx.journal.write(pending);
    applied.push(...batchApplied);
    for (const item of batchApplied) {
      const d = describe(item);
      try {
        deps.auditLogger?.log({ operation: d.auditOp, scope: MEMORY_DOC_SCOPE, memoryId: item.id, actor: "system", details: `${RECONCILE_NOTE_PREFIX} ${d.detail}` });
      } catch { /* 审计失败不影响对账 */ }
    }
  }
  return { applied, skipped };
}

/** 执行一份计划：插入 → 恢复 → 下架。调用方负责持锁。 */
export async function applyMemoryReconcile(
  deps: ApplyDeps,
  plan: MemoryReconcilePlan,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const nowMs = (ctx.now ?? Date.now)();
  const isoNow = new Date(nowMs).toISOString();
  const journal = new Journal(ctx.journalPath);
  const result: ApplyResult = {
    inserted: 0,
    insertSkippedExisting: 0,
    insertSkippedForgotten: 0,
    insertPending: 0,
    insertErrors: [],
    reactivatedReconcileRetired: 0,
    reactivatedBrokenConsolidation: 0,
    reactivateSkippedStateChanged: 0,
    reactivateSkippedForgotten: 0,
    retired: 0,
    retireDeferredPendingInsert: 0,
    retireDeferredDependency: 0,
    retireSkippedStateChanged: 0,
  };

  // 1. 插入
  const settled = await applyInserts(deps, plan.insert, { ...ctx, isoNow, journal }, result);
  const pendingFiles = new Set(plan.insert.filter((item) => !settled.has(item.id)).flatMap((item) => item.files));

  // 2. 恢复（在下架之前：先有代表再撤旧的）。因目标本轮下架而断的合并链，只在下架照常进行时才恢复。
  //    恢复前再读一次审计日志：规划之后被 forget 的文字（删的可能是同文的另一行）不恢复（第二次代码单审 F1）。
  ctx.forgetWatcher?.refresh();
  const deferRetireIds = new Set<string>();
  const toReactivate: PlannedReactivate[] = [];
  for (const item of plan.reactivate) {
    if (item.kind === "broken-consolidation" && item.targetRetiredThisRun && !ctx.retireAllowed) continue;
    if (ctx.forgetWatcher?.isForgotten(item.id, item.norm)) {
      result.reactivateSkippedForgotten++;
      for (const t of item.dependentRetireIds) deferRetireIds.add(t);
      continue;
    }
    toReactivate.push(item);
  }
  if (toReactivate.length > 0) {
    const { applied, skipped } = await applyPatches(
      deps,
      toReactivate,
      { ...ctx, journal },
      (item, meta, text, scope) => {
        const state = rowState(meta);
        if (scope !== MEMORY_DOC_SCOPE || !isMemoryDocSlice(meta) || normalizeDedupText(text) !== item.norm) return false;
        if (item.kind === "reconcile-retired") return isReconcileRetired(state);
        return state.status === "consolidated" && state.consolidatedInto === item.expect.consolidatedInto;
      },
      (item, meta) => {
        const prev = journalFields(meta);
        patchEvolutionOnMeta(meta, {
          status: "active",
          validUntil: null,
          evolutionNote: null,
          ...(item.kind === "broken-consolidation" ? { consolidatedInto: null } : {}),
        });
        meta.reconcile = { v: 1, action: "reactivated", kind: item.kind, at: isoNow, run: ctx.runId, prev: { ...prev, reconcile: stripPrev(prev.reconcile) } };
      },
      (item) => ({ action: "reactivate", detail: item.kind, auditOp: "update" }),
    );
    result.reactivatedReconcileRetired = applied.filter((i) => i.kind === "reconcile-retired").length;
    result.reactivatedBrokenConsolidation = applied.filter((i) => i.kind === "broken-consolidation").length;
    result.reactivateSkippedStateChanged = skipped.length;
    // 恢复没成功：这段文字此刻还靠那些本轮要下架的合并目标撑着，先别下（上线前代码单审 N3、第二次 F2）
    for (const item of skipped) for (const t of item.dependentRetireIds) deferRetireIds.add(t);
  }

  // 3. 下架：重复文本随时可下（同文的保留行仍活跃）；其余要等所在文件的新段落都有了着落；依赖未满足的都延后
  if (ctx.retireAllowed && plan.retire.length > 0) {
    const ready: PlannedRetire[] = [];
    for (const item of plan.retire) {
      if (deferRetireIds.has(item.id)) {
        result.retireDeferredDependency++;
      } else if (item.reason !== "duplicate-text" && item.file && pendingFiles.has(item.file)) {
        result.retireDeferredPendingInsert++;
      } else {
        ready.push(item);
      }
    }
    const { applied, skipped } = await applyPatches(
      deps,
      ready,
      { ...ctx, journal },
      (item, meta, text, scope) => scope === MEMORY_DOC_SCOPE
        && isMemoryDocSlice(meta)
        && normalizeDedupText(text) === item.norm
        && rowState(meta).status === item.expect.status,
      (item, meta) => {
        const prev = journalFields(meta);
        patchEvolutionOnMeta(meta, { status: "archived", validUntil: nowMs, evolutionNote: `${RECONCILE_NOTE_PREFIX} ${item.reason}` });
        meta.reconcile = { v: 1, action: "retired", reason: item.reason, at: isoNow, run: ctx.runId, file: item.file, prev: { ...prev, reconcile: stripPrev(prev.reconcile) } };
      },
      (item) => ({ action: "retire", detail: item.reason, auditOp: "archive" }),
    );
    result.retired = applied.length;
    result.retireSkippedStateChanged = skipped.length;
  }

  journal.write([{ run: ctx.runId, summary: result }]);
  return result;
}

// ---------------------------------------------------------------------------
// 编排：持锁 → 收集 → 规划 → 护栏 → 执行
// ---------------------------------------------------------------------------

export interface ReconcileOptions extends ApplyDeps {
  memDir: string;
  /**
   * 数据目录：锁（<dataDir>/locks）、审计（<dataDir>/audit.jsonl）、对账日志与护栏状态都在这里。
   * 必须是其他进程用的同一个目录（resolve(envConfig.dataDir())），CLI 会核对它与库所在目录一致。
   */
  dataDir: string;
  /** sources.memory.path 是否显式配置；auto 不允许对账 */
  explicitPath: boolean;
  apply: boolean;
  /** 覆盖默认的单轮下架上限 */
  maxRetire?: number;
  now?: () => number;
}

export type GuardReason = "dir-sanity" | "cap" | "insert-failed" | "lock-stale";

export interface ReconcileOutcome {
  ran: boolean;
  mode: "dry-run" | "apply";
  skippedReason?: string;
  runId: string;
  plan: MemoryReconcilePlan | null;
  maxRetire: number;
  /** 护栏：dir-sanity 整轮不写；cap 只拦下架；insert-failed 有段落没插进去；lock-stale 锁被活着的进程久占 */
  guard: { reason: GuardReason; detail: string } | null;
  applied: ApplyResult | null;
  journalPath: string | null;
  /** 要报警（护栏触发且距上次同因报警超过 24 小时）——ingest 据此以退出码 3 结束 */
  alert: boolean;
}

export function resolveMaxRetire(activeDocRows: number, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) return Math.floor(override);
  return envConfig.memoryReconcileMaxRetire()
    ?? Math.max(DEFAULT_MAX_RETIRE_FLOOR, Math.ceil(activeDocRows * DEFAULT_MAX_RETIRE_FRACTION));
}

export function guardStatePath(dataDir: string): string {
  return join(dataDir, "memory-reconcile-guard.json");
}

/**
 * 护栏报警去抖：同一原因 24 小时内只报一次（第三轮 Kimi / Agy：护栏持续触发时每天最多 7 次报警会被当噪音）。
 * 没有护栏触发时清掉状态，下次触发立刻报。
 */
export function decideGuardAlert(dataDir: string, guard: ReconcileOutcome["guard"], nowMs: number): boolean {
  const path = guardStatePath(dataDir);
  if (!guard) {
    if (existsSync(path)) rmSync(path, { force: true });
    return false;
  }
  let last: Record<string, unknown> = {};
  try {
    last = asRecord(JSON.parse(readFileSync(path, "utf-8"))) ?? {};
  } catch { /* 没有状态 = 没报过 */ }
  const lastAlertAt = typeof last.lastAlertAt === "number" ? last.lastAlertAt : null;
  const alert = last.reason !== guard.reason || lastAlertAt === null || nowMs - lastAlertAt >= GUARD_ALERT_INTERVAL_MS;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, JSON.stringify({
      reason: guard.reason,
      detail: guard.detail,
      lastAlertAt: alert ? nowMs : lastAlertAt,
      lastSeenAt: nowMs,
    }) + "\n");
  } catch { /* 写不了状态就每次都报，宁可吵 */ }
  return alert;
}

type LockedOutcome<T> = { ran: true; result: T } | { ran: false; busy: string };

async function withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<LockedOutcome<T>> {
  if (keys.length === 0) return { ran: true, result: await fn() };
  const [head, ...rest] = keys;
  let inner: LockedOutcome<T> = { ran: false, busy: head };
  const outcome = await withLock(head, async () => {
    inner = await withLocks(rest, fn);
  }, { onBusy: "skip", expireMs: NEVER_EXPIRE_MS });
  return outcome.ran ? inner : { ran: false, busy: head };
}

/** 刷新所持锁文件的 mtime：别的进程按 mtime 判断锁是否过期，长任务不刷就可能被当成死锁抢走。 */
function touchLocks(keys: readonly string[]): void {
  const now = new Date();
  for (const key of keys) {
    try {
      utimesSync(lockPathForKey(key), now, now);
    } catch { /* 锁文件不在就算了 */ }
  }
}

/** 拿齐三把锁、定期续期，再跑 fn；拿不齐就返回被谁占着 */
async function underReconcileLocks<T>(fn: () => Promise<T>): Promise<LockedOutcome<T>> {
  return withLocks(RECONCILE_LOCK_KEYS, async () => {
    const heartbeat = setInterval(() => touchLocks(RECONCILE_LOCK_KEYS), LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
    }
  });
}

function busyDescription(key: string): string {
  return key === "memory-reconcile" ? "另一轮对账或撤销" : key === "gc-run" ? "GC" : "dream 合并";
}

export async function reconcileMemoryDocuments(opts: ReconcileOptions): Promise<ReconcileOutcome> {
  const now = opts.now ?? Date.now;
  const runId = `mr-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`;
  if (!opts.explicitPath) {
    throw new Error("memory 对账需要显式配置 sources.memory.path（当前为 auto）；auto 路径请继续用 ingestMarkdownFiles");
  }
  if (!existsSync(opts.memDir) || !statSync(opts.memDir).isDirectory()) {
    throw new Error(`记忆目录不存在：${opts.memDir}`);
  }

  const run = async (): Promise<ReconcileOutcome> => {
    const forgetWatcher = new ForgetWatcher(join(opts.dataDir, "audit.jsonl"));
    const { chunks, fileNames } = collectCurrentChunks(opts.memDir);
    const existing = await loadMemoryScopeRows(opts.store);

    // 合并目标不在 scope "memory" 里的，单独查一次状态
    const known = new Set(existing.map((r) => r.id));
    const externalStatus = new Map<string, string>();
    for (const row of existing) {
      const target = rowState(row.meta).consolidatedInto;
      if (!target || known.has(target) || externalStatus.has(target)) continue;
      const entry = await opts.store.getById(target);
      if (entry) externalStatus.set(target, rowState(parseMeta(entry.metadata)).status);
    }

    const plan = planMemoryReconcile({
      current: chunks,
      currentFileNames: fileNames,
      existing,
      forgottenIds: new Set(forgetWatcher.set.ids),
      forgottenNorms: new Set(forgetWatcher.set.norms),
      externalStatus,
    });
    const maxRetire = resolveMaxRetire(plan.activeDocRows, opts.maxRetire);
    let guard: ReconcileOutcome["guard"] = null;
    if (plan.filesWithActiveDocRows > 0 && plan.currentFiles < plan.filesWithActiveDocRows * DIR_SANITY_MIN_RATIO) {
      guard = { reason: "dir-sanity", detail: `记忆目录现行文件 ${plan.currentFiles} 个，不到有活跃文档切片的文件数 ${plan.filesWithActiveDocRows} 的一半，本轮不写入` };
    } else if (plan.retire.length > maxRetire) {
      guard = { reason: "cap", detail: `计划下架 ${plan.retire.length} 条，超过单轮上限 ${maxRetire}，本轮只插入与恢复` };
    }

    if (!opts.apply) {
      return { ran: true, mode: "dry-run", runId, plan, maxRetire, guard, applied: null, journalPath: null, alert: false };
    }
    if (guard?.reason === "dir-sanity") {
      return { ran: true, mode: "apply", runId, plan, maxRetire, guard, applied: null, journalPath: null, alert: decideGuardAlert(opts.dataDir, guard, now()) };
    }

    const journalPath = join(opts.dataDir, "reconcile-journals", `memory-reconcile-${runId.slice(3)}.jsonl`);
    const applied = await applyMemoryReconcile(
      { store: opts.store, embedder: opts.embedder, llm: opts.llm, auditLogger: opts.auditLogger },
      plan,
      { runId, journalPath, retireAllowed: guard === null, forgetWatcher, now },
    );
    if (guard === null && applied.insertErrors.length > 0) {
      guard = { reason: "insert-failed", detail: `${applied.insertPending} 段没插进去（所在文件本轮不下架）：${applied.insertErrors.slice(0, 3).join("；")}` };
    }
    return { ran: true, mode: "apply", runId, plan, maxRetire, guard, applied, journalPath, alert: decideGuardAlert(opts.dataDir, guard, now()) };
  };

  // 只看计划不写库：不持锁，任何时候都能跑
  if (!opts.apply) return run();

  const outcome = await underReconcileLocks(run);
  if (!outcome.ran) {
    const holder = inspectLock(outcome.busy);
    const stale = holder.exists && holder.pidAlive && (holder.ageMs ?? 0) >= LOCK_STALE_ALERT_MS;
    const skippedReason = `${busyDescription(outcome.busy)}正在运行（锁 ${outcome.busy} 被进程 ${holder.pid ?? "?"} 占着${holder.ageMs !== null ? `、${Math.round(holder.ageMs / 60_000)} 分钟没更新` : ""}），本轮跳过`;
    const guard: ReconcileOutcome["guard"] = stale
      ? { reason: "lock-stale", detail: `超过 ${Math.round(LOCK_STALE_ALERT_MS / 3_600_000)} 小时没更新，对账会一直跳过，看一下那个进程` }
      : null;
    return {
      ran: false,
      mode: "apply",
      skippedReason,
      runId,
      plan: null,
      maxRetire: 0,
      guard,
      applied: null,
      journalPath: null,
      alert: stale ? decideGuardAlert(opts.dataDir, guard, now()) : false,
    };
  }
  return outcome.result;
}

export function formatReconcileSummary(outcome: ReconcileOutcome): string {
  if (!outcome.ran || !outcome.plan) {
    let line = `对账跳过：${outcome.skippedReason ?? "未知原因"}`;
    if (outcome.guard) line += `。⚠️ 护栏（${outcome.guard.reason}）：${outcome.guard.detail}${outcome.alert ? "" : "（同一原因 24 小时内已报过警，这次只记日志）"}`;
    return line;
  }
  const p = outcome.plan;
  const a = outcome.applied;
  const reactA = p.reactivate.filter((r) => r.kind === "reconcile-retired").length;
  const reactB = p.reactivate.filter((r) => r.kind === "broken-consolidation").length;
  const parts = [
    `现行 ${p.currentChunks} 段 / ${p.currentFiles} 个文件`,
    `保留 ${p.keep}`,
    a ? `插入 ${a.inserted}` : `计划插入 ${p.insert.length}`,
    ...(p.insertAltId ? [`其中 ${p.insertAltId} 段的原 id 被另一段正文占着、用备用 id`] : []),
    a ? `恢复 ${a.reactivatedReconcileRetired}+${a.reactivatedBrokenConsolidation}` : `计划恢复 ${reactA}+${reactB}`,
    a ? `下架 ${a.retired}` : `计划下架 ${p.retire.length}`,
    `合并链完好 ${p.representedByConsolidation}`,
    `例外 forget ${p.exceptionForgotten} / 其他下架 ${p.exceptionOtherInactive}`,
  ];
  if (a) {
    const extra: string[] = [];
    if (a.insertSkippedExisting) extra.push(`插入时已存在同文 ${a.insertSkippedExisting}`);
    if (a.insertSkippedForgotten) extra.push(`插入前刚被 forget ${a.insertSkippedForgotten}`);
    if (a.reactivateSkippedForgotten) extra.push(`恢复前刚被 forget ${a.reactivateSkippedForgotten}`);
    if (a.retireDeferredPendingInsert) extra.push(`待插入文件的下架延后 ${a.retireDeferredPendingInsert}`);
    if (a.retireDeferredDependency) extra.push(`合并链成员没恢复成的下架延后 ${a.retireDeferredDependency}`);
    const changed = a.retireSkippedStateChanged + a.reactivateSkippedStateChanged;
    if (changed) extra.push(`提交时状态已变跳过 ${changed}`);
    if (extra.length) parts.push(extra.join("，"));
  }
  let line = parts.join("，");
  if (outcome.guard) {
    line += `。⚠️ 护栏（${outcome.guard.reason}）：${outcome.guard.detail}`;
    if (outcome.mode === "apply" && !outcome.alert) line += "（同一原因 24 小时内已报过警，这次只记日志）";
  }
  return line;
}

// ---------------------------------------------------------------------------
// 撤销
// ---------------------------------------------------------------------------

export interface UndoResult {
  restored: number;
  insertsRetired: number;
  skippedConflict: string[];
  /**
   * 撤了会造出断链而没撤的：合并链成员的恢复（它原来指向的那一行现在不活跃、或本次撤销会把它撤成不活跃），
   * 以及此刻有合并成员指向的插入行 / 恢复行
   */
  skippedDependency: string[];
  /** 撤回去会让一段已被 forget 的文字重新活跃：保留非活跃 */
  skippedForgotten: string[];
  /** 日志里解析不了的行（比如写到一半崩溃留下的截断尾行） */
  unparsedLines: number;
  undoJournalPath: string;
}

interface UndoRecord {
  run: string;
  action: "insert" | "retire" | "reactivate";
  id: string;
  /** 结果行的实际前值（只有意图行时不用它，改用行上 reconcile.prev 存的提交时前值） */
  before?: JournalFields;
  /** 结果行的实际后值；插入的意图行也带（插入前就知道） */
  after?: JournalFields;
  textFp?: string;
  /** 只有意图、没有结果（崩溃在写库与写结果之间） */
  intentOnly: boolean;
}

const UNDO_ACTIONS: ReadonlySet<string> = new Set(["insert", "retire", "reactivate"]);

function asJournalFields(value: unknown): JournalFields | undefined {
  const r = asRecord(value);
  return r ? (r as unknown as JournalFields) : undefined;
}

function readUndoRecords(journalPath: string): { records: UndoRecord[]; unparsed: number } {
  const results = new Map<string, UndoRecord>();
  const intents = new Map<string, UndoRecord>();
  /** 插入时撞 id 被跳过的：这个 id 上的行不是本轮写的 */
  const notWritten = new Set<string>();
  let unparsed = 0;
  for (const line of readFileSync(journalPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown> | null;
    try {
      rec = asRecord(JSON.parse(line));
    } catch {
      unparsed++;
      continue;
    }
    if (!rec || typeof rec.run !== "string" || typeof rec.action !== "string" || !UNDO_ACTIONS.has(rec.action)) continue;
    const run = rec.run;
    const action = rec.action as UndoRecord["action"];
    if (rec.phase === "intent") {
      if (Array.isArray(rec.items)) {
        for (const it of rec.items) {
          const item = asRecord(it);
          if (!item || typeof item.id !== "string") continue;
          intents.set(item.id, {
            run,
            action,
            id: item.id,
            after: action === "insert" ? asJournalFields(item.after) : undefined,
            textFp: typeof item.textFp === "string" ? item.textFp : undefined,
            intentOnly: true,
          });
        }
      }
      continue;
    }
    if (typeof rec.id !== "string") continue;
    if (action === "insert" && rec.inserted === false) {
      notWritten.add(rec.id);
      continue;
    }
    results.set(rec.id, {
      run,
      action,
      id: rec.id,
      before: asJournalFields(rec.before),
      after: asJournalFields(rec.after),
      textFp: typeof rec.textFp === "string" ? rec.textFp : undefined,
      intentOnly: false,
    });
  }
  for (const [id, rec] of intents) if (!results.has(id) && !notWritten.has(id)) results.set(id, rec);
  return { records: [...results.values()], unparsed };
}

/**
 * 只有意图行时，从行上的本轮标记推出「当时写成了什么样」与「写之前是什么样」（reconcile.prev 是提交时在写锁内记下的真实前值）。
 * 推不出来（标记不是本轮这个动作、没有前值）就返回 null，调用方按冲突跳过。
 */
function expectedFromMarker(meta: Record<string, unknown>, rec: UndoRecord): { before: JournalFields; after: JournalFields } | null {
  const marker = asRecord(meta.reconcile);
  const expectedAction = rec.action === "retire" ? "retired" : "reactivated";
  if (!marker || marker.run !== rec.run || marker.action !== expectedAction) return null;
  const prev = asJournalFields(marker.prev);
  if (!prev) return null;
  if (rec.action === "retire") {
    const at = typeof marker.at === "string" ? Date.parse(marker.at) : NaN;
    if (!Number.isFinite(at) || typeof marker.reason !== "string") return null;
    return {
      before: prev,
      after: { status: "archived", validUntil: at, evolutionNote: `${RECONCILE_NOTE_PREFIX} ${marker.reason}`, consolidatedInto: prev.consolidatedInto, reconcile: marker },
    };
  }
  return {
    before: prev,
    after: {
      status: "active",
      validUntil: null,
      evolutionNote: null,
      consolidatedInto: marker.kind === "broken-consolidation" ? null : prev.consolidatedInto,
      reconcile: marker,
    },
  };
}

/**
 * 按对账日志逐条撤销，整轮持有与对账相同的三把锁。
 * - 下架、恢复：只在「当前值 == 当时写成的样子」时写回写之前的值。有结果行用结果行；只有意图行的，用行上本轮标记里
 *   存的提交时前值，并按标记推出当时写成的样子来核对——之后被改过就跳过，绝不拿规划时的旧值覆盖。
 * - 合并链成员的恢复：它原来指向的那一行必须此刻活跃、而且不在本次撤销要撤成不活跃的名单里，否则保留成员并列出。
 * - 插入与恢复的撤销会让行失活：此刻已有合并成员指向它的（对账之后 dream 合并进来的），保留并列出。
 * - 撤回去会让一行重新活跃的（撤下架），先查审计里的 forget：这段文字已被 forget 就保留非活跃并列出。
 * - 插入：当前字段与正文指纹都等于插入时的样子才改成 archived（undo-insert），不删行；之后被改过的保留。
 * 后做的先撤：下架 → 恢复 → 插入。撤销之后要么把 sources.memory.path 改回 auto，要么暂停导入——
 * 否则下一轮对账会按现行文件重新对一遍。
 */
export async function undoMemoryReconcile(
  deps: { store: MemoryStore; auditLogger?: Pick<AuditLogger, "log"> | null },
  journalPath: string,
  opts: { now?: () => number; auditPath?: string } = {},
): Promise<UndoResult> {
  const outcome = await underReconcileLocks(() => undoUnlocked(deps, journalPath, opts));
  if (!outcome.ran) {
    throw new Error(`撤销没执行：${busyDescription(outcome.busy)}正在运行（锁 ${outcome.busy} 被占用），稍后再试`);
  }
  return outcome.result;
}

async function undoUnlocked(
  deps: { store: MemoryStore; auditLogger?: Pick<AuditLogger, "log"> | null },
  journalPath: string,
  opts: { now?: () => number; auditPath?: string },
): Promise<UndoResult> {
  const { records, unparsed } = readUndoRecords(journalPath);
  const forgets = opts.auditPath ? loadForgetSet(opts.auditPath) : null;
  const nowMs = (opts.now ?? Date.now)();
  const isoNow = new Date(nowMs).toISOString();
  const undoRun = `undo-${isoNow.replace(/[:.]/g, "-")}`;
  const undoJournalPath = `${journalPath.replace(/\.jsonl$/, "")}.${undoRun}.jsonl`;
  const journal = new Journal(undoJournalPath);
  const result: UndoResult = {
    restored: 0,
    insertsRetired: 0,
    skippedConflict: [],
    skippedDependency: [],
    skippedForgotten: [],
    unparsedLines: unparsed,
    undoJournalPath,
  };

  // 本次撤销会撤成不活跃的行：插入的行（改成 archived）与恢复过的行（撤回原来的非活跃状态）。
  // 合并链成员原来指向的若在其中，撤成员就会和它一起失活——按撤销完成后的样子判依赖（第二次代码单审 F3）。
  const willDeactivate = new Set(records.filter((r) => r.action === "insert" || r.action === "reactivate").map((r) => r.id));
  // 反过来：此刻已有合并成员指向的行（比如对账之后 dream 把别的行合并进了本轮插入或恢复的行），撤成不活跃也会造出断链
  const targetsInUse = new Set<string>();
  if (willDeactivate.size > 0) {
    for (const row of await loadMemoryScopeRows(deps.store)) {
      const st = rowState(row.meta);
      if (st.status === "consolidated" && st.consolidatedInto) targetsInUse.add(st.consolidatedInto);
    }
  }

  const restore = (meta: Record<string, unknown>, before: JournalFields) => {
    patchEvolutionOnMeta(meta, {
      status: before.status as EvolutionMetadata["status"],
      validUntil: typeof before.validUntil === "number" ? before.validUntil : null,
      evolutionNote: before.evolutionNote,
      consolidatedInto: before.consolidatedInto,
    });
    if (before.reconcile === null || before.reconcile === undefined) delete meta.reconcile;
    else meta.reconcile = before.reconcile;
  };

  const phases: Array<UndoRecord["action"]> = ["retire", "reactivate", "insert"];
  for (const phase of phases) {
    const list = records.filter((r) => r.action === phase);
    for (let i = 0; i < list.length; i += PATCH_BATCH) {
      const batch = list.slice(i, i + PATCH_BATCH);
      const dependencyOk = new Set<string>();
      if (phase === "reactivate") {
        for (const rec of batch) {
          const current = await deps.store.getById(rec.id);
          const before = rec.intentOnly
            ? (current ? expectedFromMarker(parseMeta(current.metadata), rec)?.before : undefined)
            : rec.before;
          const target = before?.status === "consolidated" ? before.consolidatedInto : null;
          if (!target) {
            dependencyOk.add(rec.id);
            continue;
          }
          if (willDeactivate.has(target)) continue;
          const holder = await deps.store.getById(target);
          if (holder && isActiveStatus(rowState(parseMeta(holder.metadata)).status)) dependencyOk.add(rec.id);
        }
      }
      const byId = new Map(batch.map((r) => [r.id, r]));
      const pending: object[] = [];
      const seen = new Set<string>();
      await deps.store.patchMetadataBatch(batch.map((rec) => ({
        id: rec.id,
        patchFn: (meta, entry) => {
          const r = byId.get(entry.id)!;
          seen.add(entry.id);
          const current = journalFields(meta);
          if (r.action !== "retire" && targetsInUse.has(entry.id)) {
            result.skippedDependency.push(r.id);
            return meta;
          }
          if (r.action === "insert") {
            const untouched = !!r.after
              && stableStringify(current) === stableStringify(r.after)
              && !!r.textFp && r.textFp === textFingerprint(entry.text);
            if (!untouched) {
              result.skippedConflict.push(r.id);
              return meta;
            }
            patchEvolutionOnMeta(meta, { status: "archived", validUntil: nowMs, evolutionNote: `${RECONCILE_NOTE_PREFIX} undo-insert` });
            meta.reconcile = { v: 1, action: "retired", reason: "undo-insert", at: isoNow, run: undoRun };
            pending.push({ run: undoRun, action: "undo-insert", id: r.id, before: current, after: journalFields(meta) });
            result.insertsRetired++;
            return meta;
          }
          if (r.action === "reactivate" && !dependencyOk.has(r.id)) {
            result.skippedDependency.push(r.id);
            return meta;
          }
          const expected = r.intentOnly
            ? expectedFromMarker(meta, r)
            : (r.before && r.after ? { before: r.before, after: r.after } : null);
          if (!expected || stableStringify(current) !== stableStringify(expected.after)) {
            result.skippedConflict.push(r.id);
            return meta;
          }
          // 撤回去会重新活跃（撤下架）：这段文字已被 forget 就不撤
          if (isActiveStatus(expected.before.status) && forgets && isTextForgotten(forgets, entry.text, entry.id)) {
            result.skippedForgotten.push(r.id);
            return meta;
          }
          restore(meta, expected.before);
          pending.push({ run: undoRun, action: `undo-${r.action}`, id: r.id, before: current, after: journalFields(meta) });
          result.restored++;
          return meta;
        },
      })));
      for (const rec of batch) if (!seen.has(rec.id)) result.skippedConflict.push(rec.id);
      journal.write(pending);
    }
  }
  try {
    deps.auditLogger?.log({ operation: "update", scope: MEMORY_DOC_SCOPE, actor: "system", details: `${RECONCILE_NOTE_PREFIX} undo restored=${result.restored} insertsRetired=${result.insertsRetired} conflicts=${result.skippedConflict.length} dependency=${result.skippedDependency.length} forgotten=${result.skippedForgotten.length}` });
  } catch { /* 审计失败不影响撤销 */ }
  return result;
}
