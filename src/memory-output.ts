import { formatAgeLabel } from "./age-label.js";
import type { MemoryEntry } from "./store.js";
import type { RetrievalResult } from "./retriever.js";
import type { RetrievalProfileName } from "./retrieval-profiles.js";
import { extractMemoryProvenance } from "./memory-boundaries.js";
import { extractMultiVectorText } from "./multi-vector.js";
import { parseNarrative } from "./narrative-schema.js";
import { getConfidence, getConfidenceMetadata } from "./confidence-tracker.js";
import { estimateTokens } from "./context-collapse-renderer.js";
import { evaluateEntryFreshness, createFreshnessCache } from "./freshness.js";
import { fullTextScoreThreshold, searchFirstScreen } from "./env-config.js";

interface MemoryMetadata {
  source?: string;
  sessionId?: string;
  file?: string;
  heading?: string;
  preferenceSlot?: {
    type?: string;
    brand?: string;
    item?: string;
    traits?: string[];
    preferredTool?: string;
    avoidedTool?: string;
  };
  [key: string]: unknown;
}

interface RenderContext {
  query: string;
  profile: RetrievalProfileName;
}

export interface DistilledSourceSummary {
  source: string;
  hits: number;
  newest: string;
  files: string[];
}

export interface DistilledEvidence {
  memoryId: string;
  source: string;
  scope: string;
  date: string;
  age: string;
  retrievalPath: string;
  snippet: string;
}

export interface DistilledSummary {
  query: string;
  profile: RetrievalProfileName;
  hits: number;
  sources: DistilledSourceSummary[];
  takeaways: string[];
  evidence: DistilledEvidence[];
  reusableCandidates: string[];
}

function parseMetadata(entry: MemoryEntry): MemoryMetadata {
  try {
    return JSON.parse(entry.metadata || "{}") as MemoryMetadata;
  } catch {
    return {};
  }
}

function getDateLabel(timestamp: number): string {
  if (!timestamp) return "unknown";
  return new Date(timestamp).toISOString().split("T")[0] || "unknown";
}

function getSourceLabel(result: RetrievalResult): string {
  const meta = parseMetadata(result.entry);
  return String(meta.source || result.entry.scope || "?");
}

function getCategoryLabel(result: RetrievalResult): string {
  return result.entry.category || "other";
}

function getTierLabel(result: RetrievalResult): string {
  const meta = parseMetadata(result.entry);
  return String(meta.tier || "peripheral");
}

/**
 * 所在 session 里有用户贴图时，多给一行提示。
 *
 * 图本体不在库里，正文里通常也没有对图的描述——这一行是唯一能让读到这条
 * 记忆的人意识到「这附近还有图没看」的信号。判断值不值得看，回 Deja 按
 * session 读原文。
 *
 * ⚠️ 这是 **session 级**标记，不是「本条记忆有图」：同一个 session 切出来
 * 的每条记忆都带同一个数，图未必跟眼前这条有关。粒度换覆盖，明知而为——
 * 图所在的那一轮常因正文太短根本没进库，只有盖到同 session 的其他轮次上
 * 才可能被搜到。
 *
 * 无图时返回 null，调用方据此不输出这一行——不给无图记忆添噪音。
 */
function formatSessionImages(result: RetrievalResult): string | null {
  const meta = parseMetadata(result.entry);
  const own = typeof meta.sessionImages === "number" ? meta.sessionImages : 0;
  const tool = typeof meta.sessionToolImages === "number" ? meta.sessionToolImages : 0;
  if (own <= 0 && tool <= 0) return null;

  // 两类分开报，因为它们答的是不同的问题：找「我发过的那张截图」看前者，
  // 回溯「我当时生成的图 / 那个页面当时的样子」看后者。
  // 措辞用英文，与同一块里的 prov / fresh 行保持一致（这个输出面是英文的）。
  const parts: string[] = [];
  if (own > 0) parts.push(`${own} user-pasted`);
  if (tool > 0) parts.push(`${tool} agent-made`);
  const sess = typeof meta.sessionId === "string" ? meta.sessionId.slice(0, 8) : "?";

  return `${parts.join(", ")} in this session · read sess=${sess}`;
}

interface DistilledSource {
  /** 原会话日期（`date:` 标签），不是写入日——批量回填的行两者能差出半年。 */
  date: string | null;
  /** 写入时存在行上的原文 anchor；可能是当时助手说的，不一定是用户的话。 */
  text: string;
}

/**
 * 批量提炼行（pivot-apply 从历史会话回填，2026-08-04/05 共 1,516 条）：表里那句是转述，不是原话。
 *
 * 这批提炼句没逐条核对过——2026-09-11 抽 20 条对照各自存的原文，8 条有实质走样（丢限定词、
 * 一次性要求记成长期规则、把当时助手的话记成用户偏好……）。原文 anchor 本来就存在行上，
 * 读取时亮出来，比事后清洗存量便宜，也能罩住以后同一条路写进来的行。
 *
 * 只认 pivot-apply 标签：当场记录（manual / agent）的 anchor 语义不同，不在这里出。
 * 不是批量行时返回 null，调用方据此什么都不输出——不给别的记忆添噪音。
 */
