import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkSessionsSweep } from "../doctor.js";
import type { LLMClient } from "../llm-client.js";
import { commitLedger, LEDGER_COMMIT_LOCK_PREFIX, ledgerTargetPath, markHeartbeatRunning, nextLlmFailState, policyFor, readHeartbeat, runSweep, SWEEP_DEFAULT_POLICY_BY_SOURCE, SWEEP_STALE_MS, SWEEP_STUCK_MS, touchHeartbeatBusy, writeSessionLedgerNow } from "../sessions-sweep-run.js";
import { acquireLock, lockPathForKey, releaseLock } from "../distill-lock.js";
import type { SessionDoc } from "../session-events.js";
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { discoverTranscripts, SessionStateStore } from "../sessions-sweep.js";

/**
 * 会话扫描正式模式（P1 ④，2026-10-23）：账本写 ledgerDir、游标写 stateDir、心跳给 doctor；
 * 按端的静默阈值（CC 60 / 720，其余 30 / 360）；候选关着时只写事实账本、候选到期不再调 LLM。
 */

const MIN = 60_000;
const NOW = Date.parse("2026-10-23T12:00:00.000Z");

function writeCC(dir: string, sid: string, lastMsgAgoMin: number, users = 4): string {
  const p = join(dir, "-Users-x", `${sid}.jsonl`);
  mkdirSync(join(dir, "-Users-x"), { recursive: true });
  const lines: string[] = [];
  const end = NOW - lastMsgAgoMin * MIN;
  for (let i = 0; i < users; i++) {
    const t = (k: number) => new Date(end - (users - i) * 2 * MIN + k * 1000).toISOString();
    lines.push(JSON.stringify({ type: "user", sessionId: sid, timestamp: t(0), message: { role: "user", content: `第 ${i} 个问题：把日志挪到 ops-logs` } }));
    lines.push(JSON.stringify({ type: "assistant", sessionId: sid, timestamp: i === users - 1 ? new Date(end).toISOString() : t(30), message: { role: "assistant", content: [{ type: "text", text: `第 ${i} 步做完了` }] } }));
  }
  writeFileSync(p, `${lines.join("\n")}\n`);
  // mtime 也停在最后一条消息那一刻（粗筛不挡）
  utimesSync(p, new Date(end), new Date(end));
  return p;
}

