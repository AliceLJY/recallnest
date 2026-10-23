/**
 * session-ledger — 把一场会话的事件变成一份 markdown 账本（plan.md v3 第 1、2 条的文件形状）。
 *
 * 一场一文件，frontmatter 带 session / source / machine / started / ended / trigger / pass；正文四节：
 * 解决了什么 / 决定与否决 / 经验（待确认）/ 没做完；文末两节机器抽取（报错清单、当场写过的记忆）不经 LLM。
 * 「决定与否决」是 P1 ② 加的（P0 账本召回：checkpoint 的 decisions 只覆盖 45%，决定没有自己的节）。
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
  /** 定下的与否决的做法，每条以「定：」或「否：」开头、带理由与谁定的（P1 ②） */
  decisions: string[];
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
  /** agent = 收工时当场的 agent 自己写的正文（P1 ⑤），llm = 扫描器兜底生成 */
  generator: "llm" | "none" | "llm-failed" | "agent";
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
  /**
   * 敏感性比较用（互审 P0 R1 Codex N6）：助手常在写记忆之前先用自然语言复述一遍，maskMemoryWrites 只遮工具输入、
   * 遮不住复述。打开后，含记忆写入的那一轮（上一条用户发言到下一条用户发言之间）的助手发言全部隐藏——
   * 这是「复述」的上界（连同一轮里别的助手话一起遮了），只给回放量偏差用，生产不开。
   */
  maskRestatement?: boolean;
}

export const DEFAULT_RENDER: Required<RenderTranscriptOptions> = { maxChars: 28_000, assistantClip: 500, errorClip: 300, maskMemoryWrites: false, maskRestatement: false };
/** 结尾这么多条事件单独标出、不削、助手发言放宽到 TAIL_ASSISTANT_CLIP 字——结尾定结果（P1 ②：「没做完」要在这里找完成证据） */
export const TAIL_EVENTS = 10;
export const TAIL_ASSISTANT_CLIP = 1200;
export const TAIL_MARKER = `[—— 会话最后 ${TAIL_EVENTS} 条 ——]`;
export const EXPERIENCE_KINDS = ["坑", "技巧", "决定", "偏好"] as const;

/** 出站前脱敏（互审 R1 Codex #9）：原始转录不该带着凭证去 LLM；先脱敏再截断（#7） */
function safe(text: string, max?: number): string {
  const t = redactSecrets(text).text;
  return max !== undefined && t.length > max ? `${t.slice(0, max)}…` : t;
}

function shortTs(ts: string | null): string {
  return ts ? ts.slice(11, 16) : "--:--";
}

const MEMORY_WRITE_RE = /(checkpoint_session|store_case|store_memory|store_workflow_pattern)$/;

/**
 * 把事件渲染成给 LLM 读的紧凑文本；超长时从中间削助手发言，首尾保全（开头定任务、结尾定结果）。
 * 最后 TAIL_EVENTS 条前插一行 TAIL_MARKER、这几条不削、其中助手发言放宽到 TAIL_ASSISTANT_CLIP 字：
 * P0 无声场抽检 10 场错漏里 8 场是「没做完」把结尾已做完的事写成待办，原因是结尾被削或被截在 500 字。
 */
