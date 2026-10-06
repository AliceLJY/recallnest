/**
 * Checkpoint mirror — make session checkpoints findable by ordinary memory search.
 *
 * Checkpoints live as JSON files (session-store.ts) and are only read back per session by
 * resume_context / latest_checkpoint; search_memory never saw them. On every save, both
 * write entry points (MCP checkpoint_session, HTTP POST /v1/checkpoint) also mirror the
 * checkpoint into the memory table: one row per session in scope `checkpoint`, overwritten
 * in place by each newer checkpoint of that session. The JSON files remain the history —
 * the mirror keeps no superseded rows, so old versions never compete for retrieval slots.
 *
 * Measured before launch (sync-bridge AI产出/2026-10-07-RecallNest第一下命中率/):
 * first-hit "roughly close" +4–5 / 48 queries, none pushed out. Entry text = that trial's
 * `ent` variant; the follow-up ranking trial found no shorter / re-weighted variant better.
 *
 * Invariants:
 *  - A mirror failure never fails the checkpoint save: mirrorCheckpoint never throws.
 *  - At most one row per session: the row id is derived from the exact sessionId.
 *  - A row only moves forward: an older checkpoint (by updatedAt, then checkpointId — the
 *    same order session-store uses) never overwrites a newer one, also across processes
 *    (compare-and-write under one cross-process lock).
 *
 * Kill switch, read on every call so running processes stop without a restart:
 * `RECALLNEST_CHECKPOINT_MIRROR=off`, or the file data/checkpoint-mirror.off.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { metaDir } from "./compat.js";
import { withWriteLock } from "./distill-lock.js";
import type { Embedder } from "./embedder.js";
import * as envConfig from "./env-config.js";
import { detectLang, tokenizeFts } from "./language-hook.js";
import { CHECKPOINT_MIRROR_SCOPE, type MemoryBoundaryMetadata } from "./memory-boundaries.js";
import { redactSecrets } from "./pii-detector.js";
import type { SessionCheckpointRecord } from "./session-schema.js";
import { checkpointFileName, classifyCheckpointQuality } from "./session-store.js";
import { logWarn } from "./stderr-log.js";
import { deterministicId, escapeSqlLiteral, loadLanceDB, type MemoryEntry, type MemoryStore } from "./store.js";

export { CHECKPOINT_MIRROR_SCOPE };
const MIRROR_CATEGORY = "events" as const;
const MIRROR_IMPORTANCE = 0.5;
const MIRROR_TIER = "peripheral";
const MIRROR_LOCK_KEY = "checkpoint-mirror-write";
const DEFAULT_OFF_FILE = resolve(metaDir(import.meta), "../data/checkpoint-mirror.off");
const CST_OFFSET_MS = 8 * 3_600_000;

const MIRROR_BOUNDARY: MemoryBoundaryMetadata = {
  layer: "session",
  authority: "session-checkpoint",
  conflictPolicy: "latest-wins",
  originalCategory: MIRROR_CATEGORY,
  note: "Session checkpoint mirrored for search; latest checkpoint per session wins.",
};

export type CheckpointMirrorStatus =
  | "stored"
  | "replaced"
  | "refreshed"
  | "unchanged"
  | "skipped-minimal"
  | "skipped-stale"
  | "disabled"
  | "failed";

export interface CheckpointMirrorResult {
  status: CheckpointMirrorStatus;
  id?: string;
  error?: string;
}

export interface CheckpointMirrorDeps {
  store: Pick<MemoryStore, "getById" | "upsertUnlessNewer">;
  embedder: Pick<Embedder, "embedPassage">;
  /** Kill-switch file; defaults to data/checkpoint-mirror.off next to the checkpoint files. */
  offFile?: string;
  /** Lock directory override (tests). */
  lockDir?: string;
}

export function checkpointMirrorEnabled(offFile: string = DEFAULT_OFF_FILE): boolean {
  if (!envConfig.checkpointMirror()) return false;
  return !existsSync(offFile);
}

/** Stable per-session key. A digest of the exact sessionId: normalizeCanonicalKey would lowercase,
 * fold punctuation and truncate, letting distinct sessions (task_a / task-a / ABC / abc) collide. */
