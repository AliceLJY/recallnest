/**
 * CC-6: Distill gate — PID-based lock file + session gate.
 * Lock file mtime serves as lastDistillAt timestamp (no separate field).
 *
 * - acquireLock(): write `<pid>:<token>:<expireMs>`, check existing lock PID liveness + the
 *   holder's own expiry against mtime; reclaim a stale lock via compare-and-delete
 * - releaseLock(): delete lock file if it still holds our body (mtime naturally updates to now on success)
 * - refreshLock(): heartbeat — bump mtime of a lock we still hold
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
  openSync,
  fstatSync,
  closeSync,
  linkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import * as envConfig from "./env-config.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DistillLockConfig {
  /** Path to the lock file (default: data/distill.lock) */
  lockPath: string;
  /** Lock expiry in ms (default: 3600000 = 1h) */
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

// P2: in-process record of the ownership body we wrote into each lock file we hold.
// releaseLock only removes a lock whose on-disk body still matches — so if our lock
// expired mid-run and another process legitimately reclaimed it, our finally-release
// won't delete the new owner's lock (which would break mutual exclusion).
const heldTokens = new Map<string, string>();

/** Parse the PID prefix from a lock file body (`<pid>` legacy, `<pid>:<token>` or `<pid>:<token>:<ttlMs>`). */
function parsePid(content: string): number {
  return parseInt((content.split(":")[0] ?? "").trim(), 10);
}

/**
 * The holder's own expiry, written as the third field when it took the lock. Waiters judge
 * staleness by this, not by whatever expireMs they themselves passed: a long holder (30 min)
 * must not be reclaimed by a writer that only waits 30 s. Legacy bodies without the field → null.
 */
function parseTtl(content: string): number | null {
  const field = content.trim().split(":")[2];
  if (field === undefined) return null;
  const ttl = Number(field);
  return !Number.isNaN(ttl) && ttl > 0 ? ttl : null;
}

/**
 * A lock file with no parsable pid is reclaimable only after this long. This code never makes
 * one (createExclusive links the body into place), but a process still running the previous
 * version creates the file with an O_EXCL open and writes the body afterwards; judging that
 * brand-new, still-empty lock as garbage would delete it and hand out a second lock.
 */
const UNPARSABLE_LOCK_GRACE_MS = 5_000;

/** Dead holder, or the lock file has not been created/refreshed within the holder's expiry. */
function isReclaimable(content: string, mtimeMs: number, fallbackExpireMs: number): boolean {
  const pid = parsePid(content);
  if (isNaN(pid)) return Date.now() - mtimeMs > UNPARSABLE_LOCK_GRACE_MS;
  if (!isPidAlive(pid)) return true;
  return Date.now() - mtimeMs > (parseTtl(content) ?? fallbackExpireMs);
}

