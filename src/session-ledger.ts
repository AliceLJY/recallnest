/**
 * session-ledger — 把一场会话的事件变成一份 markdown 账本（plan.md v3 第 1、2 条的文件形状）。
 *
 * 一场一文件，frontmatter 带 session / source / machine / started / ended / trigger / pass；正文三节：
 * 解决了什么 / 经验（待确认）/ 没做完；文末两节机器抽取（报错清单、当场写过的记忆）不经 LLM。
 *
 * 两层分工（D3）：这里是第二层「服务端 LLM 兜底」——只负责覆盖；质量由当场的 agent（第一层）和人负责。
 * 所以它的产物全部进「待确认」，每条经验必须带原话锚点（逐字摘录 + 事件序号），锚点在转录里找不到的
 * 直接标 `anchor:未核`，不悄悄放行；pivot 零自动写入（v3 第 4 条）。
 *
 * 文本一律过 redactSecrets 再落盘（open-loops 10-22：checkpoint JSON 不脱敏是既存缺口，账本不能再添一份）。
 */

import type { LLMClient } from "./llm-client.js";
import { redactSecrets } from "./pii-detector.js";
import { extractErrorSignatures } from "./error-signature.js";
import { classifySignatureSpecificity } from "./error-signature-specificity.js";
import { summarizeSession, type SessionDoc, type SessionEvent, type SessionSummary } from "./session-events.js";

export interface LedgerExperience {
  text: string;
  anchor: string;
  anchorSeq: number | null;
  anchorVerified: boolean;
  kind: string;
}

export interface LedgerBody {
  oneLine: string;
  solved: string[];
  experience: LedgerExperience[];
  unfinished: string[];
}

export interface LedgerUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  wallMs: number;
  inputChars: number;
}

export interface LedgerRender {
  frontmatter: Record<string, unknown>;
  body: LedgerBody | null;
  usage: LedgerUsage | null;
  generator: "llm" | "none" | "llm-failed";
  failure?: string;
  markdown: string;
}

export interface RenderTranscriptOptions {
  /** 喂给 LLM 的总字符上限（qwen-turbo 上下文够大，但账本不该靠读完 10 万字才写得出） */
  maxChars?: number;
  /** 每条助手发言保留多少字 */
  assistantClip?: number;
  /** 每条报错保留多少字 */
  errorClip?: number;
  /** 回放时隐藏当场写过的记忆（checkpoint / store_case 的输入），否则「账本召回」会被它们灌水 */
  maskMemoryWrites?: boolean;
}

export const DEFAULT_RENDER: Required<RenderTranscriptOptions> = { maxChars: 28_000, assistantClip: 500, errorClip: 300, maskMemoryWrites: false };

function shortTs(ts: string | null): string {
  return ts ? ts.slice(11, 16) : "--:--";
}

