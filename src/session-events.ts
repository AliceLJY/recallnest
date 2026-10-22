/**
 * session-events — 面向「会话总结」的四端事件解析层（CC / Codex / Kimi / Antigravity）。
 *
 * 为什么不复用 ingest.ts 的 parse*：那几只解析器是给「切片入库」设计的——整块丢掉 tool_use / tool_result，
 * 过滤 ≤10 字的短发言，不保留工具报错与时间戳；拿它们算不出真实轮数、报错清单与复发证据
 * （plan.md v2.1 D2；research §4 的 `证据/measure4.py` 是本层的原型）。
 *
 * 本层只做一件事：把一份转录文件变成一串带时间戳、带角色、带报错标记的事件，**不判断价值、不写库**。
 * 保留：用户短发言（含「好」「继续」）、系统注入（标 injected 而不是丢掉）、tool_result 的报错正文、
 * 每条事件的时间戳与序号；只对识别出的记忆写入工具（checkpoint_session / store_case / store_memory /
 * store_workflow_pattern）保留 tool_call 的输入，其余工具只留名字。
 *
 * 格式事实（2026-10-23 在 mini 对 30 天语料逐端核过，见 AI产出/2026-10-22-RecallNest自动总结经验/P0/README.md）：
 * - CC：`~/.claude/projects/<proj>/<sid>.jsonl`，行 `type` user/assistant，`message.content` 字符串或块数组，
 *   tool_result 块带 `is_error`；`isMeta` 行是系统插入；`<system-reminder>` 嵌在用户文本里。
 *   统一树 `conversation-truth/claude/projects` 里混着导入的 desktop / doubao / muse / minis / grokbot / chatgpt
 *   会话，它们的行带 `source` 字段——本层记到 `importedSource`，由调用方决定要不要排除。
 * - Codex：`rollout-*.jsonl`，行 `{timestamp, type, payload}`；用户/助手在 `response_item.message`
 *   （`input_text` / `output_text`，`developer` 角色与 AGENTS.md 注入要排除），工具调用 `function_call` /
 *   `custom_tool_call`，输出 `*_output.output`（无退出码元数据，报错只能从正文认：`Script failed` /
 *   `Exit code: N` / Traceback）。
 * - Kimi：`sessions/<wd>/session_<sid>/agents/main/wire.jsonl`，行 `time` 为毫秒；用户发言在
 *   `context.append_message`（`message.origin.kind === "user"` 才是人说的）；助手正文在
 *   `agent.message.appended.message.message`（嵌两层）；工具调用 / 结果在 `context.append_loop_event.event`
 *   的 `tool.call` / `tool.result`，后者 `result.isError` 标报错。
 * - Antigravity：`brain/<sid>/.system_generated/logs/transcript_full.jsonl`（本机与 `transcript.jsonl` 是硬链接，
 *   MacBook 拉过来的只有 `_full`），行 `type` USER_INPUT / PLANNER_RESPONSE（`content` 文本或 `tool_calls`）/
 *   GENERIC（工具结果，`status === "ERROR"` 或带 `error` 即报错）/ ERROR_MESSAGE（API 级错误，单独计）/
 *   SYSTEM_MESSAGE / CHECKPOINT；`created_at` 为 ISO。
 */

import { readFileSync } from "node:fs";
import { basename, dirname, sep } from "node:path";

export type SessionSource = "cc" | "codex" | "kimi" | "antigravity";
export type EventKind = "user" | "assistant" | "tool_call" | "tool_result" | "system";

export interface SessionEvent {
  /** 文件内顺序号（0 起），锚点 `src:<sid8>#<seq>` 用它回原文 */
  seq: number;
  /** ISO 时间；格式里没有就 null（不拿文件 mtime 冒充） */
  ts: string | null;
  tsMs: number | null;
  kind: EventKind;
  /** user / assistant / system：正文；tool_result：结果正文（已截断到 MAX_TOOL_TEXT）；tool_call：空串 */
  text: string;
  /** 系统注入的「用户」文本（hook、system-reminder、斜杠命令、AGENTS.md 注入）——保留但标出，不算人说的 */
  injected?: boolean;
  toolName?: string;
  toolCallId?: string;
  /** 只对记忆写入类工具保留 */
  toolInput?: unknown;
  /** tool_result：该次工具调用报错 */
  isError?: boolean;
  /** system：宿主 / API 级错误（antigravity ERROR_MESSAGE、CC connection_retry 之类），与工具报错分开计 */
  systemError?: boolean;
}

