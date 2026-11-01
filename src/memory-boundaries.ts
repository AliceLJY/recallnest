import { createHash } from "node:crypto";

import type { DurableMemoryCategory } from "./memory-schema.js";
import { inferPreferenceSlot } from "./preference-slots.js";

export const MEMORY_LAYERS = [
  "canonical",
  "durable",
  "session",
  "evidence",
] as const;

export const MEMORY_AUTHORITIES = [
  "manual-document",
  "structured-memory",
  "document-ingest",
  "transcript-ingest",
  "session-checkpoint",
  "distillation",
] as const;

export const MEMORY_CONFLICT_POLICIES = [
  "latest-wins",
  "append-only",
  "manual-review",
] as const;

export type MemoryLayer = (typeof MEMORY_LAYERS)[number];
export type MemoryAuthority = (typeof MEMORY_AUTHORITIES)[number];
export type MemoryConflictPolicy = (typeof MEMORY_CONFLICT_POLICIES)[number];

export interface MemoryBoundaryMetadata {
  layer: MemoryLayer;
  authority: MemoryAuthority;
  conflictPolicy: MemoryConflictPolicy;
  originalCategory?: DurableMemoryCategory;
  downgradedFrom?: DurableMemoryCategory;
  note?: string;
}

export interface PromotedFromMetadata {
  memoryId: string;
  scope?: string;
  category?: string;
  source?: string;
  boundary?: MemoryBoundaryMetadata | null;
}

export interface ProvenanceHistoryMetadata extends PromotedFromMetadata {
  observedAt?: string;
}

export interface MemoryProvenance {
  boundary: MemoryBoundaryMetadata | null;
  canonicalKey: string | null;
  promotedFrom: PromotedFromMetadata | null;
  provenanceHistory: ProvenanceHistoryMetadata[];
  provenanceHistoryCount: number;
}

export interface IngestBoundaryResolution {
  category: DurableMemoryCategory;
  boundary: MemoryBoundaryMetadata;
}

// 在栈各端的 transcript 来源与 scope 前缀。
// ⚠️ 接入新的 AI 端时必须同步这两处 —— 漏掉的端不会被认成 evidence 层，
// 其会话碎片既不会被降权，也会被 layer admission 当成 durable 结论放行。
// （kimi / antigravity 就漏了：kimi 2026-07-19 进栈、antigravity 07-29 进栈，
//   直到 08-01 才发现库里的 `kimi:` scope 一直被当结论对待。）
//
// minis（2026-08-12 加，iPhone 上的 Minis agent，经 iCloud 文件信箱回流对话记录）：
// 这一次是**接入前先补**，不是事后发现——补的动机值得记下来，因为 Minis 比前面几端更危险。
// 它的 CLI 把 agent 自己的工具调用回传也标成 `type:"user"` / `role:"user"`（实测一场对话
// 137 条里 69 条 user，其中仅 11 条是真人发言，另外 58 条是 `[Tool result: ...]`）。
// 所以漏掉它不只是"碎片被当结论"，而是**把 shell 输出提炼成用户说过的话**——
// 例如 `ssh: connect to host ... timed out` 会变成一条"用户说过"的记忆。
// 导出侧已在上游过滤（只导真人对话），这里是第二道闸：即使某次导出没过滤干净，
// 走 ingest 的内容也会被正确降权到 evidence 层，而不是当成 durable 结论。
const TRANSCRIPT_SOURCES = new Set(["cc", "codex", "gemini", "kimi", "antigravity", "minis"]);
const TRANSCRIPT_SCOPE_PREFIXES = [
  "cc:",
  "codex:",
  "gemini:",
  "kimi:",
  "antigravity:",
  "minis:",
];

export function getConflictPolicyForCategory(category: DurableMemoryCategory): MemoryConflictPolicy {
  return category === "events" || category === "cases"
    ? "append-only"
    : "latest-wins";
}

export function isTranscriptIngestSource(source: string): boolean {
  return TRANSCRIPT_SOURCES.has(source);
}

export function isTranscriptScope(scope: string): boolean {
  return TRANSCRIPT_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix));
}