function getDistilledSource(result: RetrievalResult): DistilledSource | null {
  const meta = parseMetadata(result.entry);
  const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
  if (!tags.includes("pivot-apply")) return null;
  const dateTag = tags.find((tag) => tag.startsWith("date:"));
  return {
    date: dateTag ? dateTag.slice("date:".length) : null,
    text: typeof meta.anchor === "string" ? meta.anchor : "",
  };
}

const DISTILLED_ORIGIN_MAX_LEN = 160;

// 措辞用英文，与 prov / imgs / fresh 行保持一致（这个输出面是英文的）。
const DISTILLED_NOTE =
  "rows with an orig line were batch-distilled from old sessions: the snippet is a paraphrase, " +
  "orig is the source text (it may be the assistant's words, not the user's) — trust orig";

function formatDistilledOrigin(source: DistilledSource): string {
  const when = source.date ? `(${source.date} session) ` : "";
  const text = source.text
    ? cleanSnippet(source.text, DISTILLED_ORIGIN_MAX_LEN)
    : "(source text missing)";
  return `${when}${text}`;
}

function getProvenanceSummary(result: RetrievalResult): string {
  const provenance = extractMemoryProvenance({
    scope: result.entry.scope,
    metadata: result.entry.metadata,
  });
  const boundary = provenance.boundary;
  const meta = parseMetadata(result.entry);
  const parts = [
    boundary
      ? `${boundary.layer}/${boundary.authority}`
      : result.entry.scope.startsWith("memory:") || result.entry.scope.startsWith("asset:")
        ? "durable/?"
        : result.entry.scope.startsWith("cc:") || result.entry.scope.startsWith("codex:") || result.entry.scope.startsWith("gemini:")
          ? "evidence/?"
          : "-",
  ];

  if (boundary?.downgradedFrom) {
    parts.push(`downgraded:${boundary.downgradedFrom}`);
  }

  if (provenance.canonicalKey) {
    parts.push(`key:${provenance.canonicalKey}`);
  }

  if (provenance.promotedFrom) {
    const promotedBoundary = provenance.promotedFrom.boundary;
    const promotedLabel = promotedBoundary
      ? `${promotedBoundary.layer}/${promotedBoundary.authority}`
      : "-";
    parts.push(`promoted:${provenance.promotedFrom.memoryId.slice(0, 8)}<-${promotedLabel}`);
  }

  const hasObservationHistory =
    provenance.provenanceHistoryCount > 1 ||
    provenance.provenanceHistory.some((item) => typeof item.observedAt === "string");
  if (hasObservationHistory) {
    parts.push(`history:${provenance.provenanceHistoryCount}`);
    const latestObservation = [...provenance.provenanceHistory]
      .reverse()
      .find((item) => typeof item.observedAt === "string");
    if (latestObservation?.observedAt) {
      parts.push(`observed:${latestObservation.memoryId.slice(0, 8)}@${latestObservation.observedAt.slice(0, 10)}`);
    }
  }

  const preferenceSlot = meta.preferenceSlot;
  if (
    preferenceSlot?.type === "brand-item" &&
    typeof preferenceSlot.brand === "string" &&
    typeof preferenceSlot.item === "string"
  ) {
    parts.push(`slot:${preferenceSlot.type}:${preferenceSlot.brand}:${preferenceSlot.item}`);
  } else if (
    preferenceSlot?.type === "reply-style" &&
    Array.isArray(preferenceSlot.traits) &&
    preferenceSlot.traits.length > 0
  ) {
    parts.push(`slot:${preferenceSlot.type}:${preferenceSlot.traits.join(":")}`);
  } else if (
    preferenceSlot?.type === "tool-choice" &&
    typeof preferenceSlot.preferredTool === "string" &&
    typeof preferenceSlot.avoidedTool === "string"
  ) {
    parts.push(`slot:${preferenceSlot.type}:${preferenceSlot.preferredTool}:over:${preferenceSlot.avoidedTool}`);
  }

  return parts.join(" | ");
}

export function selectBriefSeedResults(results: RetrievalResult[]): RetrievalResult[] {
  const directResults = results.filter((result) => getSourceLabel(result) !== "asset");
  return directResults.length > 0 ? directResults : results;
}

function getFileLabel(result: RetrievalResult): string {
  const meta = parseMetadata(result.entry);
  return String(meta.file || meta.heading || "-");
}

function getSessionLabel(result: RetrievalResult): string {
  const meta = parseMetadata(result.entry);
  return String(meta.sessionId || result.entry.scope || "-");
}

function getRetrievalPath(result: RetrievalResult): string {
  const parts: string[] = [];
  if (result.sources.vector) parts.push("vector");
  if (result.sources.bm25) parts.push("bm25");
  if (result.sources.reranked) parts.push("reranked");
  if (result.sources.trigger) parts.push("trigger");
  if (result.sources.narrativeSibling) parts.push("narrative");
  return parts.join("+") || "direct";
}

