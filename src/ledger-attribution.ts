/**
 * 账本「决定与否决」的归属复判（2026-10-31，P1 影子周 ⑤ 超线后换的做法）。
 *
 * 为什么要它：10-24～10-30 的正式账本抽 40 条对原会话，关键词判法假收 6、误降 15（判据 ≥5 就换做法）。两类错方向相反：
 *  - 假收：引的确实是用户原话，但挂到了不相干的决定上（一句「快点快点」被当成对体检 B 区的拍板）；
 *  - 误降：用户回了「可以」「加吧」「选臻臻」确认助手刚提的方案，关键词判法要求原话 ≥4 字、且 prompt 让「好 / 嗯」写助手，一律降成助手提议。
 * 所以改成按「主语和目标事项」判（10-23 R5 Codex 的提法）：让 LLM 对每条决定指出是哪一条用户发言、摘原句；
 * 代码只核两件机械的事——那条发言确实是真人用户说的、原句逐字在里面。判不了或核不过就不算用户的。
 * LLM 失败时返回 null，调用方保留关键词判法的结果，不让账本因为复判失败而写不出来。
 */
import type { LLMClient } from "./llm-client.js";
import type { SessionDoc, SessionEvent } from "./session-events.js";
import { normalizeForMatch } from "./session-ledger.js";

export interface DecisionItem {
  text: string;
  /** LLM 账本给的归属；旧格式（纯字符串）记「旧格式」 */
  by: "用户" | "助手" | "旧格式";
  anchor: string;
}

export const ATTRIBUTION_VERDICTS = ["用户定", "用户否", "助手提议", "判不了"] as const;
export type AttributionVerdict = (typeof ATTRIBUTION_VERDICTS)[number];

export interface AttributionJudgement {
  verdict: AttributionVerdict;
  userSeq: number | null;
  quote: string;
}

/** 复判输入里用户发言的总字数上限；超了按与决定的字面重合度留前面的，再按时间排回去 */
export const ATTRIBUTION_INPUT_BUDGET = 16_000;
const USER_CLIP = 1000;
const PREV_ASSISTANT_CLIP = 300;
export const ATTRIBUTION_MAX_TOKENS = 1200;

export const ATTRIBUTION_SYSTEM_PROMPT = `你判断会话账本里每条「决定」是谁拍的板。给你两样东西：账本列出的决定（D1、D2…），和这场会话里真人用户的全部发言（[U#序号] 用户：…），每条发言前附上它之前助手说的最后一段（此前助手：…），用来看用户是在回应什么。

对每条决定，判一个 verdict：
- 用户定：有一条用户发言，说的就是这件事，并且是用户在拍板——用户自己提出这个做法，或者助手刚提出这个具体方案、用户回答同意（「可以」「加吧」「行，就按你的」「选 X」这类短回答，只要此前助手问的正是这件事，就算）。
- 用户否：用户明确说出了与这条决定相反的做法（比如决定写「不提前补发」，用户说「改到现在发」）。用户只是提问、补充背景、指出别的问题、或抱怨某个现象，都不算用户否——那种情况看这条决定后来有没有被用户认可，没有就判助手提议。
- 助手提议：这是助手自己的提议或技术取舍，用户没有针对它表态；或者用户的话只是泛泛催促、转去问别的事，与这条决定无关。
- 判不了：材料不够判断。
要点：只看用户发言的主语和目标事项是不是这条决定，不要因为字面上出现了相同的词就算；用户整段贴进来的别人（助手、另一个窗口、文档）的文字不是用户自己的话，不能拿来作证；一句发言不能同时给两条不相干的决定作证；「快点」「继续」「好的我看看」这类不针对具体方案的话不算拍板。

用户定 / 用户否 必须给 userSeq（那条发言的序号整数）和 quote（从那条发言里逐字摘出能说明问题的那一句，≤60 字，不改写）。其余 verdict 的 userSeq 写 null、quote 写空串。

只输出 JSON：{"judgements":[{"d":1,"verdict":"用户定","userSeq":12,"quote":"…"}, …]}，每条决定一项，按 D 的编号。`;

function clip(s: string, n: number, fromEnd = false): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return fromEnd ? `…${t.slice(t.length - n)}` : `${t.slice(0, n)}…`;
}

