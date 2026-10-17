/**
 * 写入工具的回执（2026-10-17）：store_memory、batch_store、HTTP /v1/store 三处共用。
 *
 * agent 读回执决定要不要重试、要不要补 trigger。以前三处都按「没撞 conflict 就算存了」写：
 * batch_store 把 rejected / conflict 计成 new，HTTP 对 rejected 回 `stored: true` 与 201，
 * store_memory 第一行一律写 `Stored memory`、trigger 条数照抄入参。这里按 disposition 写，
 * trigger 条数按侧表实际写入的条数（PersistedMemoryRecord.triggersWritten）写。
 */

import type { PersistedMemoryRecord } from "./capture-engine.js";
import type { WriteDisposition } from "./memory-schema.js";

/** 这次写入在主表里落下了新内容：新行、原位修订、提升。deduped / conflict / rejected 都没有。 */
export function dispositionWroteMemory(disposition: WriteDisposition): boolean {
  return disposition === "stored" || disposition === "updated" || disposition === "promoted";
}

function receiptHeadline(stored: PersistedMemoryRecord): string {
  switch (stored.disposition) {
    case "stored":
      return `Stored memory ${stored.id.slice(0, 8)}`;
    case "updated":
      return `Updated memory ${stored.id.slice(0, 8)}`;
    case "promoted":
      return `Promoted memory ${stored.id.slice(0, 8)}`;
    case "deduped":
      // 完整 id：调用方要拿它去查、去改那一行
      return `Not stored: duplicate of existing memory ${stored.id}`;
    case "conflict":
      return `Not stored: canonical key conflict with memory ${stored.id}`;
    case "rejected":
      return `Not stored: rejected (${stored.rejectionReason ?? "unknown reason"})`;
  }
}

function triggerLine(stored: PersistedMemoryRecord, requested: number): string | null {
  if (requested === 0) return null;
  const written = stored.triggersWritten;
  if (written === requested) return `Triggers: ${written}`;
  if (written > 0) return `Triggers: ${written} (of ${requested} given; blank, over-length or repeated ones are dropped)`;
  if (stored.disposition === "rejected" || stored.disposition === "conflict") {
    return `Triggers: 0 of ${requested} written (nothing was stored)`;
  }
  return `Triggers: 0 of ${requested} written (none attached to memory ${stored.id.slice(0, 8)})`;
}

/** store_memory 的回执正文。`requestedTriggers` 是调用方传入的 triggers 条数。 */
export function formatStoreMemoryReceipt(
  stored: PersistedMemoryRecord,
  options: { requestedTriggers: number; scope: string },
): string {
  const hostExists = stored.disposition !== "rejected";
  const isPivot = (stored.resolvedScope || options.scope).startsWith("memory:pivot");
  const trigger = triggerLine(stored, options.requestedTriggers);
  return [
    receiptHeadline(stored),
    `Disposition: ${stored.disposition}`,
    ...(stored.rejectionReason ? [`Rejection reason: ${stored.rejectionReason}`] : []),
    `Category: ${stored.category}`,
    `Scope: ${stored.resolvedScope}`,
    ...(stored.canonicalKey ? [`Canonical key: ${stored.canonicalKey}`] : []),
    ...(stored.conflictId ? [`Conflict: ${stored.conflictId.slice(0, 8)}`] : []),
    // rejected 没有行，storedAt 只是拒绝的时刻
    ...(hostExists ? [`Stored at: ${stored.storedAt}`] : []),
    ...(trigger ? [trigger] : []),
    ...(isPivot && options.requestedTriggers === 0 && hostExists && stored.disposition !== "conflict"
      ? ["⚠️ pivot 记忆缺 triggers：§5.3 要求带 2–5 句「她以后会怎么问」。同 canonicalKey 再存一次并带 triggers 字段，回执的 Triggers 行会写明实际挂上了几条。"]
      : []),
  ].join("\n");
}

/** batch_store 的回执：按 disposition 分别计数，没写进主表的逐条列出。 */
export function formatBatchStoreReceipt(records: readonly PersistedMemoryRecord[]): string {
  const counts: Record<WriteDisposition, number> = {
    stored: 0, updated: 0, promoted: 0, deduped: 0, conflict: 0, rejected: 0,
  };
  for (const r of records) counts[r.disposition]++;
  const written = counts.stored + counts.updated + counts.promoted;
  const headline = `Stored ${written} of ${records.length} memories (${counts.stored} new, ${counts.updated} updated, ${counts.promoted} promoted, ${counts.deduped} deduped, ${counts.conflict} conflict, ${counts.rejected} rejected)`;
  const notWritten = records.flatMap((r, i) => {
    if (dispositionWroteMemory(r.disposition)) return [];
    const n = `#${i + 1}`;
    if (r.disposition === "rejected") return [`- ${n} rejected (${r.rejectionReason ?? "unknown reason"})`];
    if (r.disposition === "conflict") {
      return [`- ${n} conflict with memory ${r.id}${r.conflictId ? ` (conflict ${r.conflictId.slice(0, 8)})` : ""}`];
    }
    return [`- ${n} deduped: duplicate of existing memory ${r.id}`];
  });
  return [headline, ...notWritten].join("\n");
}

/** HTTP /v1/store 的状态码与响应体。只有真写进主表才回 201 与 `stored: true`。 */
export function buildStoreHttpResponse(stored: PersistedMemoryRecord): { status: 200 | 201; body: Record<string, unknown> } {
  const wrote = dispositionWroteMemory(stored.disposition);
  return {
    status: wrote ? 201 : 200,
    body: {
      id: stored.id,
      stored: wrote,
      disposition: stored.disposition,
      storedAt: stored.storedAt,
      category: stored.category,
      scope: stored.resolvedScope,
      canonicalKey: stored.canonicalKey,
      conflictId: stored.conflictId,
      ...(stored.rejectionReason ? { rejectionReason: stored.rejectionReason } : {}),
    },
  };
}
