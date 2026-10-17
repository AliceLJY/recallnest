/**
 * CC-6: Distill gate + P0-1 named cross-process locks.
 *
 * Mutual exclusion is a kernel advisory lock: flock(2) on a descriptor that stays open for as long
 * as the lock is held (src/flock.ts). The kernel drops it when the holder closes the descriptor,
 * exits, or is SIGKILLed, so there is no stale-lock reclaim, no PID or expiry check deciding that a
 * live holder may be pushed out, no marker files and no heartbeat. The lock file still carries
 * `<pid>:<token>:flock:<acquiredAtMs>:<maxHoldMs>` for diagnostics (inspectLock, timeout messages,
 * the stuck-holder warning); nothing decides ownership from its content.
 *
 * ROLLOUT — the previous versions of this file (PID + mtime in the lock file, reclaimed by
 * unlink-and-recreate) do not take the flock, so old and new processes do not exclude each other.
 * Upgrade by stopping EVERY RecallNest process that shares the data directory (all mcp-server
 * instances, the HTTP API, launchd jobs: incremental-ingest, dream, gc, memory-reconcile, …), then
 * starting the new ones. As a guard for a missed old process: a lock file in the old format whose
 * PID is alive is treated as held and is never taken over (see acquireLock); if it was left by a
 * process that is gone and its PID has been reused, a warning names the file to delete.
 *
 * - acquireLock(): open + non-blocking flock, write the diagnostic body
 * - releaseLock(): unlink (while still locked) + close; never touches a lock this process does not hold
 * - rollbackLock(previousMtime): on failure, rewind lock mtime so next run retries
 * - shouldDistill(checkpointCount): session gate — checkpoint count < 3 → skip
 * - getLastDistillTime(): read lock file mtime, return 0 if absent
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  statSync,
  utimesSync,
  existsSync,
  fstatSync,
  closeSync,
  ftruncateSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import * as envConfig from "./env-config.js";
import { openLockFile, tryLockExclusive, unlockFd } from "./flock.js";
import { logWarn } from "./stderr-log.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DistillLockConfig {
  /** Path to the lock file (default: data/distill.lock) */
  lockPath: string;
  /**
   * How long this holder expects to keep the lock (default: 3600000 = 1h). Recorded in the lock
   * file; holding it longer only raises the stuck-holder warning. It never lets another process
   * take the lock: only the kernel releases a flock.
   */
  expireMs: number;
  /** Minimum checkpoint count before distill is allowed (default: 3) */
  minCheckpoints: number;
}

export const DEFAULT_DISTILL_LOCK_CONFIG: DistillLockConfig = {
  lockPath: join(envConfig.dataDir(), "distill.lock"),
  expireMs: 3_600_000,
  minCheckpoints: 3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConfig(cfg?: Partial<DistillLockConfig>): DistillLockConfig {
  return { ...DEFAULT_DISTILL_LOCK_CONFIG, ...cfg };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parse the PID prefix from a lock file body (`<pid>` legacy, `<pid>:<token>…`). */
function parsePid(content: string): number {
  return parseInt((content.split(":")[0] ?? "").trim(), 10);
}

const FLOCK_TAG = "flock";

/** What this process holds: the open, flocked descriptor, its inode, and the body we wrote. */
interface HeldLock {
  fd: number;
  dev: number;
  ino: number;
  body: string;
}

// Locks held by this process, by path. releaseLock only acts on an entry here, so a release can
// never remove a lock some other process (or another call in this process) holds.
const heldLocks = new Map<string, HeldLock>();

interface HolderInfo {
  pid: number;
  token: string;
  acquiredAt: number;
  maxHoldMs: number;
}

/** Parse a body written by this version; null for the legacy format or garbage. */
function parseFlockBody(content: string): HolderInfo | null {
  const [pid, token, tag, acquiredAt, maxHoldMs] = content.trim().split(":");
  if (tag !== FLOCK_TAG || pid === undefined || token === undefined) return null;
  const info = { pid: parseInt(pid, 10), token, acquiredAt: Number(acquiredAt), maxHoldMs: Number(maxHoldMs) };
  return Number.isNaN(info.pid) || Number.isNaN(info.acquiredAt) || Number.isNaN(info.maxHoldMs) ? null : info;
}

const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  logWarn(message);
}

/**
 * A body from a pre-flock version naming a live PID. Such a process does not take the flock, so
 * holding the flock proves nothing about it: refuse rather than take a lock it may be inside.
 */
function heldByLegacyProcess(lockPath: string, content: string, expectedHoldMs: number): boolean {
  if (content.trim() === "" || parseFlockBody(content) !== null) return false;
  const pid = parsePid(content);
  if (isNaN(pid) || !isPidAlive(pid)) return false;
  let ageMs = 0;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    /* gone: report age 0 */
  }
  if (ageMs > expectedHoldMs) {
    warnOnce(`legacy|${lockPath}|${content}`,
      `[distill-lock] ${lockPath} is in the pre-flock format and names live pid ${pid} ` +
      `(${Math.round(ageMs / 1000)} s old); treating it as held. If no RecallNest process from ` +
      `before the flock upgrade is still running, that pid has been reused: delete the file.`);
  }
  return true;
}