export function checkpointMirrorKey(sessionId: string): string {
  return `checkpoint-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

export function checkpointMirrorId(sessionId: string): string {
  return deterministicId(CHECKPOINT_MIRROR_SCOPE, checkpointMirrorKey(sessionId));
}

/**
 * Entry text (the trial's `ent` variant — swap the format here only):
 *   line 1  YYYY-MM-DD (updatedAt in Beijing time) + " " + task   (date only when no task)
 *   line 2  summary
 *   then    decisions / openLoops / nextActions, one line each, items joined by "；"
 *   last    entities joined by "、"
 * Empty lines are dropped; no field names or labels; files are left out.
 */
export function buildCheckpointMirrorText(record: SessionCheckpointRecord): string {
  const date = new Date(Date.parse(record.updatedAt) + CST_OFFSET_MS).toISOString().slice(0, 10);
  const task = record.task?.trim();
  const lines = [task ? `${date} ${task}` : date, record.summary.trim()];
  for (const items of [record.decisions, record.openLoops, record.nextActions]) {
    if (items.length > 0) lines.push(items.map((item) => item.trim()).join("；"));
  }
  if (record.entities.length > 0) lines.push(record.entities.join("、"));
  return lines.filter(Boolean).join("\n");
}

/** Same order as session-store's newest-first sort: updatedAt, then checkpointId. */
export function compareCheckpointVersion(
  a: { updatedAt: string; checkpointId: string },
  b: { updatedAt: string; checkpointId: string },
): number {
  const timeDiff = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  if (timeDiff !== 0) return timeDiff;
  return a.checkpointId.localeCompare(b.checkpointId);
}

function parseMeta(metadata?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The checkpoint version a mirror row holds; null for rows this module did not write. */
function mirroredVersion(entry: MemoryEntry): { updatedAt: string; checkpointId: string } | null {
  const meta = parseMeta(entry.metadata);
  if (meta.checkpointMirror !== true) return null;
  const updatedAt = meta.checkpointUpdatedAt;
  const checkpointId = meta.checkpointId;
  return typeof updatedAt === "string" && typeof checkpointId === "string" ? { updatedAt, checkpointId } : null;
}

function buildMirrorMetadata(record: SessionCheckpointRecord, text: string, previous: MemoryEntry | null): string {
  const lines = text.split("\n");
  const prevMeta = previous ? parseMeta(previous.metadata) : {};
  // Access stats and tier promotions belong to the session's row, not to one checkpoint version.
  const prevEvolution = prevMeta.evolution as Record<string, unknown> | undefined;
  const carriedEvolution = prevEvolution && (prevEvolution.accessCount != null || prevEvolution.lastAccessedAt != null)
    ? { evolution: { accessCount: prevEvolution.accessCount, lastAccessedAt: prevEvolution.lastAccessedAt } }
    : {};
  return JSON.stringify({
    source: "checkpoint",
    sessionId: record.sessionId,
    file: `session-checkpoints/${checkpointFileName(record)}`,
    l0_abstract: lines[0].slice(0, 120),
    l1_overview: lines[1] ?? "",
    l2_content: text,
    tier: typeof prevMeta.tier === "string" ? prevMeta.tier : MIRROR_TIER,
    boundary: MIRROR_BOUNDARY,
    canonicalKey: checkpointMirrorKey(record.sessionId),
    checkpointMirror: true,
    checkpointId: record.checkpointId,
    checkpointUpdatedAt: record.updatedAt,
    resolvedScope: record.resolvedScope,
    ...carriedEvolution,
  });
}

/**
 * Whether `record` should be written over `existing`:
 *  - no row yet, or a row this module did not write → write;
 *  - existing row holds an older version → write (same text: only timestamp / metadata move on);
 *  - same version, same text → unchanged; same version, different text (the entry format
 *    changed and the backfill is re-run) → write;
 *  - existing row holds a newer version → skipped-stale.
 */
function decideMirrorWrite(
  existing: MemoryEntry | null,
  record: SessionCheckpointRecord,
  text: string,
): "write" | "unchanged" | "skipped-stale" {
  const version = existing ? mirroredVersion(existing) : null;
  if (!existing || !version) return "write";
  const cmp = compareCheckpointVersion(record, version);
  if (cmp < 0) return "skipped-stale";
  if (cmp === 0 && existing.text === text) return "unchanged";
  return "write";
}

/**
 * Mirror one checkpoint. Never throws — every failure comes back as status "failed" and a
 * one-line stderr warning (session id and error message only, never the checkpoint text).
 */
export async function mirrorCheckpoint(
  deps: CheckpointMirrorDeps,
  record: SessionCheckpointRecord,
): Promise<CheckpointMirrorResult> {
  try {
    if (!checkpointMirrorEnabled(deps.offFile)) return { status: "disabled" };
    if (classifyCheckpointQuality(record) === "minimal") return { status: "skipped-minimal" };

    const text = redactSecrets(buildCheckpointMirrorText(record)).text;
    const id = checkpointMirrorId(record.sessionId);

    // Decide outside the lock whether an embedding is needed (the slow part), then
    // re-read and decide again inside the lock before writing.
    const before = await deps.store.getById(id);
    const early = decideMirrorWrite(before, record, text);
    if (early !== "write") return { status: early, id };
    const vector = before && before.text === text && before.vector.length > 0
      ? before.vector
      : await deps.embedder.embedPassage(text);

    return await withWriteLock(MIRROR_LOCK_KEY, async (): Promise<CheckpointMirrorResult> => {
      // Re-checked under the lock: a rollback that turns the mirror off while an embedding
      // is in flight must not see that write land after its scope delete.
      if (!checkpointMirrorEnabled(deps.offFile)) return { status: "disabled" };
      const current = await deps.store.getById(id);
      const decision = decideMirrorWrite(current, record, text);
      if (decision !== "write") return { status: decision, id };
      const language = detectLang(text);
      const written = await deps.store.upsertUnlessNewer({
        id,
        text,
        vector,
        category: MIRROR_CATEGORY,
        scope: CHECKPOINT_MIRROR_SCOPE,
        importance: MIRROR_IMPORTANCE,
        timestamp: Date.parse(record.updatedAt),
        metadata: buildMirrorMetadata(record, text, current),
        language,
        fts_text: tokenizeFts(text, language),
      });
      // The merge itself refuses to move a row back in time — this catches a writer whose lock
      // expired mid-write while a newer checkpoint got in (timestamp = the checkpoint's updatedAt).
      if (!written) return { status: "skipped-stale", id };
      const status: CheckpointMirrorStatus = !current ? "stored" : current.text === text ? "refreshed" : "replaced";
      return { status, id };
    }, { expireMs: 60_000, ...(deps.lockDir ? { lockDir: deps.lockDir } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`[checkpoint-mirror] session=${record.sessionId} failed: ${message}`);
    return { status: "failed", error: message };
  }
}

/**
 * Entry-point wrapper: resolves deps lazily (a failing component factory is caught too) and
 * stops waiting after `deadlineMs` — the write itself keeps going in the background — so a
 * stuck embedding endpoint cannot hold up the checkpoint response.
 */
export async function mirrorCheckpointWithDeadline(
  resolveDeps: () => CheckpointMirrorDeps,
  record: SessionCheckpointRecord,
  deadlineMs = 20_000,
): Promise<CheckpointMirrorResult | { status: "pending" }> {
  let deps: CheckpointMirrorDeps;
  try {
    deps = resolveDeps();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`[checkpoint-mirror] session=${record.sessionId} failed: ${message}`);
    return { status: "failed", error: message };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ status: "pending" }>((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline({ status: "pending" }), deadlineMs);
  });
  const work = mirrorCheckpoint(deps, record);
  const outcome = await Promise.race([work, deadline]);
  if (timer) clearTimeout(timer);
  if (outcome.status === "pending") {
    logWarn(`[checkpoint-mirror] session=${record.sessionId} still writing after ${deadlineMs}ms; continuing in background`);
  }
  return outcome;
}

export interface CheckpointMirrorBackfillResult {
  checkpoints: number;
  sessions: number;
  /** Sessions with no rich checkpoint at all — nothing to mirror. */
  sessionsWithoutRich: number;
  /** Per-status counts; a dry run reports what a real run would do (would-embed / unchanged / skipped-stale). */
  statuses: Record<string, number>;
}

/** Pick each session's newest rich checkpoint (same order as compareCheckpointVersion). */
export function selectLatestRichPerSession(records: SessionCheckpointRecord[]): {
  selected: SessionCheckpointRecord[];
  sessions: number;
  sessionsWithoutRich: number;
} {
  const bySession = new Map<string, SessionCheckpointRecord[]>();
  for (const record of records) {
    const list = bySession.get(record.sessionId) ?? [];
    list.push(record);
    bySession.set(record.sessionId, list);
  }
  const selected: SessionCheckpointRecord[] = [];
  let sessionsWithoutRich = 0;
  for (const list of bySession.values()) {
    const rich = list.filter((record) => classifyCheckpointQuality(record) === "rich");
    if (rich.length === 0) {
      sessionsWithoutRich++;
      continue;
    }
    selected.push(rich.reduce((best, record) => (compareCheckpointVersion(record, best) > 0 ? record : best)));
  }
  selected.sort(compareCheckpointVersion);
  return { selected, sessions: bySession.size, sessionsWithoutRich };
}

/**
 * One-time (and re-runnable) backfill: mirror every session's newest rich checkpoint, oldest
 * first, one at a time. Rows already holding that version come back "unchanged", so a re-run
 * embeds nothing new.
 */
export async function backfillCheckpointMirror(
  deps: CheckpointMirrorDeps,
  records: SessionCheckpointRecord[],
  options: { dryRun?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<CheckpointMirrorBackfillResult> {
  const { selected, sessions, sessionsWithoutRich } = selectLatestRichPerSession(records);
  const statuses: Record<string, number> = {};
  const bump = (status: string) => { statuses[status] = (statuses[status] ?? 0) + 1; };
  for (const [index, record] of selected.entries()) {
    if (options.dryRun) {
      if (!checkpointMirrorEnabled(deps.offFile)) {
        bump("disabled");
      } else {
        const existing = await deps.store.getById(checkpointMirrorId(record.sessionId));
        const text = redactSecrets(buildCheckpointMirrorText(record)).text;
        const decision = decideMirrorWrite(existing, record, text);
        bump(decision !== "write" ? decision : existing?.text === text ? "would-refresh" : "would-embed");
      }
    } else {
      bump((await mirrorCheckpoint(deps, record)).status);
    }
    options.onProgress?.(index + 1, selected.length);
  }
  return { checkpoints: records.length, sessions, sessionsWithoutRich, statuses };
}

/**
 * A getById that only reads: connect + openTable + query, never MemoryStore's initialization
 * (which may add columns, create the table or build the FTS index). For --dry-run, so that a
 * dry run against the production store provably writes nothing.
 */
export async function openReadOnlyMirrorReader(dbPath: string): Promise<Pick<MemoryStore, "getById">> {
  const lancedb = await loadLanceDB();
  const table = await (await lancedb.connect(dbPath)).openTable("memories");
  return {
    async getById(id: string): Promise<MemoryEntry | null> {
      const rows = await table.query()
        .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"])
        .where(`id = '${escapeSqlLiteral(id)}'`)
        .limit(1)
        .toArray();
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        id: String(row.id),
        text: String(row.text),
        vector: [],
        category: row.category as MemoryEntry["category"],
        scope: String(row.scope ?? ""),
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadata: String(row.metadata || "{}"),
      };
    },
  };
}

export interface CheckpointMirrorPurgeResult {
  rowsBefore: number;
  rowsAfter: number;
}

/**
 * Rollback: turn the mirror off (create the off file), then — holding the mirror's write lock, so
 * a write that already passed its own off-check finishes first — delete every row whose scope is
 * exactly `checkpoint`. Writers that reach the lock afterwards see the off file and stop.
 * Residual: a writer frozen for longer than the lock's 60 s expiry inside its millisecond-long
 * locked section could still insert after the delete; count again a few minutes later.
 */
export async function purgeCheckpointMirror(
  dbPath: string,
  options: { offFile?: string; lockDir?: string } = {},
): Promise<CheckpointMirrorPurgeResult> {
  const offFile = options.offFile ?? DEFAULT_OFF_FILE;
  mkdirSync(dirname(offFile), { recursive: true });
  writeFileSync(offFile, `checkpoint mirror turned off for purge at ${new Date().toISOString()}\n`);
  const lancedb = await loadLanceDB();
  const table = await (await lancedb.connect(dbPath)).openTable("memories");
  const exact = `scope = '${escapeSqlLiteral(CHECKPOINT_MIRROR_SCOPE)}'`;
  return withWriteLock(MIRROR_LOCK_KEY, async () => {
    const rowsBefore = await table.countRows(exact);
    if (rowsBefore > 0) {
      await withWriteLock("store-write", async () => { await table.delete(exact); }, {
        expireMs: 30_000,
        ...(options.lockDir ? { lockDir: options.lockDir } : {}),
      });
    }
    return { rowsBefore, rowsAfter: await table.countRows(exact) };
  }, { expireMs: 60_000, waitTimeoutMs: 120_000, ...(options.lockDir ? { lockDir: options.lockDir } : {}) });
}
