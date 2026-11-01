/**
 * Candidate eligibility checks that must run before the retrieval pool is truncated.
 *
 * Background (2026-11 体检 #10): the vector leg over-fetches up to 200 rows but keeps only the first
 * `safeLimit` (≤ 20) — and category / archived / superseded / topicTag / after / before used to be
 * checked only after that cut (some even after `finalizeResults` had cut to `limit`). A query whose
 * top 20 were all ineligible came back empty although eligible rows sat right below. The pool size is
 * unchanged on purpose (enlarging it was measured and rejected on 2026-08-22); these helpers only make
 * the ≤ 20 rows that reach scoring eligible ones.
 *
 * Where each check runs:
 * - `category` — pushed into the SQL WHERE of `store.vectorSearch` / `store.bm25Search`.
 * - archived flag + evolution status (superseded / archived / consolidated) — `candidateAcceptor`,
 *   evaluated per row inside the store loop before the `safeLimit` break, on the rows already fetched.
 * - topicTag / explicit after-before (`CandidatePoolCriteria`) — same acceptor in the store loop, and
 *   `matchesPoolCriteria` again on the retriever's candidate pool before `finalizeResults` (covers
 *   rows that reach the pool without the vector leg: BM25, KG/PPR, trigger hosts, multi-hop).
 */

import type { MemoryEntry } from "./store.js";
import { isActiveMemory } from "./memory-evolution.js";
import { extractTopicTag } from "./topic-tag.js";
import { matchesTemporalConstraint, type TemporalConstraint } from "./temporal-parser.js";

/** Filters a caller asked for that are not columns of their own (topicTag lives in metadata). */
export interface CandidatePoolCriteria {
  /** Case-insensitive match against `metadata.topicTag`. */
  topicTag?: string;
  /** Explicit stored-time window (search_memory `after` / `before`), matched against `timestamp`. */
  timeRange?: TemporalConstraint;
}

export function hasPoolCriteria(criteria: CandidatePoolCriteria): boolean {
  return Boolean(criteria.topicTag) || criteria.timeRange !== undefined;
}

export function matchesPoolCriteria(
  entry: Pick<MemoryEntry, "metadata" | "timestamp">,
  criteria: CandidatePoolCriteria,
): boolean {
  if (criteria.topicTag) {
    const tag = extractTopicTag(entry.metadata);
    if (tag?.toLowerCase() !== criteria.topicTag.toLowerCase()) return false;
  }
  if (criteria.timeRange && !matchesTemporalConstraint(entry.timestamp, criteria.timeRange)) return false;
  return true;
}

/**
 * Parse search_memory's `after` / `before` strings into a constraint. Unparseable dates are ignored,
 * and when neither side parses there is no constraint (same rules the post-filter has always used).
 */
export function explicitTimeRange(after?: string, before?: string): TemporalConstraint | undefined {
  if (!after && !before) return undefined;
  const startMs = after ? new Date(after).getTime() || undefined : undefined;
  const endMs = before ? new Date(before).getTime() || undefined : undefined;
  if (!startMs && !endMs) return undefined;
  return {
    type: (after && before) ? "range" : (after ? "after" : "before"),
    startMs,
    endMs,
    anchor: `${after || ""}..${before || ""}`,
  };
}

function hasArchivedFlag(metadata: string | undefined): boolean {
  if (!metadata) return false;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).archived === true;
  } catch {
    return false;
  }
}

/**
 * Per-row check for the store loop. Without `includeArchived` a row must carry no `archived: true`
 * flag and an active evolution status — the same two checks the retriever applies later
 * (category/archived filter and `finalizeResults`' evolution filter), so moving them earlier only
 * frees slots that those rows would have wasted.
 */
export function candidateAcceptor(
  options: CandidatePoolCriteria & { includeArchived?: boolean },
): (entry: MemoryEntry) => boolean {
  const { includeArchived, ...criteria } = options;
  const checkPool = hasPoolCriteria(criteria);
  return (entry) => {
    if (!includeArchived && (hasArchivedFlag(entry.metadata) || !isActiveMemory(entry.metadata))) return false;
    if (checkPool && !matchesPoolCriteria(entry, criteria)) return false;
    return true;
  };
}
