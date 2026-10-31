/**
 * sessions-sweep-run — 把发现 / 决策 / 账本生成串起来的一轮扫描（CLI `recallnest sessions sweep` 的实现）。
 *
 * 两种落点：
 *   - 影子模式（P0、回放）：给 `shadowDir`，账本写 `<shadowDir>/ledgers/YYYY-MM/<sid8>.md`、游标写
 *     `<shadowDir>/session-state/`、决策日志 `<shadowDir>/sweep-log.jsonl`；
 *   - 正式模式（P1 ④）：给 `ledgerDir`（cc-memory/ledgers/）与 `stateDir`，日志与心跳各自给路径。
 * 每端各自的静默阈值走 `policyBySource`（Alice 10-23 拍板：CC 60 分钟 / 候选 12 小时，其余端 30 分钟 / 6 小时）。
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { LockTimeoutError, withLock } from "./distill-lock.js";
import type { LLMClient } from "./llm-client.js";
import { redactSecrets } from "./pii-detector.js";
import { buildLedger, renderLedgerMarkdown, type GenerateLedgerOptions, type LedgerBody, type LedgerMeta } from "./session-ledger.js";
import { parseSessionFile, summarizeSession, type SessionDoc, type SessionSource } from "./session-events.js";
import { applyDecision, decide, DEFAULT_POLICY, discoverTranscripts, ledgerRelPath, SessionStateStore, sid8, type RootSpec, type SweepAction, type SweepPolicy, type TranscriptFile } from "./sessions-sweep.js";
import { addToIndex, buildSignatureIndex, ledgerDirDigest, ledgerFileSignatures, lookupSignatures, readSignatureIndex, recurrenceLines, recurrenceSignatures, writeSignatureIndex, type SignatureIndex } from "./ledger-signatures.js";
import type { SessionSummary } from "./session-events.js";
import { judgeRecallLog } from "./recall-outcome.js";
import { RECALL_LOG_DIRNAME, recallLogFileName } from "./recall-log.js";

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
  /** 账本签名索引的落点（报错召回的 hook 读它，P1 ⑥）；不给就不写。本轮写了账本、或文件还不存在时才写 */
  signatureIndexPath?: string;
  /** recall-log 所在的数据目录（<dir>/recall-log/<sid>.jsonl）；给了就在会话静默后判四态（P1 ⑥） */
  recallLogRoot?: string;
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
  /** 账本提交锁所在目录（测试用；默认数据目录下的 locks/，收工命令与扫描器必须是同一个） */
  lockDir?: string;
  /** 提交锁最多等多久（测试用；默认 LEDGER_COMMIT_WAIT_MS） */
  commitWaitMs?: number;
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
  /** 本轮判出的 recall-log 四态计数 */
  recallOutcomes?: Record<string, number>;
  /** 写了心跳时带回本轮心跳（CLI 据此定退出码） */
  heartbeat?: SweepHeartbeat;
}

/** 解析过且过了静默判据的决策：可以判 recall-log（not-idle 没静默；skip-* 在静默判据之前就返回了） */
const JUDGEABLE_ACTIONS: ReadonlySet<SweepAction> = new Set<SweepAction>(["ledger", "ledger+candidates", "candidates", "up-to-date", "deferred"]);

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
/** 一轮跑了这么久还没完 doctor 报红（包装脚本 45 分钟就杀，正常到不了） */
export const SWEEP_STUCK_MS = 2 * 3_600_000;
/** 连续这么多轮开始了都没跑完（被杀或崩溃，含正在跑的这一轮）doctor 报红 */
export const SWEEP_UNFINISHED_STARTS_RED = 3;

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
  /** 这轮有没有配 LLM（没配时账本只有机器抽取的两节，doctor 要报黄，P1 互审 R1 Kimi #6） */
  llmConfigured: boolean;
  /** 上一轮还在跑、本轮因锁跳过的时刻（手动跑撞上 launchd 那一轮时会有；launchd 自己不会叠跑） */
  busyAt?: string | null;
  /**
   * 正在跑的这一轮从什么时候开始（runSweep 一开头写，跑完清成 null）。launchd 在上一轮没完时不起第二轮，
   * 长跑期间 busyAt 写不进来，doctor 靠它判「还活着」（P1 互审 R3 Codex K6）
   */
  runningSince?: string | null;
  runningPid?: number | null;
  /** 上次跑完之后开始了几轮（含正在跑的这一轮）；跑完清零。被杀 / 崩溃的轮次会让它一路涨 */
  startsSinceDone?: number;
}

