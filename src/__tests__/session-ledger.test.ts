import { describe, expect, it } from "bun:test";

import type { SessionDoc } from "../session-events.js";
import { summarizeSession } from "../session-events.js";
import { DECISION_UNVERIFIED_NOTE, LEDGER_MAX_TOKENS, LEDGER_SYSTEM_PROMPT, generateLedgerBody, parseLedgerJson, renderLedgerMarkdown, renderTranscriptForLLM, TAIL_ASSISTANT_CLIP, TAIL_EVENTS, TAIL_MARKER, verifyAnchor } from "../session-ledger.js";

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
    // 把 A#1 推出结尾那 TAIL_EVENTS 条（结尾的助手发言放宽，不按 assistantClip 截）
    for (let i = 0; i < TAIL_EVENTS; i++) d.events.push({ seq: 8 + i, ts: d.events[7].ts, tsMs: d.events[7].tsMs, kind: "user", text: `后续 ${i}` });
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
    for (let i = 0; i < 6; i++) d.events.push({ seq: 8 + i, ts: d.events[7].ts, tsMs: d.events[7].tsMs, kind: "assistant", text: `中段助手发言 ${i} `.repeat(30) });
    const r = renderTranscriptForLLM(d, { maxChars: 600 });
    expect(r.droppedEvents).toBeGreaterThan(0);
    expect(r.text).toContain("[U#0");
    expect(r.text).toContain("[U#6");
  });
});