export function renderTranscriptForLLM(doc: SessionDoc, opts: RenderTranscriptOptions = {}): { text: string; droppedEvents: number } {
  const o = { ...DEFAULT_RENDER, ...opts };
  // 轮次：一条真人发言到下一条真人发言之间算一轮（maskRestatement 按轮遮）
  const turnOf = new Map<number, number>();
  const turnsWithMemoryWrite = new Set<number>();
  let turn = 0;
  for (const e of doc.events) {
    if (e.kind === "user" && !e.injected) turn++;
    turnOf.set(e.seq, turn);
    if (e.kind === "tool_call" && e.toolName && MEMORY_WRITE_RE.test(e.toolName)) turnsWithMemoryWrite.add(turn);
  }
  const lines: Array<{ seq: number; weight: number; render: (tail: boolean) => string }> = [];
  const callNames = new Map<string, string>();
  for (const e of doc.events) {
    switch (e.kind) {
      case "user":
        if (e.injected) break;
        lines.push({ seq: e.seq, weight: 3, render: () => `[U#${e.seq} ${shortTs(e.ts)}] ${safe(e.text)}` });
        break;
      case "assistant":
        if (o.maskRestatement && turnsWithMemoryWrite.has(turnOf.get(e.seq) ?? -1)) break;
        lines.push({ seq: e.seq, weight: 1, render: (tail) => `[A#${e.seq}] ${safe(e.text, tail ? Math.max(o.assistantClip, TAIL_ASSISTANT_CLIP) : o.assistantClip)}` });
        break;
      case "tool_call":
        if (e.toolCallId && e.toolName) callNames.set(e.toolCallId, e.toolName);
        if (e.toolName && MEMORY_WRITE_RE.test(e.toolName)) {
          const name = e.toolName.replace(/^mcp__recallnest__/, "");
          const input = e.toolInput;
          if (o.maskMemoryWrites) lines.push({ seq: e.seq, weight: 2, render: () => `[MEM#${e.seq}] （当场写了一条记忆，回放时隐藏）` });
          else lines.push({ seq: e.seq, weight: 2, render: () => `[MEM#${e.seq} ${name}] ${input ? safe(JSON.stringify(input), 800) : ""}` });
        }
        break;
      case "tool_result":
        if (e.isError && !/interrupted|doesn't want to proceed|rejected/i.test(e.text.slice(0, 300))) {
          const name = e.toolCallId ? callNames.get(e.toolCallId) : undefined;
          lines.push({ seq: e.seq, weight: 2, render: () => `[ERR#${e.seq}${name ? ` ${name}` : ""}] ${safe(e.text.replace(/\s+/g, " "), o.errorClip)}` });
        }
        break;
      default:
        break;
    }
  }
  const tailStart = Math.max(0, lines.length - TAIL_EVENTS);
  const texts = lines.map((l, i) => l.render(i >= tailStart));
  const withMarker = (kept: number[]): string => {
    const out: string[] = [];
    for (const i of kept) {
      if (i === tailStart && tailStart > 0) out.push(TAIL_MARKER);
      out.push(texts[i]);
    }
    return out.join("\n");
  };
  let total = texts.reduce((n, t) => n + t.length + 1, 0);
  const all = texts.map((_, i) => i);
  if (total <= o.maxChars) return { text: withMarker(all), droppedEvents: 0 };
  // 从中间往两头削权重最低的（助手发言）；结尾 TAIL_EVENTS 条与最后 3 条助手行、3 条报错行不削
  const protectedIdx = new Set<number>();
  for (let i = tailStart; i < lines.length; i++) protectedIdx.add(i);
  for (const w of [1, 2]) {
    let kept = 0;
    for (let i = lines.length - 1; i >= 0 && kept < 3; i--) if (lines[i].weight === w) { protectedIdx.add(i); kept++; }
  }
  const order = lines.map((l, i) => ({ i, dist: Math.abs(i - lines.length / 2), w: l.weight })).sort((a, b) => a.w - b.w || a.dist - b.dist);
  const drop = new Set<number>();
  let dropped = 0;
  for (const { i } of order) {
    if (total <= o.maxChars) break;
    if (lines[i].weight >= 3 || protectedIdx.has(i)) continue;
    drop.add(i);
    total -= texts[i].length + 1;
    dropped++;
  }
  if (total > o.maxChars) {
    // 还超：用户行不丢，但单条截到 2,000 字（R3 Codex 自评 #4：30,000 字的用户输入会让预算形同虚设）
    for (let i = 0; i < texts.length; i++) {
      if (!drop.has(i) && lines[i].weight >= 3 && texts[i].length > 2000) texts[i] = `${texts[i].slice(0, 2000)}… [用户发言截断 ${texts[i].length - 2000} 字]`;
    }
  }
  return { text: withMarker(all.filter((i) => !drop.has(i))), droppedEvents: dropped };
}

