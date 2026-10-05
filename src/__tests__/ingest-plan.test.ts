/**
 * 对话原文默认不再入库（2026-10-06）。承重的是四件事：
 * - 开关关着（默认）时，六个对话来源一个都不切片入库，不管是 `--source all` 还是点名某一个；
 * - 记忆文件不跟着停；
 * - Minis 投递目录照样要挪进存档，而且不能再等「台账里记着已入库」——否则文件永远挪不走、Deja 永远读不到；
 * - cli.ts 里每一处对话入库的调用都得先过这份计划，不能留一处绕开。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CONVERSATION_SOURCES, isConversationSource, planIngest } from "../ingest-plan.js";

const TRANSCRIPTS = ["cc", "codex", "kimi", "gemini", "desktop"];

describe("planIngest — 开关关着（默认）", () => {
  it("--source all：对话来源一个都不入库，记忆文件照常，Minis 只挪存档，待处理队列不回填", () => {
    const plan = planIngest("all", false);
    expect(plan.transcriptSources).toEqual([]);
    expect(plan.memory).toBe(true);
    expect(plan.minis).toBe("archive-only");
    expect(plan.drainPendingQueue).toBe(false);
    expect(plan.skippedTranscriptSources).toEqual([...CONVERSATION_SOURCES]);
  });

  it.each(TRANSCRIPTS)("点名 --source %s：不入库，并且记进「没有执行」的清单", (name) => {
    const plan = planIngest(name, false);
    expect(plan.transcriptSources).toEqual([]);
    expect(plan.minis).toBe("skip");
    expect(plan.memory).toBe(false);
    expect(plan.skippedTranscriptSources).toEqual([name]);
  });

  it("点名 --source minis：只挪存档", () => {
    const plan = planIngest("minis", false);
    expect(plan.transcriptSources).toEqual([]);
    expect(plan.minis).toBe("archive-only");
    expect(plan.skippedTranscriptSources).toEqual(["minis"]);
  });

  it("点名 --source memory：照常跑，没有被跳过的对话来源", () => {
    const plan = planIngest("memory", false);
    expect(plan.memory).toBe(true);
    expect(plan.minis).toBe("skip");
    expect(plan.transcriptSources).toEqual([]);
    expect(plan.skippedTranscriptSources).toEqual([]);
  });
});

describe("planIngest — 开关打开（回到改动之前）", () => {
  it("--source all：五个对话来源都入库，Minis 入库后按台账挪存档，队列回填，记忆文件照常", () => {
    const plan = planIngest("all", true);
    expect(plan.transcriptSources).toEqual(TRANSCRIPTS);
    expect(plan.minis).toBe("ingest-then-archive");
    expect(plan.memory).toBe(true);
    expect(plan.drainPendingQueue).toBe(true);
    expect(plan.skippedTranscriptSources).toEqual([]);
  });

  it.each(TRANSCRIPTS)("点名 --source %s：只入这一个", (name) => {
    const plan = planIngest(name, true);
    expect(plan.transcriptSources).toEqual([name]);
    expect(plan.minis).toBe("skip");
    expect(plan.memory).toBe(false);
  });

  it("点名 --source minis：入库后挪存档", () => {
    expect(planIngest("minis", true).minis).toBe("ingest-then-archive");
  });
});

describe("对话来源清单", () => {
  it("与 memory-boundaries 认的对话来源对得上：多一个少一个，开关就管不全", async () => {
    const { isTranscriptIngestSource } = await import("../memory-boundaries.js");
    // desktop 走 ingestCCTranscripts 的默认前缀，入库后的 source 是 cc；其余五个名字本身就是入库后的 source
    for (const name of CONVERSATION_SOURCES) {
      expect(isTranscriptIngestSource(name === "desktop" ? "cc" : name)).toBe(true);
    }
    expect(isConversationSource("memory")).toBe(false);
    expect(isConversationSource("all")).toBe(false);
  });
});

/**
 * 找出 body 里下标 idx 处的代码被哪些花括号块包着，返回每个块开头那一行（由内到外）。
 * 只数花括号，不解析语法：模板字符串里的 `${…}` 是成对的，不影响计数。
 */
