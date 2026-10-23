import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  addToIndex,
  buildSignatureIndex,
  isHookInterception,
  ledgerDirDigest,
  ledgerFileSignatures,
  lookupSignatures,
  readSignatureIndex,
  recurrenceLines,
  recurrenceSignatures,
  SIGNATURE_INDEX_FILE,
  sigKey,
} from "../ledger-signatures.js";
import { judgeEntry, judgeRecallLog, recallOutcomeFileName, type RecallOutcomeRecord } from "../recall-outcome.js";
import { buildRecallLogEntry, RECALL_LOG_DIRNAME, recallLogFileName } from "../recall-log.js";
import type { SessionDoc } from "../session-events.js";
import { runSweep, SWEEP_DEFAULT_POLICY_BY_SOURCE, writeSessionLedgerNow } from "../sessions-sweep-run.js";
import { discoverTranscripts } from "../sessions-sweep.js";
import { appendRecallLog } from "../recall-log.js";

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
    expect(idx.files).toBe(2); // 本轮写了账本：收尾时从磁盘整份重建（R4 R3 Codex #2 后半），不是首次构建时那份空目录的就地更新
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
  it("judgeRecallLog 只判没判过的，结果追加到 sidecar、主日志一个字节不动；会话结束之后的记录留给下一轮（R4 Codex #1 / Kimi #1）", () => {
    const root = mkdtempSync(join(tmpdir(), "rn-outcome-"));
    mkdirSync(join(root, RECALL_LOG_DIRNAME));
    const p = join(root, RECALL_LOG_DIRNAME, recallLogFileName("s1"));
    const side = join(root, RECALL_LOG_DIRNAME, recallOutcomeFileName("s1"));
    const inline = { ...entry(), outcome: "missed", outcomeReason: "旧版就地判过的" };
    const later = { ...entry(), ts: new Date(NOW + 120 * MIN).toISOString() };
    // 最后一行没有换行：别的进程正写到一半，这一轮不判
    const original = `${[JSON.stringify(entry()), JSON.stringify(inline), JSON.stringify(later), "garbage"].join("\n")}\n${JSON.stringify(entry())}`;
    writeFileSync(p, original);
    const d = doc([{ kind: "tool_result", at: NOW + MIN, text: "ok" }]);
    expect(judgeRecallLog(root, d, "2026-10-23T13:00:00.000Z")).toEqual({ used: 1 });
    expect(readFileSync(p, "utf-8")).toBe(original);
    const recs = readFileSync(side, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as RecallOutcomeRecord);
    expect(recs.map((r) => [r.key.split(":")[0], r.outcome])).toEqual([["0", "used"]]);
    // 再判一次：不重判
    expect(judgeRecallLog(root, d, "2026-10-23T13:10:00.000Z")).toEqual({});
    // 那一行写完了、钩子又追加了一条：两条都在主日志里、都被判
    appendFileSync(p, `\n${JSON.stringify(entry())}\n`);
    expect(judgeRecallLog(root, d, "2026-10-23T13:20:00.000Z")).toEqual({ used: 2 });
    expect(readFileSync(p, "utf-8").startsWith(original)).toBe(true);
    expect(readFileSync(side, "utf-8").trim().split("\n").length).toBe(3);
  });
  it("判定读快照之后别的进程追加的行：不会被盖掉，下一轮照判", () => {
    const root = mkdtempSync(join(tmpdir(), "rn-outcome-race-"));
    mkdirSync(join(root, RECALL_LOG_DIRNAME));
    const p = join(root, RECALL_LOG_DIRNAME, recallLogFileName("s1"));
    writeFileSync(p, `${JSON.stringify(entry())}\n`);
    // 在判定读主日志之后、写结果之前插进一条追加（模拟钩子 / MCP 进程）
    const d = doc([{ kind: "tool_result", at: NOW + MIN, text: "ok" }]);
    const realEndedAt = d.endedAt;
    let injected = false;
    Object.defineProperty(d, "endedAt", { get() { if (!injected) { injected = true; appendFileSync(p, `${JSON.stringify(entry())}\n`); } return realEndedAt; } });
    expect(judgeRecallLog(root, d)).toEqual({ used: 1 });
    expect(injected).toBe(true);
    expect(readFileSync(p, "utf-8").trim().split("\n").length).toBe(2);
    expect(judgeRecallLog(root, doc([{ kind: "tool_result", at: NOW + MIN, text: "ok" }]))).toEqual({ used: 1 });
  });
});