function cleanSnippet(text: string, maxLen = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 3)}...`;
}

function extractTerms(query: string): string[] {
  const matches = query.match(/[\p{Script=Han}]{2,}|[a-z0-9._/-]{3,}/giu) || [];
  return Array.from(new Set(matches.map(term => term.toLowerCase()))).slice(0, 8);
}

function findMatchedTerms(query: string, text: string): string[] {
  const haystack = text.toLowerCase();
  return extractTerms(query).filter(term => haystack.includes(term));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map(part => part.trim())
    .filter(Boolean);
}

function pickBestSnippet(query: string, text: string): string {
  const terms = extractTerms(query);
  const sentences = splitSentences(text);
  if (sentences.length === 0) return cleanSnippet(text);

  let bestSentence = sentences[0] || text;
  let bestScore = -1;

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    if (score > bestScore) {
      bestSentence = sentence;
      bestScore = score;
    }
  }

  return cleanSnippet(bestSentence);
}

/**
 * adaptive 专用 query-aware snippet：取匹配词周围窗口（而非整句/开头），保证匹配证据可见。
 * 解决 pickBestSnippet 的两个退化（Codex 审点4 C 版 P2）：① 短缩写 query（如 "CI"）
 * extractTerms 提取不到词 → 退回开头；② 匹配在超长句/log 行后段 → cleanSnippet 从头截断丢匹配。
 * adaptive 档与默认第一屏（`formatFullTextResults` 里超预算降级的那条路）共用；旧表格（legacy）与 explain
 * 走的是 pickBestSnippet，不经这里。
 */
const ADAPTIVE_SNIPPET_BEFORE = 60;
const ADAPTIVE_SNIPPET_AFTER = 180;

function adaptiveSnippet(query: string, text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  // 短缩写时 extractTerms 可能为空，用 raw query 兜底直接定位。
  const terms = extractTerms(query);
  const isFallback = terms.length === 0;
  const searchTerms = (isFallback ? [query.toLowerCase().trim()] : terms).filter(Boolean);

  let matchIdx = -1;
  for (const term of searchTerms) {
    // term 定位策略：
    // - ASCII 字母数字短缩写（CI/PR）用 word boundary，避免误匹配 "specific" 里的 "ci"（Codex C P2）
    // - CJK 单字 / 符号 query（猫 / C++ / C#）：JS \b 只认 ASCII、对它们永不匹配，回到 substring（收尾审 P2-1）
    // - 正常 extractTerms 词：substring（容忍词根 / 词形）
    // 已知限制（收尾审 P2-2，留后续）：多 term 取最早出现，未按 term rarity/coverage 给窗口打分——
    // 泛词在前、判别词在窗口外时可能漏掉判别词。第一版接受。
    let idx: number;
    if (isFallback && /^[a-z0-9]+$/i.test(term)) {
      const m = new RegExp(`\\b${term}\\b`, "i").exec(clean);
      idx = m ? m.index : -1;
    } else {
      idx = lower.indexOf(term);
    }
    if (idx >= 0 && (matchIdx < 0 || idx < matchIdx)) matchIdx = idx;
  }
  if (matchIdx < 0) return pickBestSnippet(query, text); // 完全无匹配 → 退回整句最佳

  const start = Math.max(0, matchIdx - ADAPTIVE_SNIPPET_BEFORE);
  const end = Math.min(clean.length, matchIdx + ADAPTIVE_SNIPPET_AFTER);
  let snip = clean.slice(start, end).trim();
  if (start > 0) snip = "…" + snip;
  if (end < clean.length) snip = snip + "…";
  return snip;
}

function normalizeRecallText(result: RetrievalResult): string {
  const source = getSourceLabel(result);
  if (source !== "asset") return result.entry.text;

  return result.entry.text
    .replace(/^\[(Pinned Asset|Memory Brief)\]\s*/i, "")
    .replace(/\bSummary:\s*/gi, "")
    .replace(/\bSnippet:\s*/gi, "")
    .replace(/\bOriginal Scope:.*$/gim, "")
    .replace(/\bTags:.*$/gim, "")
    .replace(/\bSources:\s*/gi, "")
    .replace(/\bReusable:\s*/gi, "")
    .replace(/\bTakeaways:\s*/gi, "")
    .replace(/\bProfile:\s*/gi, "")
    .replace(/\bQuery:\s*/gi, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function ageDays(timestamp: number): number | null {
  if (!timestamp) return null;
  return Math.max(0, (Date.now() - timestamp) / 86_400_000);
}

function buildWhyMatched(query: string, result: RetrievalResult): string {
  const reasons: string[] = [];
  const matchedTerms = findMatchedTerms(query, result.entry.text);
  const meta = parseMetadata(result.entry);

  if (result.sources.vector && result.sources.bm25) {
    reasons.push("semantic+keyword");
  } else if (result.sources.vector) {
    reasons.push("semantic");
  } else if (result.sources.bm25) {
    reasons.push("keyword");
  }

  if (result.sources.reranked) {
    reasons.push("reranked");
  }

  if (result.sources.trigger) {
    // T-Mem：说清是哪句预演问法把它捞出来的（只在 explain 露面，不进 context）
    const t = result.sources.trigger;
    reasons.push(`trigger「${t.text}」cos=${t.cosine.toFixed(2)}${t.admittedBy === "soft" ? ` overlap=${(t.overlap ?? 0).toFixed(2)}` : ""}`);
  }

  if (matchedTerms.length > 0) {
    reasons.push(`terms:${matchedTerms.slice(0, 3).join(",")}`);
  }

  const days = ageDays(result.entry.timestamp);
  if (days !== null && days <= 14) {
    reasons.push(`fresh:${Math.round(days)}d`);
  }

  if ((result.entry.importance || 0) >= 0.7) {
    reasons.push("important");
  }

  if (meta.heading) {
    reasons.push(`heading:${String(meta.heading).slice(0, 24)}`);
  }

  return reasons.join(" | ") || "retrieved";
}

function buildSearchRow(index: number, query: string, result: RetrievalResult): string[] {
  return [
    String(index + 1).padEnd(2),
    result.entry.id.slice(0, 8).padEnd(8),
    `${(result.score * 100).toFixed(1)}%`.padEnd(6),
    getCategoryLabel(result).padEnd(12),
    getTierLabel(result).padEnd(10),
    getSourceLabel(result).padEnd(7),
    getDateLabel(result.entry.timestamp),
    formatAgeLabel(result.entry.timestamp).padEnd(5),
    getRetrievalPath(result).padEnd(20),
    getFileLabel(result),
    cleanSnippet(pickBestSnippet(query, result.entry.text), 120),
  ];
}

function extractBriefExcerpt(result: RetrievalResult): string {
  const { l0 } = extractMultiVectorText(result.entry.metadata);
  const raw = l0 || result.entry.text;
  return cleanSnippet(raw, 80);
}

export function formatBriefResults(
  results: RetrievalResult[],
  context: { query: string },
): string {
  if (results.length === 0) return "No results found.";
  const freshnessCache = createFreshnessCache();
  // brief 只标不附原文：它就是为省 token 选的档，原文会让它长一倍。
  const distilled = results.map(getDistilledSource);
  const lines = [
    `Query: ${context.query}`,
    `Hits: ${results.length}`,
    ...(distilled.some(Boolean)
      ? ["Note: [distilled] rows paraphrase old sessions — use detail_level=normal to see the source text"]
      : []),
    "",
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const excerpt = extractBriefExcerpt(r);
    const orig = distilled[i] ?? null;
    const distilledTag = orig ? ` [distilled${orig.date ? `, ${orig.date} session` : ""}]` : "";
    // Freshness suffix: only for memories that declared dependsOn (opt-in, cheap check).
    const fresh = evaluateEntryFreshness(r.entry.metadata, freshnessCache);
    const freshTag = fresh ? ` [fresh:${fresh}]` : "";
    lines.push(`#${i + 1} ${r.entry.id.slice(0, 8)} ${(r.score * 100).toFixed(1)}% — ${excerpt}${distilledTag}${freshTag}`);
  }
  return lines.join("\n");
}

