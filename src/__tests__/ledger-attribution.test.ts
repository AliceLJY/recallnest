import { describe, expect, it } from "bun:test";

import type { LLMClient } from "../llm-client.js";
import type { SessionDoc } from "../session-events.js";
import { ATTRIBUTION_SYSTEM_PROMPT, buildAttributionInput, parseAttributionJson, renderJudgedDecision, verifyUserQuote, type DecisionItem } from "../ledger-attribution.js";
import { generateLedgerBody } from "../session-ledger.js";

/** 10-31 抽样里两类真实形状：B6 助手问「要加吗」用户回「加吧」（误降）；A17 用户只是问别的事，引文被挂到周报体裁上（假收） */
function doc(): SessionDoc {
  const t = (s: number) => ({ ts: new Date(Date.UTC(2026, 9, 28, 10, 0, s)).toISOString(), tsMs: Date.UTC(2026, 9, 28, 10, 0, s) });
  const events: SessionDoc["events"] = [
    { seq: 0, ...t(0), kind: "user", text: "帮我看看这个 three.js 小游戏仓库能借鉴什么" },
    { seq: 1, ...t(1), kind: "assistant", text: "看完了。建议在 AGENTS.md 加一行版本纪律：改已有玩意前先读它自己的 three 版本，不顺手升级。要加吗？" },
    { seq: 2, ...t(2), kind: "user", text: "加吧" },
    { seq: 3, ...t(3), kind: "user", text: "<system-reminder>周报继续用 caption-news</system-reminder>", injected: true },
    { seq: 4, ...t(4), kind: "assistant", text: "周报这周我建议继续用 caption-news 体裁。" },
    { seq: 5, ...t(5), kind: "user", text: "recallnest 备份跑成功了吧" },
    { seq: 6, ...t(6), kind: "assistant", text: "跑成功了。" },
  ];
  return { source: "cc", sessionId: "200fb00b-1111-4222-8333-444444444444", filePath: "/x", events, startedAt: events[0].ts, endedAt: events[6].ts, lastUserAt: events[5].ts, malformedLines: 0 };
}

const VERSION_RULE: DecisionItem = { text: "定：加一行版本纪律", by: "助手", anchor: "" };
const CAPTION_NEWS: DecisionItem = { text: "定：周报继续用 caption-news", by: "用户", anchor: "recallnest 备份跑成功了吧" };

describe("verifyUserQuote", () => {
  it("两个字的短确认也核得过（关键词判法要求 ≥4 字，「加吧」「可以」一律降级）", () => {
    expect(verifyUserQuote(doc(), 2, "加吧")).toBe(true);
  });
  it("注入的「用户」文本、助手原话、序号不对、原句不在里面：都不算", () => {
    const d = doc();
    expect(verifyUserQuote(d, 3, "周报继续用 caption-news")).toBe(false);
    expect(verifyUserQuote(d, 4, "继续用 caption-news")).toBe(false);
    expect(verifyUserQuote(d, 99, "加吧")).toBe(false);
    expect(verifyUserQuote(d, null, "加吧")).toBe(false);
    expect(verifyUserQuote(d, 2, "不加")).toBe(false);
    expect(verifyUserQuote(d, 2, "，。")).toBe(false);
  });
});

describe("parseAttributionJson", () => {
  it("漏掉的项给 null、认不出的 verdict 按判不了、越界编号丢掉", () => {
    const r = parseAttributionJson('{"judgements":[{"d":2,"verdict":"随便","userSeq":5,"quote":"x"},{"d":9,"verdict":"用户定"},{"d":3,"verdict":"用户定","userSeq":2,"quote":"加吧"}]}', 3);
    expect(r[0]).toBeNull();
    expect(r[1]).toEqual({ verdict: "判不了", userSeq: 5, quote: "x" });
    expect(r[2]).toEqual({ verdict: "用户定", userSeq: 2, quote: "加吧" });
  });
});

describe("renderJudgedDecision", () => {
  it("用户定且原句核得过：记用户原话", () => {
    expect(renderJudgedDecision(doc(), VERSION_RULE, { verdict: "用户定", userSeq: 2, quote: "加吧" })).toBe("定：加一行版本纪律（用户原话：「加吧」）");
  });
  it("用户定但原句只在助手话里：不算用户的，按原 by 写", () => {
    expect(renderJudgedDecision(doc(), CAPTION_NEWS, { verdict: "用户定", userSeq: 4, quote: "继续用 caption-news" })).toBe("定：周报继续用 caption-news（用户原话没核到，按助手提议看）");
    expect(renderJudgedDecision(doc(), VERSION_RULE, { verdict: "判不了", userSeq: null, quote: "" })).toBe("定：加一行版本纪律（助手的取舍）");
  });
  it("用户否：只是不算用户拍板，不写「与用户原话相反」这句断言（复测里它常把提问判成反对）", () => {
    expect(renderJudgedDecision(doc(), CAPTION_NEWS, { verdict: "用户否", userSeq: 5, quote: "recallnest 备份跑成功了吧" })).toBe("定：周报继续用 caption-news（用户原话没核到，按助手提议看）");
  });
});

