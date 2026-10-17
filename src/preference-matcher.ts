/**
 * Preference Matcher — Tier 3.6
 *
 * When a new preference is about to be stored, checks for semantically similar
 * existing preferences in the same scope. If found, uses LLM to decide:
 * - MERGE: combine into existing entry (update text)
 * - SKIP: incoming is a duplicate, drop it
 * - CREATE: genuinely new preference, store normally
 *
 * This prevents duplicate preference accumulation without being too aggressive
 * (unlike hard dedup which might miss nuanced differences).
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { LLMClient } from "./llm-client.js";
import { logInfo } from "./stderr-log.js";
import { isActiveMemory, parseEvolution, type EvolutionMetadata } from "./memory-evolution.js";
import { archiveBeliefVersion, buildSupersedingBeliefMetadata, replaceBeliefVersion } from "./belief-history.js";
import { detectLang, tokenizeFts } from "./language-hook.js";

// ============================================================================
// Configuration
// ============================================================================

export interface PreferenceMatcherConfig {
  /** Minimum vector similarity to consider a match (default: 0.78) */
  similarityThreshold: number;
  /** Maximum candidates to check (default: 3) */
  maxCandidates: number;
}

export const DEFAULT_PREFERENCE_MATCHER_CONFIG: PreferenceMatcherConfig = {
  similarityThreshold: 0.78,
  maxCandidates: 3,
};

// ============================================================================
// Types
// ============================================================================

export interface PreferenceMatchResult {
  /** What to do with the incoming preference */
  action: "merge" | "skip" | "create";
  /** ID of the existing entry to merge into (when action=merge) */
  mergeTargetId?: string;
  /** Merged text (when action=merge, LLM-generated) */
  mergedText?: string;
  /** The existing preference the incoming one duplicates (when action=skip) — reported back to the caller */
  matchedEntry?: MemoryEntry;
  /** Reason for the decision */
  reason: string;
}

// ============================================================================
// Core
// ============================================================================

/**
 * Check if an incoming preference matches existing ones and decide what to do.
 *
 * @param text     The new preference text
 * @param vector   Pre-computed embedding vector for the text
 * @param scope    The scope to search within
 * @param store    Memory store
 * @param llm      LLM client (null → no LLM: top similarity ≥0.92 skips, otherwise create)
 * @param config   Optional config overrides
 */
export async function matchPreference(
  text: string,
  vector: number[],
  scope: string,
  store: MemoryStore,
  llm: LLMClient | null,
  config: PreferenceMatcherConfig = DEFAULT_PREFERENCE_MATCHER_CONFIG,
): Promise<PreferenceMatchResult> {
  // Find similar preferences in the same scope
  const candidates = await store.vectorSearch(
    vector,
    config.maxCandidates,
    config.similarityThreshold,
    [scope],
  );

  // Filter to only preferences category. store.vectorSearch() filters by scope only, so
  // superseded belief-history rows come back here too — matching against one would either
  // silently drop the incoming preference as a duplicate of a belief no longer held, or
  // merge new text into an archived version.
  const prefMatches = candidates.filter(
    c => c.entry.category === "preferences" && isActiveMemory(c.entry.metadata),
  );

  if (prefMatches.length === 0) {
    return { action: "create", reason: "no-similar-preferences" };
  }

  // Without LLM, fall back to simple similarity-based decision
  if (!llm) {
    const topScore = prefMatches[0].score;
    if (topScore >= 0.92) {
      return { action: "skip", reason: "high-similarity-no-llm", matchedEntry: prefMatches[0].entry };
    }
    return { action: "create", reason: "moderate-similarity-no-llm" };
  }

  // Ask LLM to decide
  const topMatch = prefMatches[0];
  try {
    const decision = await llm.dedupDecision(text, topMatch.entry.text);

    if (decision.action === "SKIP") {
      return {
        action: "skip",
        reason: `llm-skip: ${decision.reason}`,
        matchedEntry: topMatch.entry,
      };
    }

    if (decision.action === "MERGE") {
      // Generate merged text
      const mergedText = await generateMergedPreference(llm, text, topMatch.entry.text);
      return {
        action: "merge",
        mergeTargetId: topMatch.entry.id,
        mergedText: mergedText ?? `${topMatch.entry.text}; ${text}`,
        reason: `llm-merge: ${decision.reason}`,
      };
    }

    return { action: "create", reason: `llm-create: ${decision.reason}` };
  } catch {
    // LLM failure → safe default: create
    return { action: "create", reason: "llm-error" };
  }
}

