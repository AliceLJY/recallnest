/**
 * sessions-sweep-run — 把发现 / 决策 / 账本生成串起来的一轮扫描（CLI `recallnest sessions sweep` 的实现）。
 *
 * 两种落点：
 *   - 影子模式（P0、回放）：给 `shadowDir`，账本写 `<shadowDir>/ledgers/YYYY-MM/<sid8>.md`、游标写
 *     `<shadowDir>/session-state/`、决策日志 `<shadowDir>/sweep-log.jsonl`；
 *   - 正式模式（P1 ④）：给 `ledgerDir`（cc-memory/ledgers/）与 `stateDir`，日志与心跳各自给路径。
 * 每端各自的静默阈值走 `policyBySource`（Alice 10-23 拍板：CC 60 分钟 / 候选 12 小时，其余端 30 分钟 / 6 小时）。
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { LLMClient } from "./llm-client.js";
import { redactSecrets } from "./pii-detector.js";
import { buildLedger, renderLedgerMarkdown, type GenerateLedgerOptions, type LedgerBody, type LedgerMeta } from "./session-ledger.js";
import { parseSessionFile, summarizeSession, type SessionDoc, type SessionSource } from "./session-events.js";
import { applyDecision, decide, DEFAULT_POLICY, discoverTranscripts, ledgerRelPath, SessionStateStore, type RootSpec, type SweepAction, type SweepPolicy, type TranscriptFile } from "./sessions-sweep.js";

export interface SweepRunOptions {
  roots: RootSpec[];
  /** 影子模式：账本、游标、日志都放在这个目录下（与 ledgerDir / stateDir 二选一） */
  shadowDir?: string;
  /** 正式模式：账本根目录（下面按 YYYY-MM 分） */
  ledgerDir?: string;
  /** 正式模式：游标目录 */
  stateDir?: string;
  /** 决策日志（jsonl）；影子模式默认 <shadowDir>/sweep-log.jsonl，正式模式不给就不写 */
  logPath?: string;
  /** 每轮结束写一份心跳（doctor 据此判「上次 sweep 多久前」）；不给就不写 */
  heartbeatPath?: string;
  policy?: Partial<SweepPolicy>;
  /** 按端覆盖 policy（在 policy 之上再叠一层） */
  policyBySource?: Partial<Record<SessionSource, Partial<SweepPolicy>>>;
  /** 出不出经验候选（D2 第二步）。false 时只写事实账本，候选到期也不重生成、只记已处理。默认 true */
  candidates?: boolean;
  /** 只看最近 N 天的转录（按 mtime 粗筛，正式判据仍是消息时间） */
  sinceDays?: number;
  nowMs?: number;
  sources?: SessionSource[];
  /** 最多处理（真正生成账本）多少场；0 = 不限 */
  limit?: number;
  llm: LLMClient | null;
  render?: GenerateLedgerOptions;
  /** 只决策不写账本（游标照常更新为「已看过」？不——dry-run 什么都不写） */
  dryRun?: boolean;
  /** 只处理这些 sid（回放用），空 = 全部 */
  onlySessionIds?: Set<string>;
  trigger?: "auto-sweep" | "replay";
  /** 两次 LLM 调用之间至少隔多久（毫秒），给限速留余量；0 = 不等 */
  llmDelayMs?: number;
  log?: (line: string) => void;
}

export interface SweepRunResult {
  discovered: number;
  statCalls: number;
  discoveryWallMs: number;
  missingRoots: string[];
  actions: Record<SweepAction, number>;
  ledgersWritten: string[];
  llmCalls: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  llmFailures: number;
  wallMs: number;
  /** 写了心跳时带回本轮心跳（CLI 据此定退出码） */
  heartbeat?: SweepHeartbeat;
}