/** 把事件渲染成给 LLM 读的紧凑文本；超长时从中间削助手发言，首尾保全（开头定任务、结尾定结果） */
export function renderTranscriptForLLM(doc: SessionDoc, opts: RenderTranscriptOptions = {}): { text: string; droppedEvents: number } {
  const o = { ...DEFAULT_RENDER, ...opts };
  const lines: Array<{ seq: number; text: string; weight: number }> = [];
  const callNames = new Map<string, string>();
  for (const e of doc.events) {
    switch (e.kind) {
      case "user":
        if (e.injected) break;
        lines.push({ seq: e.seq, text: `[U#${e.seq} ${shortTs(e.ts)}] ${e.text}`, weight: 3 });
        break;
      case "assistant":
        lines.push({ seq: e.seq, text: `[A#${e.seq}] ${e.text.length > o.assistantClip ? `${e.text.slice(0, o.assistantClip)}…` : e.text}`, weight: 1 });
        break;
      case "tool_call":
        if (e.toolCallId && e.toolName) callNames.set(e.toolCallId, e.toolName);
        if (e.toolName && /(checkpoint_session|store_case|store_memory|store_workflow_pattern)$/.test(e.toolName)) {
          if (o.maskMemoryWrites) lines.push({ seq: e.seq, text: `[MEM#${e.seq}] （当场写了一条记忆，回放时隐藏）`, weight: 2 });
          else lines.push({ seq: e.seq, text: `[MEM#${e.seq} ${e.toolName.replace(/^mcp__recallnest__/, "")}] ${e.toolInput ? JSON.stringify(e.toolInput).slice(0, 800) : ""}`, weight: 2 });
        }
        break;
      case "tool_result":
        if (e.isError && !/interrupted|doesn't want to proceed|rejected/i.test(e.text.slice(0, 300))) {
          const name = e.toolCallId ? callNames.get(e.toolCallId) : undefined;
          lines.push({ seq: e.seq, text: `[ERR#${e.seq}${name ? ` ${name}` : ""}] ${e.text.replace(/\s+/g, " ").slice(0, o.errorClip)}`, weight: 2 });
        }
        break;
      default:
        break;
    }
  }
  let total = lines.reduce((n, l) => n + l.text.length + 1, 0);
  let dropped = 0;
  if (total > o.maxChars) {
    // 从中间往两头削权重最低的（助手发言），直到够用
    const order = lines.map((l, i) => ({ i, dist: Math.abs(i - lines.length / 2), w: l.weight })).sort((a, b) => a.w - b.w || a.dist - b.dist);
    const drop = new Set<number>();
    for (const { i } of order) {
      if (total <= o.maxChars) break;
      if (lines[i].weight >= 3) continue;
      drop.add(i);
      total -= lines[i].text.length + 1;
      dropped++;
    }
    return { text: lines.filter((_, i) => !drop.has(i)).map((l) => l.text).join("\n"), droppedEvents: dropped };
  }
  return { text: lines.map((l) => l.text).join("\n"), droppedEvents: 0 };
}

export const LEDGER_SYSTEM_PROMPT = `你是会话账本的记录员。读一场 AI 助手与用户的对话转录（已压缩：[U#序号 时间] 用户说的话、[A#序号] 助手说的话、[ERR#序号 工具名] 工具报错、[MEM#序号] 当场写过的记忆），写一份事实性的账本。

只写转录里有依据的内容，不推测、不补全、不美化。输出 JSON（UTF-8，中文），字段：
{
  "oneLine": "一句话说这场会话做了什么（≤40 字）",
  "solved": ["解决了什么 / 做成了什么，每条一句，带关键名词（文件、命令、服务、数字）"],
  "experience": [
    {"text": "一条可复用的经验（坑 / 技巧 / 决定 / 用户偏好），一句话，不超过 60 字",
     "anchor": "转录里逐字摘录的原话（用户或助手说的，≤120 字，不得改写）",
     "anchorSeq": 原话所在的事件序号（整数，取 [U#n] / [A#n] / [ERR#n] 里的 n）,
     "kind": "坑 | 技巧 | 决定 | 偏好"}
  ],
  "unfinished": ["没做完 / 等人拍板 / 下一步，每条一句"]
}
规则：
1. experience 宁缺毋滥：没有真正可复用的就给空数组；一次性的操作细节不算经验。
2. anchor 必须是转录里能逐字找到的一段，不要用自己的话转述；找不到原话就不要写这条经验。
3. 用户明确表达的偏好、否决、决定，用用户自己的话当 anchor。
4. 不写任何密钥、token、密码；遇到就写 [REDACTED]。
5. 只输出 JSON，不加解释。`;

