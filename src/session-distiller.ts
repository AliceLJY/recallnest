import type { LLMClient } from "./llm-client.js";
import type { Embedder } from "./embedder.js";
import type { MemoryStore } from "./store.js";
import type { ConflictCandidateStore } from "./conflict-store.js";
import type { KGExtractor } from "./kg-extractor.js";
import type { AuditLogger } from "./audit-log.js";
import type { StoredMemoryRecord, DurableMemoryCategory } from "./memory-schema.js";
import { persistMemory } from "./capture-engine.js";
import { detectLang, getSessionPromptHook } from "./language-hook.js";
import { redactSecrets } from "./pii-detector.js";
import { LockTimeoutError, withWriteLock } from "./distill-lock.js";
import { STORE_WRITE_NESTED_WAIT_MS } from "./store-write-budget.js";
import { logWarn } from "./stderr-log.js";

// ============================================================================
// Types
// ============================================================================

export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name?: string;
  timestamp?: string;
}

/** One content block as the distill_session MCP schema accepts it (Anthropic-style messages). */
export interface DistillContentBlock {
  type: "text" | "tool_use" | "tool_result";
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  content?: string;
  text?: string;
  tool_use_id?: string;
}

/** A message as distill_session accepts it: content is a string or a list of blocks. */
export interface DistillInputMessage {
  role: ConversationMessage["role"];
  content: string | DistillContentBlock[];
}

function flattenContentBlock(block: DistillContentBlock): string {
  if (block.type === "tool_use") {
    return `[tool_use${block.name ? `:${block.name}` : ""}] ${JSON.stringify(block.input ?? {})}`;
  }
  if (block.type === "tool_result") return block.content ?? block.text ?? "";
  return block.text ?? "";
}

/**
 * The MCP schema lets `content` be a list of blocks, but every layer below works on strings
 * (`redactSecrets(m.content)` threw "out.replace is not a function" on a block list). Blocks are
 * joined in order with newlines; string content passes through unchanged.
 */
export function normalizeDistillMessages(messages: readonly DistillInputMessage[]): ConversationMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string"
      ? m.content
      : m.content.map(flattenContentBlock).filter((t) => t.length > 0).join("\n"),
  }));
}

export interface MicrocompactResult {
  tokens_freed: number;
  tools_cleared: number;
}

export interface SummaryResult {
  text: string;
  dimensions: Record<string, string>;
}

export interface PersistError {
  /** Summary dimension whose memory was not written (e.g. "errors_and_fixes"). */
  dimension: string;
  error: string;
}

export interface PersistResult {
  memories_stored: number;
  memories_deduped: number;
  memories_conflicted: number;
  /** Dimensions whose write threw (embedding, LLM dedup, store write); details in `errors`. */
  memories_failed: number;
  errors: PersistError[];
  /**
   * The per-scope distill lock was still held by another distill when the wait budget ran out, so
   * this persist ran without it rather than dropping the summary. Each write is still serialized by
   * store-write and goes through persistMemory's dedup; two distills of the same session racing here
   * may leave near-duplicates for consolidation to merge.
   */
  scope_lock_timed_out: boolean;
  ids: string[];
}

function emptyPersistResult(): PersistResult {
  return {
    memories_stored: 0,
    memories_deduped: 0,
    memories_conflicted: 0,
    memories_failed: 0,
    errors: [],
    scope_lock_timed_out: false,
    ids: [],
  };
}

export interface DistillResult {
  microcompact: MicrocompactResult;
  summary: SummaryResult;
  persisted: PersistResult;
  compacted_messages: ConversationMessage[];
}

interface PersistDeps {
  store: Pick<MemoryStore, "store" | "list" | "update" | "getById" | "get" | "vectorSearch">;
  embedder: Pick<Embedder, "embedPassage">;
  conflictStore?: Pick<ConflictCandidateStore, "save" | "replace" | "getOpenByFingerprint" | "getLatestByFingerprint">;
  llm?: LLMClient | null;
  kgExtractor?: KGExtractor | null;
  auditLogger?: AuditLogger | null;
}