/** 各端默认的静默阈值（Alice 2026-10-23 拍板：CC 常停一两个小时再接着聊，60 分钟 / 候选 12 小时；其余端沿用 D2 的 30 / 360） */
export const SWEEP_DEFAULT_POLICY_BY_SOURCE: Record<SessionSource, { idleMinutes: number; candidateAfterMinutes: number }> = {
  cc: { idleMinutes: 60, candidateAfterMinutes: 720 },
  codex: { idleMinutes: 30, candidateAfterMinutes: 360 },
  kimi: { idleMinutes: 30, candidateAfterMinutes: 360 },
  antigravity: { idleMinutes: 30, candidateAfterMinutes: 360 },
};
/** 正式模式的心跳文件（在数据目录下）；doctor 看它判「上次扫描多久前」 */
export const SWEEP_HEARTBEAT_FILE = "sessions-sweep-heartbeat.json";
/** launchd 每 10 分钟拉一次；超过这么久没心跳 doctor 报红（open-loops P1 验收：≤20 分钟） */
export const SWEEP_STALE_MS = 20 * 60_000;

export interface SweepHeartbeat {
  at: string;
  wallMs: number;
  discovered: number;
  actions: Record<string, number>;
  ledgersWritten: number;
  llmCalls: number;
  llmFailures: number;
  /**
   * 连续几轮「调了 LLM 且全失败」。没调 LLM 的空轮不清零也不加（10 分钟一轮，多数轮没事可做——空轮清零的话
   * 故障永远凑不齐「连续」，P1 互审 R1 Codex #7）；有一次成功才清零。
   */
  llmFailStreak: number;
  lastLlmFailureAt: string | null;
}

/** 由上一份心跳与本轮结果算出新的失败连击 */
export function nextLlmFailState(prev: Pick<SweepHeartbeat, "llmFailStreak" | "lastLlmFailureAt"> | null, run: { llmCalls: number; llmFailures: number }, nowIso: string): { llmFailStreak: number; lastLlmFailureAt: string | null } {
  const streak = prev?.llmFailStreak ?? 0;
  const last = prev?.lastLlmFailureAt ?? null;
  if (run.llmCalls === 0) return { llmFailStreak: streak, lastLlmFailureAt: last };
  if (run.llmFailures >= run.llmCalls) return { llmFailStreak: streak + 1, lastLlmFailureAt: nowIso };
  return { llmFailStreak: 0, lastLlmFailureAt: last };
}

export function readHeartbeat(path: string): SweepHeartbeat | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SweepHeartbeat;
  } catch {
    return null;
  }
}

export function policyFor(source: SessionSource, opts: Pick<SweepRunOptions, "policy" | "policyBySource">): SweepPolicy {
  return { ...DEFAULT_POLICY, ...opts.policy, ...opts.policyBySource?.[source] };
}