export function formatFullResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const freshnessCache = createFreshnessCache();
  const distilled = results.map(getDistilledSource);
  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${results.length}`,
    ...(distilled.some(Boolean) ? [`Note    : ${DISTILLED_NOTE}`] : []),
    "",
    "#  ID       Score Category     Tier       Source  Date       Age   Retrieval Path       File / Snippet",
    "-- -------- ----- ------------ ---------- ------- ---------- ----- -------------------- --------------",
  ];

  for (let i = 0; i < results.length; i++) {
    const row = buildSearchRow(i, context.query, results[i]);
    lines.push(`${row[0]} ${row[1]} ${row[2]} ${row[3]} ${row[4]} ${row[5]} ${row[6]} ${row[7]} ${row[8]} ${row[9]} | ${row[10]}`);
    lines.push(`   prov : ${getProvenanceSummary(results[i])}`);
    const imgs = formatSessionImages(results[i]);
    if (imgs) lines.push(`   imgs : ${imgs}`);
    const orig = distilled[i] ?? null;
    if (orig) lines.push(`   orig : ${formatDistilledOrigin(orig)}`);
    // Full mode: append metadata details
    const meta = parseMetadata(results[i].entry);
    const evolution = typeof meta.evolutionStatus === "string" ? meta.evolutionStatus : "-";
    const accessCount = typeof meta.accessCount === "number" ? String(meta.accessCount) : "-";
    const readers = typeof meta.distinctReaderCount === "number" ? String(meta.distinctReaderCount) : "-";
    const importance = results[i].entry.importance.toFixed(2);
    const tags = Array.isArray(meta.tags) ? (meta.tags as string[]).join(", ") : "-";
    // Emotion metadata (from emotion-detector)
    const emotionPart = meta.emotion && typeof meta.emotion === "object"
      ? ` emotion=${(meta.emotion as Record<string, unknown>).label ?? "-"}(v=${(meta.emotion as Record<string, unknown>).valence ?? 0},a=${(meta.emotion as Record<string, unknown>).arousal ?? 0})`
      : "";
    // HP-narrative: Narrative metadata (from narrative-tagger)
    const narrative = parseNarrative(results[i].entry.metadata);
    const narrativePart = narrative
      ? ` narrative=${narrative.lifePeriodLabel}/${narrative.generalEventLabel}`
      : "";
    // F1: Confidence metadata
    const confMeta = getConfidenceMetadata(results[i].entry);
    const confPart = confMeta
      ? ` confidence=${confMeta.score.toFixed(2)}(${confMeta.reliability})`
      : "";
    lines.push(`   meta : evolution=${evolution} accessCount=${accessCount} readers=${readers} importance=${importance} tags=[${tags}]${confPart}${emotionPart}${narrativePart}`);
    // Freshness: only shown for memories that declared dependsOn (opt-in, cheap check).
    const fresh = evaluateEntryFreshness(results[i].entry.metadata, freshnessCache);
    if (fresh) lines.push(`   fresh: ${fresh}`);
  }

  return lines.join("\n");
}

/**
 * 2026-10-05 之前的默认第一屏：表格 + 每条 120 字片段。函数体一个字没动，只是改了名。
 * 现在只在 `RECALLNEST_SEARCH_FIRST_SCREEN=legacy` 时由 `formatSearchResults` 走到（退回开关）。
 */
export function formatLegacyTableResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const freshnessCache = createFreshnessCache();
  const distilled = results.map(getDistilledSource);
  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${results.length}`,
    ...(distilled.some(Boolean) ? [`Note    : ${DISTILLED_NOTE}`] : []),
    "",
    "#  ID       Score Category     Tier       Source  Date       Age   Retrieval Path       File / Snippet",
    "-- -------- ----- ------------ ---------- ------- ---------- ----- -------------------- --------------",
  ];

  for (let i = 0; i < results.length; i++) {
    const row = buildSearchRow(i, context.query, results[i]);
    lines.push(`${row[0]} ${row[1]} ${row[2]} ${row[3]} ${row[4]} ${row[5]} ${row[6]} ${row[7]} ${row[8]} ${row[9]} | ${row[10]}`);
    lines.push(`   prov : ${getProvenanceSummary(results[i])}`);
    const imgs = formatSessionImages(results[i]);
    if (imgs) lines.push(`   imgs : ${imgs}`);
    const orig = distilled[i] ?? null;
    if (orig) lines.push(`   orig : ${formatDistilledOrigin(orig)}`);
    // Freshness: only shown for memories that declared dependsOn (opt-in, cheap check).
    const fresh = evaluateEntryFreshness(results[i].entry.metadata, freshnessCache);
    if (fresh) lines.push(`   fresh: ${fresh}`);
  }

  return lines.join("\n");
}