function enclosingBlockHeaders(body: string, idx: number): string[] {
  const headers: string[] = [];
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const ch = body[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth > 0) { depth--; continue; }
      const lineStart = body.lastIndexOf("\n", i) + 1;
      headers.push(body.slice(lineStart, i + 1).trim());
    }
  }
  return headers;
}

const TRANSCRIPT_GUARD = /^if \(plan\.transcriptSources\.includes\("(cc|codex|kimi|gemini|desktop)"\)\) \{$/;
const MINIS_INGEST_GUARD = /^if \(plan\.minis === "ingest-then-archive" && ingestOpts\) \{$/;
const INGEST_CALL = /await (ingestCCTranscripts|ingestCodexSessions|ingestKimiSessions|ingestGeminiSessions)\(/g;

/** body 里每一处对话入库调用，有没有被一个「看计划」的条件块包住；返回没被包住的调用 */
function unguardedIngestCalls(body: string): string[] {
  const bad: string[] = [];
  for (const call of body.matchAll(INGEST_CALL)) {
    const headers = enclosingBlockHeaders(body, call.index);
    if (!headers.some((h) => TRANSCRIPT_GUARD.test(h) || MINIS_INGEST_GUARD.test(h))) bad.push(`${call[1]}@${call.index}`);
  }
  return bad;
}

describe("cli.ts 的 ingest 命令不绕开计划", () => {
  const cli = readFileSync(join(resolve(import.meta.dir, "../.."), "src/cli.ts"), "utf-8");
  const start = cli.indexOf('.command("ingest")');
  const end = cli.indexOf('.command("reconcile-memory")');
  const body = cli.slice(start, end);

  it("取得到 ingest 命令这一段", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("不再按 source 字符串直接决定跑不跑某个来源", () => {
    // 改动之前每个来源都是 `source === "all" || source === "<名字>"`；留下任何一处，那个来源就不受开关管
    expect(body).not.toMatch(/source === "all" \|\|/);
  });

  it("六处对话入库调用，每一处都在一个看计划的条件块里面（按花括号的包含关系，不是看前面最近的一行）", () => {
    // cc、desktop、minis 各一处 ingestCCTranscripts，加 codex / kimi / gemini 各一处
    expect([...body.matchAll(INGEST_CALL)].length).toBe(6);
    expect(unguardedIngestCalls(body)).toEqual([]);
  });

  it("反向校准：把一处调用挪到条件块外面、或者只在前面留一个空的条件块，这个检查都会报出来", () => {
    const guard = 'if (plan.transcriptSources.includes("codex")) {';
    expect(body).toContain(guard);
    // 条件块变成空的，原来的块体变成无条件执行的裸块：调用前面最近的一行仍然是那个 if，但已经不在它里面
    const emptied = body.replace(guard, `${guard}}\n    {`);
    expect(unguardedIngestCalls(emptied).some((c) => c.startsWith("ingestCodexSessions"))).toBe(true);
    // 整个条件拿掉
    const removed = body.replace(guard, "{");
    expect(unguardedIngestCalls(removed).some((c) => c.startsWith("ingestCodexSessions"))).toBe(true);
  });

  it("待处理队列的回填跟着开关走", () => {
    expect(body).toMatch(/if \(effectiveLlm && plan\.drainPendingQueue\)/);
  });

  it("Minis 挪存档：入库开着拿台账当闸，关着时不等台账", () => {
    expect(body).toMatch(/plan\.minis === "ingest-then-archive" \? isProcessed : \(\) => true/);
  });

  it("关着时 Minis 只挪存档这一步排在嵌入接口预检之前（接口挂了也照样挪）；开着时的入库排在预检之后", () => {
    const archiveOnly = body.indexOf('if (plan.minis === "archive-only") await runMinis();');
    const preflight = body.indexOf("await embedder.test()");
    const ingestThenArchive = body.indexOf('if (plan.minis === "ingest-then-archive") await runMinis(ingestOpts);');
    expect(archiveOnly).toBeGreaterThan(0);
    expect(preflight).toBeGreaterThan(archiveOnly);
    expect(ingestThenArchive).toBeGreaterThan(preflight);
  });
});
