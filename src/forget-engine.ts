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
 * 4. Trigger rows (delete its rows in memory_triggers; a failure aborts before anything else is touched)
 * 5. Pin archive (move pins made from it out of data/pins; a failure aborts, the primary row stays)
 * 6. KG triples (KGStore.deleteBySource; a failure is logged and the forget continues)
 * 7. Cascade demote (related memories lose importance, via cascade-forget.ts)
 * 8. Evolution breadcrumb (mark the row archived just before deleting it)
 * 9. Primary delete (remove the row from LanceDB)
 * 10. Read-back (fetch the id again; count what is left in triggers, pins and KG)
 * 11. Audit log (record the operation and what the read-back found)
 *
 * Steps 4 and 5 fail closed, and run before anything irreversible: once the primary
 * row is gone, forget() can no longer find the id, so whatever those steps left
 * behind would have no tool to remove it.
 *
 * Not covered — forgetting a memory does NOT touch:
 * - memories derived from it by dream / consolidation (insights, patterns), or
 *   evolution references held by other rows (supersedes, sourceMemories, consolidatedInto);
 * - brief assets and exports that quoted it;
 * - document slices or transcript chunks in other scopes that say the same thing;
 * - older LanceDB table versions, backups, and the session transcripts it came from.
 * The audit entry carries the normalized text fingerprint so that the memory-file
 * reconciler does not put the same text back (memory-reconcile.ts).
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

