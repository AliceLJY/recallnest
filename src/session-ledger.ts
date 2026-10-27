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
import { isHookInterceptionText } from "./ledger-signatures.js";
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

export interface RenderedTranscript {
  text: string;
  /** 削掉的行数（含 droppedUserTurns） */
  droppedEvents: number;
  /** 其中削掉的用户发言（只有截到 USER_LINE_CLIP 之后仍超预算才会削） */
  droppedUserTurns: number;
}

/**
 * 把事件渲染成给 LLM 读的紧凑文本；超长时从中间削助手发言，首尾保全（开头定任务、结尾定结果）。
 * 最后 TAIL_EVENTS 条前插一行 TAIL_MARKER、这几条不削、其中助手发言放宽到 TAIL_ASSISTANT_CLIP 字：
 * P0 无声场抽检 10 场错漏里 8 场是「没做完」把结尾已做完的事写成待办，原因是结尾被削或被截在 500 字。
 */
export function renderTranscriptForLLM(doc: SessionDoc, opts: RenderTranscriptOptions = {}): RenderedTranscript {
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
  // masked：遮复述的实验组里被遮的行。它先占着位置把「结尾 10 行」定下来再拿走——否则遮掉之后更早的旧发言会滑进结尾、
  // 拿到放宽的 1200 字，实验组反而看到对照组看不到的内容（P1 互审 R1 Codex #8）
  const lines: Array<{ seq: number; weight: number; masked?: boolean; render: (tail: boolean) => string }> = [];
  const callNames = new Map<string, string>();
  for (const e of doc.events) {
    switch (e.kind) {
      case "user":
        if (e.injected) break;
        lines.push({ seq: e.seq, weight: 3, render: () => `[U#${e.seq} ${shortTs(e.ts)}] ${safe(e.text)}` });
        break;
      case "assistant":
        lines.push({ seq: e.seq, weight: 1, masked: o.maskRestatement && turnsWithMemoryWrite.has(turnOf.get(e.seq) ?? -1), render: (tail) => `[A#${e.seq}] ${safe(e.text, tail ? Math.max(o.assistantClip, TAIL_ASSISTANT_CLIP) : o.assistantClip)}` });
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
  // 预算裁剪在全部行上做（被遮的行也照对照组那样渲染、占预算、参与保护行的选择），裁完再拿走被遮的行：
  // 这样遮复述组看到的恰好是对照组看到的减去被遮的那些，不会因为遮掉的行腾出预算而多留对照组削掉的旧发言
  // （P1 互审 R3 Codex C8：默认 28000 下遮复述组多留了 10 条普通助手发言）
  const texts = lines.map((l, i) => l.render(i >= tailStart));
  // 结尾标记的位置按对照组的保留集合定，被遮的行在这之后才拿走：结尾 10 行全被遮时标记照样留着，
  // 遮复述组恰好是对照组减去被遮的行（P1 互审 R4 Codex #7）
  const render = (kept: number[]): string => {
    const out: string[] = [];
    let marked = false;
    for (const i of kept) {
      if (!marked && i >= tailStart && tailStart > 0) {
        out.push(TAIL_MARKER);
        marked = true;
      }
      if (!lines[i].masked) out.push(texts[i]);
    }
    return out.join("\n");
  };
  const all = texts.map((_, i) => i);
  // 预算按最终输出算：各行加换行、减掉最后一个换行，再加结尾标记那一行（有结尾段时它一定在：结尾那几行不削）
  let total = all.reduce((n, i) => n + texts[i].length + 1, 0) - 1 + (tailStart > 0 ? TAIL_MARKER.length + 1 : 0);
  if (total <= o.maxChars) return { text: render(all), droppedEvents: 0, droppedUserTurns: 0 };
  // 从中间往两头削权重最低的（助手发言）；结尾 TAIL_EVENTS 条与最后 3 条助手行、3 条报错行不削
  const protectedIdx = new Set<number>();
  for (let i = tailStart; i < lines.length; i++) protectedIdx.add(i);
  for (const w of [1, 2]) {
    let kept = 0;
    for (let i = lines.length - 1; i >= 0 && kept < 3; i--) if (lines[i].weight === w) { protectedIdx.add(i); kept++; }
  }
  const order = all.map((i) => ({ i, dist: Math.abs(i - lines.length / 2), w: lines[i].weight })).sort((a, b) => a.w - b.w || a.dist - b.dist);
  const drop = new Set<number>();
  let dropped = 0;
  let droppedUser = 0;
  for (const { i } of order) {
    if (total <= o.maxChars) break;
    if (lines[i].weight >= 3 || protectedIdx.has(i)) continue;
    drop.add(i);
    total -= texts[i].length + 1;
    dropped++;
  }
  if (total > o.maxChars) {
    // 还超：用户行单条截到 2,000 字（R3 Codex 自评 #4：30,000 字的用户输入会让预算形同虚设）
    for (const i of all) {
      if (drop.has(i) || lines[i].weight < 3 || texts[i].length <= USER_LINE_CLIP) continue;
      const cut = `${texts[i].slice(0, USER_LINE_CLIP)}… [用户发言截断 ${texts[i].length - USER_LINE_CLIP} 字]`;
      total -= texts[i].length - cut.length;
      texts[i] = cut;
    }
  }
  if (total > o.maxChars) {
    // 截完还超（长发言一多就会，R3 Codex NEW-5：30 条 3,000 字 → 60,557 字）：从中段起削用户行，
    // 第一条用户发言（定任务）与结尾 TAIL_EVENTS 条不削。默认 28,000 下保住的部分最多约 25,000 字，上限因此落得住；
    // maxChars 再小就可能还超一点，那是保住开头与结尾的代价
    const firstUser = all.find((i) => lines[i].weight >= 3);
    for (const { i } of order) {
      if (total <= o.maxChars) break;
      if (lines[i].weight < 3 || drop.has(i) || i === firstUser || i >= tailStart) continue;
      drop.add(i);
      total -= texts[i].length + 1;
      dropped++;
      droppedUser++;
    }
  }
  return { text: render(all.filter((i) => !drop.has(i))), droppedEvents: dropped, droppedUserTurns: droppedUser };
}

/** 超预算时用户发言单条截到这么多字 */
export const USER_LINE_CLIP = 2000;

export const LEDGER_SYSTEM_PROMPT = `你是会话账本的记录员。读一场 AI 助手与用户的对话转录（已压缩：[U#序号 时间] 用户说的话、[A#序号] 助手说的话、[ERR#序号 工具名] 工具报错、[MEM#序号] 当场写过的记忆；「${TAIL_MARKER}」之后是会话结束前的最后几条），写一份事实性的账本，记的是**会话结束时**的状态。

只写转录里有依据的内容，不推测、不补全、不美化。输出 JSON（UTF-8，中文），字段：
{
  "oneLine": "一句话说这场会话做了什么（≤40 字）",
  "solved": ["解决了什么 / 做成了什么，每条一句，带关键名词（文件、命令、服务、数字）"],
  "decisions": [
    {"text": "定下来的做法或否决掉的做法，一句，以「定：」或「否：」开头，写清定的是什么和理由",
     "by": "用户 | 助手（用户亲口拍板、或明确同意了助手的方案，才写用户；用户没表态、助手自己的技术取舍写助手）",
     "anchor": "by=用户 时必填：用户自己说的那句原话，逐字摘录（≤80 字）"}
  ],
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
5. decisions 不要把助手的建议写成用户的决定：by 写「用户」必须能给出用户自己的原话；用户只是没反对、或只说了「好」「嗯」的，写助手。被推翻的旧决定写成「否：」并写新决定。没有就给空数组。偏好类 experience 同理：anchor 要用用户自己说的话。
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
    // map 按 norm 的 UTF-16 单元记：emoji 这类占两个单元的字（还有小写后变长的字）每个单元都指回同一个原文字符，
    // 否则 norm.indexOf 给的下标在它们之后整体错位（R4 R3 修复时发现）
    const low = ch.toLowerCase();
    norm += low;
    for (let k = 0; k < low.length; k++) map.push(i);
  }
  return { norm, map };
}

export function normalizeForMatch(s: string): string {
  // 去空白、标点、markdown 记号（**粗体**、`code`、列表的 - / • / 1.）——原文常是 markdown，LLM 摘录时会把这些抹掉
  return normalizeWithMap(s).norm;
}

const NEGATION_CHAR_RE = /[不没沒未非别別勿无無莫甭]/u;

/** 边界：锚点不能从**原文**里一个词的中间开始，也不能把前面的否定截掉。
 *  拉丁字母 / 数字：前一个字符不能是字母或数字（不从词中间截）。
 *  汉字没有词界，句中摘录是常态（「我明确决定以后全部使用中文回答」里摘「以后全部使用中文回答」，P1 互审 R4 Codex #5）：
 *  前一个字是汉字时，只看前两个字里有没有否定字——「这不是生产环境」截成「是生产环境」、「不要跑全量测试」截成「跑全量测试」过不了
 *  （R3 Codex 自评 #5 反例）。「注意：这不是…」里从「这」起的摘录（前面是冒号）照常通过 */
function startsAtBoundary(raw: string[], map: number[], idx: number): boolean {
  if (idx <= 0) return true;
  const rawIdx = map[idx];
  if (rawIdx === undefined || rawIdx === 0) return true;
  const prev = raw[rawIdx - 1];
  // 「不过」「没问题」这类带否定字的肯定说法先拿掉再看（R5 Codex #4：「不错不过以后全部…」）
  if (/\p{Script=Han}/u.test(prev)) return !NEGATION_CHAR_RE.test([...raw.slice(Math.max(0, rawIdx - 4), rawIdx).join("").replace(AFFIRM_RE, "")].slice(-2).join(""));
  return !/[\p{L}\p{N}]/u.test(prev);
}

/** 分句的边界：逗号、顿号、冒号、波浪号也断。破折号不断——「不要——跑全量测试」的否定管着后面 */
const CLAUSE_END_RE = /[，,、。！？!?；;：:\n~～…]/u;
/** 否定字离锚点多近算管着它：同一分句里、锚点前最近这么多个字（不数空白与标点） */
const NEGATION_WINDOW = 4;
/** 「用户不认」的说法：出现在锚点所在分句的前半截、前一个分句、锚点之后到下一个分句末尾，都可能管着锚点 */
const DISAGREE_SOURCE = "不同意|不赞成|不认同|不接受|反对|否决|不采纳|别这么|不要这么|不是这个意思";
/** 带否定字、本身却是肯定或转折的说法：数窗口里的否定字之前先拿掉（「没问题以后全部…」「不错不过以后…」，R5 Codex #4） */
const AFFIRM_RE = /没问题|没关系|没事|没错|不错|不过|不管|不论|无论|非常|不仅|不但|不少|不久/gu;
/** 「不同意」之后只剩这些语气词，才算光秃秃地管着相邻分句；接了别的东西（「我不同意删库」）就是在说别的事 */
const TRAILING_PARTICLE_RE = /[啊吧呀的哈了呢哦嘛噢喔]/gu;
/** 当前分句里「不同意」之后又转折了（「我不同意删库但以后…」），就不管锚点 */
const CONTRAST_RE = /但是|但|不过|可是|然而|而是|只是/u;
/** 「不同意」之后接了并列连词，说的是另一件事（「我反对删库而且我决定以后…」不加标点，R6 Codex #4） */
const CONJUNCTION_RE = /而且|并且|另外|同时|还有/u;
/** 锚点之后的「反对」接指代词：指的就是锚点那件事（「以后全部…，我反对这个建议」，R6 Codex #1）。只看锚点之后，前一个分句仍只认光秃秃的 */
const POINTER_RE = /^(?:这个|这样|那个|这|它|此|该)/u;
/** 采纳说法所在分句里的犹豫：「我还没决定是否采用」「要不要采用」不算采纳（R6 Codex #1） */
const HESITATE_RE = /是否|要不要|考虑|再想|再看/u;
/** 锚点之后说明这还没定、或只是助手的话：不算用户拍板（R6 Codex #1） */
const UNDECIDED_AFTER_RE = /还在考虑|再想想|再看看|还没定|待定/u;
/**
 * 同上，但只在这段话最早出自助手时看：用户自己说出口的话后面跟「你说的…」多半是在说别的（「…，你说的那个先不管」）。
 * 只认「只是 / 不过是 / 而已」这类把它说成「仅仅是对方的话」的说法：「你的建议我完全赞同」是采纳，不拦（R7 Codex #4）
 */
const ATTRIBUTED_AFTER_RE = /(?:只是|不过是|仅仅?是)(?:你的建议|你说的|你建议的)|(?:你的建议|你说的|你建议的)(?:而已|罢了)/u;
/** 方案最早出自助手时，用户要明说采纳才算她拍板（「我决定采用这个方案，以后…」，R5 Codex #4）；前一个字是否定就不算（「还没决定」「不同意」） */
const ADOPT_RE = /(?<![不没别])(?:决定|定了|就这么定|就这么办|采用|采纳|就按|按这个|按你说的|拍板|确定|同意)/u;
/** 开引号 → 闭引号（直引号开闭同形，按个数奇偶判） */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [["「", "」"], ["『", "』"], ["“", "”"], ["‘", "’"], ["\"", "\""]];

/**
 * clause 里有用户自己的采纳说法：分句里没有否定字（先拿掉「没问题」这类）与犹豫词（R6 Codex #1）；
 * 采纳词前有「你」、且「你」之后没再出现「我」，是转述对方（「你刚才说你决定了」），不算——
 * 「你这个建议我决定采纳」是用户在采纳，算（R7 Codex #4）。
 * needSubject：采纳词前要有「我」——给「反对」之后放行用：「我反对删库我决定…」放行，「我反对直接决定…」里的决定是被反对的对象（R7 Codex #1）
 */
function adoptsIn(clause: string, needSubject = false): boolean {
  const m = ADOPT_RE.exec(clause);
  if (!m) return false;
  const head = clause.slice(0, m.index);
  const you = head.lastIndexOf("你");
  if (you >= 0 && !head.slice(you).includes("我")) return false;
  if (needSubject && !head.includes("我")) return false;
  return !NEGATION_CHAR_RE.test(clause.replace(AFFIRM_RE, "")) && !HESITATE_RE.test(clause);
}

/**
 * 锚点在不在引号里：前面有没闭合的开引号，且后面先碰到的是它的闭引号（直引号：前面个数为奇数、后面还有一个）。
 * 只看前面会让前文多打的一个「把后面全算进引号（R6 Codex NEW-7，同一行也一样）；只看本行又放过跨行的引用（R7 Codex 新问题）
 */
function insideQuotes(before: string[], after: string[]): boolean {
  for (const [open, close] of QUOTE_PAIRS) {
    if (open === close) {
      if (before.filter((c) => c === open).length % 2 === 1 && after.includes(close)) return true;
      continue;
    }
    if (before.lastIndexOf(open) <= before.lastIndexOf(close)) continue;
    const c = after.indexOf(close);
    const o = after.indexOf(open);
    if (c >= 0 && (o < 0 || c < o)) return true;
  }
  return false;
}

function stripNoise(s: string): string {
  return [...s].filter((c) => !STRIP_CHAR_RE.test(c)).join("");
}

/** segment 里最后一处「不同意」类说法；bare = 它后面只剩标点和语气词 */
function lastDisagree(segment: string): { end: number; bare: boolean } | null {
  const re = new RegExp(DISAGREE_SOURCE, "gu");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(segment); m; m = re.exec(segment)) last = m;
  if (!last) return null;
  const end = last.index + last[0].length;
  return { end, bare: stripNoise(segment.slice(end)).replace(TRAILING_PARTICLE_RE, "") === "" };
}

/**
 * 用户原话核对（userOnly）的额外几关——文字出现在用户消息里，不等于用户认可这件事（P1 互审 R4 R3 Codex NEW-1、Kimi NEW-4；R5 Codex #1）：
 *  - 锚点前同一分句里最近 4 个字有否定字（先拿掉「没问题」「不错」这类）：「不要——跑全量测试」摘否定后面那半句，不算；
 *  - 同一分句前半截有「不同意 / 反对」、之后没转折、没接「而且 / 另外」这类连词、也没有用户自己的采纳说法：
 *    「我不同意你刚才说的以后全部…」，不算；「我反对删库而且我决定以后全部…」照算（R6 #4）；
 *  - 前一个分句或紧跟着的分句是光秃秃的「不同意 / 反对」：「我不同意，以后全部…」「以后全部…，这个我反对」，不算；
 *    后面接了别的事项的不管（「我不同意删库，以后全部…」「以后全部…，我反对用英文」，R5 Codex #4）；
 *    锚点之后的「反对」接的是指代词（「…，我反对这个建议」）也算管着锚点（R6 #1）；
 *  - 锚点之后到下一个分句末尾有「还在考虑 / 再想想 / 待定」：还没定，不算（R6 #1）；
 *  - 锚点落在引号（前有没闭合的开引号、后有它的闭引号，R6 NEW-7 / R7）、Markdown 引用行、代码块或行内代码里：引的是别人的话或文件内容，不算；
 *  - requireAdopt（这段话最早出自助手或工具）：同一分句前半截或前一个分句里要有「决定 / 采用 / 就按」这类采纳说法，
 *    且那个分句里没有否定、犹豫（是否 / 要不要 / 考虑），采纳词前的「你」之后要再有「我」（否则是转述对方）；锚点之后说「只是你的建议」也不算（R6 #1 / R7）。
 * 判不准就不算、降成助手提议。不按「整句里有没有否定字」判：她说话常是逗号和「~」连起来的长句，
 * 整句判在 P1 回放账本上把 259 条核到的用户原话降了 37 条真话（「是不是」「不错」「不用管」都会撞上）。
 * raw 是原文字符数组，[start, end) 是锚点在原文里的范围。
 */
function userOwnsSpan(raw: string[], start: number, end: number, requireAdopt = false): boolean {
  let clauseStart = start;
  while (clauseStart > 0 && !CLAUSE_END_RE.test(raw[clauseStart - 1])) clauseStart--;
  const pre = raw.slice(clauseStart, start).join("");
  if (NEGATION_CHAR_RE.test([...stripNoise(pre.replace(AFFIRM_RE, ""))].slice(-NEGATION_WINDOW).join(""))) return false;
  const inPre = lastDisagree(pre);
  if (inPre) {
    const rest = pre.slice(inPre.end);
    if (!CONTRAST_RE.test(rest) && !CONJUNCTION_RE.test(rest) && !adoptsIn(rest, true)) return false;
  }
  let prevStart = clauseStart - 1;
  while (prevStart > 0 && !CLAUSE_END_RE.test(raw[prevStart - 1])) prevStart--;
  const prevClause = clauseStart > 0 ? raw.slice(Math.max(0, prevStart), clauseStart - 1).join("") : "";
  let nextEnd = end;
  while (nextEnd < raw.length && !CLAUSE_END_RE.test(raw[nextEnd])) nextEnd++;
  nextEnd++;
  while (nextEnd < raw.length && !CLAUSE_END_RE.test(raw[nextEnd])) nextEnd++;
  const after = raw.slice(end, nextEnd).join("");
  const inAfter = lastDisagree(after);
  if (lastDisagree(prevClause)?.bare || inAfter?.bare || (inAfter && POINTER_RE.test(stripNoise(after.slice(inAfter.end))))) return false;
  if (UNDECIDED_AFTER_RE.test(after) || (requireAdopt && ATTRIBUTED_AFTER_RE.test(after))) return false;
  const before = raw.slice(0, start);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  if (insideQuotes(before, raw.slice(end))) return false;
  if (/^\s*>/.test(line.join("")) || line.filter((c) => c === "`").length % 2 === 1) return false;
  if (before.join("").split("\n").filter((l) => /^\s*```/.test(l)).length % 2 === 1) return false;
  if (requireAdopt && !adoptsIn(prevClause) && !adoptsIn(pre)) return false;
  return true;
}

/** 核锚点：逐字（去空白与标点后）在转录事件里找得到才算 verified；找到了但序号不对就修正序号。
 *  userOnly：只在真人用户的发言里找（偏好、用户拍板的决定必须是用户亲口说的，P1 ⑥），且要过 userOwnsSpan 那几关；
 *  这段话在全场最早出现在助手或工具输出里（用户贴回 / 复述了助手的原文，R4 R3 Kimi NEW-2），要用户明说采纳才算
 *  （最初出处与最终采纳分开判，R5 Codex #4） */
export function verifyAnchor(doc: SessionDoc, anchor: string, seq: number | null, opts: { userOnly?: boolean } = {}): { verified: boolean; seq: number | null } {
  const needle = normalizeForMatch(anchor);
  if (needle.length < 4) return { verified: false, seq };
  const spoken = (e: SessionEvent) => (e.kind === "user" && !e.injected) || e.kind === "assistant" || e.kind === "tool_result";
  const eligible = (e: SessionEvent) => (opts.userOnly ? e.kind === "user" && !e.injected : spoken(e));
  let requireAdopt = false;
  const check = (e: SessionEvent | undefined, own = false) => {
    if (!e) return false;
    const { norm, map } = normalizeWithMap(e.text);
    const raw = [...e.text];
    let idx = norm.indexOf(needle);
    while (idx >= 0) {
      if (startsAtBoundary(raw, map, idx) && (!own || userOwnsSpan(raw, map[idx], map[idx + needle.length - 1] + 1, requireAdopt))) return true;
      idx = norm.indexOf(needle, idx + 1);
    }
    return false;
  };
  if (opts.userOnly) {
    const first = doc.events.find((e) => spoken(e) && check(e));
    if (!first) return { verified: false, seq };
    requireAdopt = first.kind !== "user";
  }
  const own = !!opts.userOnly;
  const atSeq = seq !== null ? doc.events[seq] : undefined;
  if (atSeq && eligible(atSeq) && check(atSeq, own)) return { verified: true, seq };
  const hit = doc.events.find((e) => eligible(e) && check(e, own));
  return hit ? { verified: true, seq: hit.seq } : { verified: false, seq };
}

/** 偏好 / 决定的原话找不到用户亲口说过时的标签 */
export const USER_UNSAID_KIND = "助手提议";

/** LLM 用旧格式（纯字符串）给决定时的标签：没给原话，谁定的没法核 */
export const DECISION_UNVERIFIED_NOTE = "（归属没核，按助手提议看）";

/**
 * 决定与否决：LLM 给 {text, by, anchor}。by=用户 时原话必须在用户自己的发言里核得到，核不到就按助手提议写（P1 ③ 无声场
 * 30 场里 5 场至少一位读者判「把助手建议写成用户拍板」）。旧格式（纯字符串）照收，但一律标「归属没核」——
 * 否则 LLM 只要退回旧格式、在字符串里自己写「（用户拍板）」，就绕过了原话核对（P1 互审 R4 Codex #3）。
 */
export function parseDecisions(v: unknown, doc: SessionDoc): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      if (item.trim()) out.push(`${item.trim()}${DECISION_UNVERIFIED_NOTE}`);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const it = item as { text?: unknown; by?: unknown; anchor?: unknown };
    if (typeof it.text !== "string" || !it.text.trim()) continue;
    const text = it.text.trim();
    const anchor = typeof it.anchor === "string" ? it.anchor.trim() : "";
    if (it.by === "用户") {
      out.push(anchor && verifyAnchor(doc, anchor, null, { userOnly: true }).verified ? `${text}（用户原话：「${anchor}」）` : `${text}（用户原话没核到，按助手提议看）`);
    } else {
      out.push(`${text}（助手的取舍）`);
    }
  }
  return out;
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
      let kind = typeof it.kind === "string" && (EXPERIENCE_KINDS as readonly string[]).includes(it.kind.trim()) ? it.kind.trim() : "";
      // 偏好 / 决定 要是用户亲口说的：原话只在助手或工具输出里找得到，就降成「助手提议」（P0 / P1 候选走样的头号形状：
      // 把助手的判断写成用户偏好）
      if (v.verified && (kind === "偏好" || kind === "决定") && !verifyAnchor(doc, anchor, v.seq, { userOnly: true }).verified) kind = USER_UNSAID_KIND;
      experience.push({ text: it.text.trim(), anchor, anchorSeq: v.seq, anchorVerified: v.verified, kind });
    }
  }
  return { oneLine: typeof parsed.oneLine === "string" ? parsed.oneLine.trim() : "", solved: strs(parsed.solved), decisions: parseDecisions(parsed.decisions, doc), experience, unfinished: strs(parsed.unfinished) };
}

export interface GenerateLedgerOptions extends RenderTranscriptOptions {
  maxTokens?: number;
  /** 候选阶段到了没（D2：第一次静默只写账本，经验候选 6 小时后才出）。false 时 prompt 不要经验、输出里也清空（互审 R1 Codex #6） */
  includeCandidates?: boolean;
  /** 429 / 超时类错误的重试次数（默认 3）与退避起点毫秒（默认 8000，逐次翻倍） */
  retries?: number;
  retryBaseMs?: number;
}

/** 账本 JSON 的输出上限：回放（P0 / P1 复测）用的就是 2600，生产对齐它（P1 互审 R1 Kimi #8：此前生产默认 1800） */
export const LEDGER_MAX_TOKENS = 2600;

const RETRYABLE_RE = /\b(429|rate.?limit|request limit|timeout|timed out|ECONNRESET|ETIMEDOUT|503|502|overloaded)\b/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 调 LLM 生成正文；失败返回 null + 原因，不抛（扫描器要能继续处理下一场） */
export async function generateLedgerBody(doc: SessionDoc, llm: LLMClient, opts: GenerateLedgerOptions = {}): Promise<{ body: LedgerBody | null; usage: LedgerUsage | null; failure?: string; rendered: RenderedTranscript }> {
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
      result = await llm.chatLongDetailed(systemPrompt, `会话来源：${doc.source}；事件数 ${doc.events.length}${rendered.droppedEvents ? `（已削去 ${rendered.droppedEvents} 条${rendered.droppedUserTurns ? `，其中用户发言 ${rendered.droppedUserTurns} 条` : "助手发言"}）` : ""}。\n\n${rendered.text}`, {
        responseFormat: { type: "json_object" },
        tokenLimit: { parameter: "max_tokens", value: opts.maxTokens ?? LEDGER_MAX_TOKENS },
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
      const fix = await llm.chatLongDetailed("你只做一件事：把用户给的文本修成合法 JSON（UTF-8），字段与内容一字不改，只修引号、逗号、括号。只输出 JSON。", result.content.slice(0, 12_000), { responseFormat: { type: "json_object" }, tokenLimit: { parameter: "max_tokens", value: opts.maxTokens ?? LEDGER_MAX_TOKENS }, temperature: 0 });
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
  /** 「疑似又踩（机器抽取）」节的行：本场的具体性报错签名以前在别的会话里出现过（P1 ⑥，ledger-signatures.ts 算） */
  recurrence?: string[];
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

/** 列表条目压成一行：条目里带换行再以「## 」「> 」开头会被账本解析当成新节（P1 互审 R1 Kimi #9） */
function li(s: string): string {
  return red(s).replace(/\s*\n\s*/g, " / ");
}

/** 渲染成最终 markdown。body 为 null 时只写机器抽取的两节（`--no-llm` 影子跑法 / LLM 失败） */
export function renderLedgerMarkdown(doc: SessionDoc, summary: SessionSummary, body: LedgerBody | null, meta: LedgerMeta, usage: LedgerUsage | null, generator: LedgerRender["generator"], failure?: string): LedgerRender {
  const frontmatter: Record<string, unknown> = {
    session: doc.sessionId,
    source: doc.source,
    machine: meta.machine ?? doc.machine ?? null,
    started: doc.startedAt,
    ended: doc.endedAt,
    // 这份账本写的时候转录读到哪一刻：扫描器据此判断之后有没有新的用户发言（收工账本的保护看它，不看本机游标）
    covered_upto: doc.endedAt,
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
  sections.push(`# ${li(body?.oneLine || `${doc.source} 会话 ${sid8}`)}`);
  sections.push(`## 解决了什么\n${body?.solved.length ? body.solved.map((s) => `- ${li(s)}`).join("\n") : "- （未生成）"}`);
  sections.push(`## 决定与否决\n${body?.decisions.length ? body.decisions.map((s) => `- ${li(s)}`).join("\n") : body ? "- （无）" : "- （未生成）"}`);
  // 当场 agent 写的经验已经分流进 pivot / case（收工第五步），这里只列它和指针，不套候选的原话锚点格式
  // kind 也要压成一行：收工命令的 --body 收任意字符串（P1 互审 R3 Codex K9 / Kimi NEW-1）
  const exp = generator === "agent"
    ? (body?.experience.length ? body.experience.map((x) => `- ${li(x.text)}${x.kind ? `（${li(x.kind)}）` : ""}`).join("\n") : "- （无）")
    : body?.experience.length
    ? body.experience.map((x) => `- ${li(x.text)}${x.kind ? `（${li(x.kind)}）` : ""} ｜原文：「${li(x.anchor) || "—"}」 ｜src:${sid8}#${x.anchorSeq ?? "?"}${x.anchorVerified ? "" : " ｜anchor:未核"}`).join("\n")
    : "- （无）";
  sections.push(`## ${generator === "agent" ? "经验（已分流）" : "经验（待确认）"}\n${exp}`);
  sections.push(`## 没做完\n${body?.unfinished.length ? body.unfinished.map((s) => `- ${li(s)}`).join("\n") : "- （无）"}`);
  // 机器抽取两节
  const errLines = summary.errors.slice(0, 20).map((e) => {
    const sigs = extractErrorSignatures({ problem: e.text.slice(0, 4000) });
    const specific = sigs.filter((s) => classifySignatureSpecificity(s) === "specific");
    const head = red(e.text.replace(/\s+/g, " ")).slice(0, 160);
    // 钩子拦截不写签名：它们是规矩在起作用、不算又踩；签名索引只读「｜签名：」，读写两侧按同一条原始报错判（P1 互审 R4 Codex #6）
    if (isHookInterceptionText(e.text)) return `- ${e.toolName ?? "tool"} #${e.seq}: ${head} ｜钩子拦截`;
    return `- ${e.toolName ?? "tool"} #${e.seq}: ${head}${specific.length ? ` ｜签名：${specific.map((s) => red(s).slice(0, 100)).join(" ‖ ")}` : ""}`;
  });
  sections.push(`## 报错（机器抽取，${summary.toolErrors} 条${summary.errors.length > 20 ? "，只列前 20" : ""}）\n${errLines.length ? errLines.join("\n") : "- （无）"}`);
  // 待确认：签名一模一样不等于同一个坑，要不要给原条目记一笔由人或当场的 agent 定（D4：pivot 零自动写入）
  if (meta.recurrence?.length) sections.push(`## 疑似又踩（机器抽取，${meta.recurrence.length} 条，待确认）\n${meta.recurrence.map((l) => `- ${li(l)}`).join("\n")}`);
  const memCounts = new Map<string, number>();
  for (const m of summary.memoryWrites) memCounts.set(m.tool.replace(/^mcp__recallnest__/, ""), (memCounts.get(m.tool.replace(/^mcp__recallnest__/, "")) ?? 0) + 1);
  sections.push(`## 当场写过的记忆（机器抽取）\n${memCounts.size ? [...memCounts.entries()].map(([k, v]) => `- ${k} ×${v}`).join("\n") : "- （无）"}`);
  // 报错体可能是多行（网关的 HTML 错误页、多行 JSON）：续行会脱出引用块，带「## 」的就成了幻影节（R3 Kimi NEW-1）
  if (failure) sections.push(`> 生成失败：${li(failure)}`);
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