/** 一轮开始：在心跳上记 runningSince / runningPid、开始轮数 +1；还没有心跳（第一轮）就建一份「从没跑完过」的（at 为空） */
export function markHeartbeatRunning(path: string, opts: { nowIso?: string; pid?: number; llmConfigured: boolean }): void {
  const prev = readHeartbeat(path);
  const base: SweepHeartbeat = prev ?? { at: "", wallMs: 0, discovered: 0, actions: {}, ledgersWritten: 0, llmCalls: 0, llmFailures: 0, llmFailStreak: 0, lastLlmFailureAt: null, llmConfigured: opts.llmConfigured };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ ...base, runningSince: opts.nowIso ?? new Date().toISOString(), runningPid: opts.pid ?? process.pid, startsSinceDone: (prev?.startsSinceDone ?? 0) + 1 })}\n`);
  renameSync(tmp, path);
}

/** 锁忙跳过的那一笔记在心跳旁的这个小文件里 */
export function busyPathFor(heartbeatPath: string): string {
  return `${heartbeatPath}.busy`;
}

/**
 * 锁被占、本轮跳过：另写一个小文件记 busyAt，不碰主心跳。这个进程没拿扫描锁，若在锁外读改写主心跳，
 * 读到的可能是正在跑那一轮的「在跑」快照、写回时盖掉它刚写的完成时间与失败连击（P1 互审 R4 R3 Codex NEW-4 / Kimi NEW-3）
 */
export function touchHeartbeatBusy(path: string, nowIso = new Date().toISOString()): void {
  const busy = busyPathFor(path);
  mkdirSync(dirname(busy), { recursive: true });
  const tmp = `${busy}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ busyAt: nowIso, pid: process.pid })}\n`);
  renameSync(tmp, busy);
}

/** 最近一次「锁忙跳过」的时刻：.busy 文件与旧版写在主心跳里的 busyAt 取较新的；都没有返回 null */
export function readBusyAt(heartbeatPath: string, hb?: Pick<SweepHeartbeat, "busyAt"> | null): string | null {
  let side: string | null = null;
  try {
    const v = (JSON.parse(readFileSync(busyPathFor(heartbeatPath), "utf-8")) as { busyAt?: unknown }).busyAt;
    if (typeof v === "string" && Number.isFinite(Date.parse(v))) side = v;
  } catch {
    /* 没有或写坏了 */
  }
  const inline = hb?.busyAt && Number.isFinite(Date.parse(hb.busyAt)) ? hb.busyAt : null;
  if (!side) return inline;
  if (!inline) return side;
  return Date.parse(side) >= Date.parse(inline) ? side : inline;
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
  // 影子模式不许落进正式账本目录（目录或它的上级有写入端标记）：否则影子产物会混进正式账本、被对账导入（R5 Codex #3）
  if (opts.shadowDir && !opts.dryRun) {
    const marker = findLedgerWriterMarker(ledgerRoot);
    if (marker) throw new Error(`影子目录 ${ledgerRoot} 落在正式账本目录里（${marker.path}），换一个影子目录`);
  }
  const sweepLog = opts.logPath ?? (opts.shadowDir ? join(opts.shadowDir, "sweep-log.jsonl") : null);
  // 日志与终端里账本路径的显示基准：影子模式相对 shadowDir（ledgers/2026-10/x.md），正式模式相对账本根的上一级
  const displayBase = opts.shadowDir ?? dirname(ledgerRoot);
  const show = (p: string) => relative(displayBase, p);
  if (!opts.dryRun) {
    mkdirSync(ledgerRoot, { recursive: true });
    if (sweepLog) mkdirSync(dirname(sweepLog), { recursive: true });
    // 一开头就记「这一轮在跑」：一轮可能跑几十分钟，完成心跳要到结尾才写（P1 互审 R3 Codex K6）
    if (opts.heartbeatPath) markHeartbeatRunning(opts.heartbeatPath, { llmConfigured: !!opts.llm });
  }
  const candidatesOn = opts.candidates ?? true;
  // 签名索引：第一次要写账本时从账本目录建一次，之后每写一份就地更新（P1 ⑥ 复发节）
  let sigIndex: SignatureIndex | null = null;
  const getIndex = (): SignatureIndex => (sigIndex ??= buildSignatureIndex(ledgerRoot));

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
    // 上次 LLM 失败、退避还没到：这轮不再调（P1 互审 R1 Kimi #1）
    if ((decision.action === "ledger" || decision.action === "ledger+candidates" || decision.action === "candidates") && state.llmRetryAt && nowMs < Date.parse(state.llmRetryAt)) {
      decision = { ...decision, action: "up-to-date", reason: `LLM 上次失败，${state.llmRetryAt} 之后重试` };
    }
    // 候选关着时：「ledger+candidates」降成只写账本（候选记已处理，不再到期）；只剩候选到期的「candidates」不重生成
    if (!candidatesOn && decision.action === "candidates") decision = { ...decision, reason: `${decision.reason}（候选关闭，只记已处理）` };
    actions[decision.action] = (actions[decision.action] ?? 0) + 1;
    const needsLedger = decision.action === "ledger" || decision.action === "ledger+candidates" || (decision.action === "candidates" && candidatesOn);
    let ledgerPath: string | undefined;
    let llmFailedThisPass = false;
    /** 提交锁等不到：这一轮不写、游标不动，下一轮再来 */
    let deferredThisPass = false;
    let agentPath: string | null = null;
    let usageNote: Record<string, unknown> = {};
    if (needsLedger && decision.doc && !opts.dryRun) {
      if (opts.llm && opts.llmDelayMs && result.llmCalls > 0) await new Promise((r) => setTimeout(r, opts.llmDelayMs));
      const pass = decision.action === "candidates" ? state.pass : state.pass + 1;
      // D2 两步：第一次静默只写事实账本，候选到期（ledger+candidates / candidates）才出经验
      const includeCandidates = candidatesOn && decision.action !== "ledger";
      const recurrence = recurrenceFor(getIndex(), decision.doc, decision.summary ?? summarizeSession(decision.doc));
      const render = await buildLedger(decision.doc, { trigger: opts.trigger ?? "auto-sweep", pass, machine: file.machine, generatedAt: new Date(nowMs).toISOString(), recurrence }, opts.llm, { ...opts.render, includeCandidates });
      if (opts.llm) {
        result.llmCalls++;
        if (render.usage) {
          result.llmPromptTokens += render.usage.promptTokens;
          result.llmCompletionTokens += render.usage.completionTokens;
        }
        if (render.generator === "llm-failed") result.llmFailures++;
        usageNote = { generator: render.generator, tokens: render.usage ? [render.usage.promptTokens, render.usage.completionTokens] : null, wallMs: render.usage?.wallMs ?? null, failure: render.failure ? redactSecrets(render.failure).text.slice(0, 300) : undefined, candidates: includeCandidates, experience: render.body?.experience.length ?? 0, anchorsUnverified: render.body?.experience.filter((x) => !x.anchorVerified).length ?? 0 };
      }
      llmFailedThisPass = !!opts.llm && render.generator === "llm-failed";
      // 提交走会话锁、锁内重读账本头：等 LLM 的这段时间里收工命令写进来的当场账本不会被盖掉（P1 互审 R1 Codex #2、R3 C2/K4）。
      // LLM 失败时只在还没有账本时写机器抽取版（报错签名照样进索引），已有的不拿残版盖、之后按退避重试
      const commit = await commitLedger({ ledgerRoot, doc: decision.doc, stateLedgerPath: state.ledgerPath, markdown: render.markdown, mode: llmFailedThisPass ? "fallback" : "generated", lockDir: opts.lockDir, waitMs: opts.commitWaitMs, shadow: !!opts.shadowDir });
      if (commit.written) {
        ledgerPath = commit.path;
        result.ledgersWritten.push(ledgerPath);
        produced++;
        addToIndex(getIndex(), { session: decision.doc.sessionId, ended: decision.doc.endedAt ?? "", file: relative(ledgerRoot, ledgerPath), title: render.body?.oneLine ?? "" }, ledgerFileSignatures(render.markdown));
      } else if (commit.reason === "agent-ledger") {
        keepAgentUpto = decision.lastMessageAt ?? decision.doc.endedAt ?? null;
        agentPath = commit.path;
        llmFailedThisPass = false;
        actions[decision.action] = (actions[decision.action] ?? 1) - 1;
        actions["up-to-date"] = (actions["up-to-date"] ?? 0) + 1;
        decision = { ...decision, action: "up-to-date", reason: "生成期间收工账本已写入，放弃本次生成" };
      } else if (commit.reason === "busy") {
        deferredThisPass = true;
        actions[decision.action] = (actions[decision.action] ?? 1) - 1;
        actions.deferred = (actions.deferred ?? 0) + 1;
        decision = { ...decision, action: "deferred", reason: `${decision.reason}（账本提交锁没等到，下一轮再写）` };
      }
    }
    // 会话已经静默够久（过了静默判据）：判它 recall-log 里还没判的记录。不只看「这轮出了账本」——
    // 收工账本写完之后再没有新事件、候选关着时候选到期，都不会再出账本，记录就永远没人判（P1 互审 R4 Codex #2、Kimi #7）。
    // 转录没变时 decide 走 mtime 快路、不解析（没有 doc），可 recall-log 是别的进程追加的、判完之后还会长：
    // 游标另记「上次判的时候主日志多大」，主日志比那时大就解析一次再判（R4 R3 Codex #2 前半）
    let judged: { bytes: number; sid: string } | null = null;
    if (opts.recallLogRoot && !opts.dryRun && JUDGEABLE_ACTIONS.has(decision.action)) {
      // 大小在判之前取：判的时候又追加进来的行这轮也判了，下一轮看到变大再解析一次，已判的不重判。
      // 日志按解析出的会话 id 命名，它可以和转录文件名不同（文件名不是 UUID 时取内容里的 id）：没解析时用上次判时记下的 id（R5 Codex #5）
      const logSid = decision.doc?.sessionId ?? state.recallLogSid ?? file.sessionId;
      const logBytes = fileSize(join(opts.recallLogRoot, RECALL_LOG_DIRNAME, recallLogFileName(logSid)));
      let judgeDoc = decision.doc;
      // 游标是 R5 之前写的（没有 recallLogSid）：文件名 id 可能不是会话 id，按它预查到的日志永远不长，解析一次拿到真实 id 记下（R6 Codex #5）
      if (!judgeDoc && (logBytes > (state.recallLogBytes ?? 0) || state.recallLogSid === undefined)) {
        try {
          judgeDoc = parseSessionFile(file.path, { source: file.source });
        } catch (error) {
          log(`! ${file.source} ${file.sessionId.slice(0, 8)} recall-log 待判、解析转录失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (judgeDoc) {
        // 先解析后才知道真实 id 的那一轮（转录没变、按文件名 id 预查），大小按真实 id 重取——也要在判之前取：
        // 判完再取，判的时候别的进程追加的行这轮没判、大小却记进了游标，之后再也不会判（R6 Codex NEW-6）
        const sid = judgeDoc.sessionId;
        const bytes = sid === logSid ? logBytes : fileSize(join(opts.recallLogRoot, RECALL_LOG_DIRNAME, recallLogFileName(sid)));
        const counts = judgeRecallLog(opts.recallLogRoot, judgeDoc, new Date(nowMs).toISOString());
        if (counts) for (const [k, v] of Object.entries(counts)) (result.recallOutcomes ??= {})[k] = ((result.recallOutcomes ?? {})[k] ?? 0) + (v ?? 0);
        judged = { sid, bytes };
      }
    }
    if (!opts.dryRun) {
      // LLM 失败 / 提交锁没等到：游标不推进（processedUpto / pass / 候选状态都留在原处）。
      // LLM 失败另记退避——下一次在 30 分钟 × 2^(n-1)、封顶 6 小时后；锁没等到不退避，下一轮照常再来
      const next = llmFailedThisPass || deferredThisPass
        ? { ...state, path: file.path, lastSweepAt: new Date(nowMs).toISOString(), lastAction: decision.action, notIdleSince: null, ...(ledgerPath ? { ledgerPath } : {}) }
        : applyDecision(state, file, decision, nowMs, policy, ledgerPath);
      if (llmFailedThisPass) {
        next.llmFailCount = (state.llmFailCount ?? 0) + 1;
        next.llmRetryAt = new Date(nowMs + Math.min(30 * 60_000 * 2 ** (next.llmFailCount - 1), 6 * 3_600_000)).toISOString();
      } else if (!deferredThisPass && needsLedger && (decision.action === "ledger" || decision.action === "ledger+candidates" || decision.action === "candidates")) {
        next.llmRetryAt = null;
        next.llmFailCount = 0;
      }
      if (keepAgentUpto) {
        next.processedUpto = keepAgentUpto;
        next.candidateDone = true;
        const kept = agentPath ?? targetPath;
        if (kept) next.ledgerPath = kept;
      }
      if (judged) {
        next.recallLogBytes = judged.bytes;
        next.recallLogSid = judged.sid;
      }
      stateStore.save(next);
      // 没变化的场不写逐场日志：每 10 分钟一轮、每轮上千场都是 unchanged，一周把日志堆到 353MB（2026-10-31 量）；
      // 这两类的个数照旧进 actions / 心跳，逐场行只留真有动作或有原因可查的
      const quiet = decision.action === "unchanged" || (decision.action === "up-to-date" && decision.reason === "mtime unchanged, candidates done or not due");
      if (sweepLog && !quiet) appendFileSync(sweepLog, `${JSON.stringify({ ts: new Date(nowMs).toISOString(), source: file.source, sid8: file.sessionId.slice(0, 8), action: decision.action, reason: decision.reason, userTurns: decision.summary?.userTurns ?? null, rich: decision.summary?.rich ?? null, lastMessageAt: decision.lastMessageAt ?? null, ledger: ledgerPath ? show(ledgerPath) : null, ...usageNote })}\n`);
    }
    if (needsLedger) log(`${decision.action.padEnd(18)} ${file.source.padEnd(11)} ${file.sessionId.slice(0, 8)} ${decision.reason}${ledgerPath ? ` → ${show(ledgerPath)}` : ""}`);
  }
  // 签名索引：本轮写了账本、或账本目录和索引建的时候不一样（收工命令当场写的、上一轮写完账本却在写索引前被杀的、
  // 恢复或带原 mtime 拷进来的）就从磁盘整份重建。只看「本轮写没写」，这些账本的签名要等到哪一轮恰好又写账本才进索引
  // （P1 互审 R4 Codex #2、Kimi #2）；只比「最新 mtime 与 builtAt」，mtime 比 builtAt 旧的进不来（R4 R3 Codex #2 后半）
  if (opts.signatureIndexPath && !opts.dryRun) {
    const onDisk = readSignatureIndex(opts.signatureIndexPath);
    if (result.ledgersWritten.length > 0 || !onDisk || onDisk.sourceDigest !== ledgerDirDigest(ledgerRoot)) writeSignatureIndex(opts.signatureIndexPath, buildSignatureIndex(ledgerRoot));
  }
  result.wallMs = Math.round(performance.now() - t0);
  if (opts.heartbeatPath && !opts.dryRun) {
    const at = new Date().toISOString();
    const hb: SweepHeartbeat = { at, wallMs: result.wallMs, discovered: result.discovered, actions: result.actions, ledgersWritten: result.ledgersWritten.length, llmCalls: result.llmCalls, llmFailures: result.llmFailures, ...nextLlmFailState(readHeartbeat(opts.heartbeatPath), result, at), llmConfigured: !!opts.llm, busyAt: null, runningSince: null, runningPid: null, startsSinceDone: 0 };
    result.heartbeat = hb;
    mkdirSync(dirname(opts.heartbeatPath), { recursive: true });
    const tmp = `${opts.heartbeatPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(hb)}\n`);
    renameSync(tmp, opts.heartbeatPath);
  }
  return result;
}