function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, "").replace(/[“”"'‘’「」『』。，、；：！？,.;:!?()（）\-—…]/g, "").toLowerCase();
}

/** 核锚点：逐字（去空白与标点后）在转录事件里找得到才算 verified；找到了但序号不对就修正序号 */
export function verifyAnchor(doc: SessionDoc, anchor: string, seq: number | null): { verified: boolean; seq: number | null } {
  const needle = normalizeForMatch(anchor);
  if (needle.length < 4) return { verified: false, seq };
  const check = (e: SessionEvent | undefined) => !!e && normalizeForMatch(e.text).includes(needle);
  if (seq !== null && check(doc.events[seq])) return { verified: true, seq };
  const hit = doc.events.find((e) => (e.kind === "user" || e.kind === "assistant" || e.kind === "tool_result") && check(e));
  return hit ? { verified: true, seq: hit.seq } : { verified: false, seq };
}

export function parseLedgerJson(raw: string, doc: SessionDoc): LedgerBody {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as Partial<{ oneLine: unknown; solved: unknown; experience: unknown; unfinished: unknown }>;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);
  const experience: LedgerExperience[] = [];
  if (Array.isArray(parsed.experience)) {
    for (const item of parsed.experience) {
      if (!item || typeof item !== "object") continue;
      const it = item as { text?: unknown; anchor?: unknown; anchorSeq?: unknown; kind?: unknown };
      if (typeof it.text !== "string" || !it.text.trim()) continue;
      const anchor = typeof it.anchor === "string" ? it.anchor.trim() : "";
      const seqIn = typeof it.anchorSeq === "number" && Number.isInteger(it.anchorSeq) ? it.anchorSeq : null;
      const v = anchor ? verifyAnchor(doc, anchor, seqIn) : { verified: false, seq: seqIn };
      experience.push({ text: it.text.trim(), anchor, anchorSeq: v.seq, anchorVerified: v.verified, kind: typeof it.kind === "string" ? it.kind : "" });
    }
  }
  return { oneLine: typeof parsed.oneLine === "string" ? parsed.oneLine.trim() : "", solved: strs(parsed.solved), experience, unfinished: strs(parsed.unfinished) };
}

export interface GenerateLedgerOptions extends RenderTranscriptOptions {
  maxTokens?: number;
  /** 429 / 超时类错误的重试次数（默认 3）与退避起点毫秒（默认 8000，逐次翻倍） */
  retries?: number;
  retryBaseMs?: number;
}

const RETRYABLE_RE = /\b(429|rate.?limit|request limit|timeout|timed out|ECONNRESET|ETIMEDOUT|503|502|overloaded)\b/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 调 LLM 生成正文；失败返回 null + 原因，不抛（扫描器要能继续处理下一场） */
export async function generateLedgerBody(doc: SessionDoc, llm: LLMClient, opts: GenerateLedgerOptions = {}): Promise<{ body: LedgerBody | null; usage: LedgerUsage | null; failure?: string; rendered: { text: string; droppedEvents: number } }> {
  const rendered = renderTranscriptForLLM(doc, opts);
  const t0 = performance.now();
  const retries = opts.retries ?? 3;
  const base = opts.retryBaseMs ?? 8000;
  let result;
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      result = await llm.chatLongDetailed(LEDGER_SYSTEM_PROMPT, `会话来源：${doc.source}；事件数 ${doc.events.length}${rendered.droppedEvents ? `（已削去 ${rendered.droppedEvents} 条助手发言）` : ""}。\n\n${rendered.text}`, {
        responseFormat: { type: "json_object" },
        tokenLimit: { parameter: "max_tokens", value: opts.maxTokens ?? 1800 },
        temperature: 0.1,
      });
      lastError = "";
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < retries && RETRYABLE_RE.test(lastError)) {
        await sleep(base * 2 ** attempt);
        continue;
      }
      break;
    }
  }
  if (lastError) return { body: null, usage: null, failure: `llm error: ${lastError}`, rendered };
  const wallMs = Math.round(performance.now() - t0);
  if (!result?.content) return { body: null, usage: null, failure: "llm returned empty (breaker open or null content)", rendered };
  const usage: LedgerUsage = { model: result.responseModel, promptTokens: result.usage?.promptTokens ?? 0, completionTokens: result.usage?.completionTokens ?? 0, wallMs, inputChars: rendered.text.length };
  try {
    return { body: parseLedgerJson(result.content, doc), usage, rendered };
  } catch (error) {
    return { body: null, usage, failure: `bad json: ${error instanceof Error ? error.message : String(error)}`, rendered };
  }
}