export async function runSweep(opts: SweepRunOptions): Promise<SweepRunResult> {
  const t0 = performance.now();
  if (!opts.shadowDir && !(opts.ledgerDir && opts.stateDir)) throw new Error("runSweep 需要 shadowDir，或同时给 ledgerDir 与 stateDir");
  const nowMs = opts.nowMs ?? Date.now();
  // mtime 粗筛按真实墙钟算，不按 --now：回放把「现在」定到未来时，30 天窗口不该跟着整体平移
  const sinceMs = opts.sinceDays ? Date.now() - opts.sinceDays * 86_400_000 : 0;
  const log = opts.log ?? (() => {});
  const disc = discoverTranscripts(opts.roots, { sinceMs });
  let files = disc.files;
  if (opts.sources?.length) files = files.filter((f) => opts.sources!.includes(f.source));
  if (opts.onlySessionIds?.size) files = files.filter((f) => opts.onlySessionIds!.has(f.sessionId) || opts.onlySessionIds!.has(f.sessionId.slice(0, 8)));
  // 老的先处理：回放时顺序稳定，影子期也让积压的先出
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const stateStore = new SessionStateStore(opts.stateDir ?? join(opts.shadowDir!, "session-state"));
  const ledgerRoot = opts.ledgerDir ?? join(opts.shadowDir!, "ledgers");
  const sweepLog = opts.logPath ?? (opts.shadowDir ? join(opts.shadowDir, "sweep-log.jsonl") : null);
  // 日志与终端里账本路径的显示基准：影子模式相对 shadowDir（ledgers/2026-10/x.md），正式模式相对账本根的上一级
  const displayBase = opts.shadowDir ?? dirname(ledgerRoot);
  const show = (p: string) => relative(displayBase, p);
  if (!opts.dryRun) {
    mkdirSync(ledgerRoot, { recursive: true });
    if (sweepLog) mkdirSync(dirname(sweepLog), { recursive: true });
  }
  const candidatesOn = opts.candidates ?? true;

  const actions = {} as Record<SweepAction, number>;
  const result: SweepRunResult = { discovered: disc.files.length, statCalls: disc.statCalls, discoveryWallMs: disc.wallMs, missingRoots: disc.missingRoots, actions, ledgersWritten: [], llmCalls: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmFailures: 0, wallMs: 0 };
  let produced = 0;

  for (const file of files) {
    if (opts.limit && produced >= opts.limit) break;
    const key = stateStore.fresh(file).key;
    const state = stateStore.load(key) ?? stateStore.fresh(file);
    const policy = policyFor(file.source, opts);
    let decision;
    try {
      decision = decide(file, state, nowMs, policy);
    } catch (error) {
      log(`! ${file.source} ${file.sessionId.slice(0, 8)} parse failed: ${error instanceof Error ? error.message : String(error)}`);
      actions["skip-no-timestamp"] = (actions["skip-no-timestamp"] ?? 0) + 1;
      continue;
    }
    // 收工时当场写过账本（P1 ⑤），之后没有新的用户发言：留着那份，不用机器版盖掉。
    // 判据看账本文件自己的 frontmatter（generator: agent + covered_upto），不看本机游标——游标会被每轮扫描改写，
    // 也不跟着账本跨机同步（P1 互审 R1 Codex #1 #3）
    let keepAgentUpto: string | null = null;
    const targetPath = decision.doc ? ledgerTargetPath(ledgerRoot, decision.doc, state.ledgerPath) : null;
    if ((decision.action === "ledger" || decision.action === "ledger+candidates" || decision.action === "candidates") && decision.doc && targetPath && agentLedgerCovers(targetPath, decision.doc)) {
      keepAgentUpto = decision.lastMessageAt ?? decision.doc.endedAt ?? null;
      decision = { ...decision, action: "up-to-date", reason: "收工账本之后没有新的用户发言，保留当场写的账本" };
    }
    // 候选关着时：「ledger+candidates」降成只写账本（候选记已处理，不再到期）；只剩候选到期的「candidates」不重生成
    if (!candidatesOn && decision.action === "candidates") decision = { ...decision, reason: `${decision.reason}（候选关闭，只记已处理）` };
    actions[decision.action] = (actions[decision.action] ?? 0) + 1;
    const needsLedger = decision.action === "ledger" || decision.action === "ledger+candidates" || (decision.action === "candidates" && candidatesOn);
    let ledgerPath: string | undefined;
    let usageNote: Record<string, unknown> = {};
    if (needsLedger && decision.doc && !opts.dryRun) {
      if (opts.llm && opts.llmDelayMs && result.llmCalls > 0) await new Promise((r) => setTimeout(r, opts.llmDelayMs));
      const pass = decision.action === "candidates" ? state.pass : state.pass + 1;
      // D2 两步：第一次静默只写事实账本，候选到期（ledger+candidates / candidates）才出经验
      const includeCandidates = candidatesOn && decision.action !== "ledger";
      const render = await buildLedger(decision.doc, { trigger: opts.trigger ?? "auto-sweep", pass, machine: file.machine, generatedAt: new Date(nowMs).toISOString() }, opts.llm, { ...opts.render, includeCandidates });
      if (opts.llm) {
        result.llmCalls++;
        if (render.usage) {
          result.llmPromptTokens += render.usage.promptTokens;
          result.llmCompletionTokens += render.usage.completionTokens;
        }
        if (render.generator === "llm-failed") result.llmFailures++;
        usageNote = { generator: render.generator, tokens: render.usage ? [render.usage.promptTokens, render.usage.completionTokens] : null, wallMs: render.usage?.wallMs ?? null, failure: render.failure ? redactSecrets(render.failure).text.slice(0, 300) : undefined, candidates: includeCandidates, experience: render.body?.experience.length ?? 0, anchorsUnverified: render.body?.experience.filter((x) => !x.anchorVerified).length ?? 0 };
      }
      const target = targetPath ?? join(ledgerRoot, ledgerRelPath(decision.doc.sessionId, decision.lastMessageAt ?? decision.doc.endedAt ?? new Date(nowMs).toISOString()));
      // 等 LLM 的这段时间里收工命令可能已经写了当场账本：提交前再看一眼，盖住就放弃这次生成（P1 互审 R1 Codex #2）
      if (agentLedgerCovers(target, decision.doc)) {
        keepAgentUpto = decision.lastMessageAt ?? decision.doc.endedAt ?? null;
        actions[decision.action] = (actions[decision.action] ?? 1) - 1;
        actions["up-to-date"] = (actions["up-to-date"] ?? 0) + 1;
        decision = { ...decision, action: "up-to-date", reason: "生成期间收工账本已写入，放弃本次生成" };
      } else {
        ledgerPath = target;
        mkdirSync(dirname(ledgerPath), { recursive: true });
        // 先写临时文件再改名：Syncthing / 对账导入不会读到写了一半的账本
        const tmp = `${ledgerPath}.tmp-${process.pid}`;
        writeFileSync(tmp, render.markdown);
        renameSync(tmp, ledgerPath);
        result.ledgersWritten.push(ledgerPath);
        produced++;
      }
    }
    if (!opts.dryRun) {
      const next = applyDecision(state, file, decision, nowMs, policy, ledgerPath);
      if (keepAgentUpto) {
        next.processedUpto = keepAgentUpto;
        next.candidateDone = true;
        if (targetPath) next.ledgerPath = targetPath;
      }
      stateStore.save(next);
      if (sweepLog) appendFileSync(sweepLog, `${JSON.stringify({ ts: new Date(nowMs).toISOString(), source: file.source, sid8: file.sessionId.slice(0, 8), action: decision.action, reason: decision.reason, userTurns: decision.summary?.userTurns ?? null, rich: decision.summary?.rich ?? null, lastMessageAt: decision.lastMessageAt ?? null, ledger: ledgerPath ? show(ledgerPath) : null, ...usageNote })}\n`);
    }
    if (needsLedger) log(`${decision.action.padEnd(18)} ${file.source.padEnd(11)} ${file.sessionId.slice(0, 8)} ${decision.reason}${ledgerPath ? ` → ${show(ledgerPath)}` : ""}`);
  }
  result.wallMs = Math.round(performance.now() - t0);
  if (opts.heartbeatPath && !opts.dryRun) {
    const at = new Date().toISOString();
    const hb: SweepHeartbeat = { at, wallMs: result.wallMs, discovered: result.discovered, actions: result.actions, ledgersWritten: result.ledgersWritten.length, llmCalls: result.llmCalls, llmFailures: result.llmFailures, ...nextLlmFailState(readHeartbeat(opts.heartbeatPath), result, at) };
    result.heartbeat = hb;
    mkdirSync(dirname(opts.heartbeatPath), { recursive: true });
    const tmp = `${opts.heartbeatPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(hb)}\n`);
    renameSync(tmp, opts.heartbeatPath);
  }
  return result;
}