/**
 * Scope of the session-checkpoint mirror (src/checkpoint-mirror.ts): one `events` row per session.
 * Lives here so the retriever can refer to it without importing the mirror module.
 */
export const CHECKPOINT_MIRROR_SCOPE = "checkpoint";

/**
 * Scopes a retrieval must keep out of its candidate pool. The vector / BM25 candidate pool is
 * cut to at most 20 rows before the category filter runs, so rows that the category filter is
 * certain to drop still take candidate slots from the rows it would keep. Mirror rows are all
 * `events`; any other category filter therefore drops every one of them — excluding the scope up
 * front is lossless and keeps category searches as they were before the mirror existed.
 */
export function resolveExcludedScopes(params: { category?: string; excludeScopes?: string[] }): string[] {
  const excluded = new Set(params.excludeScopes ?? []);
  if (params.category && params.category !== "events") excluded.add(CHECKPOINT_MIRROR_SCOPE);
  return [...excluded];
}

export function isDurableMemoryScope(scope: string): boolean {
  return scope.startsWith("memory:") || scope.startsWith("asset:");
}

export function buildStructuredMemoryBoundary(
  category: DurableMemoryCategory,
): MemoryBoundaryMetadata {
  return {
    layer: "durable",
    authority: "structured-memory",
    conflictPolicy: getConflictPolicyForCategory(category),
    originalCategory: category,
    note: "Structured memory writes are the durable source inside RecallNest.",
  };
}

export function buildDistillationBoundary(
  category: DurableMemoryCategory,
): MemoryBoundaryMetadata {
  return {
    layer: "durable",
    authority: "distillation",
    conflictPolicy: getConflictPolicyForCategory(category),
    originalCategory: category,
  };
}

const CANONICAL_KEY_MAX_LENGTH = 120;