// ============================================================================
// Constants
// ============================================================================

const CLEARABLE_TOOLS = new Set([
  "read_file", "bash", "grep", "glob", "web_search", "web_fetch",
  "edit_file", "write_file", "Read", "Write", "Edit", "Bash",
  "Grep", "Glob", "WebSearch", "WebFetch",
]);

// Session summary fallback prompts (used when babel-memory is not installed)

const DEFAULT_DIMENSION_LABELS: Record<string, string> = {
  user_intent: "User intent and requests",
  technical_concepts: "Key technical concepts",
  files_and_code: "Files and code segments involved",
  errors_and_fixes: "Errors and fix records",
  problem_solving: "Problem solving process",
  user_quotes: "User original quotes preserved",
  user_profile: "Stable facts about the user: identity, role, background, long-term context",
  unfinished_tasks: "Unfinished tasks",
  current_state: "Current work state",
  next_steps: "Suggested next steps",
};

const DEFAULT_SESSION_SYSTEM = `You are a session summarizer. Analyze the conversation and produce a structured summary.
Wrap the summary in <summary></summary> tags.
Use numbered ## headings for each dimension:
${Object.entries(DEFAULT_DIMENSION_LABELS).map(([, label], i) => `## ${i + 1}. ${label}`).join("\n")}
If a dimension has no relevant content, write "N/A".`;

interface DimensionMapping {
  category: DurableMemoryCategory;
  importance: number;
}

const DIMENSION_TO_MEMORY: Record<string, DimensionMapping> = {
  user_intent: { category: "events", importance: 0.5 },
  files_and_code: { category: "entities", importance: 0.6 },
  errors_and_fixes: { category: "cases", importance: 0.7 },
  problem_solving: { category: "patterns", importance: 0.8 },
  user_quotes: { category: "preferences", importance: 0.7 },
  // user_profile → profile：让 distill 能沉淀"用户是谁"的稳定身份事实（不只是偏好）。
  // distill 走 source=agent，不被 resolveIngestBoundary 降级，直接进 durable profile。
  user_profile: { category: "profile", importance: 0.8 },
  // 2026-05-13 P1.2: 加 unfinished_tasks + next_steps 持久化映射
  // LLM 早在 DEFAULT_DIMENSION_LABELS 行 74/76 已产出这两条，但缺映射被丢弃
  // 都映射到 cases/patterns 走 tag 兜底（extractAndPersist 自动加 tags: ["session_distill", dimKey]）
  // 未来如要 unresolved-first 召回，按 tags 含 "unfinished_tasks" 过滤即可
  unfinished_tasks: { category: "cases", importance: 0.75 },
  next_steps: { category: "patterns", importance: 0.65 },
};

/**
 * The per-scope distill lock covers the whole persist phase: one persistMemory per mapped dimension,
 * each of which may wait for store-write and then embed, run LLM dedup and write — budgeted at
 * STORE_WRITE_NESTED_WAIT_MS apiece. That is how long a healthy holder may keep the lock
 * (`maxHoldMs`, past which it logs as stuck), and a waiter waits at least that long: with a shorter
 * budget (10 s by default, 60 s since 10-18) a second distill of the same scope timed out while the
 * first was still healthily writing, and its already-computed summary was thrown away.
 */
const DISTILL_PERSIST_MAX_HOLD_MS = Object.keys(DIMENSION_TO_MEMORY).length * STORE_WRITE_NESTED_WAIT_MS;
export const DISTILL_PERSIST_LOCK_OPTS = {
  maxHoldMs: DISTILL_PERSIST_MAX_HOLD_MS,
  waitTimeoutMs: DISTILL_PERSIST_MAX_HOLD_MS,
} as const;

// ============================================================================
// Layer 1: Microcompact
// ============================================================================

export function microcompact(
  messages: ConversationMessage[],
  opts: { preserveRecent?: number; keepRecentTools?: number } = {},
): { messages: ConversationMessage[]; result: MicrocompactResult } {
  const preserveRecent = opts.preserveRecent ?? 6;
  const keepRecentTools = opts.keepRecentTools ?? 5;

  if (messages.length === 0) {
    return { messages: [], result: { tokens_freed: 0, tools_cleared: 0 } };
  }

  const cutoff = Math.max(0, messages.length - preserveRecent);
  let tokensFreed = 0;
  let toolsCleared = 0;

  // Find tool messages eligible for clearing (before the preserve window)
  const toolIndices: number[] = [];
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role === "tool" && msg.tool_name && CLEARABLE_TOOLS.has(msg.tool_name)) {
      toolIndices.push(i);
    }
  }

  // Keep the most recent N tool results even if they're before the cutoff
  const indicesToClear = new Set(
    toolIndices.slice(0, Math.max(0, toolIndices.length - keepRecentTools)),
  );

  const compacted: ConversationMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (indicesToClear.has(i)) {
      const tokenCount = Math.ceil(msg.content.length / 4);
      tokensFreed += tokenCount;
      toolsCleared++;
      compacted.push({
        ...msg,
        content: `[Cleared: ${msg.tool_name}, ~${tokenCount} tokens]`,
      });
    } else {
      compacted.push({ ...msg });
    }
  }

  return {
    messages: compacted,
    result: { tokens_freed: tokensFreed, tools_cleared: toolsCleared },
  };
}

// ============================================================================
// Layer 2: LLM Structured Summary
// ============================================================================

export async function summarizeSession(
  messages: ConversationMessage[],
  llm: LLMClient,
): Promise<SummaryResult> {
  // F-3b: Redact per-message BEFORE the 500-char cut — truncating first could
  // slice a secret in half and leak its prefix past the redaction regexes.
  const conversationText = messages
    .map((m) => `[${m.role}${m.tool_name ? `:${m.tool_name}` : ""}] ${redactSecrets(m.content).text.slice(0, 500)}`)
    .join("\n")
    .slice(0, 8000);

  // Use babel-memory bilingual prompt if available, otherwise fallback to defaults
  const lang = detectLang(conversationText);
  const babelPrompt = getSessionPromptHook(lang);
  const sessionSystemPrompt = babelPrompt?.system ?? DEFAULT_SESSION_SYSTEM;
  const dimensionLabels = babelPrompt?.dimensionLabels ?? DEFAULT_DIMENSION_LABELS;
  const dimensionKeys = Object.keys(dimensionLabels);

  const raw = await llm.chatLong(sessionSystemPrompt, conversationText, 2000);

  if (!raw) {
    return { text: "", dimensions: {} };
  }

  // Extract <summary> block, discard <analysis>
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  const summaryText = summaryMatch ? summaryMatch[1].trim() : raw;

  // Parse dimensions from ## headings
  const dimensions: Record<string, string> = {};
  const sections = summaryText.split(/^## \d+\.\s*/m).filter(Boolean);

  for (const section of sections) {
    const firstLine = section.split("\n")[0].trim().toLowerCase();
    for (const key of dimensionKeys) {
      const label = dimensionLabels[key].toLowerCase();
      if (firstLine.includes(label) || label.includes(firstLine.replace(/\s+/g, " ").trim())) {
        const body = section.split("\n").slice(1).join("\n").trim();
        if (body && body !== "N/A") {
          dimensions[key] = body;
        }
        break;
      }
    }
  }

  return { text: summaryText, dimensions };
}

// ============================================================================
// Layer 3: Extract and Persist
// ============================================================================

export async function extractAndPersist(
  summary: SummaryResult,
  deps: PersistDeps,
  scope: string,
): Promise<PersistResult> {
  const result = emptyPersistResult();

  for (const [dimKey, mapping] of Object.entries(DIMENSION_TO_MEMORY)) {
    const dimText = summary.dimensions[dimKey];
    if (!dimText || dimText.trim().length < 10) continue;

    try {
      const stored = await persistMemory(deps, {
        text: dimText.slice(0, 4000),
        category: mapping.category,
        importance: mapping.importance,
        scope,
        source: "agent" as const,
        tags: ["session_distill", dimKey],
      });

      trackDisposition(result, stored);
    } catch (err) {
      // Non-fatal: continue with other dimensions, but say which one was lost and why.
      const error = redactSecrets(err instanceof Error ? err.message : String(err)).text;
      result.memories_failed++;
      result.errors.push({ dimension: dimKey, error });
      logWarn(`[session-distiller] dimension '${dimKey}' not persisted (scope ${scope}): ${error}`);
    }
  }

  return result;
}

function trackDisposition(result: PersistResult, stored: StoredMemoryRecord): void {
  result.ids.push(stored.id);
  switch (stored.disposition) {
    case "deduped":
      result.memories_deduped++;
      break;
    case "conflict":
      result.memories_conflicted++;
      break;
    default:
      result.memories_stored++;
      break;
  }
}

// ============================================================================
// Full Pipeline
// ============================================================================

export async function distillSession(
  messages: ConversationMessage[],
  /** `llm` is null when none is configured; only the summary layer needs it. */
  deps: PersistDeps & { llm: LLMClient | null },
  opts: {
    scope?: string;
    preserveRecent?: number;
    keepRecentTools?: number;
    persist?: boolean;
    /** Override the per-scope lock wait budget (default DISTILL_PERSIST_LOCK_OPTS.waitTimeoutMs). */
    lockWaitTimeoutMs?: number;
  } = {},
): Promise<DistillResult> {
  const scope = opts.scope || "default";
  const shouldPersist = opts.persist ?? true;

  // Layer 1: Microcompact
  const { messages: compacted, result: microcompactResult } = microcompact(
    messages,
    { preserveRecent: opts.preserveRecent, keepRecentTools: opts.keepRecentTools },
  );

  // Layer 2: Summarize (using compacted messages minus preserved recent)
  const preserveRecent = opts.preserveRecent ?? 6;
  const cutoff = Math.max(0, compacted.length - preserveRecent);
  const oldMessages = compacted.slice(0, cutoff);
  // Same cases fail as before (summary needed, no client); the error now says why instead of
  // "Cannot read properties of null".
  if (oldMessages.length > 0 && !deps.llm) {
    throw new Error("distill_session needs an LLM client to summarize older messages, and none is configured");
  }
  const summaryResult = oldMessages.length > 0 && deps.llm
    ? await summarizeSession(oldMessages, deps.llm)
    : { text: "", dimensions: {} };

  // Layer 3: Persist (optional)
  let persistResult = emptyPersistResult();

  if (shouldPersist && Object.keys(summaryResult.dimensions).length > 0) {
    // P0-1: serialize the persist phase per scope across processes. Wait (not skip) —
    // skipping would drop this session's distilled knowledge when two sessions distill
    // the same scope at once; microcompact/summary above run unlocked. The persist phase
    // takes store-write for each dimension, so the holder may itself be waiting on it; the
    // wait budget covers the holder's whole max hold (DISTILL_PERSIST_LOCK_OPTS).
    // If the holder is still there after that (stuck, or a far slower store than budgeted),
    // persist without the scope lock instead of throwing: the summary above cost an LLM call
    // and exists nowhere else, and a near-duplicate is recoverable where a lost summary is not.
    try {
      persistResult = await withWriteLock(
        `distill-${scope}`,
        () => extractAndPersist(summaryResult, deps, scope),
        {
          maxHoldMs: DISTILL_PERSIST_LOCK_OPTS.maxHoldMs,
          waitTimeoutMs: opts.lockWaitTimeoutMs ?? DISTILL_PERSIST_LOCK_OPTS.waitTimeoutMs,
        },
      );
    } catch (err) {
      if (!(err instanceof LockTimeoutError)) throw err;
      logWarn(`[session-distiller] ${err.message}; persisting this summary without the scope lock so it is not lost`);
      persistResult = await extractAndPersist(summaryResult, deps, scope);
      persistResult.scope_lock_timed_out = true;
    }
  }

  return {
    microcompact: microcompactResult,
    summary: summaryResult,
    persisted: persistResult,
    compacted_messages: compacted,
  };
}
