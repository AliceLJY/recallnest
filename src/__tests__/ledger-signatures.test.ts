import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildSignatureIndex,
  isHookInterception,
  ledgerFileSignatures,
  lookupSignatures,
  readSignatureIndex,
  recurrenceLines,
  recurrenceSignatures,
  SIGNATURE_INDEX_FILE,
  sigKey,
} from "../ledger-signatures.js";
import { judgeEntry, judgeRecallLog } from "../recall-outcome.js";
import { buildRecallLogEntry, RECALL_LOG_DIRNAME, recallLogFileName } from "../recall-log.js";
import type { SessionDoc } from "../session-events.js";
import { runSweep, SWEEP_DEFAULT_POLICY_BY_SOURCE } from "../sessions-sweep-run.js";

/**
 * P1 ⑥：账本签名索引 → 「疑似又踩」节、报错召回（hook 脚本）、recall-log 四态。
 * 查账本签名不查 case 签名：P0 数⑤ 525 种具体性签名对上既有 case 0 种（case 的 problem 是中文转述）。
 */

const MIN = 60_000;
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const STORE_CASE_ERR = "<tool_use_error>Error: Invalid arguments for tool store_case: Required at solutionSteps</tool_use_error>";
const HOOK_ERR = "PreToolUse:Bash hook error: [bash ~/.claude/hooks/bash-guard.sh]: [RM-GUARD] blocked";

function ccWithError(dir: string, sid: string, lastMsgAgoMin: number, errorText: string): string {
  mkdirSync(join(dir, "-Users-x"), { recursive: true });
  const p = join(dir, "-Users-x", `${sid}.jsonl`);
  const end = NOW - lastMsgAgoMin * MIN;
  const at = (k: number) => new Date(end - (10 - k) * MIN).toISOString();
  const lines = [
    { type: "user", sessionId: sid, timestamp: at(0), message: { role: "user", content: "帮我记一条 case" } },
    { type: "assistant", sessionId: sid, timestamp: at(1), message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__recallnest__store_case", input: { title: "x" } }] } },
    { type: "user", sessionId: sid, timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: errorText }] } },
    { type: "user", sessionId: sid, timestamp: at(3), message: { role: "user", content: "再试一次" } },
    { type: "assistant", sessionId: sid, timestamp: at(4), message: { role: "assistant", content: [{ type: "text", text: "补上 solutionSteps 再存" }] } },
    { type: "user", sessionId: sid, timestamp: at(5), message: { role: "user", content: "好" } },
    { type: "assistant", sessionId: sid, timestamp: new Date(end).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "存好了" }] } },
  ];
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  utimesSync(p, new Date(end), new Date(end));
  return p;
}