/** normalizeCanonicalKey 截断之前的结果；默认 key 要靠它判断有没有发生截断。 */
function normalizeCanonicalKeyUntruncated(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function normalizeCanonicalKey(value: string): string {
  return normalizeCanonicalKeyUntruncated(value).slice(0, CANONICAL_KEY_MAX_LENGTH);
}

function collapseKeyText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDefaultCanonicalKey(params: {
  category: DurableMemoryCategory;
  text?: string;
  title?: string;
}): string {
  if (params.category === "preferences") {
    const slot = inferPreferenceSlot(params.text || params.title || "");
    if (slot) {
      return truncateCanonicalKey(
        slot.type === "brand-item"
          ? [params.category, slot.type, slot.brand, slot.item]
          : slot.type === "reply-style"
            ? [params.category, slot.type, ...slot.traits]
            : slot.type === "implicit-usage"
              ? [params.category, slot.type, slot.subject]
              : [params.category, slot.type, slot.preferredTool, "over", slot.avoidedTool],
      );
    }
  }

  const base = collapseKeyText(params.title || params.text || "");
  if (!base) return `${params.category}:memory`;
  const fullBase = normalizeCanonicalKeyUntruncated(base);

  // 归一化后为空（西里尔、韩文、纯假名……）或发生了截断时，单靠归一化结果会让不同正文共用一个 key，
  // latest-wins 下后写的把先写的原位改掉。只在这两种情形附全文短哈希；其余情形与改前逐字相同，
  // 现有生产行的 key 一个都不变。
  // 哈希段用 `:h<16 hex>` 接在 key 后面：正文归一化后只剩 [a-z0-9 汉字 -]，产不出冒号，所以带这个
  // 尾巴的 key 只可能出自哈希分支——普通正文「memory-h<hex>」「note-h0123456789abcdef」照旧原样，
  // 不需要再按形状识别、也不会被反过来加哈希（R3 Codex / Kimi / Grok 都指出按 `-h` 形状识别会改写
  // 这类既有行的 key）。哈希输入是 keyHashInput：与归一化同一套折叠（小写、去直引号、标点空白折成 -），
  // 但保留所有文字而不只 a-z0-9 与汉字，长正文里只差西里尔 / 假名的两段才不会再算成同一个哈希。
  if (!fullBase || fullBase.length > CANONICAL_KEY_MAX_LENGTH) {
    const head = fullBase ? `${params.category}:${fullBase}` : `${params.category}:memory`;
    return appendKeyHash(head, keyHashInput(base));
  }
  return `${params.category}:${fullBase}`;
}

/** 哈希后缀的形状：`:h` + 16 位 hex（sha256 前 64 bit）。 */
const KEY_HASH_SUFFIX_LENGTH = ":h".length + 16;

function keyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * 全文哈希的输入：normalizeCanonicalKeyUntruncated 同一套折叠，但保留任何文字系统的字母与数字
 * （\p{L}\p{N}），不只 a-z0-9 与汉字。大小写、直引号、标点与空白的差异不进哈希；
 * 西里尔、假名、谚文的差异进哈希。
 */
function keyHashInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 截到整条 key（含类别前缀）加上哈希后缀不超过 120 字，再附 `:h<16 hex>`：冲突记录的 canonicalKey
 * 上限是 120（conflict-schema.ts），冲突指纹与聚类键也先按 120 截，哈希放在 120 之外会被截掉。
 * 按码点截，不留半个代理对；截完去掉结尾的 `-` / `:`。
 */
function appendKeyHash(head: string, hashInput: string): string {
  const suffix = `:h${keyHash(hashInput)}`;
  const budget = CANONICAL_KEY_MAX_LENGTH - KEY_HASH_SUFFIX_LENGTH;
  let kept = "";
  for (const char of head) {
    if (kept.length + char.length > budget) break;
    kept += char;
  }
  return `${kept.replace(/[:\-]+$/u, "")}${suffix}`;
}

function truncateCanonicalKey(segments: string[]): string {
  const joined = segments.filter(Boolean).join(":");
  // 槽位 key 超长时同样附哈希（哈希整条结构化 key）；未超长的槽位 key 与改前一字不变。
  if (joined.length > CANONICAL_KEY_MAX_LENGTH) {
    return appendKeyHash(joined, joined);
  }
  return joined.replace(/[:\-]+$/u, "");
}

export function resolveIngestBoundary(params: {
  source: string;
  scope: string;
  category: DurableMemoryCategory;
}): IngestBoundaryResolution {
  const { source, scope, category } = params;

  if (isTranscriptIngestSource(source)) {
    if (category === "profile" || category === "preferences") {
      return {
        category: "events",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: category,
          downgradedFrom: category,
          note: "Transcript-derived stable facts stay as evidence until explicitly promoted.",
        },
      };
    }

    return {
      category,
      boundary: {
        layer: "evidence",
        authority: "transcript-ingest",
        conflictPolicy: getConflictPolicyForCategory(category),
        originalCategory: category,
        note: "Transcript-derived memories are evidence and should not override curated memory.",
      },
    };
  }

  if (isDurableMemoryScope(scope) || scope === "memory") {
    return {
      category,
      boundary: {
        layer: "durable",
        authority: "document-ingest",
        conflictPolicy: getConflictPolicyForCategory(category),
        originalCategory: category,
        note: "Curated memory documents can mirror durable memory, but they are not session authority.",
      },
    };
  }

  return {
    category,
    boundary: {
      layer: "evidence",
      authority: "document-ingest",
      conflictPolicy: getConflictPolicyForCategory(category),
      originalCategory: category,
      note: "Unstructured ingest stays evidence until explicitly promoted.",
    },
  };
}

export function parseMetadataObject(metadata?: string): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function coerceBoundaryMetadata(candidate: unknown): MemoryBoundaryMetadata | null {
  if (!candidate || typeof candidate !== "object") return null;

  const record = candidate as Record<string, unknown>;
  const layer = typeof record.layer === "string" ? record.layer : "";
  const authority = typeof record.authority === "string" ? record.authority : "";
  const conflictPolicy = typeof record.conflictPolicy === "string" ? record.conflictPolicy : "";

  if (
    !MEMORY_LAYERS.includes(layer as MemoryLayer) ||
    !MEMORY_AUTHORITIES.includes(authority as MemoryAuthority) ||
    !MEMORY_CONFLICT_POLICIES.includes(conflictPolicy as MemoryConflictPolicy)
  ) {
    return null;
  }

  return {
    layer: layer as MemoryLayer,
    authority: authority as MemoryAuthority,
    conflictPolicy: conflictPolicy as MemoryConflictPolicy,
    ...(typeof record.originalCategory === "string"
      ? { originalCategory: record.originalCategory as DurableMemoryCategory }
      : {}),
    ...(typeof record.downgradedFrom === "string"
      ? { downgradedFrom: record.downgradedFrom as DurableMemoryCategory }
      : {}),
    ...(typeof record.note === "string" ? { note: record.note } : {}),
  };
}

