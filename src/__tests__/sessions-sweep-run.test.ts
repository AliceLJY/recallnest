import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkSessionsSweep } from "../doctor.js";
import type { LLMClient } from "../llm-client.js";
import { policyFor, runSweep, SWEEP_DEFAULT_POLICY_BY_SOURCE, SWEEP_STALE_MS, writeSessionLedgerNow } from "../sessions-sweep-run.js";
import { appendFileSync } from "node:fs";
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

describe("doctor：会话扫描验活", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-sweep-doctor-"));
  const hbPath = join(dir, "hb.json");
  const write = (at: number, extra: Record<string, unknown> = {}) => writeFileSync(hbPath, JSON.stringify({ at: new Date(at).toISOString(), wallMs: 10, discovered: 3, actions: {}, ledgersWritten: 1, llmCalls: 2, llmFailures: 0, ...extra }));
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
    write(NOW - 2 * MIN, { llmFailures: 2 });
    expect(checkSessionsSweep({ ledgersConfigured: true, heartbeatPath: hbPath, nowMs: NOW })?.status).toBe("warn");
  });
});
