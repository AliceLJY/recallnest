import { describe, expect, it } from "bun:test";

import type { SessionDoc } from "../session-events.js";
import { summarizeSession } from "../session-events.js";
import { parseLedgerJson, renderLedgerMarkdown, renderTranscriptForLLM, verifyAnchor } from "../session-ledger.js";

function doc(): SessionDoc {
  const t = (s: number) => ({ ts: new Date(Date.UTC(2026, 9, 20, 10, 0, s)).toISOString(), tsMs: Date.UTC(2026, 9, 20, 10, 0, s) });
  const events: SessionDoc["events"] = [
    { seq: 0, ...t(0), kind: "user", text: "帮我把 bot 的日志目录挪到 ~/ops-logs，别放 Library/Logs" },
    { seq: 1, ...t(1), kind: "assistant", text: "好的，先看现状。".repeat(80) },
    { seq: 2, ...t(2), kind: "tool_call", text: "", toolName: "Bash", toolCallId: "t1" },
    { seq: 3, ...t(3), kind: "tool_result", text: "zsh: command not found: launchctl-x\nsecret=sk-live-" + "A".repeat(32), isError: true, toolCallId: "t1" },
    { seq: 4, ...t(4), kind: "user", text: "<system-reminder>注入</system-reminder>", injected: true },
    { seq: 5, ...t(5), kind: "tool_call", text: "", toolName: "mcp__recallnest__store_case", toolCallId: "t2", toolInput: { title: "日志目录", problem: "柠檬清理会删 Library/Logs 子目录" } },
    { seq: 6, ...t(6), kind: "user", text: "以后自建日志一律放 ops-logs，记住" },
    { seq: 7, ...t(7), kind: "assistant", text: "记下了。" },
  ];
  return { source: "cc", sessionId: "cfe4de46-1111-4222-8333-444444444444", filePath: "/x", events, startedAt: events[0].ts, endedAt: events[7].ts, lastUserAt: events[6].ts, malformedLines: 0 };
}

describe("session-ledger rendering for the LLM", () => {
  it("includes user turns, clipped assistant text, tool errors and memory writes; masks writes on request", () => {
    const d = doc();
    const r = renderTranscriptForLLM(d, { assistantClip: 20 });
    expect(r.text).toContain("[U#0 10:00] 帮我把 bot");
    expect(r.text).toContain("[A#1] 好的，先看现状。");
    expect(r.text).not.toContain("好的，先看现状。".repeat(5));
    expect(r.text).toContain("[ERR#3 Bash] zsh: command not found");
    expect(r.text).toContain("[MEM#5 store_case]");
    expect(r.text).not.toContain("<system-reminder>");
    const masked = renderTranscriptForLLM(d, { maskMemoryWrites: true });
    expect(masked.text).toContain("回放时隐藏");
    expect(masked.text).not.toContain("柠檬清理");
  });
  it("drops assistant lines first when over budget but never user lines", () => {
    const d = doc();
    const r = renderTranscriptForLLM(d, { maxChars: 400 });
    expect(r.droppedEvents).toBeGreaterThan(0);
    expect(r.text).toContain("[U#0");
    expect(r.text).toContain("[U#6");
  });
});

describe("session-ledger redaction before the LLM sees anything", () => {
  it("redacts user/assistant/error/memory-write text in the rendered transcript", () => {
    const d = doc();
    const fake = ["sk", "-", "b".repeat(24), "7".repeat(16)].join("");
    d.events[0].text = `帮我修 bot，key 是 ${fake}`;
    d.events[5].toolInput = { title: "x", problem: `token=${fake}` };
    const r = renderTranscriptForLLM(d);
    expect(r.text).not.toContain(fake);
    expect(r.text).toContain("[REDACTED");
  });
});