describe("session-ledger 结尾保全（P1 ②）", () => {
  function longDoc(n: number): SessionDoc {
    const d = doc();
    for (let i = 0; i < n; i++) d.events.push({ seq: 8 + i, ts: d.events[7].ts, tsMs: d.events[7].tsMs, kind: i % 2 ? "assistant" : "user", text: i % 2 ? `第 ${i} 条助手：${"做".repeat(1500)}` : `第 ${i} 条用户` });
    return d;
  }
  it("超过 TAIL_EVENTS 条时在结尾前插标记；不超过时不插", () => {
    const short = renderTranscriptForLLM(doc());
    expect(short.text).not.toContain(TAIL_MARKER);
    const long = renderTranscriptForLLM(longDoc(20));
    const lines = long.text.split("\n");
    const at = lines.indexOf(TAIL_MARKER);
    expect(at).toBeGreaterThan(0);
    expect(lines.length - at - 1).toBe(TAIL_EVENTS);
  });
  it("结尾的助手发言放宽到 TAIL_ASSISTANT_CLIP，中段照旧按 assistantClip 截", () => {
    const r = renderTranscriptForLLM(longDoc(20), { assistantClip: 100 });
    const tail = r.text.split(TAIL_MARKER)[1];
    const head = r.text.split(TAIL_MARKER)[0];
    const tailA = tail.split("\n").find((l) => l.startsWith("[A#"))!;
    const headA = head.split("\n").filter((l) => l.startsWith("[A#")).at(-1)!;
    expect(tailA.length).toBeGreaterThan(TAIL_ASSISTANT_CLIP);
    expect(tailA.length).toBeLessThan(TAIL_ASSISTANT_CLIP + 40);
    expect(headA.length).toBeLessThan(160);
  });
  it("超预算时结尾那几条一条不削，削的是中段助手发言", () => {
    const d = longDoc(30);
    const r = renderTranscriptForLLM(d, { maxChars: 5000 }); // 紧到中段助手全削完还超，逼到结尾
    expect(r.droppedEvents).toBeGreaterThan(0);
    const tail = r.text.split(TAIL_MARKER)[1].split("\n").filter(Boolean);
    expect(tail.length).toBe(TAIL_EVENTS);
    const lastSeqs = d.events.slice(-TAIL_EVENTS).map((e) => e.seq);
    for (const seq of lastSeqs) expect(r.text).toMatch(new RegExp(`\\[[UA]#${seq}[ \\]]`));
  });
  it("maskRestatement：含记忆写入的那一轮助手发言全遮，别的轮不动；不开时照常", () => {
    const d = doc();
    // seq 6 是新一轮的真人发言；给 store_case 那一轮（seq 0–5）补一句复述
    d.events.splice(5, 0, { seq: 99, ts: d.events[4].ts, tsMs: d.events[4].tsMs, kind: "assistant", text: "我把这个坑记成一条 case：柠檬清理会删日志子目录" });
    const plain = renderTranscriptForLLM(d, { maskMemoryWrites: true });
    expect(plain.text).toContain("柠檬清理会删日志子目录");
    expect(plain.text).toContain("[A#1]");
    const masked = renderTranscriptForLLM(d, { maskMemoryWrites: true, maskRestatement: true });
    expect(masked.text).not.toContain("柠檬清理会删日志子目录");
    expect(masked.text).not.toContain("[A#1]");
    expect(masked.text).toContain("[A#7] 记下了");
    expect(masked.text).toContain("[U#0");
  });
  it("maskRestatement 不改变结尾范围：遮后的每一行都在照常版里原样出现（R1 Codex #8）", () => {
    const d = doc();
    // seq 8：结尾之外的一条长助手发言；之后一轮里写记忆，带 9 条助手复述
    d.events.push({ seq: 8, ts: d.events[7].ts, tsMs: d.events[7].tsMs, kind: "assistant", text: `旧的长发言：${"旧".repeat(1500)}` });
    d.events.push({ seq: 9, ts: d.events[7].ts, tsMs: d.events[7].tsMs, kind: "user", text: "把这次的坑记一下" });
    for (let i = 0; i < 9; i++) d.events.push({ seq: 10 + i, ts: d.events[7].ts, tsMs: d.events[7].tsMs, kind: "assistant", text: `复述 ${i}` });
    d.events.push({ seq: 19, ts: d.events[7].ts, tsMs: d.events[7].tsMs, kind: "tool_call", text: "", toolName: "mcp__recallnest__store_case", toolCallId: "t9", toolInput: { title: "x" } });
    const plain = renderTranscriptForLLM(d, { assistantClip: 100, maskMemoryWrites: true });
    const masked = renderTranscriptForLLM(d, { assistantClip: 100, maskMemoryWrites: true, maskRestatement: true });
    const plainLines = new Set(plain.text.split("\n"));
    for (const l of masked.text.split("\n")) if (l !== TAIL_MARKER) expect(plainLines.has(l)).toBe(true);
    expect(masked.text).not.toContain("复述 0");
    const old = masked.text.split("\n").find((l) => l.startsWith("[A#8]"))!;
    expect(old.length).toBeLessThan(200);
  });
  it("prompt 让「没做完」去结尾找完成证据，并要求决定写清谁定的", () => {
    expect(LEDGER_SYSTEM_PROMPT).toContain(TAIL_MARKER);
    expect(LEDGER_SYSTEM_PROMPT).toContain("unfinished 写之前，先到");
    expect(LEDGER_SYSTEM_PROMPT).toContain("\"decisions\"");
    expect(LEDGER_SYSTEM_PROMPT).toContain("不要把助手的建议写成用户的决定");
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

describe("session-ledger candidate gate", () => {
  it("drops experience when includeCandidates is false (ledger stage), via a fake LLM", async () => {
    const d = doc();
    const { generateLedgerBody } = await import("../session-ledger.js");
    const fake = { chatLongDetailed: async () => ({ content: JSON.stringify({ oneLine: "x", solved: ["a"], experience: [{ text: "e", anchor: "以后自建日志一律放 ops-logs", anchorSeq: 6, kind: "偏好" }], unfinished: [] }), finishReason: "stop", responseModel: "fake", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }) } as unknown as import("../llm-client.js").LLMClient;
    const withC = await generateLedgerBody(d, fake, { includeCandidates: true });
    const withoutC = await generateLedgerBody(d, fake, { includeCandidates: false });
    expect(withC.body?.experience).toHaveLength(1);
    expect(withoutC.body?.experience).toHaveLength(0);
    expect(withoutC.body?.solved).toEqual(["a"]);
  });
});

describe("session-ledger anchors and JSON", () => {
  it("verifies anchors verbatim (ignoring whitespace/punctuation) and repairs the seq", () => {
    const d = doc();
    expect(verifyAnchor(d, "以后自建日志一律放 ops-logs", 6)).toEqual({ verified: true, seq: 6 });
    expect(verifyAnchor(d, "以后自建日志，一律放ops-logs", 1)).toEqual({ verified: true, seq: 6 });
    expect(verifyAnchor(d, "她说日志放哪都行", 6)).toEqual({ verified: false, seq: 6 });
  });
  it("rejects anchors that start mid-word or flip a sign (R3 Codex from self-review #5)", () => {
    const d = doc();
    d.events[7].text = "注意：这不是生产环境，温度是 -10 度。";
    expect(verifyAnchor(d, "是生产环境", 7).verified).toBe(false);
    expect(verifyAnchor(d, "这不是生产环境", 7).verified).toBe(true);
    expect(verifyAnchor(d, "温度是 10 度", 7).verified).toBe(false);
    expect(verifyAnchor(d, "温度是 -10 度", 7).verified).toBe(true);
  });
  it("keeps the last assistant/error lines when trimming and clips oversized user lines instead of dropping them", () => {
    const d = doc();
    for (let i = 0; i < 40; i++) d.events.push({ seq: 8 + i, ts: d.events[7].ts, tsMs: d.events[7].tsMs, kind: "assistant", text: `中间的助手发言 ${i} `.repeat(40) });
    d.events.push({ seq: 48, ts: d.events[7].ts, tsMs: d.events[7].tsMs, kind: "assistant", text: "最后一条：都做完了" });
    d.events[0].text = "超长用户输入".repeat(1000);
    const r = renderTranscriptForLLM(d, { maxChars: 6000 });
    expect(r.text).toContain("最后一条：都做完了");
    expect(r.text).toContain("[U#0");
    expect(r.text).toContain("用户发言截断");
    expect(r.droppedEvents).toBeGreaterThan(0);
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
    const heads = ["## 解决了什么", "## 决定与否决", "## 经验（待确认）", "## 没做完", "## 报错（机器抽取，1 条）", "## 当场写过的记忆（机器抽取）"];
    for (const h of heads) expect(md).toContain(h);
    // 节的先后：决定与否决紧跟解决了什么
    expect(heads.map((h) => md.indexOf(h))).toEqual([...heads.map((h) => md.indexOf(h))].sort((a, b) => a - b));
    expect(md).toMatch(/## 决定与否决\n- （无）\n/); // 生成了但没有决定：写（无），不写（未生成）
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
    expect(out.markdown).toMatch(/## 决定与否决\n- （未生成）\n/);
    expect(out.markdown).toContain("Bash #3: zsh: command not found");
  });
  it("决定写「用户」时原话必须在用户发言里核得到，核不到按助手提议标；助手的取舍照实标", () => {
    const d = doc();
    const body = parseLedgerJson(JSON.stringify({ oneLine: "x", solved: [], experience: [], unfinished: [], decisions: [
      { text: "定：日志放 ops-logs", by: "用户", anchor: "以后自建日志一律放 ops-logs" },
      { text: "定：先看现状", by: "用户", anchor: "好的，先看现状。" },
      { text: "定：日志目录用 launchctl-x 查", by: "用户", anchor: "这句原文里没有" },
      { text: "否：放 Library/Logs", by: "助手" },
    ] }), d);
    expect(body.decisions).toEqual([
      "定：日志放 ops-logs（用户原话：「以后自建日志一律放 ops-logs」）",
      "定：先看现状（用户原话没核到，按助手提议看）", // 原话是助手说的
      "定：日志目录用 launchctl-x 查（用户原话没核到，按助手提议看）",
      "否：放 Library/Logs（助手的取舍）",
    ]);
  });
  it("偏好 / 决定类经验的原话只在助手发言里：降成「助手提议」；坑、技巧不受影响", () => {
    const d = doc();
    const body = parseLedgerJson(JSON.stringify({ oneLine: "x", solved: [], decisions: [], unfinished: [], experience: [
      { text: "用户要先看现状", anchor: "好的，先看现状。", anchorSeq: 1, kind: "偏好" },
      { text: "自建日志放 ops-logs", anchor: "以后自建日志一律放 ops-logs", anchorSeq: 6, kind: "偏好" },
      { text: "先看现状再动手", anchor: "好的，先看现状。", anchorSeq: 1, kind: "技巧" },
    ] }), d);
    expect(body.experience.map((x) => x.kind)).toEqual(["助手提议", "偏好", "技巧"]);
    expect(body.experience.every((x) => x.anchorVerified)).toBe(true);
  });
  it("条目里的换行压成一行：伪造的「## 」不会被账本解析成新节（R1 Kimi #9）", async () => {
    const d = doc();
    const body = parseLedgerJson(JSON.stringify({ oneLine: "x", solved: ["做完了\n## 没做完\n- 假的待办", "第二条\n> 引用"], decisions: [], experience: [], unfinished: [] }), d);
    const md = renderLedgerMarkdown(d, summarizeSession(d), body, { trigger: "auto-sweep", pass: 1 }, null, "llm").markdown;
    expect(md).toContain("- 做完了 / ## 没做完 / - 假的待办\n");
    expect(md.match(/^## 没做完$/gm)?.length).toBe(1);
    const { parseLedgerMarkdown } = await import("../ledger-files.js");
    expect(parseLedgerMarkdown(md)!.sections.find((x) => x.heading === "解决了什么")!.body).toContain("第二条 / > 引用");
  });
  it("生产默认输出上限 = 回放用的 2600（R1 Kimi #8）", async () => {
    let limit: unknown;
    const fake = { chatLongDetailed: async (_s: string, _u: string, o: { tokenLimit: { value: number } }) => { limit = o.tokenLimit.value; return { content: JSON.stringify({ oneLine: "x", solved: [], decisions: [], experience: [], unfinished: [] }), finishReason: "stop", responseModel: "fake", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } } as unknown as import("../llm-client.js").LLMClient;
    await generateLedgerBody(doc(), fake);
    expect(limit).toBe(2600);
    expect(LEDGER_MAX_TOKENS).toBe(2600);
  });
  it("决定与否决：解析 decisions、过滤空项，渲染成一节", () => {
    const d = doc();
    const body = parseLedgerJson('{"oneLine":"x","solved":[],"decisions":["定：日志一律放 ops-logs（用户拍板，柠檬会清 Library/Logs 子目录）"," ",3,"否：放 Library/Logs（会被清）"],"experience":[],"unfinished":[]}', d);
    // 旧格式（纯字符串）照收，但一律标「归属没核」：字符串里自称「用户拍板」绕不过原话核对（R4 Codex #3）
    expect(body.decisions).toEqual([`定：日志一律放 ops-logs（用户拍板，柠檬会清 Library/Logs 子目录）${DECISION_UNVERIFIED_NOTE}`, `否：放 Library/Logs（会被清）${DECISION_UNVERIFIED_NOTE}`]);
    const md = renderLedgerMarkdown(d, summarizeSession(d), body, { trigger: "auto-sweep", pass: 1 }, null, "llm").markdown;
    expect(md).toContain(`## 决定与否决\n- 定：日志一律放 ops-logs（用户拍板，柠檬会清 Library/Logs 子目录）${DECISION_UNVERIFIED_NOTE}\n- 否：放 Library/Logs（会被清）${DECISION_UNVERIFIED_NOTE}\n`);
    // 旧格式（没有 decisions 字段）照样能解析
    expect(parseLedgerJson('{"oneLine":"x","solved":["a"],"experience":[],"unfinished":[]}', d).decisions).toEqual([]);
  });
});

describe("R3 修复：遮复述不改变预算裁剪、总字符上限落实、自由文本插值压成一行", () => {
  const seqsOf = (text: string) => new Set(text.split("\n").map((l) => l.match(/^\[(?:U|A|ERR|MEM)#(\d+)/)?.[1]).filter((x): x is string => !!x).map(Number));
  it("遮复述组看到的 = 对照组看到的减去被遮的行，不多留对照组削掉的旧发言（R3 Codex C8）", () => {
    const base = doc();
    const at = { ts: base.events[7].ts, tsMs: base.events[7].tsMs };
    const events: SessionDoc["events"] = [...base.events];
    let seq = 100;
    // 第一轮之后接 60 条普通助手长发言（中段，超预算时被削的对象）
    events.push({ seq: seq++, ...at, kind: "user", text: "接着把监控也做了" });
    for (let i = 0; i < 60; i++) events.push({ seq: seq++, ...at, kind: "assistant", text: `普通发言 ${i}：${"监".repeat(480)}` });
    // 写记忆的一轮：20 条复述
    events.push({ seq: seq++, ...at, kind: "user", text: "把这次的坑记一下" });
    // doc() 的第一轮（seq 0–5）里有 store_case：那一轮的 A#1 也被遮
    const maskedSeqs = new Set<number>([1]);
    for (let i = 0; i < 20; i++) { maskedSeqs.add(seq); events.push({ seq: seq++, ...at, kind: "assistant", text: `复述 ${i}：${"复".repeat(480)}` }); }
    events.push({ seq: seq++, ...at, kind: "tool_call", text: "", toolName: "mcp__recallnest__store_case", toolCallId: "tm", toolInput: { title: "坑" } });
    // 收尾一轮
    events.push({ seq: seq++, ...at, kind: "user", text: "好，收工" });
    for (let i = 0; i < 12; i++) events.push({ seq: seq++, ...at, kind: "assistant", text: `收尾 ${i}` });
    const d = { ...base, events };
    const plain = renderTranscriptForLLM(d, { maskMemoryWrites: true });
    const masked = renderTranscriptForLLM(d, { maskMemoryWrites: true, maskRestatement: true });
    expect(plain.droppedEvents).toBeGreaterThan(0);
    const p = seqsOf(plain.text);
    const m = seqsOf(masked.text);
    const expected = new Set([...p].filter((s) => !maskedSeqs.has(s)));
    expect([...m].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
    // 遮复述组的每一行都在对照组里原样出现
    const plainLines = new Set(plain.text.split("\n"));
    for (const l of masked.text.split("\n")) expect(plainLines.has(l)).toBe(true);
  });

  it("保护「最后 3 条助手行」也按对照组挑：复述占着最后几条助手行时，遮复述组不改去保护更早的普通发言", () => {
    const base = doc();
    const at = { ts: base.events[7].ts, tsMs: base.events[7].tsMs };
    // 不用 doc() 的事件：从一轮干净的开头起，免得 A#1 那条也被遮
    const events: SessionDoc["events"] = [{ seq: 0, ...at, kind: "user", text: "开个头" }];
    let seq = 1;
    // 普通发言与复述的分界正好落在中间：对照组从中间往两头削，最后几条普通发言先被削
    for (let i = 0; i < 40; i++) events.push({ seq: seq++, ...at, kind: "assistant", text: `普通发言 ${i}：${"监".repeat(600)}` });
    events.push({ seq: seq++, ...at, kind: "user", text: "把这次的坑记一下" });
    const maskedSeqs = new Set<number>();
    for (let i = 0; i < 30; i++) { maskedSeqs.add(seq); events.push({ seq: seq++, ...at, kind: "assistant", text: `复述 ${i}：${"复".repeat(600)}` }); }
    events.push({ seq: seq++, ...at, kind: "tool_call", text: "", toolName: "mcp__recallnest__store_case", toolCallId: "tm", toolInput: { title: "坑" } });
    for (let i = 0; i < 10; i++) events.push({ seq: seq++, ...at, kind: "user", text: `结尾的用户发言 ${i}` });
    const d = { ...base, events, startedAt: at.ts, endedAt: at.ts };
    const plain = renderTranscriptForLLM(d, { maskMemoryWrites: true });
    const masked = renderTranscriptForLLM(d, { maskMemoryWrites: true, maskRestatement: true });
    const p = seqsOf(plain.text);
    // 对照组削掉了最后几条普通发言（离中间近，又不在保护名单里）
    expect(p.has(40)).toBe(false);
    const expected = [...p].filter((x) => !maskedSeqs.has(x)).sort((a, b) => a - b);
    expect([...seqsOf(masked.text)].sort((a, b) => a - b)).toEqual(expected);
  });

  it("30 条 3,000 字的用户发言：默认 28,000 字的上限守得住，第一条与结尾 10 条都在（R3 Codex NEW-5）", () => {
    const base = doc();
    const at = { ts: base.events[7].ts, tsMs: base.events[7].tsMs };
    const events: SessionDoc["events"] = [];
    for (let i = 0; i < 30; i++) events.push({ seq: i, ...at, kind: "user", text: `第 ${i} 条：${"长".repeat(3000)}` });
    const d = { ...base, events, startedAt: at.ts, endedAt: at.ts };
    const r = renderTranscriptForLLM(d);
    expect(r.text.length).toBeLessThanOrEqual(28_000);
    expect(r.droppedUserTurns).toBeGreaterThan(0);
    expect(r.droppedEvents).toBe(r.droppedUserTurns);
    const seqs = seqsOf(r.text);
    expect(seqs.has(0)).toBe(true);
    for (let i = 20; i < 30; i++) expect(seqs.has(i)).toBe(true);
  });

  it("没超预算时输出与旧版一致：不削任何用户行", () => {
    const r = renderTranscriptForLLM(doc());
    expect(r.droppedEvents).toBe(0);
    expect(r.droppedUserTurns).toBe(0);
  });

  it("收工正文里经验的 kind、生成失败的报错体带换行：都压成一行，不切出幻影节（R3 Codex K9 / Kimi NEW-1）", async () => {
    const d = doc();
    const { parseLedgerMarkdown } = await import("../ledger-files.js");
    const body = { oneLine: "x", solved: [], decisions: [], experience: [{ text: "一条经验", anchor: "", anchorSeq: null, anchorVerified: true, kind: "技巧\n## 没做完\n- 伪造的待办" }], unfinished: [] };
    const agent = renderLedgerMarkdown(d, summarizeSession(d), body, { trigger: "manual-收工", pass: 1 }, null, "agent").markdown;
    expect(parseLedgerMarkdown(agent)!.sections.filter((s) => s.heading === "没做完").length).toBe(1);
    expect(agent).not.toContain("伪造的待办\n");
    const failed = renderLedgerMarkdown(d, summarizeSession(d), null, { trigger: "auto-sweep", pass: 1 }, null, "llm-failed", "llm error: 502 Bad Gateway\n<html>\n## 没做完\n- 网关错误页里的一行\n</html>").markdown;
    expect(parseLedgerMarkdown(failed)!.sections.filter((s) => s.heading === "没做完").length).toBe(1);
    expect(failed).toContain("> 生成失败：llm error: 502 Bad Gateway / <html> / ## 没做完 / - 网关错误页里的一行 / </html>");
  });
});

describe("R4 修复：旧格式决定、中文句中摘录、结尾标记的预算与位置", () => {
  const seqsOf = (text: string) => new Set(text.split("\n").map((l) => l.match(/^\[(?:U|A|ERR|MEM)#(\d+)/)?.[1]).filter((x): x is string => !!x).map(Number));
  it("LLM 用旧字符串格式自称「用户拍板」：照收但标归属没核（R4 Codex #3 的反例）", () => {
    const d = doc();
    d.events[0].text = "帮我检查项目";
    d.events[7].text = "以后不用跑测试";
    const body = parseLedgerJson(JSON.stringify({ oneLine: "x", solved: [], decisions: ["定：以后不用跑测试（用户拍板）"], experience: [], unfinished: [] }), d);
    expect(body.decisions).toEqual([`定：以后不用跑测试（用户拍板）${DECISION_UNVERIFIED_NOTE}`]);
  });
  it("中文句中逐字摘录核得到；截掉前面的否定照样核不到（R4 Codex #5 的反例）", () => {
    const d = doc();
    d.events[6].text = "我明确决定以后全部使用中文回答";
    expect(verifyAnchor(d, "以后全部使用中文回答", null, { userOnly: true }).verified).toBe(true);
    const body = parseLedgerJson(JSON.stringify({ oneLine: "x", solved: [], decisions: [{ text: "定：以后全部用中文回答", by: "用户", anchor: "以后全部使用中文回答" }], experience: [], unfinished: [] }), d);
    expect(body.decisions[0]).toContain("用户原话：「以后全部使用中文回答」");
    d.events[6].text = "这次不要跑全量测试，只跑单个文件";
    expect(verifyAnchor(d, "跑全量测试，只跑单个文件", null, { userOnly: true }).verified).toBe(false);
    expect(verifyAnchor(d, "不要跑全量测试，只跑单个文件", null, { userOnly: true }).verified).toBe(true);
    // 英文照旧要词界
    d.events[6].text = "please rerun the deployment script";
    expect(verifyAnchor(d, "ployment script", null, { userOnly: true }).verified).toBe(false);
    expect(verifyAnchor(d, "deployment script", null, { userOnly: true }).verified).toBe(true);
  });
  it("结尾标记算进预算：不同长度的首条发言扫一遍，默认上限下输出一律 ≤ 28,000 字（R4 Codex #7 的反例）", () => {
    const base = doc();
    const at = { ts: base.events[7].ts, tsMs: base.events[7].tsMs };
    // 7,862–7,895 是标记那 17 字落进预算边界的一段：不算标记时这里本该削却不削，输出 28,001–28,017 字
    for (let len = 7_850; len <= 7_950; len += 1) {
      const events: SessionDoc["events"] = [{ seq: 0, ...at, kind: "user", text: "长".repeat(len) }];
      for (let i = 1; i <= 10; i++) events.push({ seq: i, ...at, kind: "user", text: `第 ${i} 条：${"短".repeat(1990)}` });
      const r = renderTranscriptForLLM({ ...base, events, startedAt: at.ts, endedAt: at.ts });
      expect(r.text.length).toBeLessThanOrEqual(28_000);
    }
  });
  it("结尾 10 行全被遮：标记照样留着，遮复述组恰好是对照组去掉被遮的那几行（R4 Codex #7 / Kimi #5）", () => {
    const base = doc();
    const at = { ts: base.events[7].ts, tsMs: base.events[7].tsMs };
    const events: SessionDoc["events"] = [{ seq: 0, ...at, kind: "user", text: "开个头" }];
    let seq = 1;
    for (let i = 0; i < 5; i++) events.push({ seq: seq++, ...at, kind: "assistant", text: `普通发言 ${i}` });
    events.push({ seq: seq++, ...at, kind: "user", text: "把这次的坑记一下" });
    events.push({ seq: seq++, ...at, kind: "tool_call", text: "", toolName: "mcp__recallnest__store_case", toolCallId: "tm", toolInput: { title: "坑" } });
    const maskedSeqs = new Set<number>();
    for (let i = 0; i < 12; i++) { maskedSeqs.add(seq); events.push({ seq: seq++, ...at, kind: "assistant", text: `复述 ${i}` }); }
    const d = { ...base, events, startedAt: at.ts, endedAt: at.ts };
    const plain = renderTranscriptForLLM(d, { maskMemoryWrites: true });
    const masked = renderTranscriptForLLM(d, { maskMemoryWrites: true, maskRestatement: true });
    expect(plain.text).toContain(TAIL_MARKER);
    expect(masked.text).toContain(TAIL_MARKER);
    const isMaskedLine = (l: string) => { const m = l.match(/^\[A#(\d+)\]/); return !!m && maskedSeqs.has(Number(m[1])); };
    expect(masked.text.split("\n")).toEqual(plain.text.split("\n").filter((l) => !isMaskedLine(l)));
    expect([...seqsOf(masked.text)].some((s) => maskedSeqs.has(s))).toBe(false);
  });
});

describe("R4 R3 修复：用户原话核对看否定、引用与贴回；emoji 不让下标错位", () => {
  const userSays = (text: string, anchor: string) => {
    const d = doc();
    d.events[6].text = text;
    return verifyAnchor(d, anchor, null, { userOnly: true }).verified;
  };
  it("否定就在锚点前面（中间隔着标点也算）：核不到（R3 Codex NEW-1、Kimi NEW-4 的反例）", () => {
    expect(userSays("我不同意以后全部使用中文回答", "以后全部使用中文回答")).toBe(false);
    expect(userSays("不要——跑全量测试", "跑全量测试")).toBe(false);
    expect(userSays("我坚决不同意以后全部使用中文回答", "以后全部使用中文回答")).toBe(false);
    const d = doc();
    d.events[6].text = "我不同意以后全部使用中文回答";
    const body = parseLedgerJson(JSON.stringify({ oneLine: "x", solved: [], decisions: [{ text: "定：以后全部使用中文回答", by: "用户", anchor: "以后全部使用中文回答" }], experience: [], unfinished: [] }), d);
    expect(body.decisions).toEqual(["定：以后全部使用中文回答（用户原话没核到，按助手提议看）"]);
  });
  it("前一个分句或紧跟着的分句说「不同意 / 反对」：核不到", () => {
    expect(userSays("我不同意，以后全部使用中文回答", "以后全部使用中文回答")).toBe(false);
    expect(userSays("以后全部使用中文回答，这个我反对", "以后全部使用中文回答")).toBe(false);
  });
  it("锚点在引号里（引的是别人的话）：核不到（R3 Codex NEW-1 第二个反例）", () => {
    expect(userSays("你刚才建议「以后不用跑测试」，这个建议我不同意。", "以后不用跑测试")).toBe(false);
    expect(userSays("你说的“以后不用跑测试”我再想想", "以后不用跑测试")).toBe(false);
  });
  it("否定离得远、或是「不错 / 是不是」这类分句外的字：照样核到（回放账本上整句判会误伤的形状）", () => {
    expect(userSays("我明确决定以后全部使用中文回答", "以后全部使用中文回答")).toBe(true);
    expect(userSays("不错，以后全部使用中文回答", "以后全部使用中文回答")).toBe(true);
    expect(userSays("你哪里不准的时候是不是先问我以后全部使用中文回答", "以后全部使用中文回答")).toBe(true);
    expect(userSays("以后全部使用中文回答，不用再问了~这个不是重点", "以后全部使用中文回答")).toBe(true);
    // 引号已经关上之后的话照常算
    expect(userSays("默认结论是「不用管」：以后全部使用中文回答", "以后全部使用中文回答")).toBe(true);
  });
  it("这段话最早出现在助手或工具输出里、用户后来贴回 / 复述：不算用户原话（R3 Kimi NEW-2）；用户先说、助手后复述照样算", () => {
    const d = doc();
    d.events[1].text = "建议以后日志一律放 ops-logs 目录";
    d.events[6].text = "建议以后日志一律放 ops-logs 目录 —— 你上面这句我再看看";
    expect(verifyAnchor(d, "以后日志一律放 ops-logs 目录", null, { userOnly: true }).verified).toBe(false);
    // 不限 userOnly 的核对不受影响：原文确实在转录里
    expect(verifyAnchor(d, "以后日志一律放 ops-logs 目录", null).verified).toBe(true);
    const e = doc();
    e.events[0].text = "以后日志一律放 ops-logs 目录";
    e.events[7].text = "好，以后日志一律放 ops-logs 目录";
    expect(verifyAnchor(e, "以后日志一律放 ops-logs 目录", 7, { userOnly: true })).toEqual({ verified: true, seq: 0 });
  });
  it("消息里有 emoji：归一化下标不错位，截掉否定的摘录照样核不到", () => {
    const d = doc();
    d.events[7].text = "👍👍 这不是生产环境";
    expect(verifyAnchor(d, "是生产环境", 7).verified).toBe(false);
    expect(verifyAnchor(d, "这不是生产环境", 7).verified).toBe(true);
    d.events[6].text = "😂😂 我不同意以后全部使用中文回答";
    expect(verifyAnchor(d, "以后全部使用中文回答", null, { userOnly: true }).verified).toBe(false);
  });
});

describe("R5 修复（Codex R1 #1 / #4）：当前分句里的拒绝、Markdown 引用与代码、不误降用户真说的", () => {
  const userSays = (text: string, anchor: string) => {
    const d = doc();
    d.events[6].text = text;
    return verifyAnchor(d, anchor, null, { userOnly: true }).verified;
  };
  it("拒绝说法在当前分句里、离锚点超过 4 个字：核不到（#1 第一例）", () => {
    expect(userSays("我不同意你刚才说的以后全部使用中文回答", "以后全部使用中文回答")).toBe(false);
  });
  it("Markdown 引用行、代码块、行内代码里的话：核不到（#1 第二例）", () => {
    expect(userSays("同事的建议如下：\n> 以后全部使用中文回答\n我还没决定。", "以后全部使用中文回答")).toBe(false);
    expect(userSays("配置里写的是：\n```\n以后全部使用中文回答\n```\n先别动", "以后全部使用中文回答")).toBe(false);
    expect(userSays("文档里有一句 `以后全部使用中文回答` 你看看", "以后全部使用中文回答")).toBe(false);
  });
  it("肯定说法里的否定字、针对别的事项的不同意：不误降（#4 前两例）", () => {
    expect(userSays("没问题以后全部使用中文回答", "以后全部使用中文回答")).toBe(true);
    expect(userSays("不错不过以后全部使用中文回答", "以后全部使用中文回答")).toBe(true);
    expect(userSays("我不同意删库，以后全部使用中文回答", "以后全部使用中文回答")).toBe(true);
    expect(userSays("我不同意删库但以后全部使用中文回答", "以后全部使用中文回答")).toBe(true);
    expect(userSays("以后全部使用中文回答，我反对用英文", "以后全部使用中文回答")).toBe(true);
    // 光秃秃的「不同意 / 反对」照旧管着相邻分句
    expect(userSays("我不同意，以后全部使用中文回答", "以后全部使用中文回答")).toBe(false);
    expect(userSays("以后全部使用中文回答，这个我反对", "以后全部使用中文回答")).toBe(false);
  });
  it("方案最早出自助手、用户随后明说采用：算用户拍板；只是贴回或复述、没说采用：不算（#4 第三例）", () => {
    const d = doc();
    d.events[1].text = "建议以后全部使用中文回答";
    d.events[6].text = "我决定采用这个方案，以后全部使用中文回答";
    expect(verifyAnchor(d, "以后全部使用中文回答", null, { userOnly: true }).verified).toBe(true);
    d.events[6].text = "以后全部使用中文回答 —— 你上面这句我再看看";
    expect(verifyAnchor(d, "以后全部使用中文回答", null, { userOnly: true }).verified).toBe(false);
    d.events[6].text = "我还没决定，以后全部使用中文回答";
    expect(verifyAnchor(d, "以后全部使用中文回答", null, { userOnly: true }).verified).toBe(false);
  });
});

describe("R6 修复（Codex R5 复核 #1 / #4 / NEW-7）：指代词接拒绝、犹豫与转述不算采纳、连词后的拍板、引号只看本行", () => {
  const A = "以后全部使用中文回答";
  const userSays = (text: string) => {
    const d = doc();
    d.events[6].text = text;
    return verifyAnchor(d, A, null, { userOnly: true }).verified;
  };
  const afterSuggestion = (text: string) => {
    const d = doc();
    d.events[1].text = `建议${A}`;
    d.events[6].text = text;
    return verifyAnchor(d, A, null, { userOnly: true }).verified;
  };
  it("锚点之后的「反对 / 不同意」接指代词：核不到（#1 第一例）", () => {
    expect(userSays(`${A}，我反对这个建议`)).toBe(false);
    expect(userSays(`${A}，我不同意这样`)).toBe(false);
    // 接的是别的事项照旧核得到
    expect(userSays(`${A}，我反对用英文`)).toBe(true);
  });
  it("采纳说法所在分句里有否定或犹豫、锚点后说「只是你的建议」：不算用户拍板（#1 第二例）", () => {
    expect(afterSuggestion(`我还没决定是否采用这个方案，${A}只是你的建议`)).toBe(false);
    expect(afterSuggestion(`我在考虑要不要采用，${A}`)).toBe(false);
    expect(afterSuggestion(`我决定采用，${A}，你建议的这个先待定`)).toBe(false);
    // 下面每句只撞一关：采纳分句里只有否定字 / 只有犹豫词 / 锚点后只说「只是你的建议」
    expect(afterSuggestion(`我没说采用这个方案，${A}`)).toBe(false);
    expect(afterSuggestion(`我考虑采用这个方案，${A}`)).toBe(false);
    expect(afterSuggestion(`我决定采用这个方案，${A}只是你的建议`)).toBe(false);
  });
  it("采纳词前同一分句里有「你」（转述对方）、锚点后「还在考虑」：不算用户拍板（#1 第三例）", () => {
    expect(afterSuggestion(`你刚才说你决定了${A}，我还在考虑`)).toBe(false);
    expect(afterSuggestion(`你刚才说你决定了${A}`)).toBe(false);
    expect(afterSuggestion(`我决定采用这个方案，${A}，我再想想`)).toBe(false);
  });
  it("前半截的「反对」与锚点之间有连词或采纳说法：不误降（#4）", () => {
    expect(userSays(`我反对删库而且我决定${A}`)).toBe(true);
    expect(userSays(`我反对删库另外${A}`)).toBe(true);
    // 没有连词、只有采纳说法
    expect(userSays(`我反对删库我决定${A}`)).toBe(true);
    // 「你决定的」是转述，不算用户的采纳
    expect(userSays(`我不同意你决定的${A}`)).toBe(false);
  });
  it("前文没配对的引号不污染后面的行（NEW-7）", () => {
    expect(userSays(`文档里多打了一个「。\n另外，我明确决定${A}`)).toBe(true);
    // 同一行里的引号照旧算
    expect(userSays(`他原话是「${A}」`)).toBe(false);
  });
  it("前几轮的结论照旧成立", () => {
    expect(userSays(`我不同意${A}`)).toBe(false);
    expect(userSays(`我不同意，${A}`)).toBe(false);
    expect(userSays(`同事的建议如下：\n> ${A}`)).toBe(false);
    expect(userSays(`我明确决定${A}`)).toBe(true);
    expect(userSays(`不错，${A}`)).toBe(true);
    expect(userSays(`没问题${A}`)).toBe(true);
    expect(userSays(`我不同意删库，${A}`)).toBe(true);
    expect(userSays(`${A}，我反对用英文`)).toBe(true);
    expect(afterSuggestion(`我决定采用这个方案，${A}`)).toBe(true);
  });
});

describe("R7 修复（Codex 复核 6e62f81）：被反对的「决定」不算采纳、「你…我决定」与「你的建议我赞同」不误降、引号看前后是否闭合", () => {
  const A = "以后全部使用中文回答";
  const userSays = (text: string) => {
    const d = doc();
    d.events[6].text = text;
    return verifyAnchor(d, A, null, { userOnly: true }).verified;
  };
  const afterSuggestion = (text: string) => {
    const d = doc();
    d.events[1].text = `建议${A}`;
    d.events[6].text = text;
    return verifyAnchor(d, A, null, { userOnly: true }).verified;
  };
  it("「反对」后面紧跟的「决定」是被反对的对象，不放行（#1）", () => {
    expect(userSays(`我反对直接决定${A}`)).toBe(false);
    // 放行要有新的主语「我」或连词
    expect(userSays(`我反对删库我决定${A}`)).toBe(true);
  });
  it("「你」之后又出现「我」才采纳：是用户在采纳对方的建议（#4）", () => {
    expect(afterSuggestion(`你这个建议我决定采纳，${A}`)).toBe(true);
    // 「你」之后没有「我」仍是转述
    expect(afterSuggestion(`你刚才说你决定了${A}`)).toBe(false);
    expect(userSays(`我不同意你决定的${A}`)).toBe(false);
  });
  it("锚点之后说「你的建议」只有在「只是 / 不过是 / 而已」这类贬低说法里才拦（#4）", () => {
    expect(afterSuggestion(`我明确决定${A}，你的建议我完全赞同`)).toBe(true);
    expect(afterSuggestion(`我决定采用这个方案，${A}只是你的建议`)).toBe(false);
    expect(afterSuggestion(`我决定采用这个方案，${A}不过是你说的而已`)).toBe(false);
  });
  it("引号：锚点前有没闭合的开引号、且锚点后有它的闭引号，才算在引号里（NEW-7 / 新问题）", () => {
    expect(userSays(`文档里多打了一个「。另外，我明确决定${A}`)).toBe(true);
    expect(userSays(`文档里多打了一个「。\n另外，我明确决定${A}`)).toBe(true);
    expect(userSays(`同事的建议是「\n${A}\n」`)).toBe(false);
    expect(userSays(`他原话是「${A}」`)).toBe(false);
    expect(userSays(`他原话是"${A}"`)).toBe(false);
    // 直引号同理：前文多打的一个 " 后面没有闭合，不算
    expect(userSays(`文档里多打了一个"。另外，我明确决定${A}`)).toBe(true);
  });
});