export interface LedgerMeta {
  trigger: "auto-sweep" | "manual-收工" | "precompact" | "replay";
  pass: number;
  machine?: string;
  generatedAt?: string;
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  return /[:#\n"'{}\[\],&*?|<>=!%@`]/.test(s) || s.trim() !== s || s === "" ? JSON.stringify(s) : s;
}

function red(s: string): string {
  return redactSecrets(s).text;
}

/** 渲染成最终 markdown。body 为 null 时只写机器抽取的两节（`--no-llm` 影子跑法 / LLM 失败） */
export function renderLedgerMarkdown(doc: SessionDoc, summary: SessionSummary, body: LedgerBody | null, meta: LedgerMeta, usage: LedgerUsage | null, generator: LedgerRender["generator"], failure?: string): LedgerRender {
  const frontmatter: Record<string, unknown> = {
    session: doc.sessionId,
    source: doc.source,
    machine: meta.machine ?? doc.machine ?? null,
    started: doc.startedAt,
    ended: doc.endedAt,
    trigger: meta.trigger,
    pass: meta.pass,
    generated_at: meta.generatedAt ?? new Date().toISOString(),
    generator,
    model: usage?.model ?? null,
    tokens: usage ? `${usage.promptTokens}+${usage.completionTokens}` : null,
    turns: `${summary.userTurns}u/${summary.assistantTurns}a/${summary.toolCalls}t/${summary.toolErrors}e`,
    experience_pending: body?.experience.length ?? 0,
    anchors_unverified: body?.experience.filter((x) => !x.anchorVerified).length ?? 0,
  };
  const fm = ["---", ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${yamlScalar(v)}`), "---"].join("\n");
  const sid8 = doc.sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  const sections: string[] = [];
  sections.push(`# ${red(body?.oneLine || `${doc.source} 会话 ${sid8}`)}`);
  sections.push(`## 解决了什么\n${body?.solved.length ? body.solved.map((s) => `- ${red(s)}`).join("\n") : "- （未生成）"}`);
  const exp = body?.experience.length
    ? body.experience.map((x) => `- ${red(x.text)}${x.kind ? `（${x.kind}）` : ""} ｜原文：「${red(x.anchor) || "—"}」 ｜src:${sid8}#${x.anchorSeq ?? "?"}${x.anchorVerified ? "" : " ｜anchor:未核"}`).join("\n")
    : "- （无）";
  sections.push(`## 经验（待确认）\n${exp}`);
  sections.push(`## 没做完\n${body?.unfinished.length ? body.unfinished.map((s) => `- ${red(s)}`).join("\n") : "- （无）"}`);
  // 机器抽取两节
  const errLines = summary.errors.slice(0, 20).map((e) => {
    const sigs = extractErrorSignatures({ problem: e.text.slice(0, 4000) });
    const specific = sigs.filter((s) => classifySignatureSpecificity(s) === "specific");
    const head = red(e.text.replace(/\s+/g, " ").slice(0, 160));
    return `- ${e.toolName ?? "tool"} #${e.seq}: ${head}${specific.length ? ` ｜签名：${specific.map((s) => red(s.slice(0, 100))).join(" ‖ ")}` : ""}`;
  });
  sections.push(`## 报错（机器抽取，${summary.toolErrors} 条${summary.errors.length > 20 ? "，只列前 20" : ""}）\n${errLines.length ? errLines.join("\n") : "- （无）"}`);
  const memCounts = new Map<string, number>();
  for (const m of summary.memoryWrites) memCounts.set(m.tool.replace(/^mcp__recallnest__/, ""), (memCounts.get(m.tool.replace(/^mcp__recallnest__/, "")) ?? 0) + 1);
  sections.push(`## 当场写过的记忆（机器抽取）\n${memCounts.size ? [...memCounts.entries()].map(([k, v]) => `- ${k} ×${v}`).join("\n") : "- （无）"}`);
  if (failure) sections.push(`> 生成失败：${red(failure)}`);
  const markdown = `${fm}\n\n${sections.join("\n\n")}\n`;
  return { frontmatter, body, usage, generator, failure, markdown };
}

/** 一步到位：有 llm 就生成正文，没有就只出机器抽取版 */
export async function buildLedger(doc: SessionDoc, meta: LedgerMeta, llm: LLMClient | null, opts: GenerateLedgerOptions = {}): Promise<LedgerRender> {
  const summary = summarizeSession(doc);
  if (!llm) return renderLedgerMarkdown(doc, summary, null, meta, null, "none");
  const gen = await generateLedgerBody(doc, llm, opts);
  return renderLedgerMarkdown(doc, summary, gen.body, meta, gen.usage, gen.body ? "llm" : "llm-failed", gen.failure);
}