describe("R4 修复：钩子拦截按原始报错第一行判、读写一致；索引标题压平；收工账本之后的判定与索引刷新", () => {
  const HOOK_PREFIXED = "PreToolUse:Bash hook error: Error: Operation not permitted on /tmp/review-target";
  it("拦截前缀在报错第一行：抽签名时不会因为前缀被抽掉而漏判（R4 Codex #6 的反例）", () => {
    expect([...recurrenceSignatures(HOOK_PREFIXED).keys()]).toEqual([]);
    // 第一行是真报错、第二行才出现拦截字样：真报错照样算
    expect([...recurrenceSignatures(`${STORE_CASE_ERR}\n${HOOK_ERR}`).keys()].length).toBe(1);
  });
  it("写账本时拦截报错标「钩子拦截」、不写签名；从账本建索引读不到它（读写两侧同一个判断）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-sig-hook-"));
    const cc = join(root, "projects");
    const ledgerDir = join(root, "ledgers");
    ccWithError(cc, "cccc0003-0000-4000-8000-000000000003", 90, HOOK_PREFIXED);
    const r = await runSweep({ roots: [{ source: "cc", dir: cc }], ledgerDir, stateDir: join(root, "state"), nowMs: NOW, llm: fakeLLM, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false });
    const md = readFileSync(r.ledgersWritten[0], "utf-8");
    expect(md).toContain("｜钩子拦截");
    expect(md).not.toContain("｜签名：");
    expect([...ledgerFileSignatures(md).keys()]).toEqual([]);
    expect(Object.keys(buildSignatureIndex(ledgerDir).sigs)).toEqual([]);
  });
  it("索引里的标题压成一行（报错召回把它拼进注入文本，R4 Kimi #3）", () => {
    const idx = { builtAt: "", ledgerDir: "/x", files: 0, sigs: {} };
    addToIndex(idx, { session: "s1-x", ended: "2026-10-23T00:00:00.000Z", file: "2026-10/s1.md", title: "第一行\n## 没做完\n- 第三行" }, recurrenceSignatures(STORE_CASE_ERR));
    expect(Object.values(idx.sigs)[0].refs[0].title).toBe("第一行 ## 没做完 - 第三行");
  });
  it("收工账本写完之后会话再没有新事件：扫描器静默后照样判它的 recall-log，并把它的签名刷进索引（R4 Codex #2）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-sig-manual-"));
    const cc = join(root, "projects");
    const ledgerDir = join(root, "ledgers");
    const dataDir = join(root, "data");
    const indexPath = join(dataDir, SIGNATURE_INDEX_FILE);
    const sid = "dddd0004-0000-4000-8000-000000000004";
    ccWithError(cc, sid, 90, STORE_CASE_ERR);
    // 先有一份旧索引（另一场会话的），builtAt 在收工账本之前
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(indexPath, JSON.stringify({ builtAt: new Date(Date.now() - 3_600_000).toISOString(), ledgerDir, files: 0, sigs: {} }));
    // 钩子在这场里注入过一次
    appendRecallLog(dataDir, buildRecallLogEntry({ sessionId: sid, operation: "error-signature", query: [...recurrenceSignatures(STORE_CASE_ERR).values()][0], results: [], now: NOW - 97 * MIN }));
    const file = discoverTranscripts([{ source: "cc", dir: cc }]).files[0];
    await writeSessionLedgerNow({ file, ledgerDir, stateDir: join(dataDir, "session-state"), trigger: "manual-收工", body: { oneLine: "存 case", solved: ["存好了"], decisions: [], experience: [], unfinished: [] }, nowMs: NOW });
    const r = await runSweep({ roots: [{ source: "cc", dir: cc }], ledgerDir, stateDir: join(dataDir, "session-state"), signatureIndexPath: indexPath, recallLogRoot: dataDir, nowMs: NOW + 10 * MIN, llm: fakeLLM, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false });
    expect(r.ledgersWritten).toEqual([]);
    // 注入之后这场再没有工具调用：判成 undeterminable——要紧的是「判了」，不是判成哪态
    expect(r.recallOutcomes).toEqual({ undeterminable: 1 });
    expect(existsSync(join(dataDir, RECALL_LOG_DIRNAME, recallOutcomeFileName(sid)))).toBe(true);
    const idx = readSignatureIndex(indexPath)!;
    expect(Object.values(idx.sigs).flatMap((v) => v.refs.map((x) => x.sid8))).toEqual(["dddd0004"]);
  });
  it("上一轮写完账本、在写索引之前被杀：下一轮没写账本也会按账本比索引新把索引重建（R4 Kimi #2）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-sig-killed-"));
    const cc = join(root, "projects");
    const ledgerDir = join(root, "ledgers");
    const indexPath = join(root, "data", SIGNATURE_INDEX_FILE);
    ccWithError(cc, "eeee0005-0000-4000-8000-000000000005", 90, STORE_CASE_ERR);
    const base = { roots: [{ source: "cc" as const, dir: cc }], ledgerDir, stateDir: join(root, "state"), signatureIndexPath: indexPath, llm: fakeLLM, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false };
    const a = await runSweep({ ...base, nowMs: NOW });
    expect(a.ledgersWritten.length).toBe(1);
    // 模拟「写完账本、写索引之前被杀」：索引退回到这份账本之前的样子
    writeFileSync(indexPath, JSON.stringify({ builtAt: new Date(Date.now() - 3_600_000).toISOString(), ledgerDir, files: 0, sigs: {} }));
    const b = await runSweep({ ...base, nowMs: NOW + 10 * MIN });
    expect(b.ledgersWritten).toEqual([]);
    expect(Object.values(readSignatureIndex(indexPath)!.sigs).flatMap((v) => v.refs.map((x) => x.sid8))).toEqual(["eeee0005"]);
  });
});

