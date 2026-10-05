/**
 * Forget Engine — ethics-aware memory deletion, with a read-back.
 *
 * Philosophy: "The right to forget" — a memory can be explicitly removed, the
 * removal is auditable, and it reaches the places this engine knows the memory
 * left a copy or a pointer in.
 *
 * Sequence (the step comments in forgetMemory() carry the same numbers and names;
 * forget-cascade-completeness.test.ts fails if the two lists drift apart):
 * 1. Fetch target
 * 2. Privacy tier check (durable requires explicit confirm)
 * 3. Evidence snapshot (returned to the caller, not persisted)
 * 4. Trigger rows (delete its rows in memory_triggers; a failure aborts before anything is touched)
 * 5. Pin archive (delete the indexed copy of each pin made from it, then move the pin files out of data/pins; a failure aborts, the primary row stays)
 * 6. KG triples (KGStore.deleteBySource; a failure is logged and the forget continues)
 * 7. Cascade demote (related memories lose importance, via cascade-forget.ts)
 * 8. Evolution breadcrumb (mark the row archived with a "forgotten:" note just before deleting it)
 * 9. Primary delete (remove the row from LanceDB)
 * 10. Read-back (fetch the id again; count what is left in triggers, pins, pin index rows and KG)
 * 11. Audit log (record the operation and what the read-back found)
 *
 * Steps 4 and 5 fail closed and run before the primary delete: once the row is
 * gone, forget() can no longer find the id, so whatever they left behind would
 * have no tool to remove it.
 *
 * When a forget stops part-way:
 * - at step 4, nothing has been changed;
 * - at step 5, the memory is untouched and still active, but its trigger rows, pin
 *   index rows or some pin files may already be gone;
 * - at step 9 or 10 (the delete threw, or the row is still readable afterwards), the
 *   row stays in the table marked archived with the "forgotten:" note — default recall
 *   skips it and the memory-file reconciler treats its text as forgotten — while its
 *   triggers, pins and KG triples are gone. That is a soft forget; running forget
 *   again finishes it.
 * Whenever something was already changed, the error says what, and a
 * `forget_incomplete` audit entry records it. That entry deliberately carries no
 * `norm=` fingerprint and is not a `forget` operation, so the reconciler does not
 * read an aborted forget as a completed one.
 *
 * Not covered — forgetting a memory does NOT touch:
 * - memories derived from it by dream / consolidation (insights, patterns), or
 *   evolution references held by other rows (supersedes, sourceMemories, consolidatedInto);
 * - brief assets and exports that quoted it;
 * - document slices or transcript chunks in other scopes that say the same thing;
 * - the archived pin files themselves (data/archive/forgotten-pins keeps the snippet so a
 *   mistaken forget can be undone; remove the file by hand if the content has to go);
 * - older LanceDB table versions, backups, and the session transcripts it came from.
 * The audit entry of a completed forget carries the normalized text fingerprint so
 * that the memory-file reconciler does not put the same text back (memory-reconcile.ts).
 *
 * Until 2026-10-05 this header promised propagation to "all derived artifacts
 * (KG triples, pins, evolution chains)" while the body had no pin code at all, the
 * memory_triggers side table (added 2026-09-22) was never cleaned, and nothing
 * read back after the delete.
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { KGStore } from "./kg-store.js";
import type { AuditLogger } from "./audit-log.js";
import { parsePrivacyTier, type PrivacyTier } from "./memory-schema.js";
import { parseEvolution, patchEvolution } from "./memory-evolution.js";
import { cascadeForget, type CascadeForgetConfig, DEFAULT_CASCADE_FORGET_CONFIG } from "./cascade-forget.js";
import { textFingerprint } from "./text-fingerprint.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForgetRequest {
  /** Memory ID to forget (full UUID or 8+ hex prefix) */
  memoryId: string;
  /** Explicit confirmation — required for "durable" tier memories */
  confirm: boolean;
  /** Reason for forgetting (audit trail) */
  reason?: string;
  /** Scope filter for permission check */
  scopeFilter?: string[];
}

export interface ForgetEvidence {
  /** Snapshot of the memory before deletion */
  entry: MemoryEntry;
  /** Privacy tier at time of deletion */
  privacyTier: PrivacyTier;
  /** Evolution chain snapshot */
  evolution: ReturnType<typeof parseEvolution>;
  /** Timestamp of forget operation */
  forgottenAt: string;
  /** Reason provided */
  reason?: string;
}

/** The places the read-back looks. */
export type ForgetLayer = "primary" | "triggers" | "pins" | "pin-index" | "kg";