const ADAPTIVE_TOKEN_BUDGET = 8000;

/**
 * 默认第一屏单条正文的封顶（按码点数）。
 *
 * 线是照库里的实际长度定的（2026-10-05 只读快照，138,501 条活跃记忆）：手写与提炼条目最长 2,278、
 * 会话切片最长 2,077、记忆文件切片最长 1,523，都在线下，永远给全文；会被截的只有项目文档的大切片
 * （`project:` 7,797 条，中位 2,401、最长 3,990）。封顶防的是一条长文档排第一时把后面几条的预算吃光。
 */
const FIRST_SCREEN_ENTRY_CAP = 2400;

const DISTILLED_NOTE_FULLTEXT =
  "entries with an orig line are batch-distilled paraphrases of old sessions; " +
  "orig is the source text (it may be the assistant's words, not the user's) — trust orig";

/**
 * 条目行末尾的出处：有会话编号就给 `sess=前 8 位`（imgs 行、Deja 回查用的都是它）；文件名只在它不是
 * 会话编号的重复时才给——Claude Code 的会话文件叫 `<会话编号>.jsonl`、Codex 的叫 `rollout-<时间>-<会话编号>.jsonl`，
 * 再写一遍每条白占四五十个字。
 */
function getOriginLabel(result: RetrievalResult): string[] {
  const meta = parseMetadata(result.entry);
  const sessionId = typeof meta.sessionId === "string" ? meta.sessionId : "";
  const file = getFileLabel(result);
  const parts: string[] = [];
  if (sessionId) parts.push(`sess=${sessionId.slice(0, 8)}`);
  // 要整段会话编号对上才算重复：只对上前 8 位的可能是另有内容的文件名。
  const repeatsSession = sessionId !== "" && file.endsWith(`${sessionId}.jsonl`);
  if (file !== "-" && !repeatsSession) parts.push(file);
  return parts;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * adaptiveSnippet / cleanSnippet 按 UTF-16 下标切，窗口边上可能留下半个代理对。
 * 默认第一屏这条路上把落单的那半个去掉；那两个函数本身不动（adaptive、legacy、explain 的输出不变）。
 */
function dropLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, "");
}

/** 片段里属于原文的字数：去掉片段函数在两头补的省略号。 */
function snippetSourceChars(snippet: string): number {
  return Array.from(snippet.replace(/^…/, "").replace(/(…|\.\.\.)$/, "")).length;
}

/** 按码点取开头一段，不把代理对切成两半。`total` 是整条的码点数。 */
function headByCodePoints(text: string, max: number): { head: string; total: number; truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= max) return { head: text, total: points.length, truncated: false };
  return { head: points.slice(0, max).join(""), total: points.length, truncated: true };
}