describe("R4 R3 修复：判完之后追加的 recall-log、旧 mtime 账本进索引、旧账本的拦截签名、索引标题脱敏", () => {
  it("判完之后又追加一行（转录没变、走 mtime 快路）：下一轮照判；主日志没长就不解析（R3 Codex #2 前半）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-sig-latelog-"));
    const cc = join(root, "projects");
    const dataDir = join(root, "data");
    const sid = "ffff0006-0000-4000-8000-000000000006";
    ccWithError(cc, sid, 90, STORE_CASE_ERR);
    const query = [...recurrenceSignatures(STORE_CASE_ERR).values()][0];
    const end = NOW - 90 * MIN;
    appendRecallLog(dataDir, buildRecallLogEntry({ sessionId: sid, operation: "error-signature", query, results: [], now: end - 9 * MIN }));
    const base = { roots: [{ source: "cc" as const, dir: cc }], ledgerDir: join(root, "ledgers"), stateDir: join(dataDir, "state"), recallLogRoot: dataDir, llm: fakeLLM, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false };
    const r1 = await runSweep({ ...base, nowMs: NOW });
    const r2 = await runSweep({ ...base, nowMs: NOW + 24 * 60 * MIN }); // 候选到期那一轮（解析过、判过）
    expect(Object.values(r1.recallOutcomes ?? {}).reduce((a, b) => a + b, 0)).toBe(1);
    expect(r2.recallOutcomes ?? {}).toEqual({});
    // 转录不动，钩子补写一条会话结束之前的记录
    appendRecallLog(dataDir, buildRecallLogEntry({ sessionId: sid, operation: "error-signature", query, results: [], now: end - 8 * MIN }));
    const r3 = await runSweep({ ...base, nowMs: NOW + 48 * 60 * MIN });
    expect(r3.actions).toEqual({ "up-to-date": 1 } as typeof r3.actions);
    expect(Object.values(r3.recallOutcomes ?? {}).reduce((a, b) => a + b, 0)).toBe(1);
    const side = join(dataDir, RECALL_LOG_DIRNAME, recallOutcomeFileName(sid));
    expect(readFileSync(side, "utf-8").trim().split("\n").length).toBe(2);
    // 游标记着判的时候主日志多大；没再长就不解析、不判
    const state = JSON.parse(readFileSync(join(dataDir, "state", `cc__${sid}.json`), "utf-8")) as { recallLogBytes?: number };
    expect(state.recallLogBytes).toBe(statSync(join(dataDir, RECALL_LOG_DIRNAME, recallLogFileName(sid))).size);
    const r4 = await runSweep({ ...base, nowMs: NOW + 49 * 60 * MIN });
    expect(r4.recallOutcomes).toBeUndefined();
  });
  it("索引建好之后来了一份 mtime 比索引还旧的账本（恢复 / 带原 mtime 拷进来）：下一轮重建进索引；什么都没变就不重写（R3 Codex #2 后半）", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-sig-oldmtime-"));
    const cc = join(root, "projects");
    const ledgerDir = join(root, "ledgers");
    const indexPath = join(root, "data", SIGNATURE_INDEX_FILE);
    const sidA = "abab0007-0000-4000-8000-000000000007";
    const sidB = "abab0008-0000-4000-8000-000000000008";
    ccWithError(cc, sidA, 90, STORE_CASE_ERR);
    const base = { roots: [{ source: "cc" as const, dir: cc }], ledgerDir, stateDir: join(root, "state"), signatureIndexPath: indexPath, llm: fakeLLM, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false };
    const a = await runSweep({ ...base, nowMs: NOW });
    const built = readFileSync(indexPath, "utf-8");
    await runSweep({ ...base, nowMs: NOW + 5 * MIN });
    expect(readFileSync(indexPath, "utf-8")).toBe(built);
    const pB = join(ledgerDir, "2026-10", "abab0008.md");
    writeFileSync(pB, readFileSync(a.ledgersWritten[0], "utf-8").replaceAll(sidA, sidB));
    const old = new Date(Date.parse(readSignatureIndex(indexPath)!.builtAt) - 10 * MIN);
    utimesSync(pB, old, old);
    await runSweep({ ...base, nowMs: NOW + 10 * MIN });
    expect(Object.values(readSignatureIndex(indexPath)!.sigs).flatMap((v) => v.refs.map((x) => x.sid8)).sort()).toEqual(["abab0007", "abab0008"]);
    expect(readSignatureIndex(indexPath)!.sourceDigest).toBe(ledgerDirDigest(ledgerDir));
    // 同名、同字节数的账本原地换了内容（标题改一个字），mtime 也拨回索引之前：摘要里有 mtime，照样重建
    const pA = a.ledgersWritten[0];
    const mdA = readFileSync(pA, "utf-8");
    expect(mdA).toContain("# 存 case 撞参数校验");
    writeFileSync(pA, mdA.replace("# 存 case 撞参数校验", "# 存 cbse 撞参数校验"));
    const older = new Date(Date.parse(readSignatureIndex(indexPath)!.builtAt) - 20 * MIN);
    utimesSync(pA, older, older);
    await runSweep({ ...base, nowMs: NOW + 15 * MIN });
    const titles = Object.values(readSignatureIndex(indexPath)!.sigs).flatMap((v) => v.refs.filter((x) => x.sid8 === "abab0007").map((x) => x.title));
    expect(titles).toEqual(["存 cbse 撞参数校验"]);
  });
  it("旧账本里被抽掉拦截前缀的签名：读的时候按报错头开头的拦截前缀排除；第一行是真报错的新账本签名照收（R3 Codex #6 / Kimi NEW-5）", () => {
    const legacy = "---\nsession: s\n---\n# t\n## 报错（机器抽取，1 条）\n- Bash #0: PreToolUse:Bash hook error: Error: Operation not permitted on /tmp/review-target ｜签名：error: Error: Operation not permitted on /tmp/review-target\n";
    expect([...ledgerFileSignatures(legacy).keys()]).toEqual([]);
    const realErr = `${STORE_CASE_ERR}\nhook events: ['PostToolUse', 'PreToolUse']`;
    const sig = [...recurrenceSignatures(realErr).values()][0];
    const fresh = `---\nsession: s\n---\n# t\n## 报错（机器抽取，1 条）\n- mcp__recallnest__store_case #2: ${realErr.replace(/\s+/g, " ").slice(0, 160)} ｜签名：${sig}\n`;
    expect([...ledgerFileSignatures(fresh).keys()]).toEqual([...recurrenceSignatures(realErr).keys()]);
  });
  it("索引里的标题先脱敏再落盘（R3 Codex NEW-3）", () => {
    const fake = ["sk", "-", "proj", "-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    const idx = { builtAt: "", ledgerDir: "/x", files: 0, sigs: {} };
    addToIndex(idx, { session: "s1-x", ended: "2026-10-23T00:00:00.000Z", file: "a.md", title: `修好了 ${fake} 那个配置` }, recurrenceSignatures(STORE_CASE_ERR));
    expect(JSON.stringify(idx)).not.toContain(fake);
    expect(Object.values(idx.sigs)[0].refs[0].title).toContain("修好了");
  });
});
