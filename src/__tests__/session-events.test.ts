import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyCCUserText,
  detectCodexError,
  detectSource,
  idleGaps,
  parseSessionFile,
  sessionIdFromPath,
  summarizeSession,
} from "../session-events.js";

const root = mkdtempSync(join(tmpdir(), "session-events-"));
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function writeCC(): string {
  const dir = join(root, ".claude", "projects", "-Users-x");
  mkdirSync(dir, { recursive: true });
  const sid = "11111111-2222-4333-8444-555555555555";
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(
    p,
    jsonl([
      { type: "user", sessionId: sid, timestamp: "2026-10-20T10:00:00.000Z", message: { role: "user", content: "<system-reminder>注入</system-reminder>\n帮我修 bot" } },
      { type: "assistant", sessionId: sid, timestamp: "2026-10-20T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "先看日志" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "tail x" } }] } },
      { type: "user", sessionId: sid, timestamp: "2026-10-20T10:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: `zsh: command not found: tail-x\nAuthorization: Bearer ${["sk", "-", "a".repeat(24), "9".repeat(16)].join("")}` }] } },
      { type: "user", sessionId: sid, timestamp: "2026-10-20T10:00:07.000Z", isMeta: true, message: { role: "user", content: "系统插入" } },
      { type: "user", sessionId: sid, timestamp: "2026-10-20T10:01:00.000Z", message: { role: "user", content: "/code-review" } },
      { type: "user", sessionId: sid, timestamp: "2026-10-20T10:02:00.000Z", message: { role: "user", content: "好" } },
      { type: "assistant", sessionId: sid, timestamp: "2026-10-20T10:02:05.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "mcp__recallnest__checkpoint_session", input: { summary: "修好了 bot", scope: "project:x" } }] } },
      { type: "user", sessionId: sid, timestamp: "2026-10-20T10:02:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } },
      { type: "user", sessionId: sid, timestamp: "2026-10-20T10:40:00.000Z", message: { role: "user", content: "收工" } },
    ]) + "not json at all\n",
  );
  return p;
}

function writeCodex(): string {
  const dir = join(root, ".codex", "sessions", "2026", "10", "20");
  mkdirSync(dir, { recursive: true });
  const sid = "01a15411-54df-7b23-93ef-1272cbe09290";
  const p = join(dir, `rollout-2026-10-20T15-11-18-${sid}.jsonl`);
  writeFileSync(
    p,
    jsonl([
      { timestamp: "2026-10-19T12:09:45.760Z", type: "session_meta", payload: { id: sid } },
      { timestamp: "2026-10-19T12:09:47.608Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "## Memory\nlong instructions" }] } },
      { timestamp: "2026-10-19T12:09:47.608Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>...</INSTRUCTIONS>" }] } },
      { timestamp: "2026-10-19T12:09:47.700Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "读交接文件" }] } },
      { timestamp: "2026-10-19T12:09:47.706Z", type: "event_msg", payload: { type: "user_message", message: "读交接文件" } },
      { timestamp: "2026-10-19T12:09:51.284Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "我先读文件。" }] } },
      { timestamp: "2026-10-19T12:09:52.934Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: "ls" } },
      { timestamp: "2026-10-19T12:09:53.566Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "Script failed\nWall time 0.6 seconds\nOutput:\nls: x: No such file" }] } },
      { timestamp: "2026-10-19T12:10:00.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "Script completed\nOutput:\nfine" } },
      { timestamp: "2026-10-19T12:20:00.000Z", type: "event_msg", payload: { type: "user_message", message: "继续" } },
      { timestamp: "2026-10-19T12:20:00.100Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "继续" }] } } },
      { timestamp: "2026-10-19T12:25:00.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "只在 item_completed 里的那句" }] } } },
      // 一条消息两个文本块 = 一轮（Codex #4）；相邻两轮同文 = 两轮（Codex #3 的 Codex 版）
      { timestamp: "2026-10-19T12:30:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "第一块" }, { type: "input_text", text: "第二块" }] } },
      { timestamp: "2026-10-19T12:31:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "收到" }] } },
      { timestamp: "2026-10-19T12:32:00.000Z", type: "event_msg", payload: { type: "user_message", message: "继续" } },
      { timestamp: "2026-10-19T12:33:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好" }] } },
      { timestamp: "2026-10-19T12:34:00.000Z", type: "event_msg", payload: { type: "user_message", message: "继续" } },
      { timestamp: "2026-10-19T12:35:00.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c3", output: "Process exited with code 2\nOutput:\nboom" } },
      // N1：同一条消息里「AGENTS 注入块 + 真人请求」→ 真人块单独成一轮
      { timestamp: "2026-10-19T12:36:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>x</INSTRUCTIONS>" }, { type: "input_text", text: "帮我看一下这个仓库" }] } },
    ]),
  );
  return p;
}

function writeCodexSubagent(): string {
  const dir = join(root, ".codex", "sessions", "2026", "10", "21");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "rollout-2026-10-21T01-00-00-01a1aaaa-54df-7b23-93ef-1272cbe09290.jsonl");
  writeFileSync(p, jsonl([{ timestamp: "2026-10-21T01:00:00.000Z", type: "session_meta", payload: { id: "01a1aaaa-54df-7b23-93ef-1272cbe09290", parent_thread_id: "01a15411-54df-7b23-93ef-1272cbe09290", source: { subagent: { other: "guardian" } } } }]));
  return p;
}

function writeImportedCC(): string {
  const dir = join(root, ".claude", "projects", "-Users-x");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "doubao-0001.jsonl");
  writeFileSync(p, jsonl([
    { type: "user", source: "doubao", sessionId: "doubao-0001", timestamp: "2026-10-20T10:00:00.000Z", message: { role: "user", content: "豆包里聊的" } },
    { type: "assistant", source: "doubao", sessionId: "doubao-0001", timestamp: "2026-10-20T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "嗯" }] } },
  ]));
  return p;
}

function writeRetryCC(): string {
  const dir = join(root, ".claude", "projects", "-Users-x");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "22222222-2222-4333-8444-555555555555.jsonl");
  writeFileSync(p, jsonl([
    { type: "system", source: "request_retry", timestamp: "2026-10-20T10:00:00.000Z", content: "retrying" },
    { type: "user", timestamp: "2026-10-20T10:00:01.000Z", message: { role: "user", content: "真 CC 会话" } },
    { type: "assistant", timestamp: "2026-10-20T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
  ]));
  return p;
}

function writeKimi(): string {
  const dir = join(root, ".kimi-code", "sessions", "wd_x", "session_e2fb8182-f336-4c91-b471-3fc929b9dc90", "agents", "main");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "wire.jsonl");
  const t0 = Date.parse("2026-10-18T08:00:00.000Z");
  writeFileSync(
    p,
    jsonl([
      { type: "metadata", created_at: t0, protocol_version: 1 },
      { type: "turn.prompt", time: t0 + 1000, origin: { kind: "user" }, input: [{ type: "text", text: "审一下这段代码" }] },
      { type: "context.append_message", time: t0 + 1001, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "审一下这段代码" }] } },
      { type: "context.append_message", time: t0 + 1002, message: { role: "user", origin: { kind: "system" }, content: [{ type: "text", text: "<system-reminder>skill 激活</system-reminder>" }] } },
      { type: "context.append_loop_event", time: t0 + 2000, event: { type: "tool.call", name: "Bash", args: { command: "ls" }, toolCallId: "k1" } },
      { type: "context.append_loop_event", time: t0 + 2500, event: { type: "tool.result", toolCallId: "k1", result: { durationMs: 10, isError: true, output: "ls: cannot access" } } },
      { type: "context.append_loop_event", time: t0 + 2600, event: { type: "content.part", part: { type: "text", text: "我看到报错了" } } },
      { type: "agent.message.appended", time: t0 + 2601, message: { message: { role: "assistant", content: [{ type: "think", think: "..." }, { type: "text", text: "我看到报错了" }] }, meta: {} } },
      { type: "agent.message.appended", time: t0 + 2602, message: { message: { role: "tool", toolCallId: "k1", content: [{ type: "text", text: "ls: cannot access" }] }, meta: {} } },
      { type: "turn.prompt", time: t0 + 3000, origin: { kind: "user" }, input: [{ type: "text", text: "继续" }] },
      { type: "context.append_message", time: t0 + 3001, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "继续" }] } },
      { type: "agent.message.appended", time: t0 + 3500, message: { message: { role: "assistant", content: [{ type: "text", text: "好" }] }, meta: {} } },
      { type: "turn.prompt", time: t0 + 4000, origin: { kind: "user" }, input: [{ type: "text", text: "继续" }] },
      // N2：turn.prompt → 系统注入 → 同轮 append_message 副本，仍是一轮
      { type: "context.append_message", time: t0 + 4000, message: { role: "user", origin: { kind: "system" }, content: [{ type: "text", text: "Skill tool loaded instructions" }] } },
      { type: "context.append_message", time: t0 + 4001, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "继续" }] } },
      { type: "agent.turn.ended", time: t0 + 4500 },
      // 回合边界之后同文（没有助手回复也）算新一轮
      { type: "context.append_message", time: t0 + 5000, message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "继续" }] } },
    ]),
  );
  return p;
}