/** "pid 123, held 45 s (max hold 30 s)" for messages; null when the file says nothing useful. */
function describeHolder(lockPath: string): string | null {
  let content: string;
  try {
    content = readFileSync(lockPath, "utf-8");
  } catch {
    return null;
  }
  const info = parseFlockBody(content);
  if (info === null) {
    const pid = parsePid(content);
    return isNaN(pid) ? null : `pid ${pid} (pre-flock lock file)`;
  }
  const heldMs = Date.now() - info.acquiredAt;
  return `pid ${info.pid}, held ${Math.round(heldMs / 1000)} s (max hold ${Math.round(info.maxHoldMs / 1000)} s)`;
}

/**
 * Waiter-side stuck-holder warning: the holder's own watchdog cannot fire if its event loop is
 * blocked, so whoever is waiting also says so, once per holder.
 */
function warnIfHolderOverdue(key: string, lockPath: string): void {
  let content: string;
  try {
    content = readFileSync(lockPath, "utf-8");
  } catch {
    return;
  }
  const info = parseFlockBody(content);
  if (info === null) return;
  const heldMs = Date.now() - info.acquiredAt;
  if (heldMs <= info.maxHoldMs) return;
  warnOnce(`overdue|${lockPath}|${info.token}`,
    `[distill-lock] lock '${key}' has been held by pid ${info.pid} for ${Math.round(heldMs / 1000)} s, ` +
    `past its max hold of ${Math.round(info.maxHoldMs / 1000)} s. Writers waiting on it will time out ` +
    `until that process finishes or is restarted.`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to acquire the lock without waiting.
 * Returns true if acquired, false if another holder (another process, or another call in this
 * process) has it, or if a live pre-flock process is named in the lock file.
 */
export function acquireLock(cfg?: Partial<DistillLockConfig>): boolean {
  const { lockPath, expireMs } = resolveConfig(cfg);
  if (heldLocks.has(lockPath)) return false;
  mkdirSync(dirname(lockPath), { recursive: true });

  // A releaser unlinks the file while it still holds the flock; a process that opened the path
  // before that unlink can get the flock on the orphaned inode afterwards. So after locking,
  // check that the path still names our inode, and start over if not.
  for (let attempt = 0; attempt < 5; attempt++) {
    const fd = openLockFile(lockPath);
    let keep = false;
    try {
      if (!tryLockExclusive(fd)) return false;
      const ours = fstatSync(fd);
      let onDisk: ReturnType<typeof statSync>;
      try {
        onDisk = statSync(lockPath);
      } catch {
        continue; // unlinked after we opened it
      }
      if (onDisk.ino !== ours.ino || onDisk.dev !== ours.dev) continue;

      if (heldByLegacyProcess(lockPath, readFileSync(fd, "utf-8"), expireMs)) return false;

      const body = `${process.pid}:${randomUUID()}:${FLOCK_TAG}:${Date.now()}:${expireMs}`;
      ftruncateSync(fd, 0);
      writeSync(fd, body, 0);
      heldLocks.set(lockPath, { fd, dev: ours.dev, ino: ours.ino, body });
      keep = true;
      return true;
    } finally {
      if (!keep) closeSync(fd);
    }
  }
  return false;
}

/**
 * Release a lock this process holds: remove the file while still holding the flock (so a waiter
 * that opened it earlier sees the inode is gone and retries), then close the descriptor, which
 * drops the flock. A lock this process does not hold is left alone — never unlinked blind.
 */
export function releaseLock(cfg?: Partial<DistillLockConfig>): void {
  const { lockPath } = resolveConfig(cfg);
  const held = heldLocks.get(lockPath);
  if (held === undefined) return;
  heldLocks.delete(lockPath);
  try {
    const onDisk = statSync(lockPath);
    if (onDisk.ino === held.ino && onDisk.dev === held.dev) unlinkSync(lockPath);
  } catch {
    /* already gone */
  } finally {
    unlockFd(held.fd);
    closeSync(held.fd);
  }
}

/**
 * Roll back lock mtime to a previous value so the next run retries sooner.
 * Used when distill fails and we want to preserve the "last success" timestamp.
 */
export function rollbackLock(
  previousMtime: Date,
  cfg?: Partial<DistillLockConfig>,
): void {
  const { lockPath } = resolveConfig(cfg);
  if (existsSync(lockPath)) {
    utimesSync(lockPath, previousMtime, previousMtime);
  }
}

/** Session gate: returns true when enough checkpoints have accumulated. */
export function shouldDistill(
  checkpointCountSinceLastDistill: number,
  cfg?: Partial<DistillLockConfig>,
): boolean {
  const { minCheckpoints } = resolveConfig(cfg);
  return checkpointCountSinceLastDistill >= minCheckpoints;
}

/** Read lock file mtime as the last-distill timestamp. Returns 0 if absent. */
export function getLastDistillTime(cfg?: Partial<DistillLockConfig>): number {
  const { lockPath } = resolveConfig(cfg);
  if (!existsSync(lockPath)) return 0;
  return statSync(lockPath).mtimeMs;
}

// ---------------------------------------------------------------------------
// P0-1: Named cross-process locks (store-write + maintenance families)
//
// distill-lock was dead code (0 src imports). P0-1 wires it up: one global
// `store-write` lock serializes every `memories`-table write across the 11
// mcp-server processes, and scope-keyed maintenance locks (dream/consolidate/
// distill) + a global gc lock stop redundant concurrent maintenance runs.
// ---------------------------------------------------------------------------

/** Base directory for named locks. Defaults to <dataDir>/locks; overridable in tests. */
export function locksDir(lockDir?: string): string {
  return lockDir ?? join(envConfig.dataDir(), "locks");
}

/**
 * 只读查看一把命名锁：在不在、持有者进程活没活、锁文件多久没更新。不改任何东西。
 * 记忆文件对账用它区分「dream / GC 正常在跑」和「某个进程占着锁很久没动静」（后者要报警，不然对账会一直静默跳过）。
 */
export function inspectLock(key: string, lockDir?: string): { exists: boolean; pid: number | null; pidAlive: boolean; ageMs: number | null } {
  const lockPath = lockPathForKey(key, lockDir);
  try {
    const pid = parsePid(readFileSync(lockPath, "utf-8"));
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    return { exists: true, pid: isNaN(pid) ? null : pid, pidAlive: !isNaN(pid) && isPidAlive(pid), ageMs };
  } catch {
    return { exists: false, pid: null, pidAlive: false, ageMs: null };
  }
}

/**
 * Resolve a lock key (e.g. "store-write", "dream-<scope>", "gc-global") to a safe
 * lock-file path. The key is sanitized for the filesystem and suffixed with a short
 * hash of the raw key so distinct keys never collide after sanitization/truncation.
 */
export function lockPathForKey(key: string, lockDir?: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return join(locksDir(lockDir), `${safe}-${hash}.lock`);
}

export interface WithLockOptions {
  /**
   * How long this holder expects to keep the lock (default 600_000 = 10 min). Recorded in the lock
   * file. Past it the holder logs a loud warning and `fn`'s AbortSignal fires; waiters log too.
   * It never lets anyone take the lock away from a live holder.
   */
  maxHoldMs?: number;
  /** Older name for maxHoldMs, kept so existing callers read the same; maxHoldMs wins if both are set. */
  expireMs?: number;
  /** Override the base lock directory (tests). */
  lockDir?: string;
  /** Behavior when another holder has the lock (default "skip"). */
  onBusy?: "skip" | "wait";
  /** For onBusy="wait": total time budget before throwing (default 10_000). */
  waitTimeoutMs?: number;
  /** For onBusy="wait": poll interval in ms (default 50). */
  pollMs?: number;
}

export type WithLockOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; reason: "locked_by_another_process" };

/** Reason carried by the AbortSignal handed to `fn` once the lock is held past its max hold. */
export class LockHoldDeadlineError extends Error {
  constructor(readonly key: string, readonly maxHoldMs: number) {
    super(`lock '${key}' held past its max hold of ${maxHoldMs} ms`);
    this.name = "LockHoldDeadlineError";
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** setTimeout/setInterval treat longer delays as 1 ms; such a max hold means "no deadline". */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Run `fn` while holding a named cross-process lock, releasing it afterwards
 * (even on throw). Maintenance-type writes use onBusy:"skip" — for a personal
 * store, skipping a redundant dream/consolidate/gc run beats queueing it.
 *
 * Stuck holders: once `fn` has held the lock for `maxHoldMs`, this process logs a warning (and
 * again every `maxHoldMs` while it still holds it) and aborts the signal passed to `fn`. The lock
 * itself is NOT released then — `fn` may be in the middle of a write, and handing the lock to the
 * next writer would be exactly the double-writer bug this lock exists to prevent. A caller that can
 * stop at a safe point (e.g. between independent batches) checks `signal.aborted` and returns.
 */
export async function withLock<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: WithLockOptions = {},
): Promise<WithLockOutcome<T>> {
  const lockPath = lockPathForKey(key, opts.lockDir);
  const maxHoldMs = opts.maxHoldMs ?? opts.expireMs ?? 600_000;
  const lockCfg = { lockPath, expireMs: maxHoldMs };

  if (!acquireLock(lockCfg)) {
    if ((opts.onBusy ?? "skip") === "skip") {
      return { ran: false, reason: "locked_by_another_process" };
    }
    // wait: poll until acquired or the budget is exhausted.
    const timeoutMs = opts.waitTimeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    const pollMs = opts.pollMs ?? 50;
    let acquired = false;
    while (Date.now() < deadline) {
      warnIfHolderOverdue(key, lockPath);
      await sleep(pollMs);
      if (acquireLock(lockCfg)) {
        acquired = true;
        break;
      }
    }
    if (!acquired) {
      const holder = describeHolder(lockPath);
      throw new Error(`lock '${key}' timed out after ${timeoutMs}ms (held by ${holder ?? "another process"})`);
    }
  }

  const controller = new AbortController();
  const acquiredAt = Date.now();
  let repeat: ReturnType<typeof setInterval> | undefined;
  const overdue = (): void => {
    logWarn(`[distill-lock] lock '${key}' held by this process (pid ${process.pid}) for ` +
      `${Math.round((Date.now() - acquiredAt) / 1000)} s, past its max hold of ${Math.round(maxHoldMs / 1000)} s. ` +
      `Its critical section looks stuck; other writers time out until it finishes or this process is restarted.`);
  };
  const watchdog = maxHoldMs <= MAX_TIMER_MS
    ? setTimeout(() => {
      overdue();
      controller.abort(new LockHoldDeadlineError(key, maxHoldMs));
      repeat = setInterval(overdue, maxHoldMs);
      repeat.unref?.();
    }, maxHoldMs)
    : undefined;
  watchdog?.unref?.();
  try {
    return { ran: true, result: await fn(controller.signal) };
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    if (repeat !== undefined) clearInterval(repeat);
    releaseLock(lockCfg);
  }
}

/**
 * Run `fn` under a named write lock, waiting for the lock rather than skipping —
 * losing a memory write would be data loss. Throws if the lock can't be acquired
 * within the timeout. Returns fn's result directly. Used by store.upsert/storeBatch
 * so all `memories`-table writes serialize across the 11 mcp-server processes.
 */
export async function withWriteLock<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: Omit<WithLockOptions, "onBusy"> = {},
): Promise<T> {
  const outcome = await withLock(key, fn, { ...opts, onBusy: "wait" });
  // onBusy:"wait" resolves to {ran:true} or throws; ran:false is unreachable here.
  if (!outcome.ran) {
    throw new Error(`write lock '${key}' unavailable`);
  }
  return outcome.result;
}

/**
 * Stamp a lock file's mtime to now without releasing it, marking "last completed".
 * gc (auto-gc.ts) uses this to persist a cross-process throttle timestamp in the
 * lock file's mtime (getLastDistillTime pattern) so the 24h throttle holds across
 * processes rather than each process tracking its own module-level timestamp.
 */
export function stampLock(cfg?: Partial<DistillLockConfig>): void {
  const { lockPath } = resolveConfig(cfg);
  mkdirSync(dirname(lockPath), { recursive: true });
  // Create-or-overwrite so the mtime becomes now. Unlike releaseLock this leaves the
  // file in place — it is a persistent "last run" marker (gc's cross-process throttle),
  // read back via getLastDistillTime.
  writeFileSync(lockPath, String(process.pid), "utf-8");
}

/** Remove a stamp written by stampLock (tests). Stamps are markers, not locks: nobody holds them. */
export function clearStamp(cfg?: Partial<DistillLockConfig>): void {
  const { lockPath } = resolveConfig(cfg);
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}
