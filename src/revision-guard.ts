/**
 * 修订记忆时的级联降权闸（2026-11-03，「错误转脚本检查」第 6 条）。
 *
 * 失败形状：修订一条记忆时先 store 新条、再 forget 旧条，forget 的 cascade 按相似度把刚存的新条一起降权；
 * 或者同 key 修订传错 scope，另存一份重复，删重复时 cascade 又连带降了同 key 的别的条。
 * 有记录的真实损坏 4 次：open-loops「三次同型失败」（第三次 2026-08-08 session b5714e42，新条 0.92→0.8256）、
 * RecallNest case 2712ee04（2026-10-28 session 739f925a，8 条记忆被降权，一条 0.6→0.41 掉到 peripheral）。
 * 文字提醒三次失效，所以改成代码：
 *  - forget 前先预演 cascade；名单里有「本进程刚写的」或「与被删条同 canonicalKey 的」就拒绝并回显名单；
 *  - store 时同 canonicalKey 已在别的 scope 存在，回执里警告。
 * 关闭：forget_memory 传 cascadeMode="force"（照旧降权）或 "skip"（删但不降权）；整体关 RECALLNEST_REVISION_GUARD=off。
 */

import { extractCanonicalKey, normalizeCanonicalKey } from "./memory-boundaries.js";
import type { PlannedDemotion } from "./cascade-forget.js";
import type { MemoryEntry } from "./store.js";

// ---------------------------------------------------------------------------
// 本进程写过的条目（MCP stdio 进程 ≈ 一个会话）
// ---------------------------------------------------------------------------

const sessionWrites = new Map<string, number>();

export function recordSessionWrite(id: string): void {
  if (id) sessionWrites.set(id, Date.now());
}

export function sessionWrittenIds(): ReadonlySet<string> {
  return new Set(sessionWrites.keys());
}

/** 测试用。 */
export function resetSessionWrites(): void {
  sessionWrites.clear();
}

// ---------------------------------------------------------------------------
// forget 前预演
// ---------------------------------------------------------------------------

export type CascadeMode = "auto" | "skip" | "force";

export interface ProtectedDemotion {
  plan: PlannedDemotion;
  reasons: Array<"written-this-session" | "same-canonical-key">;
}

export function findProtectedDemotions(
  forgotten: Pick<MemoryEntry, "id" | "metadata">,
  planned: readonly PlannedDemotion[],
  sessionIds: ReadonlySet<string>,
): ProtectedDemotion[] {
  const key = extractCanonicalKey(forgotten.metadata);
  const out: ProtectedDemotion[] = [];
  for (const plan of planned) {
    const reasons: ProtectedDemotion["reasons"] = [];
    if (sessionIds.has(plan.entry.id)) reasons.push("written-this-session");
    if (key && extractCanonicalKey(plan.entry.metadata) === key) reasons.push("same-canonical-key");
    if (reasons.length > 0) out.push({ plan, reasons });
  }
  return out;
}

export function formatPlannedDemotions(planned: readonly PlannedDemotion[], protectedIds: ReadonlySet<string> = new Set()): string[] {
  return planned.map((p) => {
    const key = extractCanonicalKey(p.entry.metadata);
    const mark = protectedIds.has(p.entry.id) ? "  ← 受保护" : "";
    return `- ${p.entry.id.slice(0, 8)} sim=${p.similarity.toFixed(3)} importance ${p.from.toFixed(2)}→${p.to.toFixed(2)}${key ? ` key=${key}` : ""}${mark}`;
  });
}

export function refusalMessage(
  forgotten: Pick<MemoryEntry, "id">,
  planned: readonly PlannedDemotion[],
  protectedRows: readonly ProtectedDemotion[],
): string {
  const label = (r: ProtectedDemotion["reasons"][number]) => (r === "written-this-session" ? "本会话刚写的" : "与被删条同 canonicalKey");
  return [
    `Not forgotten: 预演发现 cascade 会降权受保护的条目，什么都没改。`,
    ...protectedRows.map((p) => `  ${p.plan.entry.id.slice(0, 8)}（${p.reasons.map(label).join("、")}）`),
    `完整预演名单（${planned.length} 条）：`,
    ...formatPlannedDemotions(planned, new Set(protectedRows.map((p) => p.plan.entry.id))),
    `理由：修订记忆时「先存新条、后删旧条」会让 cascade 把新条一起降权，2026-08-08（session b5714e42）与 2026-10-28（session 739f925a，case 2712ee04）都真出过；2026-11-03 起由代码拦。`,
    `改法：同 key 修订直接 store_memory 同 canonicalKey（原位更新，不要 forget）；确实要删旧条，用 cascadeMode="skip"（删但不降权）或确认名单后用 "force"。被删条 ${forgotten.id.slice(0, 8)}。`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// store 时同 key 在别的 scope
// ---------------------------------------------------------------------------

export interface ListCapableStore {
  list(scopeFilter?: string[], category?: string, limit?: number, offset?: number): Promise<MemoryEntry[]>;
}

const OTHER_SCOPE_SCAN_LIMIT = 1000;

export async function findSameKeyInOtherScopes(
  store: ListCapableStore,
  canonicalKey: string,
  scope: string,
): Promise<Array<{ id: string; scope: string }>> {
  const key = normalizeCanonicalKey(canonicalKey);
  if (!key) return [];
  const rows = await store.list(undefined, undefined, OTHER_SCOPE_SCAN_LIMIT, 0);
  return rows
    .filter((r) => r.scope !== scope && extractCanonicalKey(r.metadata) === key)
    .map((r) => ({ id: r.id, scope: r.scope }));
}

export function otherScopeWarning(hits: ReadonlyArray<{ id: string; scope: string }>): string | null {
  if (hits.length === 0) return null;
  const list = hits.slice(0, 5).map((h) => `${h.id.slice(0, 8)}@${h.scope}`).join(", ");
  return `⚠️ 同 canonicalKey 已在别的 scope 存在：${list}。如果你是想修订那一条，scope 传错了——这里另存了一份重复；回头删重复时 cascade 会连带降权（2026-10-28 case 2712ee04）。修订请用原 scope 再存一次。`;
}
