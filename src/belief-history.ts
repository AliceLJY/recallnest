/**
 * Belief history — copy-on-write archival for belief-changing writes.
 *
 * Problem this solves: the latest-wins and conflict-resolution paths used to call
 * store.update() on the canonical row, replacing text + vector in place. The previous
 * belief was physically gone, so no retrieval strategy could ever answer
 * "what did I believe last month?".
 *
 * Approach: before overwriting canonical row C, copy C's current content into a new
 * `superseded` history row H, then update C in place as before. C keeps its id, so the
 * `deterministicId(scope, canonicalKey)` invariant every canonical lookup depends on is
 * untouched — history lives beside it rather than replacing it.
 *
 * Chain shape (C is the stable canonical id, H1 older than H2):
 *   H1 --supersededBy--> C     C  --supersedes--> H2
 *   H2 --supersededBy--> C     H2 --supersedes--> H1
 * so traceEvolution() walks backward C → H2 → H1 to rebuild the timeline, and forward
 * from any history row to the belief that is live now.
 */

import { deterministicId, type MemoryEntry, type MemoryStore } from "./store.js";
import type { MemoryStoreUpdate } from "./memory-store-port.js";
import { parseEvolution, patchEvolution, type EvolutionMetadata } from "./memory-evolution.js";
import { detectLang, tokenizeFts } from "./language-hook.js";
import type { Embedder } from "./embedder.js";

/** Namespace for history-row ids — keeps them deterministic (retry-safe) yet distinct from C. */
const BELIEF_HISTORY_ID_PREFIX = "belief-history:";

export interface BeliefHistoryDeps {
  store: Pick<MemoryStore, "store"> & Partial<Pick<MemoryStore, "upsert" | "getById">>;
  embedder: Pick<Embedder, "embedPassage">;
}

export interface BeliefArchiveResult {
  /** Id of the newly written history row — becomes the canonical row's `supersedes`. */
  historyId: string;
  /** When the archived version stopped being the live belief. */
  validUntil: number;
}

/**
 * Resolve a usable vector for the row being archived.
 *
 * store.list() deliberately returns `vector: []` for performance, and that is where the
 * canonical-match candidates come from — so the entry handed to us usually has no vector.
 * Re-read the full row first; only re-embed if the store can't give it back.
 */
async function resolveVector(
  store: Partial<Pick<MemoryStore, "getById">>,
  embedder: Pick<Embedder, "embedPassage">,
  current: MemoryEntry,
): Promise<number[]> {
  if (current.vector && current.vector.length > 0) return current.vector;

  if (store.getById) {
    const full = await store.getById(current.id);
    if (full?.vector && full.vector.length > 0) return full.vector;
  }

  return await embedder.embedPassage(current.text);
}

// Text is part of the id, not just (id, timestamp): two belief changes landing in the
// same millisecond would otherwise collide and the second archive would overwrite the
// first. With the text folded in, a collision means the content is identical anyway.
function beliefHistoryId(current: MemoryEntry): string {
  const historyId = deterministicId(
    current.scope,
    `${BELIEF_HISTORY_ID_PREFIX}${current.id}@${current.timestamp}\n${current.text}`,
  );
  if (historyId === current.id) {
    throw new Error(`Belief history id collided with canonical id ${current.id}`);
  }
  return historyId;
}

/**
 * Build the `superseded` history row for `current` (pure — no I/O). Throws when no vector is
 * available or the history id would collide with the canonical id.
 */