/** Read body and mtime from one open file descriptor, so both describe the same file. */
function readLockFile(lockPath: string): { content: string; mtimeMs: number } | null {
  let fd: number;
  try {
    fd = openSync(lockPath, "r");
  } catch {
    return null;
  }
  try {
    return { content: readFileSync(fd, "utf-8"), mtimeMs: fstatSync(fd).mtimeMs };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Create `path` holding `content`, failing (false) if it already exists. The content is written
 * to a private temp file first and hard-linked into place, so `path` never exists empty: with a
 * plain O_EXCL open the file appears before its body is written, and a process reading it in
 * that gap sees no pid and judges the brand-new lock reclaimable.
 */
function createExclusive(path: string, content: string): boolean {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, content, { encoding: "utf-8", flag: "wx" });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}

/**
 * A marker file older than this whose creator may still be alive is treated as orphaned anyway
 * (pid reuse). Markers are held only across a few synchronous syscalls, never across an await,
 * so a live process can sit inside one this long only if it is frozen.
 */
const CAS_MARKER_STALE_MS = 60_000;
/** Each level only comes into play after a process died inside the level below. */
const CAS_MAX_DEPTH = 3;

/**
 * Delete `path` only if its content is still exactly `expected`. Returns true if this call deleted it.
 *
 * unlink has no compare-and-swap, so a plain read-check-unlink lets A delete the lock B created a
 * moment ago (B reclaimed first, A then unlinks B's fresh lock and creates its own: two holders).
 * Here every removal of a file with content C happens only while holding the O_EXCL marker
 * `<path>.cas-<hash(C)>`, and the content is re-read under it. Lock bodies carry a random token,
 * so once C is gone it never comes back: a late process that wins the marker after C was replaced
 * sees different content and leaves the file alone. That also makes it safe to drop the marker
 * right after the delete.
 *
 * A marker whose creator died before dropping it would otherwise pin C forever; it is removed the
 * same way, one level up (`<marker>.cas-<hash(marker body)>`).
 */
function compareAndDelete(path: string, expected: string, depth = 0): boolean {
  const markerPath = `${path}.cas-${createHash("sha256").update(expected).digest("hex").slice(0, 16)}`;
  if (!createExclusive(markerPath, `${process.pid}:${randomUUID()}`)) {
    // Another process is removing this exact content right now — or died while doing so.
    if (depth >= CAS_MAX_DEPTH) return false;
    const marker = readLockFile(markerPath);
    if (marker === null) return compareAndDelete(path, expected, depth + 1); // just dropped: retry
    const pid = parsePid(marker.content);
    const orphaned = isNaN(pid) || !isPidAlive(pid) || Date.now() - marker.mtimeMs > CAS_MARKER_STALE_MS;
    if (!orphaned) return false;
    compareAndDelete(markerPath, marker.content, depth + 1);
    return compareAndDelete(path, expected, depth + 1);
  }
  try {
    let current: string;
    try {
      current = readFileSync(path, "utf-8");
    } catch {
      return false;
    }
    if (current !== expected) return false;
    try {
      unlinkSync(path);
    } catch {
      return false;
    }
    return true;
  } finally {
    try {
      unlinkSync(markerPath);
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to acquire the distill lock.
 * Returns true if lock was acquired, false if another live process holds it.
 * `expireMs` is written into the lock file as this holder's expiry; when judging someone
 * else's lock, the expiry in their file wins and `expireMs` is only the fallback for
 * legacy lock files that carry none.
 */
export function acquireLock(cfg?: Partial<DistillLockConfig>): boolean {
  const { lockPath, expireMs } = resolveConfig(cfg);
  mkdirSync(dirname(lockPath), { recursive: true });

  // Fast path: atomic exclusive create. link() fails with EEXIST like an O_EXCL open, so
  // only one of N processes creating the same lock succeeds.
  // This closes the check-then-write TOCTOU the previous existsSync+writeFileSync
  // form had (two processes could both see "no lock" then both write); the P0-1
  // store-write lock relies on acquisition being truly exclusive.
  if (tryExclusiveCreate(lockPath, expireMs)) return true;

  // Lock file exists — decide whether it is reclaimable (dead holder or expired).
  const existing = readLockFile(lockPath);
  if (existing === null) {
    // Holder released between our failed create and this read — retry the create.
    return tryExclusiveCreate(lockPath, expireMs);
  }
  if (!isReclaimable(existing.content, existing.mtimeMs, expireMs)) {
    return false; // held by a live process, not expired
  }

  // Reclaim a stale lock: remove exactly the content we judged stale (never a lock some
  // competing reclaimer has just created in its place), then re-create atomically. Whether
  // or not we were the one to remove it, the exclusive create decides who holds the lock now.
  compareAndDelete(lockPath, existing.content);
  return tryExclusiveCreate(lockPath, expireMs);
}

/**
 * Atomic exclusive create of the lock file (see createExclusive). Writes a unique ownership body
 * (`<pid>:<uuid>:<expireMs>`) and records it so releaseLock can verify we still own the
 * lock. false on EEXIST.
 */
function tryExclusiveCreate(lockPath: string, expireMs: number): boolean {
  const body = `${process.pid}:${randomUUID()}:${expireMs}`;
  if (!createExclusive(lockPath, body)) return false;
  heldTokens.set(lockPath, body);
  return true;
}

/**
 * Refresh the mtime of a lock we still hold, so waiters keep seeing it as unexpired.
 * No-op (returns false) once the lock is gone or has been reclaimed by another owner.
 */
export function refreshLock(cfg?: Partial<DistillLockConfig>): boolean {
  const { lockPath } = resolveConfig(cfg);
  const ours = heldTokens.get(lockPath);
  if (ours === undefined) return false;
  try {
    if (readFileSync(lockPath, "utf-8") !== ours) return false;
    const now = new Date();
    utimesSync(lockPath, now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the distill lock. If we hold a known ownership token for this path, only
 * remove the file when its on-disk token still matches ours — otherwise our lock was
 * expired and reclaimed by another process, and deleting would evict the new owner.
 * When we hold no token (e.g. a direct caller/test-written lock) fall back to removing.
 */
export function releaseLock(cfg?: Partial<DistillLockConfig>): void {
  const { lockPath } = resolveConfig(cfg);
  const ourToken = heldTokens.get(lockPath);
  heldTokens.delete(lockPath);
  if (!existsSync(lockPath)) return;
  if (ourToken !== undefined) {
    // Same compare-and-delete as reclaim: a plain read-then-unlink could remove the lock a
    // reclaimer created in the gap. If it no longer holds our body we were reclaimed — leave it.
    compareAndDelete(lockPath, ourToken);
    return;
  }
  unlinkSync(lockPath);
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
 * Resolve a lock key (e.g. "store-write", "dream-<scope>", "gc-global") to a safe
 * lock-file path. The key is sanitized for the filesystem and suffixed with a short
 * hash of the raw key so distinct keys never collide after sanitization/truncation.
 */
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

export function lockPathForKey(key: string, lockDir?: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return join(locksDir(lockDir), `${safe}-${hash}.lock`);
}

export interface WithLockOptions {
  /**
   * This holder's expiry in ms (default 600_000 = 10min), written into the lock file: other
   * processes may reclaim the lock once it has gone this long without being created or
   * refreshed. Judging someone else's lock uses the expiry in their file, not this value.
   */
  expireMs?: number;
  /**
   * Refresh the lock file's mtime at this interval while `fn` runs (default: no heartbeat).
   * For holders that can run longer than their expiry: with a heartbeat, `expireMs` only has
   * to cover a stalled event loop, not the whole run.
   */
  heartbeatMs?: number;
  /** Override the base lock directory (tests). */
  lockDir?: string;
  /** Behavior when another live process holds the lock (default "skip"). */
  onBusy?: "skip" | "wait";
  /** For onBusy="wait": total time budget before throwing (default 10_000). */
  waitTimeoutMs?: number;
  /** For onBusy="wait": poll interval in ms (default 50). */
  pollMs?: number;
}

export type WithLockOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; reason: "locked_by_another_process" };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding a named cross-process lock, releasing it afterwards
 * (even on throw). Maintenance-type writes use onBusy:"skip" — for a personal
 * store, skipping a redundant dream/consolidate/gc run beats queueing it.
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: WithLockOptions = {},
): Promise<WithLockOutcome<T>> {
  const lockPath = lockPathForKey(key, opts.lockDir);
  const lockCfg = { lockPath, expireMs: opts.expireMs ?? 600_000 };

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
      await sleep(pollMs);
      if (acquireLock(lockCfg)) {
        acquired = true;
        break;
      }
    }
    if (!acquired) {
      throw new Error(`lock '${key}' timed out after ${timeoutMs}ms (held by another process)`);
    }
  }

  const heartbeat = opts.heartbeatMs !== undefined && opts.heartbeatMs > 0
    ? setInterval(() => refreshLock(lockCfg), opts.heartbeatMs)
    : undefined;
  heartbeat?.unref?.();
  try {
    return { ran: true, result: await fn() };
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
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
  fn: () => Promise<T>,
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