export const LEDGER_SYSTEM_PROMPT = `你是会话账本的记录员。读一场 AI 助手与用户的对话转录（已压缩：[U#序号 时间] 用户说的话、[A#序号] 助手说的话、[ERR#序号 工具名] 工具报错、[MEM#序号] 当场写过的记忆；「${TAIL_MARKER}」之后是会话结束前的最后几条），写一份事实性的账本，记的是**会话结束时**的状态。

只写转录里有依据的内容，不推测、不补全、不美化。输出 JSON（UTF-8，中文），字段：
{
  "oneLine": "一句话说这场会话做了什么（≤40 字）",
  "solved": ["解决了什么 / 做成了什么，每条一句，带关键名词（文件、命令、服务、数字）"],
  "decisions": ["定下来的做法或否决掉的做法，每条一句，以「定：」或「否：」开头，写清定的是什么、谁定的（用户拍板 / 用户认可了助手的方案 / 助手自己的技术取舍）、理由"],
  "experience": [
    {"text": "一条可复用的经验（坑 / 技巧 / 决定 / 用户偏好），一句话，不超过 60 字",
     "anchor": "转录里逐字摘录的原话（用户或助手说的，≤120 字，不得改写）",
     "anchorSeq": 原话所在的事件序号（整数，取 [U#n] / [A#n] / [ERR#n] 里的 n）,
     "kind": "坑 | 技巧 | 决定 | 偏好"}
  ],
  "unfinished": ["会话结束时仍没做完的事 / 仍在等人拍板的事 / 明说了的下一步，每条一句"]
}
规则：
1. experience 宁缺毋滥：没有真正可复用的就给空数组；一次性的操作细节不算经验。{{EXPERIENCE_RULE}}
2. anchor 必须是转录里能逐字找到的一段，不要用自己的话转述；找不到原话就不要写这条经验。
3. 用户明确表达的偏好、否决、决定，用用户自己的话当 anchor。
4. unfinished 写之前，先到「${TAIL_MARKER}」之后找完成证据：助手已报告做完、已提交 / 已推送 / 测试通过、或用户已确认的，就不是没做完，写进 solved；中途提过、后来做完了的不写；只是助手的建议、用户没要求做的不写。找不到完成证据、也没人说不做了的，才写进 unfinished。
5. decisions 不要把助手的建议写成用户的决定；用户没表态的方案不算「定」。被推翻的旧决定写成「否：」并写新决定。没有就给空数组。
6. 不写任何密钥、token、密码；遇到就写 [REDACTED]。
7. 只输出 JSON，不加解释。`;

const STRIP_CHAR_RE = /[\s“”"'‘’「」『』。，、；：！？,.;:!?()（）\-—…*_`#>•·\[\]【】]/u;

/** 归一化并记下每个归一化字符对应的原文下标（边界检查要看原文里前一个字符是什么） */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // 数字前的负号保留（「-10 度」≠「10 度」，R3 Codex 从自评 #5 推出的反例）
    if (ch === "-" && i + 1 < chars.length && /\d/.test(chars[i + 1])) {
      norm += "-";
      map.push(i);
      continue;
    }
    if (STRIP_CHAR_RE.test(ch)) continue;
    norm += ch.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

export function normalizeForMatch(s: string): string {
  // 去空白、标点、markdown 记号（**粗体**、`code`、列表的 - / • / 1.）——原文常是 markdown，LLM 摘录时会把这些抹掉
  return normalizeWithMap(s).norm;
}

/** 边界：锚点起点在**原文**里的前一个字符不能是汉字 / 字母 / 数字——「这不是生产环境」截成「是生产环境」过不了，
 *  而「注意：这不是…」里从「这」起的摘录（前面是冒号）照常通过（R3 Codex 自评 #5 反例） */
function startsAtBoundary(raw: string[], map: number[], idx: number): boolean {
  if (idx <= 0) return true;
  const rawIdx = map[idx];
  if (rawIdx === undefined || rawIdx === 0) return true;
  return !/[\p{L}\p{N}]/u.test(raw[rawIdx - 1]);
}

/** 核锚点：逐字（去空白与标点后）在转录事件里找得到才算 verified；找到了但序号不对就修正序号 */
export function verifyAnchor(doc: SessionDoc, anchor: string, seq: number | null): { verified: boolean; seq: number | null } {
  const needle = normalizeForMatch(anchor);
  if (needle.length < 4) return { verified: false, seq };
  const check = (e: SessionEvent | undefined) => {
    if (!e) return false;
    const { norm, map } = normalizeWithMap(e.text);
    const raw = [...e.text];
    let idx = norm.indexOf(needle);
    while (idx >= 0) {
      if (startsAtBoundary(raw, map, idx)) return true;
      idx = norm.indexOf(needle, idx + 1);
    }
    return false;
  };
  if (seq !== null && check(doc.events[seq])) return { verified: true, seq };
  const hit = doc.events.find((e) => (e.kind === "user" || e.kind === "assistant" || e.kind === "tool_result") && check(e));
  return hit ? { verified: true, seq: hit.seq } : { verified: false, seq };
}

export function parseLedgerJson(raw: string, doc: SessionDoc): LedgerBody {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as Partial<{ oneLine: unknown; solved: unknown; decisions: unknown; experience: unknown; unfinished: unknown }>;
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
      const kind = typeof it.kind === "string" && (EXPERIENCE_KINDS as readonly string[]).includes(it.kind.trim()) ? it.kind.trim() : "";
      experience.push({ text: it.text.trim(), anchor, anchorSeq: v.seq, anchorVerified: v.verified, kind });
    }
  }
  return { oneLine: typeof parsed.oneLine === "string" ? parsed.oneLine.trim() : "", solved: strs(parsed.solved), decisions: strs(parsed.decisions), experience, unfinished: strs(parsed.unfinished) };
}

