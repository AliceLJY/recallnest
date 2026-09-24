/**
 * HP-2: Formation Review Pass — post-write verification.
 * After storing a memory, verify: embedding exists, text non-empty, scope and importance set, metadata parses.
 * Non-blocking: failures are logged but never block the write path.
 */

import type { MemoryStore, MemoryEntry } from "./store.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WriteVerifierConfig {
  /** Enable/disable verification (default: true) */
  enabled: boolean;
  /** Maximum time to wait for verification in ms (default: 2000) */
  timeoutMs: number;
}

export const DEFAULT_VERIFIER_CONFIG: WriteVerifierConfig = {
  enabled: true,
  timeoutMs: 2000,
};

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

export type VerificationIssue =
  | "missing_entry"
  | "missing_vector"
  | "missing_scope"
  | "missing_importance"
  | "empty_text"
  | "corrupt_metadata";

export interface VerificationResult {
  ok: boolean;
  entryId: string;
  issues: VerificationIssue[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a just-written memory entry by reading it back.
 * Returns issues found (empty = all good).
 */
export async function verifyWrite(
  store: Pick<MemoryStore, "get">,
  entryId: string,
  cfg?: Partial<WriteVerifierConfig>,
): Promise<VerificationResult> {
  const config = { ...DEFAULT_VERIFIER_CONFIG, ...cfg };
  const start = Date.now();

  if (!config.enabled) {
    return { ok: true, entryId, issues: [], durationMs: 0 };
  }

  try {
    const entry = await Promise.race([
      store.get(entryId),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), config.timeoutMs),
      ),
    ]) as MemoryEntry | null;

    const issues = checkEntry(entry, entryId);
    return {
      ok: issues.length === 0,
      entryId,
      issues,
      durationMs: Date.now() - start,
    };
  } catch {
    return {
      ok: false,
      entryId,
      issues: ["missing_entry"],
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal checks
// ---------------------------------------------------------------------------

function checkEntry(entry: MemoryEntry | null, id: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  if (!entry) {
    issues.push("missing_entry");
    return issues;
  }

  // Vector should exist (embedding succeeded)
  if (!entry.vector || (Array.isArray(entry.vector) && entry.vector.length === 0)) {
    issues.push("missing_vector");
  }

  // Text should not be empty
  if (!entry.text || entry.text.trim().length === 0) {
    issues.push("empty_text");
  }

  // scope / importance 是行上的列，不在 metadata 里——buildStructuredMetadata 从不写这两个字段。
  // 原先查 metadata，对每一次真实写入都报 missing_scope + missing_importance（agy-sync 日志
  // 5,052 条告警里 5,051 条是它，2026-09-24 统计），真正有用的 missing_entry 被埋在里面。
  if (typeof entry.scope !== "string" || entry.scope.trim().length === 0) {
    issues.push("missing_scope");
  }
  if (typeof entry.importance !== "number" || !Number.isFinite(entry.importance)) {
    issues.push("missing_importance");
  }

  // Metadata has to parse: every downstream reader JSON.parse()s it.
  if (entry.metadata) {
    try {
      JSON.parse(entry.metadata);
    } catch {
      issues.push("corrupt_metadata");
    }
  }

  return issues;
}
