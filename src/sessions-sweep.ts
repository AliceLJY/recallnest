/**
 * sessions-sweep — 转录扫描器（plan.md v2.1 D2 / v3 机械件①）。
 *
 * P0 影子模式：只读转录、只写 `--shadow <dir>` 下的样例账本与游标文件，不写 LanceDB、不碰 `cc-memory/ledgers/`。
 * 正式模式（写 `ledgers/`、launchd 装任务）在 P1；本文件里非影子路径一律抛错，不留半成品。
 *
 * 入队谓词（D2 原文，Codex R3 新问题 1 的修订）：
 *   入队 =（转录静默 ≥ idleMinutes 且 最后消息时间 > processedUpto）或（now ≥ candidateDueAt 且候选阶段未做）
 *   第一次只写账本；经验候选在 lastMessageAt + candidateAfterMinutes 到期才出。同一 sid 再活跃就再处理，每次 pass 都重写账本。
 *
 * 游标用「最后一条消息的时间」而不是「文件存在 / mtime」：mtime 会被同步工具改写，消息时间不会。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { parseSessionFile, sessionIdFromPath, summarizeSession, type SessionDoc, type SessionSource, type SessionSummary } from "./session-events.js";

export interface RootSpec {
  source: SessionSource;
  dir: string;
  /** 这棵树里的会话来自哪台机（能确定才填；mini 的 ~/.claude/projects 混着 MacBook 拉来的，填不了） */
  machine?: string;
}

/** D2「扫哪些目录」：本机四端 + MacBook 拉来的 agy 落点。发布版默认只有前四个。 */
export function defaultLocalRoots(home = homedir()): RootSpec[] {
  return [
    { source: "cc", dir: join(home, ".claude", "projects") },
    { source: "codex", dir: join(home, ".codex", "sessions") },
    { source: "kimi", dir: join(home, ".kimi-code", "sessions") },
    { source: "antigravity", dir: join(home, ".gemini", "antigravity-cli", "brain"), machine: "mini" },
    { source: "antigravity", dir: join(home, "machine-data", "macbook-agy", "brain"), machine: "macbook" },
  ];
}

/** 统一查询树（Deja 的 conversation-truth）：量数用它，因为它把两台机的会话都收齐了 */
export function truthRoots(home = homedir()): RootSpec[] {
  const t = join(home, "conversation-truth");
  return [
    { source: "cc", dir: join(t, "claude", "projects") },
    { source: "codex", dir: join(t, "codex", "sessions", "by-session") },
    { source: "kimi", dir: join(t, "kimi", "sessions") },
    { source: "antigravity", dir: join(t, "antigravity", "brain") },
  ];
}

export interface TranscriptFile {
  path: string;
  source: SessionSource;
  sessionId: string;
  mtimeMs: number;
  sizeBytes: number;
  machine?: string;
}

export interface DiscoveryResult {
  files: TranscriptFile[];
  /** 本轮 stat 了多少个目录项 / 花了多少墙钟（数⑦） */
  statCalls: number;
  wallMs: number;
  missingRoots: string[];
}