describe("buildAttributionInput", () => {
  it("只列真人用户发言、附此前助手最后一段；注入文本不进", () => {
    const s = buildAttributionInput(doc(), [VERSION_RULE, CAPTION_NEWS]);
    expect(s).toContain("D1：定：加一行版本纪律");
    expect(s).toContain("[U#2] 用户：加吧\n  （此前助手：看完了。建议在 AGENTS.md 加一行版本纪律");
    expect(s).not.toContain("[U#3]");
    expect(s).toContain("共 3 条");
  });
  it("超预算时留与决定相关的发言，略去条数写明，时间顺序不乱", () => {
    const d = doc();
    for (let i = 0; i < 40; i++) d.events.push({ seq: 10 + i, ts: d.events[6].ts, tsMs: d.events[6].tsMs, kind: "user", text: `无关闲聊第 ${i} 条，`.repeat(20) });
    const s = buildAttributionInput(d, [VERSION_RULE], 600);
    expect(s).toContain("[U#2] 用户：加吧");
    expect(s).toMatch(/略去 \d+ 条/);
    expect(s.length).toBeLessThan(1500);
    expect(s.indexOf("[U#0]") < 0 || s.indexOf("[U#0]") < s.indexOf("[U#2]")).toBe(true);
  });
});

/** 账本那一次回 ledgerJson；复判那一次回 judge（或抛错） */
function fakeLLM(ledgerJson: unknown, judge: unknown | Error): { llm: LLMClient; judgeCalls: () => number } {
  let j = 0;
  const reply = (content: string) => ({ content, finishReason: "stop", responseModel: "fake", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });
  const llm = {
    chatLongDetailed: async (system: string) => {
      if (system === ATTRIBUTION_SYSTEM_PROMPT) {
        j++;
        if (judge instanceof Error) throw judge;
        return reply(JSON.stringify(judge));
      }
      return reply(JSON.stringify(ledgerJson));
    },
  } as unknown as LLMClient;
  return { llm, judgeCalls: () => j };
}

const LEDGER = { oneLine: "x", solved: [], experience: [], unfinished: [], decisions: [
  { text: "定：加一行版本纪律", by: "助手" },
  { text: "定：周报继续用 caption-news", by: "用户", anchor: "recallnest 备份跑成功了吧" },
] };

describe("generateLedgerBody 接上复判", () => {
  it("复判纠正误降与假收；复判的 token 计进用量", async () => {
    const { llm, judgeCalls } = fakeLLM(LEDGER, { judgements: [
      { d: 1, verdict: "用户定", userSeq: 2, quote: "加吧" },
      { d: 2, verdict: "助手提议", userSeq: null, quote: "" },
    ] });
    const r = await generateLedgerBody(doc(), llm, { retries: 0 });
    expect(judgeCalls()).toBe(1);
    expect(r.body?.decisions).toEqual(["定：加一行版本纪律（用户原话：「加吧」）", "定：周报继续用 caption-news（用户原话没核到，按助手提议看）"]);
    expect(r.usage?.promptTokens).toBe(20);
  });
  it("关键词判法照旧会把 A17 那种无关引文收成用户原话（对照：复判要纠正的就是它）", async () => {
    const { llm } = fakeLLM(LEDGER, null);
    const r = await generateLedgerBody(doc(), llm, { retries: 0, attribution: false });
    expect(r.body?.decisions[1]).toBe("定：周报继续用 caption-news（用户原话：「recallnest 备份跑成功了吧」）");
  });
  it("复判抛错、返回空、漏项：保留关键词判法，账本照样写出", async () => {
    const keyword = ["定：加一行版本纪律（助手的取舍）", "定：周报继续用 caption-news（用户原话：「recallnest 备份跑成功了吧」）"];
    expect((await generateLedgerBody(doc(), fakeLLM(LEDGER, new Error("429 limit")).llm, { retries: 0 })).body?.decisions).toEqual(keyword);
    expect((await generateLedgerBody(doc(), fakeLLM(LEDGER, { judgements: [] }).llm, { retries: 0 })).body?.decisions).toEqual(keyword);
    const partial = await generateLedgerBody(doc(), fakeLLM(LEDGER, { judgements: [{ d: 1, verdict: "用户定", userSeq: 2, quote: "加吧" }] }).llm, { retries: 0 });
    expect(partial.body?.decisions).toEqual(["定：加一行版本纪律（用户原话：「加吧」）", keyword[1]]);
  });
  it("attribution:false 或没有决定：不多调一次", async () => {
    const off = fakeLLM(LEDGER, { judgements: [] });
    await generateLedgerBody(doc(), off.llm, { retries: 0, attribution: false });
    expect(off.judgeCalls()).toBe(0);
    const none = fakeLLM({ ...LEDGER, decisions: [] }, { judgements: [] });
    await generateLedgerBody(doc(), none.llm, { retries: 0 });
    expect(none.judgeCalls()).toBe(0);
  });
});