function realUserTurns(doc: SessionDoc): Array<{ ev: SessionEvent; prev: string }> {
  const out: Array<{ ev: SessionEvent; prev: string }> = [];
  let lastAssistant = "";
  for (const e of doc.events) {
    if (e.kind === "assistant" && e.text.trim()) lastAssistant = e.text;
    if (e.kind === "user" && !e.injected && e.text.trim()) {
      out.push({ ev: e, prev: lastAssistant });
      lastAssistant = "";
    }
  }
  return out;
}

function bigrams(s: string): Set<string> {
  const n = normalizeForMatch(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < n.length; i++) out.add(n.slice(i, i + 2));
  return out;
}

/** 组复判的用户消息：决定列表 + 用户发言（附此前助手的最后一段）。超预算时按与全部决定的二字重合度取舍 */
export function buildAttributionInput(doc: SessionDoc, decisions: DecisionItem[], budget = ATTRIBUTION_INPUT_BUDGET): string {
  const turns = realUserTurns(doc).map(({ ev, prev }) => ({
    seq: ev.seq,
    line: `[U#${ev.seq}] 用户：${clip(ev.text, USER_CLIP)}${prev ? `\n  （此前助手：${clip(prev, PREV_ASSISTANT_CLIP, true)}）` : ""}`,
    score: 0,
  }));
  let total = turns.reduce((a, t) => a + t.line.length, 0);
  let kept = turns;
  if (total > budget) {
    const want = bigrams(decisions.map((d) => d.text).join(" "));
    for (const t of turns) {
      let hit = 0;
      for (const g of bigrams(t.line)) if (want.has(g)) hit++;
      t.score = hit;
    }
    kept = [];
    total = 0;
    for (const t of [...turns].sort((a, b) => b.score - a.score || b.seq - a.seq)) {
      if (total + t.line.length > budget) continue;
      kept.push(t);
      total += t.line.length;
    }
    kept.sort((a, b) => a.seq - b.seq);
  }
  const dl = decisions.map((d, i) => `D${i + 1}：${d.text}`).join("\n");
  const omitted = turns.length - kept.length;
  return `账本里的决定：\n${dl}\n\n用户发言（共 ${turns.length} 条${omitted ? `，按与决定的相关度略去 ${omitted} 条` : ""}）：\n${kept.map((t) => t.line).join("\n")}`;
}

/** 核 quote：userSeq 那条必须是真人用户的发言（不是注入），quote 归一化后逐字在里面 */
export function verifyUserQuote(doc: SessionDoc, userSeq: number | null, quote: string): boolean {
  if (userSeq === null || !Number.isInteger(userSeq)) return false;
  const ev = doc.events.find((e) => e.seq === userSeq);
  if (!ev || ev.kind !== "user" || ev.injected) return false;
  const q = normalizeForMatch(quote);
  if (q.length === 0) return false;
  return normalizeForMatch(ev.text).includes(q);
}

/** 解析复判输出；verdict 不认识的项按「判不了」；输出里漏掉的项给 null（调用方对这条退回关键词判法） */
export function parseAttributionJson(raw: string, count: number): Array<AttributionJudgement | null> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as { judgements?: unknown };
  const out: Array<AttributionJudgement | null> = Array.from({ length: count }, () => null);
  if (!Array.isArray(parsed.judgements)) return out;
  for (const j of parsed.judgements) {
    if (!j || typeof j !== "object") continue;
    const it = j as { d?: unknown; verdict?: unknown; userSeq?: unknown; quote?: unknown };
    const d = typeof it.d === "number" ? it.d : Number(it.d);
    if (!Number.isInteger(d) || d < 1 || d > count) continue;
    const verdict = typeof it.verdict === "string" && (ATTRIBUTION_VERDICTS as readonly string[]).includes(it.verdict.trim()) ? (it.verdict.trim() as AttributionVerdict) : "判不了";
    const userSeq = typeof it.userSeq === "number" && Number.isInteger(it.userSeq) ? it.userSeq : null;
    out[d - 1] = { verdict, userSeq, quote: typeof it.quote === "string" ? it.quote.trim() : "" };
  }
  return out;
}

/** 补摘原句时给的整条发言上限 */
const REQUOTE_CLIP = 2400;

export const REQUOTE_SYSTEM_PROMPT = `上一步判定下面这些决定是用户拍的板，但摘出来的原句在那条用户发言里逐字找不到（多半是改写了或拼接了）。对每一项，从给出的那条用户发言里逐字复制一段能说明用户拍板的连续原文（≤60 字，标点、错字、语气词都照抄，不改写、不拼接两处）。找不到这样一段就给空串。

只输出 JSON：{"quotes":[{"d":1,"quote":"…"}, …]}`;