function writeAgy(machine: "mini" | "macbook"): string {
  const base = machine === "macbook" ? join(root, "machine-data", "macbook-agy", "brain") : join(root, ".gemini", "antigravity-cli", "brain");
  const dir = join(base, "2c944aa9-3c01-45a2-bcfa-a3f6d613af75", ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "transcript_full.jsonl");
  writeFileSync(
    p,
    jsonl([
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-10-15T04:46:32Z", content: "看看这个视频" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-10-15T04:46:40Z", tool_calls: [{ name: "run_command", args: { command: "yt-dlp x" } }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "ERROR", created_at: "2026-10-15T04:46:50Z", content: "", error: "yt-dlp: command not found" },
      { step_index: 3, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", created_at: "2026-10-15T04:47:00Z", error: "API error (attempt 1): request failed" },
      { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-10-15T04:47:10Z", content: "下载失败了。" },
    ]),
  );
  return p;
}

describe("session-events: source detection and ids", () => {
  it("detects the four formats from paths", () => {
    expect(detectSource("/u/.claude/projects/-Users-x/abc.jsonl")).toBe("cc");
    expect(detectSource("/u/conversation-truth/claude/projects/-Users-x/abc.jsonl")).toBe("cc");
    expect(detectSource("/u/.codex/sessions/2026/10/20/rollout-2026-10-20T15-11-18-01a15411-54df-7b23-93ef-1272cbe09290.jsonl")).toBe("codex");
    expect(detectSource("/u/.kimi-code/sessions/wd/session_x/agents/main/wire.jsonl")).toBe("kimi");
    expect(detectSource("/u/.gemini/antigravity-cli/brain/x/.system_generated/logs/transcript_full.jsonl")).toBe("antigravity");
    expect(detectSource("/u/something/else.txt")).toBeNull();
  });
  it("derives session ids per format", () => {
    expect(sessionIdFromPath("/u/.codex/sessions/2026/10/20/rollout-2026-10-20T15-11-18-01a15411-54df-7b23-93ef-1272cbe09290.jsonl", "codex")).toBe("01a15411-54df-7b23-93ef-1272cbe09290");
    expect(sessionIdFromPath("/u/.kimi-code/sessions/wd/session_abc/agents/main/wire.jsonl", "kimi")).toBe("abc");
    expect(sessionIdFromPath("/u/brain/2c944aa9/.system_generated/logs/transcript.jsonl", "antigravity")).toBe("2c944aa9");
  });
});

describe("session-events: CC", () => {
  const doc = parseSessionFile(writeCC());
  const s = summarizeSession(doc);
  it("keeps short utterances, marks injected text, strips system-reminder", () => {
    const users = doc.events.filter((e) => e.kind === "user");
    expect(users.map((u) => u.text)).toEqual(["帮我修 bot", "/code-review", "好", "收工"]);
    expect(users.map((u) => !!u.injected)).toEqual([false, true, false, false]);
    expect(s.userTurns).toBe(3);
  });
  it("records tool errors with tool names and keeps memory-write inputs", () => {
    expect(s.toolErrors).toBe(1);
    expect(s.errors[0].toolName).toBe("Bash");
    expect(s.errors[0].text).toContain("command not found");
    expect(s.errors[0].text).not.toContain("a".repeat(24));
    expect(s.memoryWrites).toHaveLength(1);
    expect(s.memoryWrites[0].tool).toBe("mcp__recallnest__checkpoint_session");
    expect((s.memoryWrites[0].input as { summary: string }).summary).toBe("修好了 bot");
    const bash = doc.events.find((e) => e.kind === "tool_call" && e.toolName === "Bash");
    expect(bash?.toolInput).toBeUndefined();
  });
  it("computes timestamps, close signal, richness and malformed count", () => {
    expect(doc.startedAt).toBe("2026-10-20T10:00:00.000Z");
    expect(doc.endedAt).toBe("2026-10-20T10:40:00.000Z");
    expect(doc.lastUserAt).toBe("2026-10-20T10:40:00.000Z");
    expect(s.closeSignal).toBe(true);
    expect(s.rich).toBe(true);
    expect(doc.malformedLines).toBe(1);
    expect(doc.importedSource).toBeUndefined();
    expect(classifyCCUserText("<system-reminder>x</system-reminder>")?.injected).toBe(true);
    // G#9：宿主标签（带 - / _）算注入；用户贴的 HTML 单词标签与 <pasted_content> 算人话
    expect(classifyCCUserText("<task-notification>done</task-notification>")?.injected).toBe(true);
    expect(classifyCCUserText("<command-name>/x</command-name>")?.injected).toBe(true);
    expect(classifyCCUserText("<div>example</div> 请解释这段代码")?.injected).toBe(false);
    expect(classifyCCUserText("<pasted_content id=\"1\">贴的内容</pasted_content> 看看")?.injected).toBe(false);
  });
  it("finds idle gaps and whether the user resumed after them", () => {
    const gaps = idleGaps(doc, 30 * 60_000);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].resumedByUser).toBe(true);
    expect(idleGaps(doc, 60 * 60_000)).toHaveLength(0);
  });
});