/** 只读账本文件开头的 frontmatter（≤4KB），取 generator / covered_upto；不是账本或读不了返回 null */
export function readLedgerHead(path: string): { generator?: string; coveredUpto?: string; session?: string } | null {
  if (!existsSync(path)) return null;
  let head = "";
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const m = head.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.startsWith("\"") && v.endsWith("\"")) {
      try { v = String(JSON.parse(v)); } catch { v = v.slice(1, -1); }
    }
    out[line.slice(0, i).trim()] = v;
  }
  return { generator: out.generator, coveredUpto: out.covered_upto, session: out.session };
}

/** 当场 agent 写的账本还管着这场会话吗：generator 是 agent，且 covered_upto 之后没有新的真人用户发言 */
export function agentLedgerCovers(path: string, doc: SessionDoc): boolean {
  const head = readLedgerHead(path);
  if (!head || head.generator !== "agent" || !head.coveredUpto || Number.isNaN(Date.parse(head.coveredUpto))) return false;
  return !hasUserTurnAfter(doc, head.coveredUpto);
}

/**
 * 账本落在哪：这场会话已经有账本（游标记着的、或按开始 / 结束月份算得到的）就写回原处，免得跨月续聊时
 * 一场会话出两份；都没有才按结束月份新建。
 */
export function ledgerTargetPath(ledgerRoot: string, doc: SessionDoc, stateLedgerPath?: string): string {
  const candidates = [
    stateLedgerPath && stateLedgerPath.startsWith(ledgerRoot) ? stateLedgerPath : null,
    doc.endedAt ? join(ledgerRoot, ledgerRelPath(doc.sessionId, doc.endedAt)) : null,
    doc.startedAt ? join(ledgerRoot, ledgerRelPath(doc.sessionId, doc.startedAt)) : null,
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? candidates[0] ?? join(ledgerRoot, ledgerRelPath(doc.sessionId, new Date().toISOString()));
}

function hasUserTurnAfter(doc: SessionDoc, iso: string): boolean {
  const t = Date.parse(iso);
  return doc.events.some((e) => e.kind === "user" && !e.injected && e.tsMs !== null && e.tsMs !== undefined && e.tsMs > t);
}

export interface WriteLedgerNowOptions {
  file: TranscriptFile;
  ledgerDir: string;
  stateDir: string;
  trigger: Extract<LedgerMeta["trigger"], "manual-收工" | "precompact">;
  /** 当场 agent 写好的正文（收工第五步的内容）；不给就用 llm 生成 */
  body?: LedgerBody | null;
  llm?: LLMClient | null;
  render?: GenerateLedgerOptions;
  nowMs?: number;
}

/**
 * 当场写一份账本（P1 ⑤：收工流程写同一格式的文件）。正文优先用当场 agent 给的（第一层，质量），
 * 没给才调 LLM；机器抽取两节照常从转录里抽。写完把游标推到当前最后一条消息、候选记已处理——
 * 扫描器之后只在有新的用户发言时才重写它。
 */
export async function writeSessionLedgerNow(o: WriteLedgerNowOptions): Promise<{ path: string; generator: string; failure?: string; written: boolean }> {
  const nowMs = o.nowMs ?? Date.now();
  const doc = parseSessionFile(o.file.path, { source: o.file.source });
  if (!doc.endedAt) throw new Error(`转录里没有带时间的事件：${o.file.path}`);
  const meta: LedgerMeta = { trigger: o.trigger, pass: 0, machine: o.file.machine, generatedAt: new Date(nowMs).toISOString() };
  const store = new SessionStateStore(o.stateDir);
  const state = store.load(store.fresh(o.file).key) ?? store.fresh(o.file);
  meta.pass = state.pass + 1;
  const render = o.body
    ? renderLedgerMarkdown(doc, summarizeSession(doc), o.body, meta, null, "agent")
    : await buildLedger(doc, meta, o.llm ?? null, { ...o.render, includeCandidates: false });
  const path = ledgerTargetPath(o.ledgerDir, doc, state.ledgerPath);
  // 没给正文、LLM 又没生成出来：不盖已有账本、不推进游标，交给扫描器之后补（P1 互审 R1 Codex #4）
  if (render.generator !== "agent" && render.generator !== "llm") return { path, generator: render.generator, failure: render.failure ?? "no llm", written: false };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, render.markdown);
  renameSync(tmp, path);
  store.save({ ...state, path: o.file.path, processedUpto: doc.endedAt, pass: meta.pass, candidateDueAt: null, candidateDone: true, lastMtimeMs: o.file.mtimeMs, lastSweepAt: new Date(nowMs).toISOString(), lastAction: "manual", notIdleSince: null, ledgerPath: path });
  return { path, generator: render.generator, failure: render.failure, written: true };
}