/**
 * 默认第一屏（2026-10-05 起）：按名次给正文全文。
 *
 * 为什么不沿用 120 字片段：同一批 48 条真实查询、同一份命中，三位读者盲判「只看这一屏就够」，
 * 表格 + 120 字是 1 条、全文是 18 条；旧默认屏里正文只占 23%，5 条全文合计的中位字数反而比它短。
 * 为什么不按分数给（adaptive 的做法）：分数是融合排序分，只表示这一批里的相对位置，排第一的中位
 * 只有 0.64，43 条非空查询里 31 条一条全文都拿不到。所以这里只看名次，不看分数。
 *
 * 规则：
 *   - 按传入顺序（handler 已排好）逐条给正文；单条超过 FIRST_SCREEN_ENTRY_CAP 只给开头那一段。
 *   - 给全文的额度是 ADAPTIVE_TOKEN_BUDGET（与 adaptive 同一个数，正文与 orig 行一起算）。放不下的条目降成
 *     匹配词周围的片段，后面更短的条目放得下仍给全文。
 *   - 每条命中都列出来，不因预算整条消失——这一点有意不照 adaptive（它超预算会停并报 omitted）。
 *     所以 8000 是「给全文给到哪为止」的线，不是整屏的硬顶：片段、以及整条不比片段窗口（240 字）长的短条目
 *     不受它拦，整屏最多超出「剩下每条一个片段」（limit ≤ 20；20 条都是 2400 个汉字时约 12,000）。
 *     先给所有条目预留片段再分全文的做法试算过：尾部的片段会把排第一的长条目挤成片段，和「按名次给」相反。
 *   - search_memory 的 related-scope 附栏各调一次本函数，各有一份额度。
 *   - 缩短过的条目各带一行说明：共多少字、给了多少、用哪个编号展开。顶上 Text 行报整屏的全文 / 截断 / 片段条数。
 *   - 元数据每条一行。旧表格里的 Tier 与 Retrieval Path 两列不再出，会话文件名换成 `sess=前 8 位`；
 *     这三样 detail_level=full 里还有。
 *   - imgs / orig / fresh 三种附加行照旧。
 */
