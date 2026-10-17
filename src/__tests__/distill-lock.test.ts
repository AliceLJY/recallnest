import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, readFileSync, mkdirSync, statSync, utimesSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  acquireLock,
  releaseLock,
  rollbackLock,
  shouldDistill,
  getLastDistillTime,
  withLock,
  withWriteLock,
  lockPathForKey,
  inspectLock,
  stampLock,
  clearStamp,
  LockHoldDeadlineError,
  type DistillLockConfig,
} from "../distill-lock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let lockPath: string;
const acquired: string[] = [];

function cfg(overrides?: Partial<DistillLockConfig>): Partial<DistillLockConfig> {
  return { lockPath, ...overrides };
}

/** acquireLock that remembers the path, so afterEach can release what a test left held. */
function take(c: Partial<DistillLockConfig>): boolean {
  const ok = acquireLock(c);
  if (ok && c.lockPath) acquired.push(c.lockPath);
  return ok;
}

/** A pid that has certainly exited: run a process to completion and keep its pid. */
function deadPid(): number {
  const pid = spawnSync("true").pid;
  if (typeof pid !== "number") throw new Error("could not obtain a dead pid");
  return pid;
}

beforeEach(() => {
  tempDir = join(tmpdir(), `distill-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  lockPath = join(tempDir, "distill.lock");
});

afterEach(() => {
  while (acquired.length) releaseLock({ lockPath: acquired.pop()! });
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// acquireLock / releaseLock (flock)
// ---------------------------------------------------------------------------

describe("acquireLock", () => {
  it("creates lock file and returns true when no lock exists", () => {
    expect(take(cfg())).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("writes a diagnostic body: pid, token, flock tag, acquiredAt, max hold", () => {
    const before = Date.now();
    take(cfg({ expireMs: 45_000 }));
    const [pid, token, tag, acquiredAt, maxHold] = readFileSync(lockPath, "utf-8").split(":");
    expect(pid).toBe(String(process.pid));
    expect(token!.length).toBeGreaterThan(0);
    expect(tag).toBe("flock");
    expect(Number(acquiredAt)).toBeGreaterThanOrEqual(before);
    expect(maxHold).toBe("45000");
  });

  it("is exclusive within one process: a second acquire fails until release", () => {
    expect(take(cfg())).toBe(true);
    expect(acquireLock(cfg())).toBe(false);
    releaseLock(cfg());
    expect(take(cfg())).toBe(true);
  });

  it("takes a lock file left by a dead new-format holder (the kernel already dropped its flock)", () => {
    writeFileSync(lockPath, `${deadPid()}:gone:flock:${Date.now()}:30000`, "utf-8");
    expect(take(cfg())).toBe(true);
    expect(readFileSync(lockPath, "utf-8").startsWith(`${process.pid}:`)).toBe(true);
  });

  it("ignores the pid in a new-format body: holding the flock is what counts", () => {
    // A live pid in a flock-format body whose flock is free = its holder released or crashed
    // after writing; nothing to respect.
    writeFileSync(lockPath, `${process.pid}:stale-body:flock:${Date.now()}:30000`, "utf-8");
    expect(take(cfg())).toBe(true);
  });

  it("refuses a pre-flock lock file naming a live pid, however old (old processes don't flock)", () => {
    writeFileSync(lockPath, `${process.pid}:legacy-token`, "utf-8");
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    utimesSync(lockPath, twoHoursAgo, twoHoursAgo);
    expect(acquireLock(cfg({ expireMs: 60_000 }))).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(`${process.pid}:legacy-token`);
    writeFileSync(lockPath, String(process.pid), "utf-8"); // oldest format: bare pid
    expect(acquireLock(cfg())).toBe(false);
  });

  it("takes a pre-flock lock file whose pid is dead", () => {
    writeFileSync(lockPath, `${deadPid()}:legacy-token`, "utf-8");
    expect(take(cfg())).toBe(true);
  });

  it("takes an empty or unparsable lock file", () => {
    writeFileSync(lockPath, "", "utf-8");
    expect(take(cfg())).toBe(true);
    releaseLock(cfg());
    writeFileSync(lockPath, "garbage", "utf-8");
    expect(take(cfg())).toBe(true);
  });

  it("creates parent directories if missing", () => {
    const deepPath = join(tempDir, "nested", "dir", "distill.lock");
    expect(take(cfg({ lockPath: deepPath }))).toBe(true);
    expect(existsSync(deepPath)).toBe(true);
  });
});

describe("releaseLock", () => {
  it("removes a lock this process holds", () => {
    expect(take(cfg())).toBe(true);
    releaseLock(cfg());
    expect(existsSync(lockPath)).toBe(false);
  });

  it("never unlinks a lock file this process does not hold", () => {
    writeFileSync(lockPath, `${process.pid}:someone-else`, "utf-8");
    releaseLock(cfg());
    expect(readFileSync(lockPath, "utf-8")).toBe(`${process.pid}:someone-else`);
  });

  it("a second release after someone else took the lock leaves their lock alone", async () => {
    // Double release (inner release + the finally of an outer helper): the second call must not
    // remove the next holder's file. Here the next holder is a child process.
    expect(take(cfg())).toBe(true);
    releaseLock(cfg());
    const child = Bun.spawn([process.execPath, "-e", `
      const { acquireLock } = await import(${JSON.stringify(join(import.meta.dir, "../distill-lock.ts"))});
      if (!acquireLock({ lockPath: ${JSON.stringify(lockPath)} })) process.exit(2);
      console.log("held");
      await new Promise((r) => setTimeout(r, 800));
    `], { stdout: "pipe" });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");
    releaseLock(cfg());
    expect(existsSync(lockPath)).toBe(true);
    expect(acquireLock(cfg())).toBe(false);
    expect(await child.exited).toBe(0);
  });

  it("is a no-op when lock file does not exist", () => {
    expect(() => releaseLock(cfg())).not.toThrow();
  });
});

describe("inspectLock", () => {
  it("reports the holder pid and liveness from the diagnostic body", () => {
    const p = lockPathForKey("inspect", tempDir);
    expect(take({ lockPath: p })).toBe(true);
    const seen = inspectLock("inspect", tempDir);
    expect(seen.exists).toBe(true);
    expect(seen.pid).toBe(process.pid);
    expect(seen.pidAlive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rollbackLock
// ---------------------------------------------------------------------------

describe("rollbackLock", () => {
  it("sets lock mtime to the given previous value", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    const pastDate = new Date(Date.now() - 600_000); // 10 min ago

    rollbackLock(pastDate, cfg());

    const st = statSync(lockPath);
    // Allow 1 second tolerance for filesystem granularity
    expect(Math.abs(st.mtimeMs - pastDate.getTime())).toBeLessThan(1000);
  });

  it("is a no-op when lock file does not exist", () => {
    expect(() => rollbackLock(new Date(), cfg())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// shouldDistill
// ---------------------------------------------------------------------------

describe("shouldDistill", () => {
  it("returns true when checkpoint count >= minCheckpoints (default 3)", () => {
    expect(shouldDistill(3, cfg())).toBe(true);
    expect(shouldDistill(5, cfg())).toBe(true);
  });

  it("returns false when checkpoint count < minCheckpoints", () => {
    expect(shouldDistill(0, cfg())).toBe(false);
    expect(shouldDistill(1, cfg())).toBe(false);
    expect(shouldDistill(2, cfg())).toBe(false);
  });

  it("respects custom minCheckpoints", () => {
    expect(shouldDistill(4, cfg({ minCheckpoints: 5 }))).toBe(false);
    expect(shouldDistill(5, cfg({ minCheckpoints: 5 }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getLastDistillTime
// ---------------------------------------------------------------------------

describe("getLastDistillTime", () => {
  it("returns lock file mtime when lock exists", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    const st = statSync(lockPath);

    const result = getLastDistillTime(cfg());
    expect(Math.abs(result - st.mtimeMs)).toBeLessThan(100);
  });

  it("returns 0 when lock file does not exist", () => {
    const result = getLastDistillTime(cfg());
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// withLock / withWriteLock
// ---------------------------------------------------------------------------

describe("withLock", () => {
  it("runs fn and releases the lock afterwards", async () => {
    const out = await withLock("wl-run", async () => 42, { lockDir: tempDir });
    expect(out.ran).toBe(true);
    if (out.ran) expect(out.result).toBe(42);
    expect(existsSync(lockPathForKey("wl-run", tempDir))).toBe(false);
  });

  it("skips (ran:false) when another holder has the lock", async () => {
    expect(take({ lockPath: lockPathForKey("wl-skip", tempDir) })).toBe(true);
    let ran = false;
    const out = await withLock("wl-skip", async () => { ran = true; return 1; }, { lockDir: tempDir });
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.reason).toBe("locked_by_another_process");
    expect(ran).toBe(false);
  });

  it("skips when a live pre-flock process is named in the lock file (mixed-version guard)", async () => {
    const p = lockPathForKey("wl-legacy", tempDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(process.pid), "utf-8");
    const out = await withLock("wl-legacy", async () => 1, { lockDir: tempDir });
    expect(out.ran).toBe(false);
  });

  it("does not block across different lock keys", async () => {
    expect(take({ lockPath: lockPathForKey("wl-keyA", tempDir) })).toBe(true);
    const out = await withLock("wl-keyB", async () => "ran", { lockDir: tempDir });
    expect(out.ran).toBe(true);
  });

  it("releases the lock even when fn throws", async () => {
    await expect(
      withLock("wl-throw", async () => { throw new Error("boom"); }, { lockDir: tempDir }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPathForKey("wl-throw", tempDir))).toBe(false);
  });

  it("serializes concurrent callers in one process", async () => {
    let inside = 0;
    let maxInside = 0;
    await Promise.all(Array.from({ length: 6 }, () => withWriteLock("wl-serial", async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 15));
      inside--;
    }, { lockDir: tempDir, pollMs: 2 })));
    expect(maxInside).toBe(1);
  });
});

describe("withLock max-hold deadline", () => {
  it("past maxHoldMs: logs loudly, aborts fn's signal, and still holds the lock until fn returns", async () => {
    const p = lockPathForKey("wl-deadline", tempDir);
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let reason: unknown;
    let heldAfterDeadline: boolean | null = null;
    try {
      const out = await withLock("wl-deadline", async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        reason = signal.reason;
        heldAfterDeadline = !acquireLock({ lockPath: p });
        return "stopped";
      }, { lockDir: tempDir, maxHoldMs: 120 });
      expect(out.ran).toBe(true);
    } finally {
      console.warn = original;
    }
    expect(reason).toBeInstanceOf(LockHoldDeadlineError);
    expect(heldAfterDeadline).toBe(true); // not handed to anyone else while fn was still inside
    expect(warnings.some((w) => w.includes("'wl-deadline'") && w.includes("max hold"))).toBe(true);
    expect(existsSync(p)).toBe(false);
  });

  it("no deadline fires within maxHoldMs", async () => {
    let aborted = true;
    await withLock("wl-in-time", async (signal) => {
      await new Promise((r) => setTimeout(r, 30));
      aborted = signal.aborted;
    }, { lockDir: tempDir, maxHoldMs: 5_000 });
    expect(aborted).toBe(false);
  });

  it("a max hold beyond the timer range (NEVER_EXPIRE) never fires", async () => {
    let aborted = true;
    await withLock("wl-never", async (signal) => {
      await new Promise((r) => setTimeout(r, 30));
      aborted = signal.aborted;
    }, { lockDir: tempDir, maxHoldMs: Number.MAX_SAFE_INTEGER });
    expect(aborted).toBe(false);
  });
});

describe("withWriteLock", () => {
  it("throws when the holder never releases, naming the holder", async () => {
    expect(take({ lockPath: lockPathForKey("ww-timeout", tempDir), expireMs: 30_000 })).toBe(true);
    await expect(
      withWriteLock("ww-timeout", async () => 1, { lockDir: tempDir, waitTimeoutMs: 150, pollMs: 20 }),
    ).rejects.toThrow(new RegExp(`timed out after 150ms \\(held by pid ${process.pid}, held \\d+ s \\(max hold 30 s\\)\\)`));
  });

  it("runs as soon as the holder releases", async () => {
    const p = lockPathForKey("ww-release", tempDir);
    expect(take({ lockPath: p })).toBe(true);
    setTimeout(() => releaseLock({ lockPath: p }), 60);
    const result = await withWriteLock("ww-release", async () => "done", { lockDir: tempDir, waitTimeoutMs: 2_000, pollMs: 10 });
    expect(result).toBe("done");
  });

  it("returns fn result directly on a free lock", async () => {
    const result = await withWriteLock("ww-free", async () => 7, { lockDir: tempDir });
    expect(result).toBe(7);
  });
});

describe("stampLock", () => {
  it("touches an existing lock file's mtime to now", () => {
    const p = lockPathForKey("stamp", tempDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(process.pid), "utf-8");
    utimesSync(p, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
    stampLock({ lockPath: p });
    const st = statSync(p);
    expect(Math.abs(st.mtimeMs - Date.now())).toBeLessThan(2000);
  });

  it("creates the marker file when absent (mtime ~ now)", () => {
    const p = lockPathForKey("stamp-absent", tempDir);
    expect(existsSync(p)).toBe(false);
    stampLock({ lockPath: p });
    expect(existsSync(p)).toBe(true);
    expect(Math.abs(statSync(p).mtimeMs - Date.now())).toBeLessThan(2000);
  });
});

describe("clearStamp", () => {
  it("removes a stamp file; absent is fine", () => {
    const p = lockPathForKey("stamp-clear", tempDir);
    stampLock({ lockPath: p });
    clearStamp({ lockPath: p });
    expect(existsSync(p)).toBe(false);
    expect(() => clearStamp({ lockPath: p })).not.toThrow();
  });
});

describe("no leftovers", () => {
  it("acquire + release leaves the lock directory empty", () => {
    expect(acquireLock(cfg())).toBe(true);
    releaseLock(cfg());
    expect(readdirSync(tempDir)).toEqual([]);
  });
});