export interface SessionDoc {
  source: SessionSource;
  sessionId: string;
  filePath: string;
  events: SessionEvent[];
  /** 首条 / 末条有时间戳事件的 ISO */
  startedAt: string | null;
  endedAt: string | null;
  /** 最后一条人说的话的时间 */
  lastUserAt: string | null;
  /** 从路径推断的机器（只在能确定时填） */
  machine?: string;
  /** CC 统一树里导入的非 CC 会话（doubao / muse / minis / grokbot / chatgpt …）；真 CC 会话为 undefined。
   *  判据：首行带 `source` 且 ≥50% 的行带同一个 `source`——真 CC 会话里 `request_retry` / `connection_retry` 只是零星几行 */
  importedSource?: string;
  /** 子 agent 线程（Codex `session_meta.payload.source.subagent` / `parent_thread_id`）。CC 的子 agent 文件靠路径 `/subagents/` 排除 */
  isSubagent?: boolean;
  /** 解析时跳过的坏行数 */
  malformedLines: number;
}

export const MEMORY_WRITE_TOOL_RE = /(checkpoint_session|store_case|store_memory|store_workflow_pattern)$/;
export const MAX_TOOL_TEXT = 4000;
export const MAX_TOOL_INPUT_JSON = 20_000;

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CC_INJECTED_PREFIXES = [
  "[系统提示",
  "SessionStart",
  "A session-scoped",
  "Another Claude session",
  "Caveat:",
  "<",
  "[Request interrupted",
  "This session is being continued",
];
const SLASH_COMMAND_RE = /^\/[A-Za-z][A-Za-z0-9:_-]*(\s|$)/;
const CODEX_INJECTED_MARKERS = ["# AGENTS.md instructions", "<INSTRUCTIONS>", "<environment_context>", "<permissions instructions>", "<user_instructions>", "<turn_aborted>", "<collaboration_mode>"];
const CODEX_ERROR_RE = /(^|\n)\s*(Script failed\b|Exit code:\s*[1-9]\d*\b|Traceback \(most recent call last\)|(Error|ERROR|error):\s)/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function toIso(value: unknown): { ts: string | null; tsMs: number | null } {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return { ts: new Date(ms).toISOString(), tsMs: ms };
  }
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { ts: new Date(ms).toISOString(), tsMs: ms };
  }
  return { ts: null, tsMs: null };
}