const fakeLLM = {
  chatLongDetailed: async () => ({ content: JSON.stringify({ oneLine: "存 case 撞参数校验", solved: ["补上 solutionSteps 存好"], decisions: [], experience: [], unfinished: [] }), finishReason: "stop", responseModel: "fake", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
} as unknown as import("../llm-client.js").LLMClient;

describe("签名过滤", () => {
  it("hook 拦截与 generic 档不算又踩；具体性签名算", () => {
    expect(isHookInterception(HOOK_ERR)).toBe(true);
    expect([...recurrenceSignatures(HOOK_ERR).keys()]).toEqual([]);
    expect([...recurrenceSignatures("Exit code 1").keys()]).toEqual([]);
    // 抽得出签名、但都是 generic 档（裸退出码 / 裸 no such file）：不算
    expect([...recurrenceSignatures("Error: Command failed with exit code 1").keys()]).toEqual([]);
    expect([...recurrenceSignatures("cat: foo: No such file or directory").keys()]).toEqual([]);
    expect([...recurrenceSignatures(STORE_CASE_ERR).values()]).toEqual(["Error: Invalid arguments for tool store_case: Required at solutionSteps</tool_use_error>"]);
  });
  it("账本里存的是脱敏截断后的原形，键与从原始报错算出来的一致", () => {
    const fromRaw = [...recurrenceSignatures(STORE_CASE_ERR).keys()][0];
    const md = `---\nsession: s1\n---\n\n# t\n\n## 报错（机器抽取，1 条）\n- tool #2: x ｜签名：${[...recurrenceSignatures(STORE_CASE_ERR).values()][0]} ‖ ${HOOK_ERR}\n\n## 当场写过的记忆（机器抽取）\n- （无）\n`;
    expect([...ledgerFileSignatures(md).keys()]).toEqual([fromRaw]);
    expect(sigKey("  Foo   BAR ")).toBe("foo bar");
  });
});

describe("扫描器：疑似又踩节 + 签名索引", () => {
  it("第二场撞上第一场的同一签名：账本出「疑似又踩」，第几次、之前哪场；索引文件写出", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-sig-"));
    const cc = join(root, "projects");
    const ledgerDir = join(root, "ledgers");
    const indexPath = join(root, "data", SIGNATURE_INDEX_FILE);
    ccWithError(cc, "aaaa0001-0000-4000-8000-000000000001", 300, STORE_CASE_ERR);
    ccWithError(cc, "bbbb0002-0000-4000-8000-000000000002", 90, `${STORE_CASE_ERR}\n${HOOK_ERR}`);
    const r = await runSweep({ roots: [{ source: "cc", dir: cc }], ledgerDir, stateDir: join(root, "state"), signatureIndexPath: indexPath, nowMs: NOW, llm: fakeLLM, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false });
    expect(r.ledgersWritten.length).toBe(2);
    const second = readFileSync(join(ledgerDir, "2026-10", "bbbb0002.md"), "utf-8");
    expect(second).toContain("## 疑似又踩（机器抽取，1 条，待确认）");
    expect(second).toContain("：第 2 次（之前：2026-10-23 aaaa0001「存 case 撞参数校验」）");
    expect(second).not.toContain("RM-GUARD] blocked：第");
    const first = readFileSync(join(ledgerDir, "2026-10", "aaaa0001.md"), "utf-8");
    expect(first).not.toContain("疑似又踩");
    const idx = readSignatureIndex(indexPath)!;
    expect(idx.files).toBe(0); // 首次构建时目录还空，之后全靠就地更新
    expect(Object.values(idx.sigs)[0].refs.map((x) => x.sid8).sort()).toEqual(["aaaa0001", "bbbb0002"]);
    // 从文件重建也得到同样的索引
    const rebuilt = buildSignatureIndex(ledgerDir);
    expect(rebuilt.files).toBe(2);
    expect(Object.keys(rebuilt.sigs)).toEqual(Object.keys(idx.sigs));
  });
  it("lookup 只算结束早于本场的、不算自己；recurrenceLines 超过 3 场写总数", () => {
    const sigs = recurrenceSignatures(STORE_CASE_ERR);
    const k = [...sigs.keys()][0];
    const refs = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-30"].map((d, i) => ({ session: `s${i}`, sid8: `s${i}`, date: d, ended: `${d}T00:00:00.000Z`, file: `2026-10/s${i}.md`, title: `t${i}` }));
    const idx = { builtAt: "", ledgerDir: "/x", files: 5, sigs: { [k]: { display: "D", refs } } };
    const hits = lookupSignatures(idx, sigs, { excludeSession: "s3", beforeIso: "2026-10-20T00:00:00.000Z" });
    expect(hits[0].refs.map((r) => r.session)).toEqual(["s0", "s1", "s2"]);
    expect(recurrenceLines([{ display: "D", refs: refs.slice(0, 4) }])[0]).toBe("D：第 5 次（之前：2026-10-02 s1「t1」、2026-10-03 s2「t2」、2026-10-04 s3「t3」 等 4 场）");
  });
});

describe("报错召回脚本（PostToolUseFailure）", () => {
  const repo = join(import.meta.dir, "..", "..");
  const runHook = (dataDir: string, input: unknown) => spawnSync("bun", ["run", join(repo, "scripts", "error-recall.ts"), "--data-dir", dataDir], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf-8" });
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "rn-recall-hook-"));
    const ledgerDir = join(root, "ledgers");
    mkdirSync(join(ledgerDir, "2026-10"), { recursive: true });
    const sig = [...recurrenceSignatures(STORE_CASE_ERR).values()][0];
    writeFileSync(join(ledgerDir, "2026-10", "aaaa0001.md"), `---\nsession: aaaa0001-0000-4000-8000-000000000001\nsource: cc\nended: "2026-10-20T10:00:00.000Z"\n---\n\n# 存 case 撞参数校验\n\n## 解决了什么\n- 补上 solutionSteps 存好\n\n## 报错（机器抽取，1 条）\n- tool #2: x ｜签名：${sig}\n`);
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, SIGNATURE_INDEX_FILE), JSON.stringify(buildSignatureIndex(ledgerDir)));
    return { root, dataDir };
  }
  it("精确命中：输出 additionalContext（带之前哪场、那次解决了什么），并记 recall-log", () => {
    const { dataDir } = setup();
    const r = runHook(dataDir, { session_id: "cur-session-1", hook_event_name: "PostToolUseFailure", tool_name: "mcp__recallnest__store_case", error: STORE_CASE_ERR, is_interrupt: false });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
    expect(out.hookSpecificOutput.additionalContext).toContain("2026-10-20 aaaa0001「存 case 撞参数校验」");
    expect(out.hookSpecificOutput.additionalContext).toContain("那次解决了：补上 solutionSteps 存好");
    const log = readFileSync(join(dataDir, RECALL_LOG_DIRNAME, recallLogFileName("cur-session-1")), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log[0]).toMatchObject({ operation: "error-signature", outcome: null });
  });
  it("没命中 / hook 拦截 / 中断 / 坏输入 / 没索引：什么都不输出、退出 0", () => {
    const { dataDir, root } = setup();
    for (const input of [
      { session_id: "c", error: "ModuleNotFoundError: No module named 'docx'" },
      { session_id: "c", error: HOOK_ERR },
      { session_id: "c", error: STORE_CASE_ERR, is_interrupt: true },
      "not json",
    ]) {
      const r = runHook(dataDir, input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    const r = runHook(join(root, "empty-data"), { session_id: "c", error: STORE_CASE_ERR });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(dataDir, RECALL_LOG_DIRNAME, recallLogFileName("c")))).toBe(false);
  });
  it("同一场会话自己的账本不算「以前」", () => {
    const { dataDir } = setup();
    const r = runHook(dataDir, { session_id: "aaaa0001-0000-4000-8000-000000000001", error: STORE_CASE_ERR });
    expect(r.stdout).toBe("");
  });
});