export function extractBoundaryMetadata(metadata?: string): MemoryBoundaryMetadata | null {
  const parsed = parseMetadataObject(metadata);
  return coerceBoundaryMetadata(parsed?.boundary);
}

function coercePromotedFromMetadata(candidate: unknown): PromotedFromMetadata | null {
  if (!candidate || typeof candidate !== "object") return null;

  const record = candidate as Record<string, unknown>;
  const memoryId = typeof record.memoryId === "string" ? record.memoryId.trim() : "";
  if (!memoryId) return null;

  return {
    memoryId,
    ...(typeof record.scope === "string" ? { scope: record.scope } : {}),
    ...(typeof record.category === "string" ? { category: record.category } : {}),
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    boundary: coerceBoundaryMetadata(record.boundary),
  };
}

function coerceProvenanceHistoryMetadata(candidate: unknown): ProvenanceHistoryMetadata | null {
  const promotedFrom = coercePromotedFromMetadata(candidate);
  if (!promotedFrom || typeof candidate !== "object") return null;

  const record = candidate as Record<string, unknown>;
  return {
    ...promotedFrom,
    ...(typeof record.observedAt === "string" ? { observedAt: record.observedAt } : {}),
  };
}

export function extractPromotedFrom(metadata?: string): PromotedFromMetadata | null {
  const parsed = parseMetadataObject(metadata);
  return coercePromotedFromMetadata(parsed?.promotedFrom);
}

export function extractProvenanceHistory(metadata?: string): ProvenanceHistoryMetadata[] {
  const parsed = parseMetadataObject(metadata);
  const rawHistory = Array.isArray(parsed?.provenanceHistory) ? parsed.provenanceHistory : [];
  const history = rawHistory
    .map((candidate) => coerceProvenanceHistoryMetadata(candidate))
    .filter((candidate): candidate is ProvenanceHistoryMetadata => Boolean(candidate));

  if (history.length > 0) {
    return history;
  }

  const promotedFrom = coerceProvenanceHistoryMetadata(parsed?.promotedFrom);
  return promotedFrom ? [promotedFrom] : [];
}

export function extractProvenanceHistoryCount(metadata?: string): number {
  const parsed = parseMetadataObject(metadata);
  const candidate = parsed?.provenanceHistoryCount;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
    return Math.floor(candidate);
  }
  return extractProvenanceHistory(metadata).length;
}

export function extractMemoryProvenance(params: {
  scope: string;
  metadata?: string;
}): MemoryProvenance {
  return {
    boundary: extractBoundaryMetadata(params.metadata),
    canonicalKey: extractCanonicalKey(params.metadata),
    promotedFrom: extractPromotedFrom(params.metadata),
    provenanceHistory: extractProvenanceHistory(params.metadata),
    provenanceHistoryCount: extractProvenanceHistoryCount(params.metadata),
  };
}

export function extractCanonicalKey(metadata?: string): string | null {
  const parsed = parseMetadataObject(metadata);
  const canonicalKey = parsed?.canonicalKey;
  return typeof canonicalKey === "string" && canonicalKey.trim().length > 0
    ? canonicalKey
    : null;
}

export function shouldUseStableMemoryResult(params: {
  category: "profile" | "preferences" | "entities";
  scope: string;
  metadata?: string;
}): boolean {
  if (isTranscriptScope(params.scope)) {
    return false;
  }

  const boundary = extractBoundaryMetadata(params.metadata);
  if (!boundary) {
    return true;
  }

  return boundary.layer !== "evidence";
}