export function formatFullTextResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const freshnessCache = createFreshnessCache();
  const blocks: string[] = [];
  let tokensUsed = 0;
  let fullCount = 0;
  let cappedCount = 0;
  let snippetCount = 0;
  let anyOrig = false;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const id = r.entry.id.slice(0, 8);
    // 展开提示给完整编号：8 位前缀在库里有撞的（2026-10-05 快照 138,502 行里 2 组），撞了 memory_drill_down 取不回来。
    const drillHint = `memory_drill_down ${r.entry.id} for the full text`;
    const capped = headByCodePoints(r.entry.text, FIRST_SCREEN_ENTRY_CAP);
    const orig = getDistilledSource(r);
    const origLine = orig ? `   orig : ${dropLoneSurrogates(formatDistilledOrigin(orig))}` : "";
    const origTokens = origLine ? estimateTokens(origLine) : 0;

    let text = capped.head;
    let cutNote = capped.truncated
      ? `   … [truncated: showing ${FIRST_SCREEN_ENTRY_CAP} of ${capped.total} chars · ${drillHint}]`
      : "";
    let tokens = estimateTokens(text) + origTokens;
    // 整条不比一个片段窗口长的条目不降级：降了也省不下字，只会多出一行「给了片段」的说明。
    const worthSnipping = capped.total > ADAPTIVE_SNIPPET_BEFORE + ADAPTIVE_SNIPPET_AFTER;
    if (worthSnipping && tokensUsed + tokens > ADAPTIVE_TOKEN_BUDGET) {
      text = dropLoneSurrogates(adaptiveSnippet(context.query, r.entry.text));
      cutNote = `   [snippet: token budget reached · showing ${snippetSourceChars(text)} of ${capped.total} chars · ${drillHint}]`;
      tokens = estimateTokens(text) + origTokens;
      snippetCount++;
    } else if (capped.truncated) {
      cappedCount++;
    } else {
      fullCount++;
    }
    tokensUsed += tokens;

    const prov = getProvenanceSummary(r);
    const header = [
      id,
      `${(r.score * 100).toFixed(1)}%`,
      `${getDateLabel(r.entry.timestamp)} (${formatAgeLabel(r.entry.timestamp)})`,
      getCategoryLabel(r),
      getSourceLabel(r),
      ...(prov !== "-" ? [prov] : []),
      ...getOriginLabel(r),
    ].join(" · ");
    blocks.push(`[${i + 1}] ${header}`);
    // fresh 管的是「这条还能不能照着用」，放在正文前面；只有声明过 dependsOn 的记忆才有（opt-in）。
    const fresh = evaluateEntryFreshness(r.entry.metadata, freshnessCache);
    if (fresh) blocks.push(`   fresh: ${fresh}`);
    blocks.push(text);
    if (cutNote) blocks.push(cutNote);
    if (origLine) {
      blocks.push(origLine);
      anyOrig = true;
    }
    const imgs = formatSessionImages(r);
    if (imgs) blocks.push(`   imgs : ${imgs}`);
    blocks.push("");
  }
  // 去掉自己加的最后一个块间空行；不对整份输出 trimEnd，否则最后一条正文自己的结尾空白也会被吃掉。
  blocks.pop();

  // 全部给全的时候这一行只报条数；有缩短的才把封顶与预算写出来。
  const shortened = cappedCount + snippetCount > 0;
  const breakdown = [
    `${fullCount} in full`,
    ...(cappedCount > 0 ? [`${cappedCount} capped (${FIRST_SCREEN_ENTRY_CAP}-char cap)`] : []),
    ...(snippetCount > 0 ? [`${snippetCount} snippet (${ADAPTIVE_TOKEN_BUDGET}-token budget)`] : []),
  ].join(", ") + (shortened ? " — shortened entries say how much is shown" : "");
  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${results.length}`,
    `Text    : ${breakdown}`,
    ...(anyOrig ? [`Note    : ${DISTILLED_NOTE_FULLTEXT}`] : []),
    "",
    ...blocks,
  ];
  return lines.join("\n");
}

/**
 * search_memory 默认档（detail_level=normal）、命令行 `search`、本地 UI 共用的入口。
 * 默认出全文那一版；`RECALLNEST_SEARCH_FIRST_SCREEN=legacy` 退回表格 + 120 字片段。
 */
export function formatSearchResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  return searchFirstScreen() === "legacy"
    ? formatLegacyTableResults(results, context)
    : formatFullTextResults(results, context);
}

/**
 * P-fidelity (点4): adaptive 保真度渲染 — 借鉴 RepoPrompt CE「保真度阶梯」的内核
 * （按相关性分配保真度 + token 预算），但 search-native 实现。
 *
 * 为什么不复用 resume_context 的 collapseResults（CC+Codex 共识，Codex 三轮 review）：
 * collapse 的 l0 floor / 按 score 重排 / query-agnostic fallback 都是为 resume 场景定制，
 * 搬到 search 连续撞三个 P2（隐藏过滤 / 覆盖 highlight 排序 / 丢失匹配证据）。search 的语义
 * 不同——结果是"为什么这条命中"，必须 query-aware；故第一版自实现两档：
 *   - 高相关（score ≥ fullTextScoreThreshold()：legacy 0.85，bounded 流行度下 0.80）→ 全文
 *   - 其余 → query-aware snippet（pickBestSnippet，显示匹配证据）
 * 按 handler 传入顺序（normal=score / highlight=contextual）依次填入 token 预算，超预算时
 * 全文降级 snippet、snippet 仍超则停止（剩余计入 omitted）。完整三档保真度阶梯（每条记忆预存
 * 多档摘要 + 预缓存 token 成本）留作后续大改。
 */
export function formatCollapsedResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const rendered: string[] = [];
  let tokensUsed = 0;
  let shown = 0;
  let anyOrigShown = false;
  const fullScore = fullTextScoreThreshold();

  // 保留传入顺序（不重排）：handler 已按 normal=score / highlight=contextual 排好。
  for (const r of results) {
    const isFull = r.score >= fullScore;
    let level = isFull ? "FULL" : "SNIP";
    // query-aware：snippet 取匹配词周围窗口、显示匹配证据（search 是"为什么命中"）。
    let text = isFull ? r.entry.text : adaptiveSnippet(context.query, r.entry.text);
    // 批量提炼行附原文。它同样占预算，和正文一起算，别让原文把预算悄悄撑破。
    const orig = getDistilledSource(r);
    const origLine = orig ? `orig: ${formatDistilledOrigin(orig)}` : "";
    const origTokens = origLine ? estimateTokens(origLine) : 0;
    let tokens = estimateTokens(text) + origTokens;

    if (tokensUsed + tokens > ADAPTIVE_TOKEN_BUDGET) {
      if (isFull) {
        // 全文超预算 → 降级为 query-aware snippet
        text = adaptiveSnippet(context.query, r.entry.text);
        level = "SNIP";
        tokens = estimateTokens(text) + origTokens;
      }
      if (tokensUsed + tokens > ADAPTIVE_TOKEN_BUDGET) break; // snippet 仍超 → 停止，剩余计入 omitted
    }
    tokensUsed += tokens;
    shown++;

    // 定位信息：id / score / category / source（Codex 约束：search 结果必须可定位）
    const id = r.entry.id.slice(0, 8);
    const scorePct = `${(r.score * 100).toFixed(0)}%`;
    rendered.push(`[${level}] ${id}  ${scorePct}  ${getCategoryLabel(r)}  ${getSourceLabel(r)}`);
    rendered.push(text);
    if (origLine) {
      rendered.push(origLine);
      anyOrigShown = true;
    }
    rendered.push("");
  }

  const omitted = results.length - shown;
  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Mode    : adaptive — full text for score ≥ ${fullScore}, query-aware snippet otherwise, ${ADAPTIVE_TOKEN_BUDGET}-token budget`,
    `Shown   : ${shown} of ${results.length}${omitted > 0 ? ` (${omitted} omitted: token budget)` : ""}`,
    ...(anyOrigShown ? [`Note    : ${DISTILLED_NOTE}`] : []),
    "",
    ...rendered,
  ];
  return lines.join("\n").trimEnd();
}