export interface GenerateLedgerOptions extends RenderTranscriptOptions {
  maxTokens?: number;
  /** 候选阶段到了没（D2：第一次静默只写账本，经验候选 6 小时后才出）。false 时 prompt 不要经验、输出里也清空（互审 R1 Codex #6） */
  includeCandidates?: boolean;
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
  const includeCandidates = opts.includeCandidates ?? true;
  const systemPrompt = LEDGER_SYSTEM_PROMPT.replace("{{EXPERIENCE_RULE}}", includeCandidates ? "" : "\n   本阶段只记事实账本，experience 一律给空数组 []。");
  let result;
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      result = await llm.chatLongDetailed(systemPrompt, `会话来源：${doc.source}；事件数 ${doc.events.length}${rendered.droppedEvents ? `（已削去 ${rendered.droppedEvents} 条助手发言）` : ""}。\n\n${rendered.text}`, {
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
  const finish = (body: LedgerBody): LedgerBody => (includeCandidates ? body : { ...body, experience: [] });
  try {
    return { body: finish(parseLedgerJson(result.content, doc)), usage, rendered };
  } catch (error) {
    // 坏 JSON 重试一次：把坏输出喂回去让它只修格式（不重新读转录，省 token；修不好就记失败）
    try {
      const fix = await llm.chatLongDetailed("你只做一件事：把用户给的文本修成合法 JSON（UTF-8），字段与内容一字不改，只修引号、逗号、括号。只输出 JSON。", result.content.slice(0, 12_000), { responseFormat: { type: "json_object" }, tokenLimit: { parameter: "max_tokens", value: opts.maxTokens ?? 1800 }, temperature: 0 });
      if (fix?.content) {
        usage.promptTokens += fix.usage?.promptTokens ?? 0;
        usage.completionTokens += fix.usage?.completionTokens ?? 0;
        return { body: finish(parseLedgerJson(fix.content, doc)), usage, rendered };
      }
    } catch {
      /* fall through */
    }
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
  sections.push(`## 决定与否决\n${body?.decisions.length ? body.decisions.map((s) => `- ${red(s)}`).join("\n") : body ? "- （无）" : "- （未生成）"}`);
  // 当场 agent 写的经验已经分流进 pivot / case（收工第五步），这里只列它和指针，不套候选的原话锚点格式
  const exp = generator === "agent"
    ? (body?.experience.length ? body.experience.map((x) => `- ${red(x.text)}${x.kind ? `（${x.kind}）` : ""}`).join("\n") : "- （无）")
    : body?.experience.length
    ? body.experience.map((x) => `- ${red(x.text)}${x.kind ? `（${x.kind}）` : ""} ｜原文：「${red(x.anchor) || "—"}」 ｜src:${sid8}#${x.anchorSeq ?? "?"}${x.anchorVerified ? "" : " ｜anchor:未核"}`).join("\n")
    : "- （无）";
  sections.push(`## ${generator === "agent" ? "经验（已分流）" : "经验（待确认）"}\n${exp}`);
  sections.push(`## 没做完\n${body?.unfinished.length ? body.unfinished.map((s) => `- ${red(s)}`).join("\n") : "- （无）"}`);
  // 机器抽取两节
  const errLines = summary.errors.slice(0, 20).map((e) => {
    const sigs = extractErrorSignatures({ problem: e.text.slice(0, 4000) });
    const specific = sigs.filter((s) => classifySignatureSpecificity(s) === "specific");
    const head = red(e.text.replace(/\s+/g, " ")).slice(0, 160);
    return `- ${e.toolName ?? "tool"} #${e.seq}: ${head}${specific.length ? ` ｜签名：${specific.map((s) => red(s).slice(0, 100)).join(" ‖ ")}` : ""}`;
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