/** 本场的具体性报错签名里，以前在别的会话（结束早于本场）出现过的那些 → 账本「疑似又踩」节的行 */
export function recurrenceFor(index: SignatureIndex, doc: SessionDoc, summary: SessionSummary): string[] {
  const sigs = new Map<string, string>();
  for (const e of summary.errors) for (const [k, v] of recurrenceSignatures(e.text)) if (!sigs.has(k)) sigs.set(k, v);
  if (sigs.size === 0) return [];
  return recurrenceLines(lookupSignatures(index, sigs, { excludeSession: doc.sessionId, beforeIso: doc.endedAt ?? undefined }));
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
 * 一场会话出两份；这几处都没有，再到每个月份目录里找一遍同名文件、核 frontmatter 的 session——
 * 会话跨了三个月份、本机又没有游标（跨机）时，账本在中间那个月（P1 互审 R3 Codex C3 / K5）。都没有才按结束月份新建。
 */
export function ledgerTargetPath(ledgerRoot: string, doc: SessionDoc, stateLedgerPath?: string): string {
  const candidates = [
    stateLedgerPath && stateLedgerPath.startsWith(ledgerRoot) ? stateLedgerPath : null,
    doc.endedAt ? join(ledgerRoot, ledgerRelPath(doc.sessionId, doc.endedAt)) : null,
    doc.startedAt ? join(ledgerRoot, ledgerRelPath(doc.sessionId, doc.startedAt)) : null,
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? findLedgerBySession(ledgerRoot, doc.sessionId) ?? candidates[0] ?? join(ledgerRoot, ledgerRelPath(doc.sessionId, new Date().toISOString()));
}

/** 在账本根下每个 YYYY-MM 目录里找 <sid8>.md，frontmatter 的 session 对得上才算；多份取最新的月份 */
function findLedgerBySession(ledgerRoot: string, sessionId: string): string | null {
  let months: string[];
  try {
    months = readdirSync(ledgerRoot).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort().reverse();
  } catch {
    return null;
  }
  const name = `${sid8(sessionId)}.md`;
  for (const m of months) {
    const p = join(ledgerRoot, m, name);
    if (existsSync(p) && readLedgerHead(p)?.session === sessionId) return p;
  }
  return null;
}

/** 账本提交锁的键前缀：后面接完整 session id。扫描器与收工命令都拿它（同一个数据目录下的 locks/） */
export const LEDGER_COMMIT_LOCK_PREFIX = "ledger-commit-";
/** 提交锁最多等多久：锁里只有读 4KB、写文件、改名，正常几毫秒；等这么久还没拿到说明持有方卡住了 */
export const LEDGER_COMMIT_WAIT_MS = 30_000;

/**
 * agent：收工命令带正文的那份，无条件写（第一层，后写者胜）；
 * generated：LLM 生成的（或 --no-llm 的机器版），锁内复查到当场 agent 账本还管着这场就放弃；
 * fallback：LLM 失败时的机器抽取版，锁内复查到已有任何账本就放弃（不拿残版盖）
 */
export type LedgerCommitMode = "agent" | "generated" | "fallback";
export type LedgerCommitResult = { written: true; path: string } | { written: false; path: string; reason: "agent-ledger" | "exists" | "busy" };

/**
 * 把一份账本提交到落点。会话锁只包「重新定位 → 重读 frontmatter → 判断 → 写临时文件改名」，不包 LLM 调用——
 * 扫描器一轮可能持锁几分钟，锁住生成会挡住收工命令（R1 否决共用会话锁的理由）；只锁提交，复查与改名之间就没有窗口了
 * （P1 互审 R3 Codex C2 / K4，收工命令自己的 LLM 分支 NEW-1）。
 * 这把锁是本机的 flock，只管得住本机的扫描器与收工命令；另一台机器写、经 Syncthing 同步进来的账本不经过它，
 * 照样可能落在复查与改名之间。跨机靠的是账本目录只许一台机器写（checkLedgerWriter，R4 R3 Codex NEW-2），不是这把锁。
 */
export async function commitLedger(o: { ledgerRoot: string; doc: SessionDoc; stateLedgerPath?: string; markdown: string; mode: LedgerCommitMode; lockDir?: string; waitMs?: number; host?: string; shadow?: boolean }): Promise<LedgerCommitResult> {
  // 落点（或它的上级）归别的机器写：不管从哪条路径进来都不写（R5 Codex #3：影子模式把 --shadow 指到正式目录的上级就能绕过命令层的检查）
  const host = o.host ?? hostname();
  assertWritableLedgerDir(o.ledgerRoot, host, o.shadow);
  const key = `${LEDGER_COMMIT_LOCK_PREFIX}${o.doc.sessionId}`;
  try {
    // lock-wait: no store-write inside（锁里只有读账本头、写文件、改名，不碰记忆库）
    const outcome = await withLock(key, async (): Promise<LedgerCommitResult> => {
      // 锁内重新定位：等锁期间对方可能已在别的月份目录写了这场的账本
      const path = ledgerTargetPath(o.ledgerRoot, o.doc, o.stateLedgerPath);
      // 最终落点所在目录再核一次（按真实路径往上找）：根下的月目录可以是指向正式目录的符号链接，根上找不到标记（R6 Codex #3）
      assertWritableLedgerDir(dirname(path), host, o.shadow);
      if (o.mode !== "agent" && agentLedgerCovers(path, o.doc)) return { written: false, path, reason: "agent-ledger" };
      if (o.mode === "fallback" && existsSync(path)) return { written: false, path, reason: "exists" };
      mkdirSync(dirname(path), { recursive: true });
      // 先写临时文件再改名：Syncthing / 对账导入不会读到写了一半的账本
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, o.markdown);
      renameSync(tmp, path);
      return { written: true, path };
    }, { onBusy: "wait", waitTimeoutMs: o.waitMs ?? LEDGER_COMMIT_WAIT_MS, maxHoldMs: 60_000, lockDir: o.lockDir });
    if (outcome.ran) return outcome.result;
  } catch (error) {
    // 认错误类型，不认文字前缀：锁模块改了措辞，这里不能把「等不到」当成真错误抛出去（R4 R3 Kimi NEW-1）
    if (!(error instanceof LockTimeoutError && error.key === key)) throw error;
  }
  return { written: false, path: ledgerTargetPath(o.ledgerRoot, o.doc, o.stateLedgerPath), reason: "busy" };
}

/** 归别的机器写的目录不写；影子提交（shadow）碰到任何标记都不写，本机的也算——影子产物不许混进正式账本（R6 Codex #3） */
function assertWritableLedgerDir(dir: string, host: string, shadow?: boolean): void {
  const marker = findLedgerWriterMarker(dir);
  if (!marker) return;
  if (shadow) throw new Error(`影子账本的落点 ${dir} 在正式账本目录里（${marker.path}），不写`);
  if (marker.owner !== host) throw new Error(`账本目录归 ${marker.owner || (marker.readError ? `（标记文件读不了：${marker.readError}）` : "（标记文件是空的）")} 写（${marker.path}），本机是 ${host}，不写`);
}

/** 账本目录里记「哪台机器写这个目录」的文件（随目录同步到别的机器，别的机器读得到） */
export const LEDGER_WRITER_FILE = ".writer-host";

export type LedgerWriterCheck = { ok: true; host: string } | { ok: false; host: string; owner: string | null; path: string; readError?: string };

/**
 * 从 dir 往上找最近的写入端标记（dir 不存在就从它最近的现存上级开始，按真实路径解析符号链接）。
 * 往上找是为了影子目录、符号链接、嵌套目录落进正式账本目录时也认得出来（R5 Codex #3）。
 */
export function findLedgerWriterMarker(dir: string): { path: string; owner: string; readError?: string } | null {
  let d = resolve(dir);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  try {
    d = realpathSync(d);
  } catch {
    /* 读不了就按原路径 */
  }
  for (;;) {
    const p = join(d, LEDGER_WRITER_FILE);
    if (existsSync(p)) {
      let owner = "";
      let readError: string | undefined;
      try {
        owner = readFileSync(p, "utf-8").trim();
      } catch (error) {
        // 读不了按空的算：谁都对不上。但要把原因带出去——10-23、10-27 两晚 23:50 各有两轮读成空，文件本身没变过，原因被吞了查不到
        readError = (error as NodeJS.ErrnoException).code ?? String(error);
      }
      return readError ? { path: p, owner, readError } : { path: p, owner };
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * 账本目录只许一台机器写（P1 互审 R4 R3 Codex NEW-2）。提交锁是本机 flock，另一台机器写、经 Syncthing 同步进来的
 * 收工账本若落在本机「复查 → 改名」之间，会被扫描结果盖掉——跨机没有锁可拿，只能不让第二台机器写。
 * 标记不会自动认领（R5 Codex #2：两台机器在标记同步过来之前各自认领，就又成了两个写入端）：要在选定的那台上
 * 显式跑一次 `sessions writer --claim`（安装脚本 install 时调它）。没有标记时，收工命令与正式扫描都拒绝；dry-run 不查。
 */
export function checkLedgerWriter(ledgerDir: string, opts: { host?: string } = {}): LedgerWriterCheck {
  const host = opts.host ?? hostname();
  const marker = findLedgerWriterMarker(ledgerDir);
  if (!marker) return { ok: false, host, owner: null, path: join(ledgerDir, LEDGER_WRITER_FILE) };
  return marker.owner === host ? { ok: true, host } : { ok: false, host, owner: marker.owner, path: marker.path, ...(marker.readError ? { readError: marker.readError } : {}) };
}

/** 显式认领账本目录（`sessions writer --claim`）：没有标记就独占创建；已经是本机照常；别的机器的不动 */
export function claimLedgerWriter(ledgerDir: string, opts: { host?: string } = {}): (LedgerWriterCheck & { claimed?: boolean }) {
  const host = opts.host ?? hostname();
  if (!findLedgerWriterMarker(ledgerDir)) {
    mkdirSync(ledgerDir, { recursive: true });
    try {
      writeFileSync(join(ledgerDir, LEDGER_WRITER_FILE), `${host}\n`, { flag: "wx" });
      return { ok: true, host, claimed: true };
    } catch (error) {
      // 同时有人建了：按它写进去的判；不是这个原因（建不了文件）就照原样报
      if (!findLedgerWriterMarker(ledgerDir)) throw error;
    }
  }
  return { ...checkLedgerWriter(ledgerDir, { host }), claimed: false };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
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
  /** 账本提交锁所在目录（测试用；默认数据目录下的 locks/） */
  lockDir?: string;
}

export interface WriteLedgerNowResult {
  path: string;
  generator: string;
  failure?: string;
  written: boolean;
  /** 没给正文、这场已有当场 agent 写的账本且之后没有新的用户发言：不用 LLM 版去盖它（之前已有、或等 LLM 期间写进来的） */
  skipped?: "agent-ledger";
}

/**
 * 当场写一份账本（P1 ⑤：收工流程写同一格式的文件）。正文优先用当场 agent 给的（第一层，质量），
 * 没给才调 LLM；机器抽取两节照常从转录里抽。写完把游标推到当前最后一条消息、候选记已处理——
 * 扫描器之后只在有新的用户发言时才重写它。提交走和扫描器同一把会话锁（commitLedger）。
 */
export async function writeSessionLedgerNow(o: WriteLedgerNowOptions): Promise<WriteLedgerNowResult> {
  const nowMs = o.nowMs ?? Date.now();
  const doc = parseSessionFile(o.file.path, { source: o.file.source });
  if (!doc.endedAt) throw new Error(`转录里没有带时间的事件：${o.file.path}`);
  const summary = summarizeSession(doc);
  const meta: LedgerMeta = { trigger: o.trigger, pass: 0, machine: o.file.machine, generatedAt: new Date(nowMs).toISOString(), recurrence: recurrenceFor(buildSignatureIndex(o.ledgerDir), doc, summary) };
  const store = new SessionStateStore(o.stateDir);
  const state = store.load(store.fresh(o.file).key) ?? store.fresh(o.file);
  meta.pass = state.pass + 1;
  // 没给正文、当场账本还管着这场：不调 LLM（LLM 版只会比当场写的差，写出来也要被提交锁里的复查挡掉）
  const existing = ledgerTargetPath(o.ledgerDir, doc, state.ledgerPath);
  if (!o.body && agentLedgerCovers(existing, doc)) return { path: existing, generator: "agent", written: false, skipped: "agent-ledger" };
  const render = o.body
    ? renderLedgerMarkdown(doc, summary, o.body, meta, null, "agent")
    : await buildLedger(doc, meta, o.llm ?? null, { ...o.render, includeCandidates: false });
  // 没给正文、LLM 又没生成出来：不盖已有账本、不推进游标，交给扫描器之后补（P1 互审 R1 Codex #4）
  if (render.generator !== "agent" && render.generator !== "llm") return { path: existing, generator: render.generator, failure: render.failure ?? "no llm", written: false };
  // 只有带正文的那份无条件写；LLM 版在锁内复查——等 LLM 期间另一次带正文的收工写进来了，就不盖它（P1 互审 R3 Codex NEW-1）
  const commit = await commitLedger({ ledgerRoot: o.ledgerDir, doc, stateLedgerPath: state.ledgerPath, markdown: render.markdown, mode: render.generator === "agent" ? "agent" : "generated", lockDir: o.lockDir });
  if (!commit.written) {
    if (commit.reason === "busy") throw new Error(`账本提交锁（${LEDGER_COMMIT_LOCK_PREFIX}${doc.sessionId}）等了 ${LEDGER_COMMIT_WAIT_MS / 1000} 秒没拿到：另一个进程卡在提交里，账本与游标都没动`);
    return { path: commit.path, generator: render.generator, written: false, skipped: "agent-ledger" };
  }
  // lastMtimeMs 不记：扫描器下一轮静默后要真解析一次（判这场的 recall-log），不能被 mtime 粗筛直接判 up-to-date（P1 互审 R4 Codex #2）
  store.save({ ...state, path: o.file.path, processedUpto: doc.endedAt, pass: meta.pass, candidateDueAt: null, candidateDone: true, lastMtimeMs: null, lastSweepAt: new Date(nowMs).toISOString(), lastAction: "manual", notIdleSince: null, ledgerPath: commit.path });
  return { path: commit.path, generator: render.generator, failure: render.failure, written: true };
}