/**
 * What the read-back after the delete found.
 * A count is `null` when that layer is not wired in, or when counting it failed; the
 * second case is also listed in `unverified`, so "not there" and "could not look" stay apart.
 */
export interface ForgetVerification {
  /** gone = the id no longer resolves; present = it still does; unverified = the read itself failed */
  primary: "gone" | "present" | "unverified";
  triggerRowsLeft: number | null;
  pinsLeft: number | null;
  pinIndexRowsLeft: number | null;
  kgTriplesLeft: number | null;
  /** Layers whose check threw. Empty when everything that could be checked was checked. */
  unverified: ForgetLayer[];
}

/**
 * One word for a read-back. `clean` is the only state in which the forget can be
 * reported as done without a caveat: the id is gone, nothing was found left over,
 * and no check failed.
 */
export function summarizeVerification(v: ForgetVerification): "clean" | "leftovers" | "unverified" | "present" {
  if (v.primary === "present") return "present";
  const left = (v.triggerRowsLeft ?? 0) + (v.pinsLeft ?? 0) + (v.pinIndexRowsLeft ?? 0) + (v.kgTriplesLeft ?? 0);
  if (left > 0) return "leftovers";
  if (v.unverified.length > 0) return "unverified";
  return "clean";
}

export interface ForgetResult {
  /** Whether the memory was successfully forgotten */
  success: boolean;
  /** ID of the forgotten memory */
  memoryId: string;
  /** Evidence snapshot (for audit/undo) */
  evidence?: ForgetEvidence;
  /** Whether the KG cleanup ran without error */
  kgTriplesRemoved: boolean;
  /** Rows removed from memory_triggers (null when no trigger store is wired in) */
  triggerRowsRemoved: number | null;
  /** Pin files moved to the archive (null when no pin archive is wired in) */
  pinsArchived: number | null;
  /** Indexed copies of those pins removed from the main table (null when the step was not reached) */
  pinIndexRowsRemoved: number | null;
  /** Cascade demote results */
  cascadeResult: { demotedCount: number; demotedIds: string[] };
  /** Read-back after the primary delete (absent when the forget stopped before deleting) */
  verification?: ForgetVerification;
  /** Error message if failed */
  error?: string;
}

/** The slice of TriggerStore the forget engine needs. */
export interface ForgetTriggerStore {
  /** Delete every trigger row of this memory; resolves to the number of rows removed. */
  deleteForMemory(memoryId: string): Promise<number>;
  countForMemory(memoryId: string): Promise<number>;
}

/** Pin files made from a memory (memory-assets.ts: archivePinAssetsForMemory / findPinAssetsForMemory). */
export interface ForgetPinArchive {
  /** Move this memory's pin files out of the pins directory; returns how many were moved. */
  archiveForMemory(memoryId: string): number;
  /** How many pin files made from this memory are still in the pins directory. */
  countForMemory(memoryId: string): number;
}

export interface ForgetByIdDeps {
  store: MemoryStore;
  kgStore?: KGStore | null;
  auditLogger?: AuditLogger | null;
  cascadeConfig?: CascadeForgetConfig;
  /** Omit to skip step 4 (callers that have no trigger side table). */
  triggerStore?: ForgetTriggerStore | null;
  /** Omit to skip the file half of step 5 (the indexed copies live in `store` and are always handled). */
  pins?: ForgetPinArchive | null;
}

