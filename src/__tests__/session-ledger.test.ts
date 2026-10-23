import { describe, expect, it } from "bun:test";

import type { SessionDoc } from "../session-events.js";
import { summarizeSession } from "../session-events.js";
import { LEDGER_MAX_TOKENS, LEDGER_SYSTEM_PROMPT, generateLedgerBody, parseLedgerJson, renderLedgerMarkdown, renderTranscriptForLLM, TAIL_ASSISTANT_CLIP, TAIL_EVENTS, TAIL_MARKER, verifyAnchor } from "../session-ledger.js";

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
    expect(body.decisions).toEqual(["定：日志一律放 ops-logs（用户拍板，柠檬会清 Library/Logs 子目录）", "否：放 Library/Logs（会被清）"]);
    const md = renderLedgerMarkdown(d, summarizeSession(d), body, { trigger: "auto-sweep", pass: 1 }, null, "llm").markdown;
    expect(md).toContain("## 决定与否决\n- 定：日志一律放 ops-logs（用户拍板，柠檬会清 Library/Logs 子目录）\n- 否：放 Library/Logs（会被清）\n");
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