describe("session-events: CC imported vs retry sources", () => {
  it("marks doubao-style imported conversations but not sessions with a few retry lines", () => {
    expect(parseSessionFile(writeImportedCC()).importedSource).toBe("doubao");
    expect(parseSessionFile(writeRetryCC()).importedSource).toBeUndefined();
  });
});

describe("session-events: Codex", () => {
  const doc = parseSessionFile(writeCodex());
  const s = summarizeSession(doc);
  it("takes session id from session_meta and skips developer/AGENTS injections as human turns", () => {
    expect(doc.sessionId).toBe("01a15411-54df-7b23-93ef-1272cbe09290");
    const humans = doc.events.filter((e) => e.kind === "user" && !e.injected).map((e) => e.text);
    expect(humans).toEqual(["读交接文件", "继续", "只在 item_completed 里的那句", "第一块\n第二块", "继续", "继续", "帮我看一下这个仓库"]);
    expect(s.userTurns).toBe(7);
    expect(doc.isSubagent).toBeUndefined();
  });
  it("flags subagent threads from session_meta", () => {
    expect(parseSessionFile(writeCodexSubagent()).isSubagent).toBe(true);
  });
  it("detects errors from output text only", () => {
    expect(s.toolErrors).toBe(2);
    expect(detectCodexError("Process exited with code 1\nOutput:")).toBe(true);
    expect(detectCodexError("Process exited with code 0\nOutput:")).toBe(false);
    expect(detectCodexError("Exit code: 1\nOutput:")).toBe(true);
    expect(detectCodexError("Exit code: 0\nOutput:")).toBe(false);
    expect(detectCodexError("Script completed\nWall time 0.6 seconds")).toBe(false);
    expect(detectCodexError("Traceback (most recent call last):\n  File x")).toBe(true);
    expect(detectCodexError("Script completed\nWall time 0.6 seconds\nOutput:\ngrep hit: Error: something in docs")).toBe(false);
    expect(detectCodexError("Wall time: 0.6 seconds\nOutput:\nError: ENOENT")).toBe(true);
    // N3：外层 Script completed 包着内层非零退出码仍是失败；K#2：成功标记在第二行也算
    expect(detectCodexError("Script completed\nWall time 1 s\nOutput:\nExit code: 2\nboom")).toBe(true);
    expect(detectCodexError("Wall time: 0.6 seconds\nProcess exited with code 0\nOutput:\nError: cited in docs")).toBe(false);
  });
});