describe("recall-log 四态", () => {
  function doc(events: Array<{ kind: "tool_result" | "user"; at: number; isError?: boolean; text: string }>): SessionDoc {
    return { source: "cc", sessionId: "s1", filePath: "/x", malformedLines: 0, startedAt: null, endedAt: new Date(NOW + 60 * MIN).toISOString(), lastUserAt: null, events: events.map((e, i) => ({ seq: i, kind: e.kind, ts: new Date(e.at).toISOString(), tsMs: e.at, text: e.text, isError: e.isError })) } as SessionDoc;
  }
  const entry = (op = "error-signature") => buildRecallLogEntry({ sessionId: "s1", operation: op, query: [...recurrenceSignatures(STORE_CASE_ERR).values()][0], results: [], now: NOW });
  it("同签名又报 = missed；没再报且之后有成功调用 = used；之后没调用 = undeterminable；第一条消息路径 = undeterminable", () => {
    expect(judgeEntry(entry(), doc([{ kind: "tool_result", at: NOW + MIN, isError: true, text: STORE_CASE_ERR }])).outcome).toBe("missed");
    expect(judgeEntry(entry(), doc([{ kind: "tool_result", at: NOW - MIN, isError: true, text: STORE_CASE_ERR }, { kind: "tool_result", at: NOW + MIN, text: "ok" }])).outcome).toBe("used");
    expect(judgeEntry(entry(), doc([])).outcome).toBe("undeterminable");
    expect(judgeEntry(entry("api:/v1/auto-recall"), doc([{ kind: "tool_result", at: NOW + MIN, text: "ok" }])).outcome).toBe("undeterminable");
  });
  it("judgeRecallLog 只判没判过的、写回文件；会话结束之后的记录留给下一轮", () => {
    const root = mkdtempSync(join(tmpdir(), "rn-outcome-"));
    mkdirSync(join(root, RECALL_LOG_DIRNAME));
    const p = join(root, RECALL_LOG_DIRNAME, recallLogFileName("s1"));
    const judged = { ...entry(), outcome: "missed", outcomeReason: "earlier" };
    const later = { ...entry(), ts: new Date(NOW + 120 * MIN).toISOString() };
    writeFileSync(p, [JSON.stringify(entry()), JSON.stringify(judged), JSON.stringify(later), "garbage"].join("\n"));
    const counts = judgeRecallLog(root, doc([{ kind: "tool_result", at: NOW + MIN, text: "ok" }]), "2026-10-23T13:00:00.000Z");
    expect(counts).toEqual({ used: 1 });
    const lines = readFileSync(p, "utf-8").split("\n");
    expect(JSON.parse(lines[0]).outcome).toBe("used");
    expect(JSON.parse(lines[1]).outcomeReason).toBe("earlier");
    expect(JSON.parse(lines[2]).outcome).toBeNull();
    expect(lines[3]).toBe("garbage");
  });
});