/** What a forget has already changed at the moment it stops or finishes. */
interface ForgetProgress {
  triggerRowsRemoved: number | null;
  pinIndexRowsRemoved: number | null;
  pinsArchived: number | null;
  kgTriplesRemoved: boolean;
  cascadeResult: { demotedCount: number; demotedIds: string[] };
  breadcrumbWritten: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function countOrNa(n: number | null): string {
  return n === null ? "n/a" : String(n);
}

function failed(memoryId: string, error: string, partial: Partial<ForgetResult> = {}): ForgetResult {
  return {
    success: false,
    memoryId,
    kgTriplesRemoved: false,
    triggerRowsRemoved: null,
    pinsArchived: null,
    pinIndexRowsRemoved: null,
    cascadeResult: { demotedCount: 0, demotedIds: [] },
    error,
    ...partial,
  };
}

function resultFields(progress: ForgetProgress): Pick<ForgetResult, "kgTriplesRemoved" | "triggerRowsRemoved" | "pinsArchived" | "pinIndexRowsRemoved" | "cascadeResult"> {
  return {
    kgTriplesRemoved: progress.kgTriplesRemoved,
    triggerRowsRemoved: progress.triggerRowsRemoved,
    pinsArchived: progress.pinsArchived,
    pinIndexRowsRemoved: progress.pinIndexRowsRemoved,
    cascadeResult: progress.cascadeResult,
  };
}

/** In plain words, what has already been changed. Empty when nothing has. */
function describeProgress(progress: ForgetProgress): string[] {
  const parts: string[] = [];
  if (progress.triggerRowsRemoved) parts.push(`${progress.triggerRowsRemoved} trigger row(s) removed`);
  if (progress.pinIndexRowsRemoved) parts.push(`${progress.pinIndexRowsRemoved} pin index row(s) removed`);
  if (progress.pinsArchived) parts.push(`${progress.pinsArchived} pin file(s) archived`);
  if (progress.kgTriplesRemoved) parts.push("KG cleanup ran");
  if (progress.cascadeResult.demotedCount) parts.push(`${progress.cascadeResult.demotedCount} related memories demoted`);
  if (progress.breadcrumbWritten) parts.push('row marked archived with a "forgotten:" note');
  return parts;
}

/**
 * Rows in the main table that index a pin made from this memory. `pin_memory` writes one
 * per pin (asset-sync.ts: scope `asset:<pin id>`, text = title + summary + snippet,
 * metadata.originalMemoryId), and search returns them like any other row.
 */
async function findPinIndexRows(store: MemoryStore, memoryId: string): Promise<MemoryEntry[]> {
  const rows = await store.list(["asset"], undefined, Number.MAX_SAFE_INTEGER, 0);
  return rows.filter((row) => {
    if (!row.scope.startsWith("asset:")) return false;
    try {
      const meta = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
      return meta.assetType === "pinned-memory" && meta.originalMemoryId === memoryId;
    } catch {
      return false;
    }
  });
}

/** Step 10. Checks by id only: every retrieval path can return a row only if it is still in the table. */
async function readBack(deps: ForgetByIdDeps, id: string, scopeFilter?: string[]): Promise<ForgetVerification> {
  const { store, kgStore, triggerStore, pins } = deps;
  const unverified: ForgetLayer[] = [];
  const check = async <T>(layer: ForgetLayer, look: () => T | Promise<T>): Promise<T | null> => {
    try {
      return await look();
    } catch (err) {
      unverified.push(layer);
      console.error(`[recallnest] Read-back of ${layer} failed after forget:`, errorMessage(err));
      return null;
    }
  };

  const row = await check("primary", async () => ((await store.get(id, scopeFilter)) ? "present" as const : "gone" as const));
  const triggerRowsLeft = triggerStore ? await check("triggers", () => triggerStore.countForMemory(id)) : null;
  const pinsLeft = pins ? await check("pins", () => pins.countForMemory(id)) : null;
  const pinIndexRowsLeft = await check("pin-index", async () => (await findPinIndexRows(store, id)).length);
  const kgTriplesLeft = kgStore && typeof kgStore.getTriplesBySourceMemories === "function"
    ? await check("kg", async () => (await kgStore.getTriplesBySourceMemories([id])).get(id)?.length ?? 0)
    : null;

  return { primary: row ?? "unverified", triggerRowsLeft, pinsLeft, pinIndexRowsLeft, kgTriplesLeft, unverified };
}

// ---------------------------------------------------------------------------
// Core: Forget a single memory
// ---------------------------------------------------------------------------

export async function forgetMemory(
  deps: ForgetByIdDeps,
  request: ForgetRequest,
): Promise<ForgetResult> {
  const { store, kgStore, auditLogger, cascadeConfig, triggerStore, pins } = deps;
  const { memoryId, confirm, reason, scopeFilter } = request;

  // 1. Fetch target
  const entry = await store.get(memoryId, scopeFilter);
  if (!entry) {
    return failed(memoryId, `Memory ${memoryId} not found`);
  }

  // 2. Privacy tier check
  const privacyTier = parsePrivacyTier(entry.metadata);
  if (privacyTier === "durable" && !confirm) {
    return failed(entry.id, `Memory ${entry.id} has privacy tier "durable" — set confirm=true to proceed`);
  }

  // 3. Evidence snapshot
  const evolution = parseEvolution(entry.metadata, entry.timestamp);
  const evidence: ForgetEvidence = {
    entry: { ...entry },
    privacyTier,
    evolution,
    forgottenAt: new Date().toISOString(),
    reason,
  };

  const progress: ForgetProgress = {
    triggerRowsRemoved: null,
    pinIndexRowsRemoved: null,
    pinsArchived: null,
    kgTriplesRemoved: false,
    cascadeResult: { demotedCount: 0, demotedIds: [] },
    breadcrumbWritten: false,
  };

  // Stops the forget after something may already have been changed: says what in the error,
  // and leaves a `forget_incomplete` audit entry (see the file header for why it is not a `forget`).
  const stopIncomplete = (
    stage: "pin-archive" | "delete" | "read-back",
    problem: string,
    nextStep: string,
    extra: Partial<ForgetResult> = {},
  ): ForgetResult => {
    const done = describeProgress(progress);
    if (done.length > 0) {
      try {
        auditLogger?.log({
          operation: "forget_incomplete",
          scope: entry.scope,
          memoryId: entry.id,
          actor: "system",
          details: `stage=${stage} triggers=${countOrNa(progress.triggerRowsRemoved)} pins=${countOrNa(progress.pinsArchived)} pinIndex=${countOrNa(progress.pinIndexRowsRemoved)} kg=${progress.kgTriplesRemoved ? "ran" : "no"} cascade=${progress.cascadeResult.demotedCount} breadcrumb=${progress.breadcrumbWritten ? "yes" : "no"} error=${problem}`,
        });
      } catch (err) {
        console.error("[recallnest] Audit log failed during an incomplete forget:", errorMessage(err));
      }
    }
    const already = done.length > 0 ? ` Already done and not rolled back: ${done.join("; ")}.` : "";
    return failed(entry.id, `${problem}${already} ${nextStep}`, { evidence, ...resultFields(progress), ...extra });
  };

  // 4. Trigger rows — fail closed (see the file header)
  if (triggerStore) {
    try {
      progress.triggerRowsRemoved = await triggerStore.deleteForMemory(entry.id);
    } catch (err) {
      return failed(entry.id, `Trigger cleanup failed: ${errorMessage(err)}. Nothing was deleted; retry the forget.`, { evidence });
    }
  }

  // 5. Pin archive — fail closed. A pin is a file under data/pins and an indexed copy in the
  //    main table; the copy goes first, because it is the half that search returns.
  try {
    const indexRows = await findPinIndexRows(store, entry.id);
    progress.pinIndexRowsRemoved = 0;
    for (const row of indexRows) {
      await store.delete(row.id);
      progress.pinIndexRowsRemoved += 1;
    }
    if (pins) progress.pinsArchived = pins.archiveForMemory(entry.id);
  } catch (err) {
    const restoreTriggers = progress.triggerRowsRemoved
      ? ` To keep the memory instead, restore its trigger rows with \`triggers-backfill --rebuild --apply --scope ${entry.scope}\`.`
      : "";
    return stopIncomplete(
      "pin-archive",
      `Pin archive failed: ${errorMessage(err)}.`,
      `The memory itself was not deleted and is still active. Retry the forget.${restoreTriggers}`,
    );
  }

  // 6. KG triples
  if (kgStore) {
    try {
      await kgStore.deleteBySource(entry.id);
      progress.kgTriplesRemoved = true;
    } catch (err) {
      console.error("[recallnest] KG cleanup failed during forget:", errorMessage(err));
    }
  }

  // 7. Cascade demote
  try {
    progress.cascadeResult = await cascadeForget(
      store,
      { id: entry.id, vector: entry.vector, scope: entry.scope },
      cascadeConfig ?? DEFAULT_CASCADE_FORGET_CONFIG,
    );
  } catch (err) {
    console.error("[recallnest] Cascade demote failed during forget:", errorMessage(err));
  }

  // 8. Evolution breadcrumb
  try {
    const patchedMetadata = patchEvolution(entry.metadata, {
      status: "archived" as any,
      evolutionNote: `forgotten: ${reason || "user request"}`,
    });
    progress.breadcrumbWritten = (await store.update(entry.id, { metadata: patchedMetadata }, scopeFilter)) !== null;
  } catch (err) {
    console.error("[recallnest] Evolution patch failed during forget:", errorMessage(err));
  }

  const rowState = () => (progress.breadcrumbWritten
    ? 'The row is still in the table, marked archived with a "forgotten:" note: default recall skips it and the memory-file reconciler treats its text as forgotten.'
    : "The row is still in the table and still active.");

  // 9. Primary delete
  try {
    await store.delete(entry.id, scopeFilter);
  } catch (err) {
    return stopIncomplete("delete", `Delete failed: ${errorMessage(err)}.`, `${rowState()} Run forget again to finish.`);
  }

  // 10. Read-back
  const verification = await readBack(deps, entry.id, scopeFilter);
  if (verification.primary === "present") {
    return stopIncomplete(
      "read-back",
      `Delete reported success but memory ${entry.id} is still readable.`,
      `${rowState()} Run forget again to finish.`,
      { verification },
    );
  }

  // 11. Audit log
  try {
    auditLogger?.log({
      operation: "forget",
      scope: entry.scope,
      memoryId: entry.id,
      actor: "system",
      // norm=<归一文本指纹> 放最前：删的是这一行，要忘的是这段文字。记忆文件对账据此不把同文的另一行
      // 恢复回来（memory-reconcile.ts），只认 id 的话换个空白就绕过去了。
      // reason 是自由文本，放最后：details 超 200 字会被截断，前面的字段不能被它挤掉。
      details: `norm=${textFingerprint(entry.text)} tier=${privacyTier} triggers=${countOrNa(progress.triggerRowsRemoved)} pins=${countOrNa(progress.pinsArchived)} pinIndex=${countOrNa(progress.pinIndexRowsRemoved)} verify=${summarizeVerification(verification)} cascade=${progress.cascadeResult.demotedCount} reason=${reason || "none"}`,
    });
    if (progress.cascadeResult.demotedCount > 0) {
      auditLogger?.log({
        operation: "cascade_forget",
        scope: entry.scope,
        memoryId: entry.id,
        actor: "system",
        details: `demoted ${progress.cascadeResult.demotedCount} related memories: ${progress.cascadeResult.demotedIds.map(id => id.slice(0, 8)).join(",")}`,
      });
    }
  } catch (err) {
    console.error("[recallnest] Audit log failed during forget:", errorMessage(err));
  }

  return {
    success: true,
    memoryId: entry.id,
    evidence,
    ...resultFields(progress),
    verification,
  };
}

// ---------------------------------------------------------------------------
// Bulk: Forget all memories in a scope
// ---------------------------------------------------------------------------

export interface ForgetByScopeResult {
  forgottenCount: number;
  failedCount: number;
  kgScopeCleared: boolean;
  totalCascadeDemoted: number;
}

export async function forgetByScope(
  deps: ForgetByIdDeps,
  scope: string,
  confirm: boolean,
  reason?: string,
): Promise<ForgetByScopeResult> {
  if (!confirm) {
    return { forgottenCount: 0, failedCount: 0, kgScopeCleared: false, totalCascadeDemoted: 0 };
  }

  const { store, kgStore, auditLogger } = deps;
  let forgottenCount = 0;
  let failedCount = 0;
  let totalCascadeDemoted = 0;

  // Fetch all entries in scope.
  //
  // scopeMatch: "exact" —— **破坏性操作绝不做前缀展开**（2026-08-16 互审 Codex R3 提出）。
  // 默认 family 语义下 `forgetByScope("memory")` 会连 `memory:pivot` 一起遗忘，而下面
  // 的 KG 清理走的是精确 `scope = 'memory'`（kg-store.ts:506）—— 记忆行按家族删、KG 只
  // 清一个 scope，两边还会不一致。当前无生产 caller，正因如此更要在有 caller 之前定死语义：
  // 要清一整个家族，就显式枚举那些 scope 逐个调用。
  const entries = await store.list([scope], undefined, 5000, 0, "exact");

  for (const entry of entries) {
    const result = await forgetMemory(deps, {
      memoryId: entry.id,
      confirm: true,
      reason: reason || `scope-level forget: ${scope}`,
      scopeFilter: [scope],
    });

    if (result.success) {
      forgottenCount++;
      totalCascadeDemoted += result.cascadeResult.demotedCount;
    } else {
      failedCount++;
    }
  }

  // Bulk KG scope cleanup
  let kgScopeCleared = false;
  if (kgStore) {
    try {
      await kgStore.deleteByScope(scope);
      kgScopeCleared = true;
    } catch (err) {
      console.error("[recallnest] KG scope cleanup failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // Audit the bulk operation
  try {
    auditLogger?.log({
      operation: "forget",
      scope,
      actor: "system",
      details: `scope-forget: ${forgottenCount} deleted, ${failedCount} failed, ${totalCascadeDemoted} cascade-demoted`,
    });
  } catch (err) {
    console.error("[recallnest] Audit log failed during scope forget:", err instanceof Error ? err.message : String(err));
  }

  return { forgottenCount, failedCount, kgScopeCleared, totalCascadeDemoted };
}