/** 四端的文件发现规则（与 session-events 的路径判据一致） */
export function discoverTranscripts(roots: RootSpec[], opts: { sinceMs?: number } = {}): DiscoveryResult {
  const t0 = performance.now();
  const files: TranscriptFile[] = [];
  const missingRoots: string[] = [];
  let statCalls = 0;
  const since = opts.sinceMs ?? 0;

  const consider = (path: string, root: RootSpec) => {
    statCalls++;
    const st = statSync(path);
    if (st.mtimeMs < since) return;
    files.push({ path, source: root.source, sessionId: sessionIdFromPath(path, root.source), mtimeMs: st.mtimeMs, sizeBytes: st.size, machine: root.machine });
  };

  const walk = (dir: string, root: RootSpec, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (root.source === "cc" && e.name === "subagents") continue;
        if (root.source === "antigravity" && depth === 0) {
          // brain/<sid>/.system_generated/logs/transcript_full.jsonl（没有就退到 transcript.jsonl）
          const logs = join(p, ".system_generated", "logs");
          const full = join(logs, "transcript_full.jsonl");
          const plain = join(logs, "transcript.jsonl");
          statCalls++;
          if (existsSync(full)) consider(full, root);
          else {
            statCalls++;
            if (existsSync(plain)) consider(plain, root);
          }
          continue;
        }
        walk(p, root, depth + 1);
      } else if (e.isFile()) {
        if (root.source === "kimi") {
          if (e.name === "wire.jsonl" && basename(dir) === "main") consider(p, root);
        } else if (root.source === "cc" || root.source === "codex") {
          if (e.name.endsWith(".jsonl")) consider(p, root);
        }
      }
    }
  };

  for (const root of roots) {
    if (!existsSync(root.dir)) {
      missingRoots.push(root.dir);
      continue;
    }
    walk(root.dir, root, 0);
  }
  return { files, statCalls, wallMs: Math.round(performance.now() - t0), missingRoots };
}

// ---------------------------------------------------------------- 游标

export interface SessionState {
  key: string;
  source: SessionSource;
  sessionId: string;
  path: string;
  /** 已处理到的最后一条消息时间（ISO）；null = 从未处理 */
  processedUpto: string | null;
  pass: number;
  candidateDueAt: string | null;
  candidateDone: boolean;
  lastMtimeMs: number | null;
  lastSweepAt: string | null;
  lastAction: SweepAction | null;
  skipReason?: string;
  /** 上一轮写出的账本文件（影子模式下是样例路径） */
  ledgerPath?: string;
}

export type SweepAction =
  | "not-idle"
  | "unchanged"
  | "skip-short"
  | "skip-imported"
  | "skip-subagent"
  | "skip-no-timestamp"
  | "ledger"
  | "ledger+candidates"
  | "candidates"
  | "up-to-date";

export interface SweepPolicy {
  idleMinutes: number;
  candidateAfterMinutes: number;
  minUserTurns: number;
}

export const DEFAULT_POLICY: SweepPolicy = { idleMinutes: 30, candidateAfterMinutes: 360, minUserTurns: 3 };

export function stateKey(source: SessionSource, sessionId: string): string {
  return `${source}__${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}`;
}

export class SessionStateStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }
  load(key: string): SessionState | null {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as SessionState;
    } catch {
      return null;
    }
  }
  save(state: SessionState): void {
    const p = this.path(state.key);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, p);
  }
  fresh(file: TranscriptFile): SessionState {
    return {
      key: stateKey(file.source, file.sessionId),
      source: file.source,
      sessionId: file.sessionId,
      path: file.path,
      processedUpto: null,
      pass: 0,
      candidateDueAt: null,
      candidateDone: false,
      lastMtimeMs: null,
      lastSweepAt: null,
      lastAction: null,
    };
  }
}

// ---------------------------------------------------------------- 决策

export interface SweepDecision {
  action: SweepAction;
  reason: string;
  /** 需要解析时才有 */
  doc?: SessionDoc;
  summary?: SessionSummary;
  lastMessageAt?: string | null;
}

/**
 * 纯决策：不写任何东西。`parse` 延迟到真需要时才调（mtime 没变且没到候选期的文件不解析）。
 */