describe("session-ledger anchors and JSON", () => {
  it("verifies anchors verbatim (ignoring whitespace/punctuation) and repairs the seq", () => {
    const d = doc();
    expect(verifyAnchor(d, "以后自建日志一律放 ops-logs", 6)).toEqual({ verified: true, seq: 6 });
    expect(verifyAnchor(d, "以后自建日志，一律放ops-logs", 1)).toEqual({ verified: true, seq: 6 });
    expect(verifyAnchor(d, "她说日志放哪都行", 6)).toEqual({ verified: false, seq: 6 });
  });
  it("ignores markdown markers in the original when matching an anchor", () => {
    const d = doc();
    d.events[7].text = "好的，记下了：\n- **处理完就删 Gem**：收进弹药库的，删前先把原文存一份。\n- `ops-logs` 以后都放这里。";
    expect(verifyAnchor(d, "处理完就删 Gem：收进弹药库的，删前先把原文存一份。", 7).verified).toBe(true);
    expect(verifyAnchor(d, "ops-logs 以后都放这里", 1)).toEqual({ verified: true, seq: 7 });
  });
  it("parses the LLM JSON (even fenced) and flags unverifiable anchors", () => {
    const d = doc();
    const body = parseLedgerJson('```json\n{"oneLine":"挪日志目录","solved":["日志目录改到 ops-logs"],"experience":[{"text":"自建日志放 ops-logs","anchor":"以后自建日志一律放 ops-logs","anchorSeq":6,"kind":"偏好"},{"text":"编的","anchor":"原文里没有这句","anchorSeq":2,"kind":"sk-not-a-kind"},{"text":"","anchor":"x"}],"unfinished":[]}\n```', d);
    expect(body.oneLine).toBe("挪日志目录");
    expect(body.experience).toHaveLength(2);
    expect(body.experience[0].anchorVerified).toBe(true);
    expect(body.experience[1].anchorVerified).toBe(false);
    expect(body.experience[1].kind).toBe(""); // kind 只认枚举
  });
  it("renders frontmatter + five sections, redacts secrets, and marks unverified anchors", () => {
    const d = doc();
    const body = parseLedgerJson('{"oneLine":"挪日志目录","solved":["改到 ops-logs"],"experience":[{"text":"自建日志放 ops-logs","anchor":"以后自建日志一律放 ops-logs","anchorSeq":6,"kind":"偏好"},{"text":"编的","anchor":"原文里没有这句","anchorSeq":2,"kind":"坑"}],"unfinished":["等 Alice 看一眼"]}', d);
    const out = renderLedgerMarkdown(d, summarizeSession(d), body, { trigger: "auto-sweep", pass: 1, machine: "mini", generatedAt: "2026-10-23T00:00:00.000Z" }, { model: "qwen-turbo", promptTokens: 1000, completionTokens: 200, wallMs: 10, inputChars: 500 }, "llm");
    const md = out.markdown;
    expect(md.startsWith("---\nsession: cfe4de46-1111-4222-8333-444444444444\nsource: cc\nmachine: mini\n")).toBe(true);
    expect(md).toContain("trigger: auto-sweep");
    expect(md).toContain("experience_pending: 2");
    expect(md).toContain("anchors_unverified: 1");
    for (const h of ["## 解决了什么", "## 经验（待确认）", "## 没做完", "## 报错（机器抽取，1 条）", "## 当场写过的记忆（机器抽取）"]) expect(md).toContain(h);
    expect(md).toContain("｜src:cfe4de46#6");
    expect(md).toContain("｜anchor:未核");
    expect(md).toContain("- store_case ×1");
    expect(md).not.toContain("sk-live-" + "A".repeat(32));
    expect(md).toContain("[REDACTED");
  });
  it("renders a machine-only ledger when there is no LLM", () => {
    const d = doc();
    const out = renderLedgerMarkdown(d, summarizeSession(d), null, { trigger: "auto-sweep", pass: 1 }, null, "none");
    expect(out.markdown).toContain("generator: none");
    expect(out.markdown).toContain("- （未生成）");
    expect(out.markdown).toContain("Bash #3: zsh: command not found");
  });
});