/**
 * Apply the match result: either merge into existing or signal to skip/create.
 *
 * @returns true if handled (merged or skipped), false if caller should proceed to create
 */
export async function applyPreferenceMatch(
  result: PreferenceMatchResult,
  store: MemoryStore,
  scope: string,
  deps: { embedder: Pick<Embedder, "embedPassage"> },
): Promise<{ handled: boolean; entry?: MemoryEntry }> {
  if (result.action === "skip") {
    logInfo(`[INFO] Preference skipped (duplicate): ${result.reason}`);
    return result.matchedEntry ? { handled: true, entry: result.matchedEntry } : { handled: true };
  }

  if (result.action === "merge" && result.mergeTargetId && result.mergedText) {
    const existing = await store.getById(result.mergeTargetId);
    if (!existing) return { handled: false };

    // Merging rewrites the target's text, which is a belief change like any other —
    // archive the version being replaced before overwriting it.
    // The old code updated `text` alone, leaving vector and fts_text describing the
    // pre-merge wording — so a merged preference stayed unfindable by its own new text.
    const mergedText = result.mergedText;
    const reason = result.reason;
    const language = detectLang(mergedText);
    const vector = await deps.embedder.embedPassage(mergedText);
    const buildUpdates = (metadata: string | undefined, previousEvo: EvolutionMetadata, historyId: string, now: number) => ({
      text: mergedText,
      vector,
      metadata: buildSupersedingBeliefMetadata(metadata, previousEvo, historyId, now, `preference-merge:${reason}`),
      timestamp: now,
      language,
      fts_text: tokenizeFts(mergedText, language),
    });

    let updated: MemoryEntry | null;
    // Real MemoryStore: archive and overwrite under one store-write lock, row re-read inside it
    // (2026-10-17). Target deleted since the lookup above → nothing written, not handled, and
    // the caller creates the preference as new — previously a history row was left behind first.
    if (typeof store.replaceWithArchivedVersion === "function") {
      const replaced = await replaceBeliefVersion(
        { store, embedder: deps.embedder },
        existing,
        ({ current, previousEvolution, historyId, now }) => buildUpdates(current.metadata, previousEvolution, historyId, now),
        { scopeFilter: [scope] },
      );
      updated = replaced.status === "replaced" ? replaced.entry : null;
    } else {
      // Narrow store doubles: the two-write form.
      const now = Date.now();
      const previousEvo = parseEvolution(existing.metadata, existing.timestamp);
      const { historyId } = await archiveBeliefVersion({ store, embedder: deps.embedder }, existing, { now });
      updated = await store.update(result.mergeTargetId, buildUpdates(existing.metadata, previousEvo, historyId, now), [scope]);
    }
    if (updated) {
      logInfo(`[INFO] Preference merged into ${result.mergeTargetId.slice(0, 8)}: ${result.reason}`);
      return { handled: true, entry: updated };
    }
  }

  return { handled: false };
}

// ============================================================================
// Helpers
// ============================================================================

async function generateMergedPreference(
  llm: LLMClient,
  newText: string,
  existingText: string,
): Promise<string | null> {
  try {
    return await llm.synthesizeFragments(
      [existingText, newText],
      "merge preferences",
      300,
    );
  } catch {
    return null;
  }
}