function buildBeliefHistoryRow(current: MemoryEntry, vector: number[], now: number): MemoryEntry {
  const historyId = beliefHistoryId(current);
  if (vector.length === 0) {
    throw new Error(`Cannot archive belief ${current.id}: no vector available`);
  }
  const currentEvo = parseEvolution(current.metadata, current.timestamp);

  // The history row inherits the old metadata wholesale (canonicalKey, boundary, emotion…)
  // and only has its evolution block rewritten to close the interval.
  const historyMetadata = patchEvolution(current.metadata, {
    status: "superseded",
    validFrom: currentEvo.validFrom,
    validUntil: now,
    supersededBy: current.id,
    // Point at the version this one replaced, so the backward walk stays a chain.
    supersedes: currentEvo.supersedes,
  });

  return {
    id: historyId,
    text: current.text,
    vector,
    category: current.category,
    scope: current.scope,
    importance: current.importance,
    // Keep the original timestamp: canonical matching scans the most recent
    // CANONICAL_SCAN_LIMIT rows, and stamping history rows "now" would let them crowd
    // live entries out of that window.
    timestamp: current.timestamp,
    metadata: historyMetadata,
    // Derive rather than copy: neither list() nor getById() selects these columns, so
    // `current.language` / `current.fts_text` are all but guaranteed to be undefined here.
    // Falling back to the "en" / raw-text defaults would mislabel Chinese memories and
    // store them unsegmented for FTS — so recompute them the same way live entries do.
    language: current.language || detectLang(current.text),
    fts_text: current.fts_text || tokenizeFts(current.text, current.language || detectLang(current.text)),
  };
}

/**
 * Archive the current content of a canonical memory as a `superseded` history row.
 *
 * Throws rather than degrading to a silent overwrite: a belief-changing write that cannot
 * preserve the old belief is exactly the failure this module exists to prevent, so callers
 * must not proceed with the overwrite if this rejects.
 *
 * This is the two-write form: the history row is committed here and the caller overwrites
 * the canonical row afterwards, with no lock held across the two. Callers that hold a full
 * MemoryStore use replaceBeliefVersion() instead, which re-reads the canonical row and does
 * both writes in one store-write critical section; this function remains only as the
 * fallback for narrower store deps (test doubles) that lack replaceWithArchivedVersion.
 * On that fallback path, if the canonical row is deleted between the caller's read and its
 * overwrite, the history row written here stays behind pointing at a row that no longer
 * exists; and if the overwrite fails for another reason, it is a superseded duplicate of a
 * belief that is in fact still live. The deterministic id means a retry reuses the same row
 * rather than piling up copies.
 */
export async function archiveBeliefVersion(
  deps: BeliefHistoryDeps,
  current: MemoryEntry,
  options: { now?: number } = {},
): Promise<BeliefArchiveResult> {
  const now = options.now ?? Date.now();
  beliefHistoryId(current); // fail on an id collision before doing any I/O
  const vector = await resolveVector(deps.store, deps.embedder, current);
  const historyRow = buildBeliefHistoryRow(current, vector, now);

  if (deps.store.upsert) {
    await deps.store.upsert(historyRow);
  } else {
    // Fallback for narrower store deps (mocks): store() stamps its own timestamp, which
    // only costs us the scan-window optimisation above — the history row is still written.
    await deps.store.store(historyRow);
  }

  return { historyId: historyRow.id, validUntil: now };
}

/** The canonical row a belief replacement was aimed at no longer exists; nothing was written. */
export class BeliefTargetMissingError extends Error {
  readonly memoryId: string;
  constructor(memoryId: string) {
    super(`Belief target ${memoryId} no longer exists; no history row was written and nothing was overwritten`);
    this.name = "BeliefTargetMissingError";
    this.memoryId = memoryId;
  }
}

export interface BeliefReplaceDeps {
  store: Pick<MemoryStore, "replaceWithArchivedVersion"> & Partial<Pick<MemoryStore, "getById">>;
  embedder: Pick<Embedder, "embedPassage">;
}

/** What the caller's updates builder sees — all derived from the row re-read under the lock. */
export interface BeliefReplaceContext {
  current: MemoryEntry;
  previousEvolution: EvolutionMetadata;
  historyId: string;
  now: number;
}