describe("session-events: Kimi", () => {
  const doc = parseSessionFile(writeKimi());
  const s = summarizeSession(doc);
  it("dedupes turn.prompt against append_message and marks system-origin user text as injected", () => {
    const users = doc.events.filter((e) => e.kind === "user");
    expect(users.filter((u) => !u.injected).map((u) => u.text)).toEqual(["审一下这段代码", "继续", "继续", "继续"]);
    expect(users.filter((u) => u.injected)).toHaveLength(2);
    expect(s.userTurns).toBe(4);
  });
  it("reads tool.result isError and assistant text from the nested message once", () => {
    expect(s.toolErrors).toBe(1);
    expect(s.errors[0].toolName).toBe("Bash");
    expect(doc.events.filter((e) => e.kind === "assistant")).toHaveLength(2);
    expect(doc.events.filter((e) => e.kind === "tool_result")).toHaveLength(1);
    expect(doc.startedAt).toBe("2026-10-18T08:00:01.000Z"); // metadata 行不是事件，首事件是 turn.prompt
  });
});

describe("session-events: Antigravity", () => {
  it("maps GENERIC ERROR to tool errors and ERROR_MESSAGE to system errors; machine from path", () => {
    const mini = summarizeSession(parseSessionFile(writeAgy("mini")));
    expect(mini.toolErrors).toBe(1);
    expect(mini.errors[0].toolName).toBeUndefined();
    expect(mini.systemErrors).toBe(1);
    expect(mini.userTurns).toBe(1);
    expect(mini.assistantTurns).toBe(1);
    const mac = parseSessionFile(writeAgy("macbook"));
    expect(mac.machine).toBe("macbook");
    expect(mac.sessionId).toBe("2c944aa9-3c01-45a2-bcfa-a3f6d613af75");
  });
});