function clip(text: string, max = MAX_TOOL_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} of ${text.length} chars]`;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

function keepToolInput(name: string | undefined, input: unknown): unknown {
  if (!name || !MEMORY_WRITE_TOOL_RE.test(name)) return undefined;
  if (input === undefined) return undefined;
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input);
    if (s.length > MAX_TOOL_INPUT_JSON) return { _truncated: true, chars: s.length };
    return typeof input === "string" ? safeJson(input) ?? input : input;
  } catch {
    return undefined;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function detectSource(filePath: string): SessionSource | null {
  const p = filePath.split(sep).join("/");
  if (/\/\.system_generated\/logs\/transcript(_full)?\.jsonl$/.test(p) || /\/brain\/[^/]+\//.test(p)) return "antigravity";
  if (/\/agents\/main\/wire\.jsonl$/.test(p) || /\/\.kimi-code\//.test(p) || /\/kimi\/sessions\//.test(p)) return "kimi";
  if (/\/rollout-[^/]*\.jsonl$/.test(p) || /\/\.codex\//.test(p) || /\/codex\/sessions\//.test(p)) return "codex";
  if (/\.jsonl$/.test(p) && (/\/\.claude\/projects\//.test(p) || /\/claude\/projects\//.test(p))) return "cc";
  return null;
}

export function sessionIdFromPath(filePath: string, source: SessionSource): string {
  const p = filePath.split(sep).join("/");
  switch (source) {
    case "cc":
      return basename(p, ".jsonl");
    case "codex": {
      const m = basename(p, ".jsonl").match(UUID_RE);
      return m ? m[0] : basename(p, ".jsonl").replace(/^rollout-/, "");
    }
    case "kimi": {
      const parts = p.split("/");
      const i = parts.findIndex((x) => x === "agents");
      const raw = i >= 1 ? parts[i - 1] : basename(dirname(p));
      return raw.replace(/^session_/, "");
    }
    case "antigravity": {
      const m = p.match(/\/brain\/([^/]+)\//);
      return m ? m[1] : basename(dirname(dirname(dirname(p))));
    }
  }
}

export function machineFromPath(filePath: string): string | undefined {
  const p = filePath.split(sep).join("/");
  if (/\/machine-data\/macbook-/.test(p)) return "macbook";
  return undefined;
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, "utf-8").split("\n");
}

export interface ParseOptions {
  /** 覆盖自动判别 */
  source?: SessionSource;
}

export function parseSessionFile(filePath: string, opts: ParseOptions = {}): SessionDoc {
  const source = opts.source ?? detectSource(filePath);
  if (!source) throw new Error(`session-events: cannot detect source for ${filePath}`);
  const doc: SessionDoc = {
    source,
    sessionId: sessionIdFromPath(filePath, source),
    filePath,
    events: [],
    startedAt: null,
    endedAt: null,
    lastUserAt: null,
    machine: machineFromPath(filePath),
    malformedLines: 0,
  };
  switch (source) {
    case "cc":
      parseCC(doc);
      break;
    case "codex":
      parseCodex(doc);
      break;
    case "kimi":
      parseKimi(doc);
      break;
    case "antigravity":
      parseAntigravity(doc);
      break;
  }
  finalize(doc);
  return doc;
}

function finalize(doc: SessionDoc): void {
  let first: SessionEvent | undefined;
  let last: SessionEvent | undefined;
  let lastUser: SessionEvent | undefined;
  for (const e of doc.events) {
    if (e.tsMs === null) continue;
    if (!first || e.tsMs < first.tsMs!) first = e;
    if (!last || e.tsMs >= last.tsMs!) last = e;
    if (e.kind === "user" && !e.injected && (!lastUser || e.tsMs >= lastUser.tsMs!)) lastUser = e;
  }
  doc.startedAt = first?.ts ?? null;
  doc.endedAt = last?.ts ?? null;
  doc.lastUserAt = lastUser?.ts ?? null;
}

function push(doc: SessionDoc, e: Omit<SessionEvent, "seq">): void {
  doc.events.push({ seq: doc.events.length, ...e });
}

// ---------------------------------------------------------------- CC

export function classifyCCUserText(raw: string): { text: string; injected: boolean } | null {
  const text = raw.replace(SYSTEM_REMINDER_RE, "").trim();
  if (!text) {
    // 整条都是 system-reminder → 保留为注入事件，不算人说的
    return raw.trim() ? { text: raw.trim().slice(0, 400), injected: true } : null;
  }
  const injected = CC_INJECTED_PREFIXES.some((p) => text.startsWith(p)) || SLASH_COMMAND_RE.test(text);
  return { text, injected };
}

function parseCC(doc: SessionDoc): void {
  let firstSource: string | undefined;
  const sourceCounts = new Map<string, number>();
  let lineCount = 0;
  for (const line of readLines(doc.filePath)) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      doc.malformedLines++;
      continue;
    }
    if (typeof o.sessionId === "string" && o.sessionId && doc.sessionId === basename(doc.filePath, ".jsonl") && !UUID_RE.test(doc.sessionId)) {
      doc.sessionId = o.sessionId;
    }
    lineCount++;
    const src = o.source;
    if (typeof src === "string" && src) {
      if (lineCount === 1) firstSource = src;
      sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
    }
    const type = o.type;
    const { ts, tsMs } = toIso(o.timestamp);
    const message = (o.message ?? {}) as { role?: string; content?: unknown };
    if (type === "user") {
      const content = message.content;
      if (o.isMeta) {
        const t = blockText(content).trim();
        if (t) push(doc, { ts, tsMs, kind: "system", text: clip(t, 400), injected: true });
        continue;
      }
      const texts: string[] = [];
      if (typeof content === "string") texts.push(content);
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          const blk = b as { type?: string; text?: string; content?: unknown; is_error?: boolean; tool_use_id?: string };
          if (blk.type === "text" && typeof blk.text === "string") texts.push(blk.text);
          else if (blk.type === "tool_result") {
            const t = blockText(blk.content);
            push(doc, { ts, tsMs, kind: "tool_result", text: clip(t), isError: blk.is_error === true, toolCallId: blk.tool_use_id });
          }
        }
      }
      const joined = texts.join("\n");
      const cls = classifyCCUserText(joined);
      if (cls) push(doc, { ts, tsMs, kind: "user", text: cls.text, injected: cls.injected || undefined });
      continue;
    }
    if (type === "assistant") {
      const content = message.content;
      const texts: string[] = [];
      if (typeof content === "string") texts.push(content);
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          const blk = b as { type?: string; text?: string; name?: string; id?: string; input?: unknown };
          if (blk.type === "text" && typeof blk.text === "string") texts.push(blk.text);
          else if (blk.type === "tool_use") {
            push(doc, { ts, tsMs, kind: "tool_call", text: "", toolName: blk.name, toolCallId: blk.id, toolInput: keepToolInput(blk.name, blk.input) });
          }
        }
      }
      const joined = texts.join("\n").trim();
      if (joined) push(doc, { ts, tsMs, kind: "assistant", text: joined });
      continue;
    }
    if (type === "system") {
      const t = blockText(message.content ?? (o as { content?: unknown }).content).trim();
      const level = (o as { level?: string }).level;
      if (t) push(doc, { ts, tsMs, kind: "system", text: clip(t, 400), systemError: level === "error" || undefined });
    }
  }
  if (firstSource && !["request_retry", "connection_retry"].includes(firstSource) && (sourceCounts.get(firstSource) ?? 0) >= lineCount * 0.5) {
    doc.importedSource = firstSource;
  }
}

// ---------------------------------------------------------------- Codex

export function detectCodexError(outputText: string): boolean {
  return CODEX_ERROR_RE.test(outputText);
}

function parseCodex(doc: SessionDoc): void {
  let lastUserText = "";
  for (const line of readLines(doc.filePath)) {
    if (!line.trim()) continue;
    let o: { timestamp?: unknown; type?: string; payload?: Record<string, unknown> };
    try {
      o = JSON.parse(line);
    } catch {
      doc.malformedLines++;
      continue;
    }
    const payload = o.payload ?? {};
    const { ts, tsMs } = toIso(o.timestamp);
    if (o.type === "session_meta") {
      if (typeof payload.id === "string") doc.sessionId = payload.id;
      const metaSource = payload.source;
      if ((metaSource && typeof metaSource === "object" && "subagent" in (metaSource as Record<string, unknown>)) || typeof payload.parent_thread_id === "string") {
        doc.isSubagent = true;
      }
      continue;
    }
    if (o.type === "response_item") {
      const ptype = payload.type;
      if (ptype === "message") {
        const role = payload.role;
        const content = payload.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          const blk = c as { type?: string; text?: string };
          if (typeof blk.text !== "string" || !blk.text.trim()) continue;
          if (blk.type === "input_text" && role === "user") {
            const text = blk.text.trim();
            const injected = CODEX_INJECTED_MARKERS.some((m) => text.startsWith(m) || text.includes(m)) || text.startsWith("<");
            if (!injected) lastUserText = text;
            push(doc, { ts, tsMs, kind: "user", text, injected: injected || undefined });
          } else if (blk.type === "input_text" && role === "developer") {
            push(doc, { ts, tsMs, kind: "system", text: clip(blk.text.trim(), 400), injected: true });
          } else if (blk.type === "output_text" && role === "assistant") {
            push(doc, { ts, tsMs, kind: "assistant", text: blk.text.trim() });
          }
        }
      } else if (ptype === "function_call" || ptype === "custom_tool_call") {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        const rawInput = payload.arguments ?? payload.input;
        push(doc, { ts, tsMs, kind: "tool_call", text: "", toolName: name, toolCallId: typeof payload.call_id === "string" ? payload.call_id : undefined, toolInput: keepToolInput(name, rawInput) });
      } else if (ptype === "function_call_output" || ptype === "custom_tool_call_output") {
        const t = blockText(payload.output);
        push(doc, { ts, tsMs, kind: "tool_result", text: clip(t), isError: detectCodexError(t), toolCallId: typeof payload.call_id === "string" ? payload.call_id : undefined });
      }
      continue;
    }
    if (o.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
      const text = payload.message.trim();
      if (text && text !== lastUserText) {
        lastUserText = text;
        push(doc, { ts, tsMs, kind: "user", text });
      }
      continue;
    }
    // 第三条用户通道：有的会话（13/397，2026-10-23 实测）只在 item_completed 的 UserMessage 里有用户原话
    if (o.type === "event_msg" && payload.type === "item_completed") {
      const item = payload.item as { type?: string; content?: unknown } | undefined;
      if (item?.type === "UserMessage") {
        const text = blockText(item.content).trim();
        if (text && text !== lastUserText && !text.startsWith("<")) {
          lastUserText = text;
          push(doc, { ts, tsMs, kind: "user", text });
        }
      }
    }
  }
}

// ---------------------------------------------------------------- Kimi

function parseKimi(doc: SessionDoc): void {
  let lastUserText = "";
  for (const line of readLines(doc.filePath)) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      doc.malformedLines++;
      continue;
    }
    const { ts, tsMs } = toIso(o.time ?? o.created_at);
    const type = o.type;
    if (type === "turn.prompt") {
      const origin = o.origin as { kind?: string } | undefined;
      if (origin?.kind !== "user") continue;
      const text = blockText(o.input).trim();
      if (text && text !== lastUserText) {
        lastUserText = text;
        push(doc, { ts, tsMs, kind: "user", text });
      }
      continue;
    }
    if (type === "context.append_message") {
      const msg = o.message as { role?: string; content?: unknown; origin?: { kind?: string } } | undefined;
      if (!msg) continue;
      const text = blockText(msg.content).trim();
      if (!text) continue;
      if (msg.role === "user") {
        const injected = msg.origin?.kind !== "user";
        if (!injected && text === lastUserText) continue; // turn.prompt 已记
        if (!injected) lastUserText = text;
        push(doc, { ts, tsMs, kind: "user", text: injected ? clip(text, 400) : text, injected: injected || undefined });
      } else if (msg.role === "assistant") {
        push(doc, { ts, tsMs, kind: "assistant", text });
      }
      continue;
    }
    if (type === "agent.message.appended") {
      const outer = o.message as { message?: { role?: string; content?: unknown; toolCallId?: string } } | undefined;
      const inner = outer?.message;
      if (!inner) continue;
      if (inner.role === "assistant") {
        const text = Array.isArray(inner.content)
          ? inner.content
              .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
              .map((b) => (b as { text?: string }).text ?? "")
              .join("\n")
              .trim()
          : blockText(inner.content).trim();
        if (text) push(doc, { ts, tsMs, kind: "assistant", text });
      }
      // role === "tool" 的结果走下面的 tool.result（带 isError），这里不重复记
      continue;
    }
    if (type === "context.append_loop_event") {
      const ev = o.event as { type?: string; name?: string; args?: unknown; toolCallId?: string; result?: { output?: unknown; isError?: boolean } } | undefined;
      if (!ev) continue;
      if (ev.type === "tool.call") {
        push(doc, { ts, tsMs, kind: "tool_call", text: "", toolName: ev.name, toolCallId: ev.toolCallId, toolInput: keepToolInput(ev.name, ev.args) });
      } else if (ev.type === "tool.result") {
        const t = blockText(ev.result?.output);
        push(doc, { ts, tsMs, kind: "tool_result", text: clip(t), isError: ev.result?.isError === true, toolCallId: ev.toolCallId });
      }
    }
  }
}

// ---------------------------------------------------------------- Antigravity

function parseAntigravity(doc: SessionDoc): void {
  for (const line of readLines(doc.filePath)) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      doc.malformedLines++;
      continue;
    }
    const { ts, tsMs } = toIso(o.created_at);
    const type = o.type;
    const content = typeof o.content === "string" ? o.content : blockText(o.content);
    if (type === "USER_INPUT") {
      const text = content.trim();
      if (text) push(doc, { ts, tsMs, kind: "user", text });
    } else if (type === "PLANNER_RESPONSE") {
      const text = content.trim();
      if (text) push(doc, { ts, tsMs, kind: "assistant", text });
      const calls = o.tool_calls;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          if (!c || typeof c !== "object") continue;
          const call = c as { name?: string; args?: unknown };
          push(doc, { ts, tsMs, kind: "tool_call", text: "", toolName: call.name, toolInput: keepToolInput(call.name, call.args) });
        }
      }
    } else if (type === "GENERIC") {
      const err = typeof o.error === "string" ? o.error : undefined;
      const isError = o.status === "ERROR" || !!err;
      const text = [content.trim(), err ? `error: ${err}` : ""].filter(Boolean).join("\n");
      push(doc, { ts, tsMs, kind: "tool_result", text: clip(text), isError });
    } else if (type === "ERROR_MESSAGE") {
      const text = (typeof o.error === "string" ? o.error : content).trim();
      push(doc, { ts, tsMs, kind: "system", text: clip(text, 400), systemError: true });
    } else if (type === "SYSTEM_MESSAGE" || type === "CHECKPOINT") {
      const text = content.trim();
      if (text) push(doc, { ts, tsMs, kind: "system", text: clip(text, 400), injected: true });
    }
  }
}

// ---------------------------------------------------------------- 汇总

export const CLOSE_SIGNAL_RE = /收工|关窗|先这样|先到这|就到这|今天就这样|不用了|辛苦了|晚安|睡了|结束吧|bye|再见/i;
export const CORRECTION_SIGNAL_RE = /你忘了|怎么不记得|之前不是说过|说过多少次|怎么又|不是说了|又开始/;

export interface MemoryWrite {
  seq: number;
  ts: string | null;
  tool: string;
  input: unknown;
}

export interface ToolError {
  seq: number;
  ts: string | null;
  toolName?: string;
  text: string;
}

export interface SessionSummary {
  source: SessionSource;
  sessionId: string;
  userTurns: number;
  injectedUserEvents: number;
  assistantTurns: number;
  toolCalls: number;
  toolErrors: number;
  systemErrors: number;
  /** 人说的 + 助手说的字符数（不含工具结果与注入） */
  chars: number;
  closeSignal: boolean;
  correctionSignal: boolean;
  /** research §4 的严格「有料」谓词：≥3 轮 且（报错 / 纠正 / 收尾 / >3K 字） */
  rich: boolean;
  richWithout3k: boolean;
  memoryWrites: MemoryWrite[];
  errors: ToolError[];
  startedAt: string | null;
  endedAt: string | null;
  lastUserAt: string | null;
}

export function summarizeSession(doc: SessionDoc): SessionSummary {
  const users: SessionEvent[] = [];
  let injected = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let systemErrors = 0;
  let chars = 0;
  const memoryWrites: MemoryWrite[] = [];
  const errors: ToolError[] = [];
  const callNames = new Map<string, string>();
  for (const e of doc.events) {
    switch (e.kind) {
      case "user":
        if (e.injected) injected++;
        else {
          users.push(e);
          chars += e.text.length;
        }
        break;
      case "assistant":
        assistantTurns++;
        chars += e.text.length;
        break;
      case "tool_call":
        toolCalls++;
        if (e.toolCallId && e.toolName) callNames.set(e.toolCallId, e.toolName);
        if (e.toolName && MEMORY_WRITE_TOOL_RE.test(e.toolName)) memoryWrites.push({ seq: e.seq, ts: e.ts, tool: e.toolName, input: e.toolInput });
        break;
      case "tool_result":
        if (e.isError) errors.push({ seq: e.seq, ts: e.ts, toolName: e.toolCallId ? callNames.get(e.toolCallId) : undefined, text: e.text });
        break;
      case "system":
        if (e.systemError) systemErrors++;
        break;
    }
  }
  // CC 的用户主动中断不算工具报错（measure4 同款过滤）
  const realErrors = errors.filter((er) => !/interrupted|doesn't want to proceed|rejected/i.test(er.text.slice(0, 300)));
  const closeSignal = users.slice(-2).some((u) => CLOSE_SIGNAL_RE.test(u.text));
  const correctionSignal = users.some((u) => CORRECTION_SIGNAL_RE.test(u.text));
  const ge3 = users.length >= 3;
  return {
    source: doc.source,
    sessionId: doc.sessionId,
    userTurns: users.length,
    injectedUserEvents: injected,
    assistantTurns,
    toolCalls,
    toolErrors: realErrors.length,
    systemErrors,
    chars,
    closeSignal,
    correctionSignal,
    rich: ge3 && (realErrors.length > 0 || correctionSignal || closeSignal || chars > 3000),
    richWithout3k: ge3 && (realErrors.length > 0 || correctionSignal || closeSignal),
    memoryWrites,
    errors: realErrors,
    startedAt: doc.startedAt,
    endedAt: doc.endedAt,
    lastUserAt: doc.lastUserAt,
  };
}

/** 事件时间轴上的静默段：相邻两条有时间戳事件之间 ≥ thresholdMs 的间隔，以及是否随后还有人继续说话 */
export interface IdleGap {
  afterSeq: number;
  gapMs: number;
  /** 间隔之后是否还有非注入的用户发言（= 这次静默是误判，会话还在继续） */
  resumedByUser: boolean;
}

export function idleGaps(doc: SessionDoc, thresholdMs: number): IdleGap[] {
  const timed = doc.events.filter((e) => e.tsMs !== null);
  const gaps: IdleGap[] = [];
  for (let i = 1; i < timed.length; i++) {
    const gap = timed[i].tsMs! - timed[i - 1].tsMs!;
    if (gap >= thresholdMs) {
      const resumed = timed.slice(i).some((e) => e.kind === "user" && !e.injected);
      gaps.push({ afterSeq: timed[i - 1].seq, gapMs: gap, resumedByUser: resumed });
    }
  }
  return gaps;
}