/** What the read-back after the delete found. `null` = that layer is not wired in, or counting it failed. */
export interface ForgetVerification {
  /** gone = the id no longer resolves; present = it still does; unverified = the read itself failed */
  primary: "gone" | "present" | "unverified";
  triggerRowsLeft: number | null;
  pinsLeft: number | null;
  kgTriplesLeft: number | null;
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
  /** Pins moved to the archive (null when no pin archive is wired in) */
  pinsArchived: number | null;
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

/** Pins made from a memory (memory-assets.ts: archivePinAssetsForMemory / findPinAssetsForMemory). */
export interface ForgetPinArchive {
  /** Move this memory's pins out of the pins directory; returns how many were moved. */
  archiveForMemory(memoryId: string): number;
  /** How many pins made from this memory are still in the pins directory. */
  countForMemory(memoryId: string): number;
}

export interface ForgetByIdDeps {
  store: MemoryStore;
  kgStore?: KGStore | null;
  auditLogger?: AuditLogger | null;
  cascadeConfig?: CascadeForgetConfig;
  /** Omit to skip step 4 (callers that have no trigger side table). */
  triggerStore?: ForgetTriggerStore | null;
  /** Omit to skip step 5. */
  pins?: ForgetPinArchive | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failed(memoryId: string, error: string, partial: Partial<ForgetResult> = {}): ForgetResult {
  return {
    success: false,
    memoryId,
    kgTriplesRemoved: false,
    triggerRowsRemoved: null,
    pinsArchived: null,
    cascadeResult: { demotedCount: 0, demotedIds: [] },
    error,
    ...partial,
  };
}

/** Step 10. Checks by id only: every retrieval path can return a row only if it is still in the table. */
async function readBack(deps: ForgetByIdDeps, id: string, scopeFilter?: string[]): Promise<ForgetVerification> {
  const { store, kgStore, triggerStore, pins } = deps;

  let primary: ForgetVerification["primary"] = "unverified";
  try {
    primary = (await store.get(id, scopeFilter)) ? "present" : "gone";
  } catch (err) {
    console.error("[recallnest] Read-back of the primary row failed after forget:", errorMessage(err));
  }

  let triggerRowsLeft: number | null = null;
  if (triggerStore) {
    try {
      triggerRowsLeft = await triggerStore.countForMemory(id);
    } catch (err) {
      console.error("[recallnest] Read-back of trigger rows failed after forget:", errorMessage(err));
    }
  }

  let pinsLeft: number | null = null;
  if (pins) {
    try {
      pinsLeft = pins.countForMemory(id);
    } catch (err) {
      console.error("[recallnest] Read-back of pins failed after forget:", errorMessage(err));
    }
  }

  let kgTriplesLeft: number | null = null;
  if (kgStore && typeof kgStore.getTriplesBySourceMemories === "function") {
    try {
      kgTriplesLeft = (await kgStore.getTriplesBySourceMemories([id])).get(id)?.length ?? 0;
    } catch (err) {
      console.error("[recallnest] Read-back of KG triples failed after forget:", errorMessage(err));
    }
  }

  return { primary, triggerRowsLeft, pinsLeft, kgTriplesLeft };
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

  // 4. Trigger rows — fail closed (see the file header)
  let triggerRowsRemoved: number | null = null;
  if (triggerStore) {
    try {
      triggerRowsRemoved = await triggerStore.deleteForMemory(entry.id);
    } catch (err) {
      return failed(entry.id, `Trigger cleanup failed: ${errorMessage(err)}. Nothing was deleted; retry the forget.`, { evidence });
    }
  }

  // 5. Pin archive — fail closed
  let pinsArchived: number | null = null;
  if (pins) {
    try {
      pinsArchived = pins.archiveForMemory(entry.id);
    } catch (err) {
      const triggerNote = triggerRowsRemoved
        ? ` Its ${triggerRowsRemoved} trigger row(s) were already removed; restore them with \`triggers-backfill --rebuild --apply\`, or retry the forget.`
        : " Retry the forget.";
      return failed(
        entry.id,
        `Pin archive failed: ${errorMessage(err)}. The memory itself was not deleted.${triggerNote}`,
        { evidence, triggerRowsRemoved },
      );
    }
  }

  // 6. KG triples
  let kgTriplesRemoved = false;
  if (kgStore) {
    try {
      await kgStore.deleteBySource(entry.id);
      kgTriplesRemoved = true;
    } catch (err) {
      console.error("[recallnest] KG cleanup failed during forget:", errorMessage(err));
    }
  }

  // 7. Cascade demote
  let cascadeResult = { demotedCount: 0, demotedIds: [] as string[] };
  try {
    cascadeResult = await cascadeForget(
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
    await store.update(entry.id, { metadata: patchedMetadata }, scopeFilter);
  } catch (err) {
    console.error("[recallnest] Evolution patch failed during forget:", errorMessage(err));
  }

  const progress = { evidence, kgTriplesRemoved, triggerRowsRemoved, pinsArchived, cascadeResult };

  // 9. Primary delete
  try {
    await store.delete(entry.id, scopeFilter);
  } catch (err) {
    return failed(entry.id, `Delete failed: ${errorMessage(err)}`, progress);
  }

  // 10. Read-back
  const verification = await readBack(deps, entry.id, scopeFilter);
  if (verification.primary === "present") {
    return failed(
      entry.id,
      `Delete reported success but memory ${entry.id} is still readable`,
      { ...progress, verification },
    );
  }

  // 11. Audit log
  try {
    const count = (n: number | null) => (n === null ? "n/a" : String(n));
    auditLogger?.log({
      operation: "forget",
      scope: entry.scope,
      memoryId: entry.id,
      actor: "system",
      // norm=<归一文本指纹> 放最前：删的是这一行，要忘的是这段文字。记忆文件对账据此不把同文的另一行
      // 恢复回来（memory-reconcile.ts），只认 id 的话换个空白就绕过去了。
      // reason 是自由文本，放最后：details 超 200 字会被截断，前面的字段不能被它挤掉。
      details: `norm=${textFingerprint(entry.text)} tier=${privacyTier} triggers=${count(triggerRowsRemoved)} pins=${count(pinsArchived)} verify=${verification.primary} cascade=${cascadeResult.demotedCount} reason=${reason || "none"}`,
    });
    if (cascadeResult.demotedCount > 0) {
      auditLogger?.log({
        operation: "cascade_forget",
        scope: entry.scope,
        memoryId: entry.id,
        actor: "system",
        details: `demoted ${cascadeResult.demotedCount} related memories: ${cascadeResult.demotedIds.map(id => id.slice(0, 8)).join(",")}`,
      });
    }
  } catch (err) {
    console.error("[recallnest] Audit log failed during forget:", errorMessage(err));
  }

  return {
    success: true,
    memoryId: entry.id,
    ...progress,
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