/** 判了用户定 / 用户否、指向真人用户发言、但原句核不过的项：补问一次，只要逐字原句（10-31 复测 5 条误降里 4 条是这个形状） */
async function requote(doc: SessionDoc, decisions: DecisionItem[], judgements: Array<AttributionJudgement | null>, llm: LLMClient): Promise<{ promptTokens: number; completionTokens: number }> {
  const todo: number[] = [];
  judgements.forEach((j, i) => {
    if (!j || (j.verdict !== "用户定" && j.verdict !== "用户否") || verifyUserQuote(doc, j.userSeq, j.quote)) return;
    const ev = doc.events.find((e) => e.seq === j.userSeq);
    if (ev && ev.kind === "user" && !ev.injected) todo.push(i);
  });
  if (todo.length === 0) return { promptTokens: 0, completionTokens: 0 };
  const input = todo
    .map((i) => {
      const ev = doc.events.find((e) => e.seq === judgements[i]!.userSeq)!;
      return `D${i + 1}：${decisions[i].text}\n[U#${ev.seq}] 用户：${clip(ev.text, REQUOTE_CLIP)}`;
    })
    .join("\n\n");
  try {
    const r = await llm.chatLongDetailed(REQUOTE_SYSTEM_PROMPT, input, { responseFormat: { type: "json_object" }, tokenLimit: { parameter: "max_tokens", value: 600 }, temperature: 0 });
    if (!r?.content) return { promptTokens: 0, completionTokens: 0 };
    const parsed = JSON.parse(r.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { quotes?: unknown };
    if (Array.isArray(parsed.quotes)) {
      for (const q of parsed.quotes) {
        if (!q || typeof q !== "object") continue;
        const it = q as { d?: unknown; quote?: unknown };
        const i = (typeof it.d === "number" ? it.d : Number(it.d)) - 1;
        if (!todo.includes(i) || typeof it.quote !== "string") continue;
        judgements[i] = { ...judgements[i]!, quote: it.quote.trim() };
      }
    }
    return { promptTokens: r.usage?.promptTokens ?? 0, completionTokens: r.usage?.completionTokens ?? 0 };
  } catch {
    return { promptTokens: 0, completionTokens: 0 };
  }
}

/** 调 LLM 复判；没有决定、LLM 不可用或输出坏掉都返回 null（调用方保留原判） */
export async function judgeDecisionAttribution(
  doc: SessionDoc,
  decisions: DecisionItem[],
  llm: LLMClient,
): Promise<{ judgements: Array<AttributionJudgement | null>; promptTokens: number; completionTokens: number } | null> {
  if (decisions.length === 0) return null;
  try {
    const r = await llm.chatLongDetailed(ATTRIBUTION_SYSTEM_PROMPT, buildAttributionInput(doc, decisions), {
      responseFormat: { type: "json_object" },
      tokenLimit: { parameter: "max_tokens", value: ATTRIBUTION_MAX_TOKENS },
      temperature: 0,
    });
    if (!r?.content) return null;
    const judgements = parseAttributionJson(r.content, decisions.length);
    const extra = await requote(doc, decisions, judgements, llm);
    return { judgements, promptTokens: (r.usage?.promptTokens ?? 0) + extra.promptTokens, completionTokens: (r.usage?.completionTokens ?? 0) + extra.completionTokens };
  } catch {
    return null;
  }
}

/**
 * 按复判结果渲染一条决定的归属尾注；quote 核不过一律不算用户的。
 * 「用户否」只用来不算用户拍板，不写「与用户原话相反」：10-31 复测四轮里它有 2–3 次把用户的提问、补充背景判成反对，
 * 写出来就是一句错的断言；不写只是降成没核到（同一批里真的相反那条照样不会被记成用户拍板）
 */
export function renderJudgedDecision(doc: SessionDoc, item: DecisionItem, j: AttributionJudgement): string {
  if (j.verdict === "用户定" && verifyUserQuote(doc, j.userSeq, j.quote)) return `${item.text}（用户原话：「${j.quote}」）`;
  return item.by === "助手" ? `${item.text}（助手的取舍）` : `${item.text}（用户原话没核到，按助手提议看）`;
}