export function decide(
  file: TranscriptFile,
  state: SessionState,
  nowMs: number,
  policy: SweepPolicy,
  parse: () => SessionDoc = () => parseSessionFile(file.path, { source: file.source }),
): SweepDecision {
  const idleMs = policy.idleMinutes * 60_000;
  if (nowMs - file.mtimeMs < idleMs) return { action: "not-idle", reason: `mtime ${Math.round((nowMs - file.mtimeMs) / 60_000)}min ago < ${policy.idleMinutes}` };

  const candidateDue = !!state.candidateDueAt && nowMs >= Date.parse(state.candidateDueAt) && !state.candidateDone;
  const mtimeUnchanged = state.lastMtimeMs !== null && state.lastMtimeMs === file.mtimeMs;
  if (mtimeUnchanged && !candidateDue) {
    if (state.processedUpto) return { action: "up-to-date", reason: "mtime unchanged, candidates done or not due" };
    if (state.skipReason) return { action: "unchanged", reason: `still ${state.skipReason}` };
  }

  const doc = parse();
  const summary = summarizeSession(doc);
  if (doc.importedSource) return { action: "skip-imported", reason: `imported ${doc.importedSource}`, doc, summary };
  if (doc.isSubagent) return { action: "skip-subagent", reason: "subagent thread", doc, summary };
  if (summary.userTurns < policy.minUserTurns) return { action: "skip-short", reason: `${summary.userTurns} user turns < ${policy.minUserTurns}`, doc, summary };
  const lastMessageAt = doc.endedAt;
  if (!lastMessageAt) return { action: "skip-no-timestamp", reason: "no timestamped events", doc, summary };

  // 静默判据用消息时间，不用 mtime（mtime 可能被同步工具刷新）
  const lastMs = Date.parse(lastMessageAt);
  if (nowMs - lastMs < idleMs) return { action: "not-idle", reason: `last message ${Math.round((nowMs - lastMs) / 60_000)}min ago < ${policy.idleMinutes}`, doc, summary, lastMessageAt };

  const newContent = !state.processedUpto || lastMs > Date.parse(state.processedUpto);
  const candidateWouldBeDue = nowMs >= lastMs + policy.candidateAfterMinutes * 60_000;
  if (newContent) {
    return { action: candidateWouldBeDue ? "ledger+candidates" : "ledger", reason: state.processedUpto ? `new messages after ${state.processedUpto}` : "first pass", doc, summary, lastMessageAt };
  }
  if (candidateDue || (candidateWouldBeDue && !state.candidateDone)) return { action: "candidates", reason: `candidate stage due (last message ${lastMessageAt})`, doc, summary, lastMessageAt };
  return { action: "up-to-date", reason: "nothing new", doc, summary, lastMessageAt };
}

/** 把决策应用到游标（纯函数，返回新 state；写盘由调用方） */
export function applyDecision(state: SessionState, file: TranscriptFile, decision: SweepDecision, nowMs: number, policy: SweepPolicy, ledgerPath?: string): SessionState {
  const next: SessionState = { ...state, path: file.path, lastMtimeMs: file.mtimeMs, lastSweepAt: new Date(nowMs).toISOString(), lastAction: decision.action };
  delete next.skipReason;
  switch (decision.action) {
    case "ledger":
    case "ledger+candidates": {
      const lastMs = Date.parse(decision.lastMessageAt!);
      next.processedUpto = decision.lastMessageAt!;
      next.pass = state.pass + 1;
      next.candidateDueAt = new Date(lastMs + policy.candidateAfterMinutes * 60_000).toISOString();
      next.candidateDone = decision.action === "ledger+candidates";
      if (ledgerPath) next.ledgerPath = ledgerPath;
      break;
    }
    case "candidates":
      next.candidateDone = true;
      if (ledgerPath) next.ledgerPath = ledgerPath;
      break;
    case "skip-short":
    case "skip-imported":
    case "skip-subagent":
    case "skip-no-timestamp":
      next.skipReason = decision.action;
      break;
    default:
      break;
  }
  return next;
}

export function sid8(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "unknown";
}

/** 账本文件落点：<ledgerRoot>/YYYY-MM/<sid8>.md，月份取会话结束时间（v3 第 1 条） */
export function ledgerRelPath(sessionId: string, endedAt: string): string {
  const d = new Date(endedAt);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(ym, `${sid8(sessionId)}.md`);
}