function fakeLLM(): { llm: LLMClient; calls: () => number } {
  let n = 0;
  const llm = {
    chatLongDetailed: async () => {
      n++;
      return {
        content: JSON.stringify({ oneLine: "挪日志目录", solved: ["日志改到 ops-logs"], decisions: ["定：日志一律放 ops-logs（用户拍板）"], experience: [{ text: "自建日志放 ops-logs", anchor: "把日志挪到 ops-logs", anchorSeq: 0, kind: "偏好" }], unfinished: [] }),
        finishReason: "stop",
        responseModel: "fake",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  } as unknown as LLMClient;
  return { llm, calls: () => n };
}

function env() {
  const root = mkdtempSync(join(tmpdir(), "rn-sweep-run-"));
  const cc = join(root, "projects");
  mkdirSync(cc);
  return { root, cc, ledgerDir: join(root, "memory", "ledgers"), stateDir: join(root, "data", "session-state"), logPath: join(root, "data", "logs", "sessions-sweep.jsonl"), heartbeatPath: join(root, "data", "sessions-sweep-heartbeat.json") };
}

describe("runSweep 正式模式", () => {
  it("账本写 ledgerDir/YYYY-MM/<sid8>.md，游标、日志、心跳各在各的位置，不留临时文件", async () => {
    const e = env();
    writeCC(e.cc, "aaaa1111-0000-4000-8000-000000000001", 120);
    const { llm } = fakeLLM();
    const r = await runSweep({ roots: [{ source: "cc", dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, logPath: e.logPath, heartbeatPath: e.heartbeatPath, nowMs: NOW, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false });
    expect(r.ledgersWritten).toEqual([join(e.ledgerDir, "2026-10", "aaaa1111.md")]);
    const md = readFileSync(r.ledgersWritten[0], "utf-8");
    expect(md).toContain("## 决定与否决\n- 定：日志一律放 ops-logs（用户拍板）");
    expect(readdirSync(join(e.ledgerDir, "2026-10"))).toEqual(["aaaa1111.md"]);
    expect(readdirSync(e.stateDir).length).toBe(1);
    const log = readFileSync(e.logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log[0].ledger).toBe("ledgers/2026-10/aaaa1111.md");
    const hb = JSON.parse(readFileSync(e.heartbeatPath, "utf-8")) as Record<string, unknown>;
    expect(hb.ledgersWritten).toBe(1);
    expect(hb.llmCalls).toBe(1);
    expect(existsSync(join(e.root, "data", "ledgers"))).toBe(false);
  });

  it("没给 shadowDir 也没给 ledgerDir + stateDir：报错", async () => {
    await expect(runSweep({ roots: [], llm: null })).rejects.toThrow("shadowDir");
  });

  it("按端阈值：CC 静默 45 分钟按 60 分钟档还没结束，按全局 30 分钟就算结束", async () => {
    const e = env();
    writeCC(e.cc, "bbbb2222-0000-4000-8000-000000000002", 45);
    const strict = await runSweep({ roots: [{ source: "cc", dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, nowMs: NOW, llm: null, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, dryRun: true });
    expect(strict.actions["not-idle"]).toBe(1);
    const loose = await runSweep({ roots: [{ source: "cc", dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, nowMs: NOW, llm: null, dryRun: true });
    expect(loose.actions.ledger).toBe(1);
    expect(policyFor("cc", { policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE })).toMatchObject({ idleMinutes: 60, candidateAfterMinutes: 720 });
    expect(policyFor("codex", { policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE })).toMatchObject({ idleMinutes: 30, candidateAfterMinutes: 360 });
  });

  it("候选关着：经验节不出；候选到期只记已处理，不再调 LLM、不重写账本", async () => {
    const e = env();
    const sid = "cccc3333-0000-4000-8000-000000000003";
    writeCC(e.cc, sid, 90);
    const { llm, calls } = fakeLLM();
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false };
    const first = await runSweep({ ...base, nowMs: NOW });
    expect(first.actions.ledger).toBe(1);
    expect(readFileSync(first.ledgersWritten[0], "utf-8")).toContain("## 经验（待确认）\n- （无）");
    const later = await runSweep({ ...base, nowMs: NOW + 13 * 60 * MIN });
    expect(later.actions.candidates).toBe(1);
    expect(later.ledgersWritten).toEqual([]);
    expect(calls()).toBe(1);
    const st = new SessionStateStore(e.stateDir);
    const [key] = readdirSync(e.stateDir).map((f) => f.replace(/\.json$/, ""));
    expect(st.load(key)?.candidateDone).toBe(true);
  });

  it("候选开着（影子 / 回放的默认）：到期时重写账本并出经验节", async () => {
    const e = env();
    writeCC(e.cc, "dddd4444-0000-4000-8000-000000000004", 90);
    const { llm, calls } = fakeLLM();
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE };
    await runSweep({ ...base, nowMs: NOW });
    const later = await runSweep({ ...base, nowMs: NOW + 13 * 60 * MIN });
    expect(later.actions.candidates).toBe(1);
    expect(calls()).toBe(2);
    expect(readFileSync(later.ledgersWritten[0], "utf-8")).toContain("自建日志放 ops-logs（偏好）");
  });
});

describe("收工当场写账本（P1 ⑤）", () => {
  const agentBody = { oneLine: "挪日志目录（当场写）", solved: ["日志改到 ops-logs，commit abc1234"], decisions: ["定：日志一律放 ops-logs（用户拍板）"], experience: [{ text: "柠檬会清 Library/Logs 子目录 → case 56d3", anchor: "", anchorSeq: null, anchorVerified: true, kind: "坑" }], unfinished: ["无"] };
  const line = (sid: string, at: number, role: "user" | "assistant", text: string) => `${JSON.stringify(role === "user"
    ? { type: "user", sessionId: sid, timestamp: new Date(at).toISOString(), message: { role: "user", content: text } }
    : { type: "assistant", sessionId: sid, timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;

  it("用 agent 给的正文写同一格式；之后只多了助手收尾不重写，用户再说话才由扫描器重写", async () => {
    const e = env();
    const sid = "eeee5555-0000-4000-8000-000000000005";
    const path = writeCC(e.cc, sid, 5);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    const r = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: e.stateDir, trigger: "manual-收工", body: agentBody, nowMs: NOW });
    expect(r.generator).toBe("agent");
    const md = readFileSync(r.path, "utf-8");
    expect(md).toContain("trigger: manual-收工");
    expect(md).toContain("## 经验（已分流）\n- 柠檬会清 Library/Logs 子目录 → case 56d3（坑）\n");
    expect(md).not.toContain("anchor:未核");
    expect(md).toContain("## 决定与否决\n- 定：日志一律放 ops-logs（用户拍板）");
    const st = new SessionStateStore(e.stateDir).load(readdirSync(e.stateDir)[0].replace(/\.json$/, ""))!;
    expect(st).toMatchObject({ lastAction: "manual", candidateDone: true, candidateDueAt: null, pass: 1 });

    // 收工之后助手又说了两句，没有新的用户发言：扫描器保留当场写的那份
    appendFileSync(path, line(sid, NOW - 4 * MIN, "assistant", "收工完成"));
    utimesSync(path, new Date(NOW - 4 * MIN), new Date(NOW - 4 * MIN));
    const { llm, calls } = fakeLLM();
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false };
    const later = await runSweep({ ...base, nowMs: NOW + 3 * 60 * MIN });
    expect(later.actions["up-to-date"]).toBe(1);
    expect(calls()).toBe(0);
    expect(readFileSync(r.path, "utf-8")).toBe(md);

    // 用户接着聊：扫描器按新内容重写
    appendFileSync(path, line(sid, NOW + 4 * 60 * MIN, "user", "再把 bot 的日志也挪一下"));
    appendFileSync(path, line(sid, NOW + 4 * 60 * MIN + 1000, "assistant", "也挪好了"));
    utimesSync(path, new Date(NOW + 4 * 60 * MIN), new Date(NOW + 4 * 60 * MIN));
    const again = await runSweep({ ...base, nowMs: NOW + 6 * 60 * MIN });
    expect(again.actions.ledger).toBe(1);
    expect(calls()).toBe(1);
    expect(readFileSync(again.ledgersWritten[0], "utf-8")).toContain("trigger: auto-sweep");
  });

  it("中间夹一轮 not-idle 扫描也不丢保护（R1 Codex #1）", async () => {
    const e = env();
    const sid = "abab1111-0000-4000-8000-000000000011";
    const path = writeCC(e.cc, sid, 5);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    const r = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: e.stateDir, trigger: "manual-收工", body: agentBody, nowMs: NOW });
    const md = readFileSync(r.path, "utf-8");
    appendFileSync(path, line(sid, NOW + MIN, "assistant", "收工完成"));
    utimesSync(path, new Date(NOW + MIN), new Date(NOW + MIN));
    const { llm, calls } = fakeLLM();
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false };
    const mid = await runSweep({ ...base, nowMs: NOW + 10 * MIN });
    expect(mid.actions["not-idle"]).toBe(1);
    const late = await runSweep({ ...base, nowMs: NOW + 90 * MIN });
    expect(late.actions["up-to-date"]).toBe(1);
    expect(calls()).toBe(0);
    expect(readFileSync(r.path, "utf-8")).toBe(md);
  });

  it("跨机同步来的收工账本、本机没有游标：扫描器照样保留（R1 Codex #3）", async () => {
    const e = env();
    const sid = "abab2222-0000-4000-8000-000000000022";
    writeCC(e.cc, sid, 90);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    // 「另一台机」写的：游标在别的目录，本机 stateDir 空
    const r = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: join(e.root, "other-machine-state"), trigger: "manual-收工", body: agentBody, nowMs: NOW });
    const md = readFileSync(r.path, "utf-8");
    const { llm, calls } = fakeLLM();
    const res = await runSweep({ roots: [{ source: "cc", dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, nowMs: NOW + 60 * MIN });
    expect(res.actions["up-to-date"]).toBe(1);
    expect(calls()).toBe(0);
    expect(readFileSync(r.path, "utf-8")).toBe(md);
  });

  it("扫描器等 LLM 期间收工账本写进来：提交前发现，放弃这次生成（R1 Codex #2）", async () => {
    const e = env();
    const sid = "abab3333-0000-4000-8000-000000000033";
    writeCC(e.cc, sid, 90);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    const inner = fakeLLM();
    let manualPath = "";
    const racingLLM = {
      chatLongDetailed: async (...args: unknown[]) => {
        const r = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: join(e.root, "cli-state"), trigger: "manual-收工", body: agentBody, nowMs: NOW });
        manualPath = r.path;
        return (inner.llm.chatLongDetailed as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as LLMClient;
    const res = await runSweep({ roots: [{ source: "cc", dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm: racingLLM, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, nowMs: NOW });
    expect(res.ledgersWritten).toEqual([]);
    expect(res.actions["up-to-date"]).toBe(1);
    expect(readFileSync(manualPath, "utf-8")).toContain("generator: agent");
  });

  it("没给正文、LLM 失败：不盖已有账本、不推进游标（R1 Codex #4）", async () => {
    const e = env();
    const sid = "abab4444-0000-4000-8000-000000000044";
    writeCC(e.cc, sid, 90);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    const { llm } = fakeLLM();
    const first = await runSweep({ roots: [{ source: "cc", dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, nowMs: NOW });
    const md = readFileSync(first.ledgersWritten[0], "utf-8");
    const stBefore = readFileSync(join(e.stateDir, readdirSync(e.stateDir)[0]), "utf-8");
    const broken = { chatLongDetailed: async () => { throw new Error("429 You have exceeded your current request limit"); } } as unknown as LLMClient;
    const r = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: e.stateDir, trigger: "manual-收工", llm: broken, render: { retries: 0 }, nowMs: NOW + MIN });
    expect(r.written).toBe(false);
    expect(readFileSync(first.ledgersWritten[0], "utf-8")).toBe(md);
    expect(readFileSync(join(e.stateDir, readdirSync(e.stateDir)[0]), "utf-8")).toBe(stBefore);
  });

  it("跨月续聊：写回原来那份，不在新月份另起一份", async () => {
    const e = env();
    const sid = "abab5555-0000-4000-8000-000000000055";
    const oct = Date.parse("2026-10-31T23:00:00.000Z");
    const path = join(e.cc, "-Users-x", `${sid}.jsonl`);
    mkdirSync(join(e.cc, "-Users-x"), { recursive: true });
    for (let i = 0; i < 4; i++) {
      appendFileSync(path, line(sid, oct + i * 2 * MIN, "user", `问 ${i}`));
      appendFileSync(path, line(sid, oct + i * 2 * MIN + 1000, "assistant", `答 ${i}`));
    }
    utimesSync(path, new Date(oct + 8 * MIN), new Date(oct + 8 * MIN));
    const { llm } = fakeLLM();
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false };
    const a = await runSweep({ ...base, nowMs: oct + 120 * MIN });
    expect(a.ledgersWritten).toEqual([join(e.ledgerDir, "2026-10", "abab5555.md")]);
    appendFileSync(path, line(sid, oct + 180 * MIN, "user", "11 月接着问"));
    appendFileSync(path, line(sid, oct + 181 * MIN, "assistant", "接着答"));
    utimesSync(path, new Date(oct + 181 * MIN), new Date(oct + 181 * MIN));
    const b = await runSweep({ ...base, nowMs: oct + 300 * MIN });
    expect(b.ledgersWritten).toEqual([join(e.ledgerDir, "2026-10", "abab5555.md")]);
    expect(existsSync(join(e.ledgerDir, "2026-11"))).toBe(false);
  });

  it("没给正文就调 LLM 生成，不出候选", async () => {
    const e = env();
    writeCC(e.cc, "ffff6666-0000-4000-8000-000000000006", 5);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    const { llm, calls } = fakeLLM();
    const r = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: e.stateDir, trigger: "manual-收工", llm, nowMs: NOW });
    expect(r.generator).toBe("llm");
    expect(calls()).toBe(1);
    expect(readFileSync(r.path, "utf-8")).toContain("## 经验（待确认）\n- （无）");
  });
});

describe("扫描器 LLM 失败：不推进游标、按退避重试、不拿残版盖已有账本（R1 Kimi #1）", () => {
  it("首轮失败写机器抽取版并记退避；退避内不再调；退避后补上完整账本、清掉退避", async () => {
    const e = env();
    writeCC(e.cc, "adad1111-0000-4000-8000-000000000111", 90);
    let broken = true;
    let calls = 0;
    const llm = { chatLongDetailed: async (...a: unknown[]) => { calls++; if (broken) throw new Error("429 limit"); return (fakeLLM().llm.chatLongDetailed as (...x: unknown[]) => Promise<unknown>)(...a); } } as unknown as LLMClient;
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, render: { retries: 0 } };
    const a = await runSweep({ ...base, nowMs: NOW });
    expect(a.llmFailures).toBe(1);
    expect(readFileSync(a.ledgersWritten[0], "utf-8")).toContain("generator: llm-failed");
    const key = readdirSync(e.stateDir)[0].replace(/\.json$/, "");
    const st1 = new SessionStateStore(e.stateDir).load(key)!;
    expect(st1.processedUpto).toBeNull();
    expect(st1.llmFailCount).toBe(1);
    expect(Date.parse(st1.llmRetryAt!)).toBe(NOW + 30 * MIN);
    const b = await runSweep({ ...base, nowMs: NOW + 10 * MIN });
    expect(b.llmCalls).toBe(0);
    expect(b.actions["up-to-date"]).toBe(1);
    broken = false;
    const c = await runSweep({ ...base, nowMs: NOW + 31 * MIN });
    expect(c.actions.ledger).toBe(1);
    expect(readFileSync(c.ledgersWritten[0], "utf-8")).toContain("generator: llm\n");
    const st2 = new SessionStateStore(e.stateDir).load(key)!;
    expect(st2.llmRetryAt).toBeNull();
    expect(st2.processedUpto).not.toBeNull();
    expect(calls).toBe(2);
  });
  it("已有完整账本、续聊后那一轮 LLM 失败：不盖，游标停在旧处", async () => {
    const e = env();
    const sid = "adad2222-0000-4000-8000-000000000222";
    const path = writeCC(e.cc, sid, 90);
    const good = fakeLLM();
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, render: { retries: 0 } };
    const a = await runSweep({ ...base, llm: good.llm, nowMs: NOW });
    const md = readFileSync(a.ledgersWritten[0], "utf-8");
    const upto = new SessionStateStore(e.stateDir).load(readdirSync(e.stateDir)[0].replace(/\.json$/, ""))!.processedUpto;
    appendFileSync(path, `${JSON.stringify({ type: "user", sessionId: sid, timestamp: new Date(NOW + 10 * MIN).toISOString(), message: { role: "user", content: "接着聊" } })}\n`);
    utimesSync(path, new Date(NOW + 10 * MIN), new Date(NOW + 10 * MIN));
    const broken = { chatLongDetailed: async () => { throw new Error("429 limit"); } } as unknown as LLMClient;
    const b = await runSweep({ ...base, llm: broken, nowMs: NOW + 120 * MIN });
    expect(b.llmFailures).toBe(1);
    expect(b.ledgersWritten).toEqual([]);
    expect(readFileSync(a.ledgersWritten[0], "utf-8")).toBe(md);
    expect(new SessionStateStore(e.stateDir).load(readdirSync(e.stateDir)[0].replace(/\.json$/, ""))!.processedUpto).toBe(upto);
    // 退避期间又扫一轮（这一轮会记下当前 mtime）
    const mid = await runSweep({ ...base, llm: good.llm, nowMs: NOW + 130 * MIN });
    expect(mid.llmCalls).toBe(0);
    // 退避过了、LLM 好了：文件 mtime 没变也要重判，把续聊那段补进账本
    const c = await runSweep({ ...base, llm: good.llm, nowMs: NOW + 160 * MIN });
    expect(c.actions.ledger).toBe(1);
    expect(c.ledgersWritten).toEqual([a.ledgersWritten[0]]);
  });
});

describe("LLM 失败连击（R1 Codex #7）", () => {
  it("全失败 +1、空轮不变、有一次成功清零", () => {
    const t = "2026-10-23T12:00:00.000Z";
    let st = nextLlmFailState(null, { llmCalls: 2, llmFailures: 2 }, t);
    expect(st).toEqual({ llmFailStreak: 1, lastLlmFailureAt: t });
    st = nextLlmFailState(st, { llmCalls: 0, llmFailures: 0 }, "2026-10-23T12:10:00.000Z");
    expect(st).toEqual({ llmFailStreak: 1, lastLlmFailureAt: t });
    st = nextLlmFailState(st, { llmCalls: 1, llmFailures: 1 }, "2026-10-23T12:20:00.000Z");
    expect(st.llmFailStreak).toBe(2);
    st = nextLlmFailState(st, { llmCalls: 3, llmFailures: 2 }, "2026-10-23T12:30:00.000Z");
    expect(st.llmFailStreak).toBe(0);
  });
  it("runSweep 把连击写进心跳，空轮带过去", async () => {
    const e = env();
    writeCC(e.cc, "acac1111-0000-4000-8000-000000000111", 90);
    const broken = { chatLongDetailed: async () => { throw new Error("429 limit"); } } as unknown as LLMClient;
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, heartbeatPath: e.heartbeatPath, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, render: { retries: 0 } };
    const a = await runSweep({ ...base, llm: broken, nowMs: NOW });
    expect(a.heartbeat?.llmFailStreak).toBe(1);
    const b = await runSweep({ ...base, llm: broken, nowMs: NOW + 10 * MIN });
    expect(b.llmCalls).toBe(0);
    expect(b.heartbeat?.llmFailStreak).toBe(1);
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: e.heartbeatPath })?.status).toBe("warn");
    expect(b.heartbeat?.llmConfigured).toBe(true);
    // 锁忙跳过：只记 busyAt，其余字段不动
    touchHeartbeatBusy(e.heartbeatPath, "2026-10-23T12:30:00.000Z");
    const hb = readHeartbeat(e.heartbeatPath)!;
    expect(hb.busyAt).toBe("2026-10-23T12:30:00.000Z");
    expect(hb.llmFailStreak).toBe(1);
    expect(hb.at).toBe(b.heartbeat!.at);
  });
});

describe("sessions ledger --trigger 白名单（R1 Kimi #9）", () => {
  it("错拼的 trigger 报错退出 2，不悄悄当成 manual-收工", () => {
    const r = spawnSync("bun", ["run", join(import.meta.dir, "..", "cli.ts"), "sessions", "ledger", "--session", "x", "--trigger", "manual-shougong"], { encoding: "utf-8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--trigger 只认");
  });
});

describe("sessions ledger / 正式 sweep 不在仓库数据目录下跑就拒绝（提交锁、游标与扫描器不是同一份）", () => {
  const cli = join(import.meta.dir, "..", "cli.ts");
  const root = mkdtempSync(join(tmpdir(), "rn-sweep-cwd-"));
  const dbDir = join(root, "repo-data", "lancedb");
  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ dbPath: dbDir, sources: {} }));
  const elsewhere = join(root, "somewhere-else");
  mkdirSync(elsewhere);
  const run = (args: string[], dataDir: string) => spawnSync("bun", ["run", cli, ...args], { cwd: elsewhere, encoding: "utf-8", env: { ...process.env, LOCAL_MEMORY_CONFIG: cfgPath, RECALLNEST_DATA_DIR: dataDir } });
  it("当前目录下的 data 与库所在的数据目录不是一个：两条命令都退出 2 并说明原因", () => {
    for (const args of [["sessions", "ledger", "--session", "x"], ["sessions", "sweep"]]) {
      const r = run(args, "");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("不一致");
    }
  });
  it("写账本时抛错（这里用一份没有时间戳的转录）：收工命令接住、退出 3、只打一行原因，不吐调用栈（R4 Kimi #4）", () => {
    const cfg2 = join(root, "config-ledgers.json");
    writeFileSync(cfg2, JSON.stringify({ dbPath: dbDir, sources: { ledgers: { path: join(root, "ledgers"), glob: "**/*.md" } } }));
    const ccDir = join(root, "cc", "-Users-x");
    mkdirSync(ccDir, { recursive: true });
    const sid = "abcd9999-0000-4000-8000-000000000999";
    writeFileSync(join(ccDir, `${sid}.jsonl`), `${JSON.stringify({ type: "user", sessionId: sid, message: { role: "user", content: "没有时间戳" } })}\n`);
    const r = spawnSync("bun", ["run", cli, "sessions", "ledger", "--session", sid, "--roots", `cc=${join(root, "cc")}`, "--body", "-"], {
      cwd: elsewhere, encoding: "utf-8", input: JSON.stringify({ oneLine: "x", solved: [], decisions: [], experience: [], unfinished: [] }),
      env: { ...process.env, LOCAL_MEMORY_CONFIG: cfg2, RECALLNEST_DATA_DIR: join(root, "repo-data") },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("转录里没有带时间的事件");
    expect(r.stderr).not.toContain("    at ");
  });
  it("设了 RECALLNEST_DATA_DIR 指向库所在的数据目录：过了这道核对（往下撞到没配账本目录）", () => {
    for (const args of [["sessions", "ledger", "--session", "x"], ["sessions", "sweep"]]) {
      const r = run(args, join(root, "repo-data"));
      expect(r.stderr).not.toContain("不一致");
      expect(r.stderr).toContain("sources.ledgers.path");
    }
  });
});

describe("doctor：会话扫描验活", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-sweep-doctor-"));
  const hbPath = join(dir, "hb.json");
  const write = (at: number, extra: Record<string, unknown> = {}) => writeFileSync(hbPath, JSON.stringify({ at: new Date(at).toISOString(), wallMs: 10, discovered: 3, actions: {}, ledgersWritten: 1, llmCalls: 2, llmFailures: 0, llmFailStreak: 0, lastLlmFailureAt: null, llmConfigured: true, ...extra }));
  it("没配账本目录：不出这一项", () => {
    expect(checkSessionsSweep({ ledgersConfigured: false, heartbeatPath: hbPath, nowMs: NOW })).toBeNull();
  });
  it("配了但没有心跳：红", () => {
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: join(dir, "none.json"), nowMs: NOW })?.status).toBe("fail");
  });
  it("心跳在 20 分钟内：绿；超过：红；LLM 全失败：黄", () => {
    write(NOW - 9 * MIN);
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("pass");
    write(NOW - SWEEP_STALE_MS - MIN);
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("fail");
    write(NOW - 2 * MIN, { llmFailures: 2, llmFailStreak: 1 });
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("warn");
    // 没配 LLM：黄
    write(NOW - 2 * MIN, { llmConfigured: false, llmCalls: 0 });
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("warn");
    // 上一轮长跑、本轮因锁跳过：心跳 40 分钟前，busyAt 5 分钟前 → 绿；完成的一轮在 3 小时前 → 红（卡住了）
    write(NOW - 40 * MIN, { busyAt: new Date(NOW - 5 * MIN).toISOString(), llmConfigured: true });
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("pass");
    write(NOW - 180 * MIN, { busyAt: new Date(NOW - 5 * MIN).toISOString(), llmConfigured: true });
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("fail");
    // 本轮空轮（0 次调用）但之前的故障没恢复：仍黄
    write(NOW - 2 * MIN, { llmCalls: 0, llmFailures: 0, llmFailStreak: 2 });
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("warn");
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const holdCommitLock = (sid: string, lockDir: string) => {
  const cfg = { lockPath: lockPathForKey(`${LEDGER_COMMIT_LOCK_PREFIX}${sid}`, lockDir), expireMs: 60_000 };
  expect(acquireLock(cfg)).toBe(true);
  return () => releaseLock(cfg);
};
const agentBodyR3 = { oneLine: "收工当场写", solved: ["当场写的"], decisions: [], experience: [], unfinished: [] };

describe("账本提交锁：扫描器与收工命令都在同一把会话锁里「重读 → 判断 → 改名」（R3 Codex C2/K4、NEW-1）", () => {
  it("扫描器生成完要等提交锁；持锁方在锁里写下当场账本，扫描器拿到锁后复查发现、不盖", async () => {
    const e = env();
    const lockDir = join(e.root, "locks");
    const sid = "aeae1111-0000-4000-8000-000000000111";
    writeCC(e.cc, sid, 90);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    const release = holdCommitLock(sid, lockDir);
    let llmDone = false;
    const inner = fakeLLM();
    const llm = { chatLongDetailed: async (...a: unknown[]) => { const r = await (inner.llm.chatLongDetailed as (...x: unknown[]) => Promise<unknown>)(...a); llmDone = true; return r; } } as unknown as LLMClient;
    const p = runSweep({ roots: [{ source: "cc", dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, nowMs: NOW, lockDir });
    while (!llmDone) await sleep(5);
    await sleep(200);
    const target = join(e.ledgerDir, "2026-10", "aeae1111.md");
    // LLM 早就返回了，提交还在等锁
    expect(existsSync(target)).toBe(false);
    // 持锁方（另一个进程里的收工命令）在锁里写下当场账本：这里用另一把锁目录模拟「它已经在临界区里」
    const manual = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: join(e.root, "cli-state"), trigger: "manual-收工", body: agentBodyR3, nowMs: NOW, lockDir: join(e.root, "other-locks") });
    expect(manual.path).toBe(target);
    const md = readFileSync(target, "utf-8");
    release();
    const res = await p;
    expect(res.ledgersWritten).toEqual([]);
    expect(res.actions["up-to-date"]).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe(md);
  });

  it("收工命令带正文的那份也要等提交锁（无条件写，但不插进扫描器的复查与改名之间）", async () => {
    const e = env();
    const lockDir = join(e.root, "locks");
    const sid = "aeae2222-0000-4000-8000-000000000222";
    writeCC(e.cc, sid, 5);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    const release = holdCommitLock(sid, lockDir);
    let settled = false;
    const p = writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: e.stateDir, trigger: "manual-收工", body: agentBodyR3, nowMs: NOW, lockDir }).then((r) => { settled = true; return r; });
    await sleep(200);
    expect(settled).toBe(false);
    expect(existsSync(join(e.ledgerDir, "2026-10", "aeae2222.md"))).toBe(false);
    release();
    const r = await p;
    expect(r.written).toBe(true);
    expect(readFileSync(r.path, "utf-8")).toContain("generator: agent");
  });

  it("收工命令没给正文、等 LLM 期间另一次带正文的收工写进来：LLM 版不盖它（R3 Codex NEW-1）", async () => {
    const e = env();
    const lockDir = join(e.root, "locks");
    writeCC(e.cc, "aeae3333-0000-4000-8000-000000000333", 5);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    const inner = fakeLLM();
    const racing = {
      chatLongDetailed: async (...a: unknown[]) => {
        await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: e.stateDir, trigger: "manual-收工", body: agentBodyR3, nowMs: NOW, lockDir });
        return (inner.llm.chatLongDetailed as (...x: unknown[]) => Promise<unknown>)(...a);
      },
    } as unknown as LLMClient;
    const r = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: e.stateDir, trigger: "manual-收工", llm: racing, nowMs: NOW, lockDir });
    expect(r.written).toBe(false);
    expect(r.skipped).toBe("agent-ledger");
    const md = readFileSync(r.path, "utf-8");
    expect(md).toContain("generator: agent");
    expect(md).toContain("# 收工当场写");
  });

  it("没给正文、当场账本还管着这场：不调 LLM、不动账本", async () => {
    const e = env();
    writeCC(e.cc, "aeae4444-0000-4000-8000-000000000444", 5);
    const file = discoverTranscripts([{ source: "cc", dir: e.cc }]).files[0];
    const first = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: e.stateDir, trigger: "manual-收工", body: agentBodyR3, nowMs: NOW });
    const md = readFileSync(first.path, "utf-8");
    const { llm, calls } = fakeLLM();
    const r = await writeSessionLedgerNow({ file, ledgerDir: e.ledgerDir, stateDir: e.stateDir, trigger: "manual-收工", llm, nowMs: NOW + MIN });
    expect(r).toMatchObject({ written: false, skipped: "agent-ledger", path: first.path });
    expect(calls()).toBe(0);
    expect(readFileSync(first.path, "utf-8")).toBe(md);
  });

  it("提交锁等不到：扫描器这一轮不写、游标不推进、不记退避，下一轮照常写", async () => {
    const e = env();
    const lockDir = join(e.root, "locks");
    const sid = "aeae5555-0000-4000-8000-000000000555";
    writeCC(e.cc, sid, 90);
    const { llm } = fakeLLM();
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, lockDir, commitWaitMs: 100 };
    const release = holdCommitLock(sid, lockDir);
    const a = await runSweep({ ...base, nowMs: NOW });
    release();
    expect(a.ledgersWritten).toEqual([]);
    // 这一轮记成 deferred，不虚记一笔 ledger（R4 Kimi #6）
    expect(a.actions.deferred).toBe(1);
    expect(a.actions.ledger ?? 0).toBe(0);
    const key = readdirSync(e.stateDir)[0].replace(/\.json$/, "");
    const st = new SessionStateStore(e.stateDir).load(key)!;
    expect(st.processedUpto).toBeNull();
    expect(st.pass).toBe(0);
    expect(st.llmRetryAt ?? null).toBeNull();
    const b = await runSweep({ ...base, nowMs: NOW + 10 * MIN });
    expect(b.ledgersWritten).toEqual([join(e.ledgerDir, "2026-10", "aeae5555.md")]);
  });

  it("commitLedger：fallback 模式已有账本就不写；agent 模式无条件写", async () => {
    const e = env();
    const lockDir = join(e.root, "locks");
    const doc = { sessionId: "aeae6666-0000-4000-8000-000000000666", startedAt: "2026-10-23T10:00:00.000Z", endedAt: "2026-10-23T11:00:00.000Z", events: [] } as unknown as SessionDoc;
    const w1 = await commitLedger({ ledgerRoot: e.ledgerDir, doc, markdown: "v1\n", mode: "fallback", lockDir });
    expect(w1.written).toBe(true);
    const w2 = await commitLedger({ ledgerRoot: e.ledgerDir, doc, markdown: "v2\n", mode: "fallback", lockDir });
    expect(w2).toMatchObject({ written: false, reason: "exists" });
    expect(readFileSync(w1.path, "utf-8")).toBe("v1\n");
    const w3 = await commitLedger({ ledgerRoot: e.ledgerDir, doc, markdown: "v3\n", mode: "agent", lockDir });
    expect(w3.written).toBe(true);
    expect(readFileSync(w1.path, "utf-8")).toBe("v3\n");
    expect(readdirSync(dirname(w1.path))).toEqual(["aeae6666.md"]);
  });
});

describe("跨三个月份、本机没有游标：找得到中间那个月的账本（R3 Codex C3 / K5）", () => {
  const sid = "afaf1111-0000-4000-8000-000000000111";
  const head = (session: string) => `---\nsession: ${session}\ngenerator: llm\ncovered_upto: "2026-10-15T00:00:00.000Z"\n---\n\n# x\n`;
  it("ledgerTargetPath：开始月、结束月都没有，扫到 10 月那份（核 session 对得上才算）", () => {
    const e = env();
    const doc = { sessionId: sid, startedAt: "2026-09-30T23:00:00.000Z", endedAt: "2026-11-01T01:00:00.000Z", events: [] } as unknown as SessionDoc;
    mkdirSync(join(e.ledgerDir, "2026-10"), { recursive: true });
    // 同一个 sid8、别的会话：不算
    writeFileSync(join(e.ledgerDir, "2026-10", "afaf1111.md"), head("afaf1111-ffff-4000-8000-000000000999"));
    expect(ledgerTargetPath(e.ledgerDir, doc)).toBe(join(e.ledgerDir, "2026-11", "afaf1111.md"));
    writeFileSync(join(e.ledgerDir, "2026-10", "afaf1111.md"), head(sid));
    expect(ledgerTargetPath(e.ledgerDir, doc)).toBe(join(e.ledgerDir, "2026-10", "afaf1111.md"));
  });

  it("runSweep：另一台机在 10 月写过账本，本机没游标、会话 11 月续聊 → 写回 10 月那份，不另起 11 月", async () => {
    const e = env();
    const line = (at: string, role: "user" | "assistant", text: string) => `${JSON.stringify(role === "user"
      ? { type: "user", sessionId: sid, timestamp: at, message: { role: "user", content: text } }
      : { type: "assistant", sessionId: sid, timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
    const path = join(e.cc, "-Users-x", `${sid}.jsonl`);
    mkdirSync(join(e.cc, "-Users-x"), { recursive: true });
    appendFileSync(path, line("2026-09-30T23:50:00.000Z", "user", "九月底开的头"));
    for (let i = 0; i < 4; i++) {
      appendFileSync(path, line(`2026-10-15T10:0${i}:00.000Z`, "user", `十月问 ${i}`));
      appendFileSync(path, line(`2026-10-15T10:0${i}:30.000Z`, "assistant", `十月答 ${i}`));
    }
    utimesSync(path, new Date("2026-10-15T10:04:00.000Z"), new Date("2026-10-15T10:04:00.000Z"));
    const { llm } = fakeLLM();
    const base = { roots: [{ source: "cc" as const, dir: e.cc }], ledgerDir: e.ledgerDir, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, sinceDays: 0 };
    const a = await runSweep({ ...base, stateDir: join(e.root, "machine-a"), nowMs: Date.parse("2026-10-15T13:00:00.000Z") });
    expect(a.ledgersWritten).toEqual([join(e.ledgerDir, "2026-10", "afaf1111.md")]);
    appendFileSync(path, line("2026-11-01T00:30:00.000Z", "user", "十一月接着问"));
    appendFileSync(path, line("2026-11-01T00:31:00.000Z", "assistant", "接着答"));
    utimesSync(path, new Date("2026-11-01T00:31:00.000Z"), new Date("2026-11-01T00:31:00.000Z"));
    const b = await runSweep({ ...base, stateDir: join(e.root, "machine-b"), nowMs: Date.parse("2026-11-01T03:00:00.000Z") });
    expect(b.ledgersWritten).toEqual([join(e.ledgerDir, "2026-10", "afaf1111.md")]);
    expect(existsSync(join(e.ledgerDir, "2026-11"))).toBe(false);
    expect(existsSync(join(e.ledgerDir, "2026-09"))).toBe(false);
  });
});

describe("一轮开始就写「在跑」心跳，doctor 不在长跑时假红（R3 Codex K6）", () => {
  it("runSweep 开头记 runningSince 与本进程 pid，跑完清掉、开始轮数归零", async () => {
    const e = env();
    writeCC(e.cc, "agag1111-0000-4000-8000-000000000111", 90);
    let seen: ReturnType<typeof readHeartbeat> = null;
    const inner = fakeLLM();
    const llm = { chatLongDetailed: async (...a: unknown[]) => { seen = readHeartbeat(e.heartbeatPath); return (inner.llm.chatLongDetailed as (...x: unknown[]) => Promise<unknown>)(...a); } } as unknown as LLMClient;
    const r = await runSweep({ roots: [{ source: "cc", dir: e.cc }], ledgerDir: e.ledgerDir, stateDir: e.stateDir, heartbeatPath: e.heartbeatPath, llm, policyBySource: SWEEP_DEFAULT_POLICY_BY_SOURCE, candidates: false, nowMs: NOW });
    const during = seen as ReturnType<typeof readHeartbeat>;
    expect(during?.runningSince).toBeTruthy();
    expect(during?.runningPid).toBe(process.pid);
    expect(during?.startsSinceDone).toBe(1);
    expect(during?.at).toBe("");
    // 在跑的那一刻 doctor：第一轮还在跑 → 绿
    expect(r.heartbeat?.runningSince).toBeNull();
    expect(r.heartbeat?.startsSinceDone).toBe(0);
    expect(readHeartbeat(e.heartbeatPath)?.runningSince).toBeNull();
  });

  describe("doctor 判活", () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-sweep-doctor-run-"));
    const hbPath = join(dir, "hb.json");
    const write = (extra: Record<string, unknown>) => writeFileSync(hbPath, JSON.stringify({ at: new Date(NOW - 40 * MIN).toISOString(), wallMs: 10, discovered: 3, actions: {}, ledgersWritten: 1, llmCalls: 2, llmFailures: 0, llmFailStreak: 0, lastLlmFailureAt: null, llmConfigured: true, ...extra }));
    const check = (running: boolean) => checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW, isSweepRunning: () => running });
    it("这一轮 30 分钟前开始、还在跑（上次完成在 40 分钟前）：绿", () => {
      write({ runningSince: new Date(NOW - 30 * MIN).toISOString(), runningPid: 4242, startsSinceDone: 1 });
      expect(check(true)?.status).toBe("pass");
      expect(check(true)?.message).toContain("还在跑");
    });
    it("跑了超过 2 小时：红", () => {
      write({ at: new Date(NOW - 200 * MIN).toISOString(), runningSince: new Date(NOW - SWEEP_STUCK_MS - MIN).toISOString(), runningPid: 4242, startsSinceDone: 1 });
      expect(check(true)?.status).toBe("fail");
    });
    it("连续 3 轮开始了都没跑完（含正在跑的）：红", () => {
      write({ runningSince: new Date(NOW - 5 * MIN).toISOString(), runningPid: 4242, startsSinceDone: 3 });
      expect(check(true)?.status).toBe("fail");
      write({ runningSince: new Date(NOW - 5 * MIN).toISOString(), runningPid: 4242, startsSinceDone: 2 });
      expect(check(true)?.status).toBe("pass");
    });
    it("写了 runningSince、扫描锁却没人拿着（那一轮被杀或崩了）：不算在跑，按上次完成判旧", () => {
      write({ runningSince: new Date(NOW - 30 * MIN).toISOString(), runningPid: 4242, startsSinceDone: 1 });
      const r = check(false);
      expect(r?.status).toBe("fail");
      expect(r?.message).toContain("没跑完就退出了");
      write({ at: new Date(NOW - 5 * MIN).toISOString(), runningSince: new Date(NOW - 30 * MIN).toISOString(), runningPid: 4242, startsSinceDone: 1 });
      expect(check(false)?.status).toBe("pass");
    });
    it("默认判据是扫描锁有没有人拿着：pid 被复用也骗不过（R4 Codex #4）", () => {
      write({ runningSince: new Date(NOW - 30 * MIN).toISOString(), runningPid: 1, startsSinceDone: 1 });
      // pid 1 永远活着，但扫描锁没人拿：那一轮早退出了 → 按上次完成（40 分钟前）判旧
      expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("fail");
      const cfg = { lockPath: lockPathForKey("sessions-sweep", join(dir, "locks")), expireMs: 60_000 };
      expect(acquireLock(cfg)).toBe(true);
      try {
        expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("pass");
      } finally {
        releaseLock(cfg);
      }
    });
    it("第一轮还在跑（没有完成过）：绿；第一轮的进程没了：红", () => {
      const first = join(dir, "first.json");
      markHeartbeatRunning(first, { nowIso: new Date(NOW - 10 * MIN).toISOString(), pid: 4242, llmConfigured: true });
      expect(readHeartbeat(first)?.at).toBe("");
      const checkFirst = (running: boolean) => checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: first, nowMs: NOW, isSweepRunning: () => running });
      expect(checkFirst(true)?.status).toBe("pass");
      expect(checkFirst(false)?.status).toBe("fail");
    });
  });
});