export type BeliefReplaceResult =
  | { status: "missing" }
  | { status: "unchanged"; current: MemoryEntry }
  | { status: "replaced"; entry: MemoryEntry; historyId: string; validUntil: number };

/**
 * Archive the canonical row's current version and overwrite it, in one store-write critical
 * section (MemoryStore.replaceWithArchivedVersion): the row is re-read under the lock, and
 * if it is gone nothing at all is written — no history row is left pointing at a row that a
 * concurrent forget just removed.
 *
 * The history row and the updates are built from the row as re-read under the lock, not from
 * `expected` (the caller's earlier read), so a concurrent edit is what gets archived. The one
 * slow step — resolving a vector when the row carries none (re-read or re-embed) — runs before
 * the lock is taken, for `expected`'s text; it is used only if the re-read row has no vector of
 * its own and still holds that same text.
 *
 * `skip(current)` returning true leaves everything as it is (result "unchanged").
 * `buildUpdates` runs under the lock: it must be pure and synchronous.
 *
 * Time: unless `options.now` is given, the single timestamp used for the history row's
 * validUntil, the canonical row's timestamp / validFrom (via ctx.now) and the returned
 * validUntil is taken inside the lock, and never earlier than the re-read row's own
 * timestamp or validFrom. Taking it before the lock (and before vector resolution) let a
 * replacement that committed in between leave a history row with validFrom > validUntil and
 * move the canonical timestamp backwards.
 *
 * language / fts_text of the history row are always recomputed from its text, as the old
 * archive path did: the row re-read under the lock carries the "en" / raw-text placeholders
 * legacy rows were migrated with, and copying those would mislabel Chinese history rows.
 */
export async function replaceBeliefVersion(
  deps: BeliefReplaceDeps,
  expected: MemoryEntry,
  buildUpdates: (ctx: BeliefReplaceContext) => MemoryStoreUpdate,
  options: { now?: number; scopeFilter?: string[]; skip?: (current: MemoryEntry) => boolean } = {},
): Promise<BeliefReplaceResult> {
  const fallbackVector = await resolveVector(deps.store, deps.embedder, expected);

  let lockedNow = 0;
  const result = await deps.store.replaceWithArchivedVersion(expected.id, (current) => {
    if (options.skip?.(current)) return null;
    const previousEvolution = parseEvolution(current.metadata, current.timestamp);
    const now = options.now ?? Math.max(Date.now(), current.timestamp, previousEvolution.validFrom);
    lockedNow = now;
    const vector = current.vector.length > 0
      ? current.vector
      : current.text === expected.text ? fallbackVector : [];
    const history = buildBeliefHistoryRow({ ...current, language: undefined, fts_text: undefined }, vector, now);
    return { history, updates: buildUpdates({ current, previousEvolution, historyId: history.id, now }) };
  }, options.scopeFilter);

  if (result.status === "replaced") {
    return { status: "replaced", entry: result.entry, historyId: result.history.id, validUntil: lockedNow };
  }
  return result;
}

/**
 * Build the evolution block for the canonical row that is about to be overwritten.
 *
 * Callers previously passed the incoming metadata straight to store.update(), which wiped
 * the evolution block along with the text. This merges the incoming metadata with a fresh
 * evolution block that links back to the archived version.
 */
export function buildSupersedingBeliefMetadata(
  incomingMetadata: string | undefined,
  previousEvolution: EvolutionMetadata,
  historyId: string,
  now: number,
  evolutionNote?: string | null,
): string {
  return patchEvolution(incomingMetadata, {
    status: "active",
    version: previousEvolution.version + 1,
    supersedes: historyId,
    supersededBy: null,
    validFrom: now,
    validUntil: null,
    // Access stats belong to the canonical key, not to a single version's text.
    accessCount: previousEvolution.accessCount,
    lastAccessedAt: previousEvolution.lastAccessedAt,
    ...(evolutionNote ? { evolutionNote } : {}),
  });
}