export function formatExplainResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  if (results.length === 0) return "No results found.";

  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${results.length}`,
    "",
    "# Explain",
  ];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const score = `${(result.score * 100).toFixed(1)}%`;
    const retrieval = getRetrievalPath(result);
    const file = getFileLabel(result);
    const session = getSessionLabel(result);
    const why = buildWhyMatched(context.query, result);

    lines.push(`${i + 1}. ${result.entry.id.slice(0, 8)} | ${score} | ${getSourceLabel(result)} | ${getDateLabel(result.entry.timestamp)} (${formatAgeLabel(result.entry.timestamp)})`);
    lines.push(`   category: ${getCategoryLabel(result)}`);
    lines.push(`   tier    : ${getTierLabel(result)}`);
    lines.push(`   path    : ${retrieval}`);
    lines.push(`   session : ${session}`);
    lines.push(`   file    : ${file}`);
    lines.push(`   prov    : ${getProvenanceSummary(result)}`);
    lines.push(`   why     : ${why}`);
    lines.push(`   snippet : ${pickBestSnippet(context.query, result.entry.text)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function summarizeResults(
  results: RetrievalResult[],
  context: RenderContext,
): DistilledSummary {
  if (results.length === 0) {
    return {
      query: context.query,
      profile: context.profile,
      hits: 0,
      sources: [],
      takeaways: [],
      evidence: [],
      reusableCandidates: [],
    };
  }

  const sourceMap = new Map<string, { hits: number; newest: number; files: Set<string> }>();
  const topTakeaways: string[] = [];
  const evidence: DistilledEvidence[] = [];
  const reusable: string[] = [];
  const seenTakeaways = new Set<string>();
  const seenReusable = new Set<string>();

  for (const result of results) {
    const source = getSourceLabel(result);
    const file = getFileLabel(result);
    const bucket = sourceMap.get(source) || { hits: 0, newest: 0, files: new Set<string>() };
    bucket.hits += 1;
    bucket.newest = Math.max(bucket.newest, result.entry.timestamp || 0);
    if (file !== "-") bucket.files.add(file);
    sourceMap.set(source, bucket);
  }

  for (const result of results) {
    const takeaway = `${getSourceLabel(result)}: ${pickBestSnippet(context.query, normalizeRecallText(result))}`;
    if (!seenTakeaways.has(takeaway)) {
      topTakeaways.push(takeaway);
      seenTakeaways.add(takeaway);
    }
    if (topTakeaways.length >= 4) break;
  }

  for (const result of results.slice(0, 5)) {
    evidence.push({
      memoryId: result.entry.id,
      source: getSourceLabel(result),
      scope: result.entry.scope,
      date: getDateLabel(result.entry.timestamp),
      age: formatAgeLabel(result.entry.timestamp),
      retrievalPath: getRetrievalPath(result),
      snippet: pickBestSnippet(context.query, normalizeRecallText(result)),
    });
  }

  for (const result of results) {
    const candidate = pickBestSnippet(context.query, normalizeRecallText(result));
    if (candidate.length < 20) continue;
    if (seenReusable.has(candidate)) continue;
    reusable.push(candidate);
    seenReusable.add(candidate);
    if (reusable.length >= 3) break;
  }

  const sources = Array.from(sourceMap.entries())
    .sort((a, b) => b[1].hits - a[1].hits)
    .map(([source, stats]) => ({
      source,
      hits: stats.hits,
      newest: getDateLabel(stats.newest),
      files: Array.from(stats.files).slice(0, 3),
    }));

  return {
    query: context.query,
    profile: context.profile,
    hits: results.length,
    sources,
    takeaways: topTakeaways,
    evidence,
    reusableCandidates: reusable,
  };
}

export function distillResults(
  results: RetrievalResult[],
  context: RenderContext,
): string {
  const summary = summarizeResults(results, context);
  if (summary.hits === 0) return "No results found.";

  const lines = [
    `Query   : ${context.query}`,
    `Profile : ${context.profile}`,
    `Hits    : ${summary.hits}`,
    "",
    "Source Map",
    "Source     Hits  Newest      Files",
    "---------- ----- ----------  ------------------------------",
  ];

  for (const item of summary.sources) {
    lines.push(
      `${item.source.padEnd(10)} ${String(item.hits).padEnd(5)} ${item.newest.padEnd(10)}  ${item.files.join(", ") || "-"}`,
    );
  }

  lines.push("", "Core Takeaways");
  summary.takeaways.forEach((item, index) => lines.push(`${index + 1}. ${item}`));

  lines.push("", "Evidence");
  summary.evidence.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.source} | ${item.date} (${item.age}) | ${item.retrievalPath} | ${item.snippet}`);
  });

  lines.push("", "Reusable Memory Candidates");
  if (summary.reusableCandidates.length === 0) {
    lines.push("1. No strong reusable memory candidate yet. Expand the query or use a broader profile.");
  } else {
    summary.reusableCandidates.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }

  return lines.join("\n");
}
