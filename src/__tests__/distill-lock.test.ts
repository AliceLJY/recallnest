import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, readFileSync, mkdirSync, statSync, utimesSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
  stampLock,
  refreshLock,
  type DistillLockConfig,
} from "../distill-lock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let lockPath: string;

function cfg(overrides?: Partial<DistillLockConfig>): Partial<DistillLockConfig> {
  return { lockPath, ...overrides };
}

beforeEach(() => {
  tempDir = join(tmpdir(), `distill-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  lockPath = join(tempDir, "distill.lock");
});

afterEach(() => {
  // Clean up lock file if it exists
  if (existsSync(lockPath)) {
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(lockPath);
    } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// acquireLock
// ---------------------------------------------------------------------------

describe("acquireLock", () => {
  it("creates lock file and returns true when no lock exists", () => {
    const result = acquireLock(cfg());
    expect(result).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("writes current PID into lock file", () => {
    acquireLock(cfg());
    const { readFileSync } = require("node:fs");
    const content = readFileSync(lockPath, "utf-8").trim();
    // Lock body is now `<pid>:<ownership-token>` (P2), so assert the PID prefix.
    expect(content.startsWith(`${process.pid}:`)).toBe(true);
  });

  it("returns false when lock held by alive PID and not expired", () => {
    // Write current process PID (which is alive)
    writeFileSync(lockPath, String(process.pid), "utf-8");

    const result = acquireLock(cfg());
    expect(result).toBe(false);
  });

  it("overwrites lock when PID is dead", () => {
    // PID 999999 is almost certainly not running
    writeFileSync(lockPath, "999999", "utf-8");

    const result = acquireLock(cfg());
    expect(result).toBe(true);

    const { readFileSync } = require("node:fs");
    const content = readFileSync(lockPath, "utf-8").trim();
    // Reclaimed lock records our `<pid>:<token>` now (P2 ownership token).
    expect(content.startsWith(`${process.pid}:`)).toBe(true);
  });

  it("overwrites lock when mtime is expired even if PID alive", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    utimesSync(lockPath, twoHoursAgo, twoHoursAgo);

    const result = acquireLock(cfg({ expireMs: 3_600_000 }));
    expect(result).toBe(true);
  });

  it("creates parent directories if missing", () => {
    const deepPath = join(tempDir, "nested", "dir", "distill.lock");
    const result = acquireLock(cfg({ lockPath: deepPath }));
    expect(result).toBe(true);
    expect(existsSync(deepPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// releaseLock
// ---------------------------------------------------------------------------

describe("releaseLock", () => {
  it("deletes lock file", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    expect(existsSync(lockPath)).toBe(true);

    releaseLock(cfg());
    expect(existsSync(lockPath)).toBe(false);
  });

  it("is a no-op when lock file does not exist", () => {
    expect(() => releaseLock(cfg())).not.toThrow();
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
// P0-1: acquireLock atomicity + named withLock / withWriteLock
// ---------------------------------------------------------------------------

describe("acquireLock atomicity (O_EXCL)", () => {
  it("is exclusive: second acquire on a live-held lock fails", () => {
    expect(acquireLock(cfg({ expireMs: 60_000 }))).toBe(true);
    expect(acquireLock(cfg({ expireMs: 60_000 }))).toBe(false);
  });
});

describe("withLock", () => {
  it("runs fn and releases the lock afterwards", async () => {
    const out = await withLock("wl-run", async () => 42, { lockDir: tempDir });
    expect(out.ran).toBe(true);
    if (out.ran) expect(out.result).toBe(42);
    expect(existsSync(lockPathForKey("wl-run", tempDir))).toBe(false);
  });

  it("skips (ran:false) when a live process already holds the lock", async () => {
    const p = lockPathForKey("wl-skip", tempDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(process.pid), "utf-8"); // current pid = alive
    let ran = false;
    const out = await withLock(
      "wl-skip",
      async () => { ran = true; return 1; },
      { lockDir: tempDir, expireMs: 60_000 },
    );
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.reason).toBe("locked_by_another_process");
    expect(ran).toBe(false);
  });

  it("does not block across different lock keys", async () => {
    const held = lockPathForKey("wl-keyA", tempDir);
    mkdirSync(dirname(held), { recursive: true });
    writeFileSync(held, String(process.pid), "utf-8");
    const out = await withLock("wl-keyB", async () => "ran", { lockDir: tempDir, expireMs: 60_000 });
    expect(out.ran).toBe(true);
  });

  it("releases the lock even when fn throws", async () => {
    await expect(
      withLock("wl-throw", async () => { throw new Error("boom"); }, { lockDir: tempDir }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPathForKey("wl-throw", tempDir))).toBe(false);
  });
});

describe("withWriteLock", () => {
  it("throws when a live holder never releases (timeout)", async () => {
    const p = lockPathForKey("ww-timeout", tempDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(process.pid), "utf-8"); // alive, never released
    await expect(
      withWriteLock("ww-timeout", async () => 1, {
        lockDir: tempDir,
        expireMs: 60_000,
        waitTimeoutMs: 150,
        pollMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("reclaims an expired lock and runs", async () => {
    const p = lockPathForKey("ww-expired", tempDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(process.pid), "utf-8");
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    utimesSync(p, twoHoursAgo, twoHoursAgo);
    const result = await withWriteLock("ww-expired", async () => "done", {
      lockDir: tempDir,
      expireMs: 3_600_000,
    });
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

describe("lock ownership token (release safety)", () => {
  it("does not delete a lock reclaimed by another owner after expiry", () => {
    const p = lockPathForKey("own-reclaimed", tempDir);
    expect(acquireLock({ lockPath: p, expireMs: 60_000 })).toBe(true);
    // Simulate: our lock expired mid-run, another process reclaimed it (its own token).
    writeFileSync(p, "99999:other-owner-token", "utf-8");
    releaseLock({ lockPath: p });
    expect(existsSync(p)).toBe(true); // new owner's lock must survive our release
    expect(readFileSync(p, "utf-8")).toContain("other-owner-token");
  });

  it("removes a lock we still own", () => {
    const p = lockPathForKey("own-normal", tempDir);
    expect(acquireLock({ lockPath: p, expireMs: 60_000 })).toBe(true);
    releaseLock({ lockPath: p });
    expect(existsSync(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-17: holder-declared expiry, heartbeat, compare-and-delete reclaim
// (multi-process races live in distill-lock-multiprocess.test.ts)
// ---------------------------------------------------------------------------

describe("holder-declared expiry", () => {
  it("writes its own expireMs as the third field of the lock body", () => {
    expect(acquireLock(cfg({ expireMs: 45_000 }))).toBe(true);
    const [pid, token, ttl] = readFileSync(lockPath, "utf-8").split(":");
    expect(pid).toBe(String(process.pid));
    expect(token!.length).toBeGreaterThan(0);
    expect(ttl).toBe("45000");
  });

  it("judges a live holder by the expiry in its file, not the waiter's", () => {
    writeFileSync(lockPath, `${process.pid}:long-holder:1800000`, "utf-8");
    const past = new Date(Date.now() - 31_000);
    utimesSync(lockPath, past, past);
    expect(acquireLock(cfg({ expireMs: 30_000 }))).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(`${process.pid}:long-holder:1800000`);
  });

  it("still reclaims once the holder's own expiry has passed", () => {
    writeFileSync(lockPath, `${process.pid}:short-holder:5000`, "utf-8");
    const past = new Date(Date.now() - 6_000);
    utimesSync(lockPath, past, past);
    expect(acquireLock(cfg({ expireMs: 3_600_000 }))).toBe(true);
  });

  it("falls back to the waiter's expireMs for a legacy body without the field", () => {
    writeFileSync(lockPath, `${process.pid}:legacy-token`, "utf-8");
    const past = new Date(Date.now() - 31_000);
    utimesSync(lockPath, past, past);
    expect(acquireLock(cfg({ expireMs: 30_000 }))).toBe(true);
  });
});

describe("withLock heartbeat", () => {
  it("keeps a holder that outlives its expiry from being reclaimed while fn runs", async () => {
    const p = lockPathForKey("hb-keep", tempDir);
    let midRunAcquired: boolean | null = null;
    const out = await withLock("hb-keep", async () => {
      await new Promise((r) => setTimeout(r, 700));
      // Same pid ⇒ "alive"; only the mtime decides. 700 ms > 300 ms expiry, but heartbeats refreshed it.
      midRunAcquired = acquireLock({ lockPath: p, expireMs: 300 });
      return "ok";
    }, { lockDir: tempDir, expireMs: 300, heartbeatMs: 50 });
    expect(out.ran).toBe(true);
    expect(midRunAcquired).toBe(false);
    expect(existsSync(p)).toBe(false);
  });

  it("without a heartbeat the same holder is reclaimable (calibrates the test above)", async () => {
    const p = lockPathForKey("hb-none", tempDir);
    let midRunAcquired: boolean | null = null;
    await withLock("hb-none", async () => {
      await new Promise((r) => setTimeout(r, 700));
      midRunAcquired = acquireLock({ lockPath: p, expireMs: 300 });
    }, { lockDir: tempDir, expireMs: 300 });
    expect(midRunAcquired).toBe(true);
  });

  it("refreshLock never touches a lock that another owner has reclaimed", () => {
    const p = lockPathForKey("hb-reclaimed", tempDir);
    expect(acquireLock({ lockPath: p, expireMs: 60_000 })).toBe(true);
    writeFileSync(p, "99999:other-owner:60000", "utf-8");
    const past = new Date(Date.now() - 50_000);
    utimesSync(p, past, past);
    expect(refreshLock({ lockPath: p })).toBe(false);
    expect(Math.abs(statSync(p).mtimeMs - past.getTime())).toBeLessThan(1000);
    releaseLock({ lockPath: p });
    expect(readFileSync(p, "utf-8")).toBe("99999:other-owner:60000");
  });
});

describe("reclaim through the compare-and-delete marker", () => {
  const markerFor = (path: string, content: string) =>
    `${path}.cas-${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;

  it("concedes while a live process holds the marker for the stale content", () => {
    const stale = "999999:dead-holder";
    writeFileSync(lockPath, stale, "utf-8");
    writeFileSync(markerFor(lockPath, stale), `${process.pid}:busy-reclaimer`, "utf-8");
    expect(acquireLock(cfg())).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(stale);
  });

  it("breaks a marker left by a reclaimer that died mid-way, then reclaims", () => {
    const stale = "999999:dead-holder";
    const marker = markerFor(lockPath, stale);
    writeFileSync(lockPath, stale, "utf-8");
    writeFileSync(marker, "999998:dead-reclaimer", "utf-8");
    expect(acquireLock(cfg())).toBe(true);
    expect(readFileSync(lockPath, "utf-8").startsWith(`${process.pid}:`)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("release defers to a live reclaimer that holds the marker for our body", () => {
    // The reclaimer is already removing exactly our body and will create its own lock next.
    // A plain read-then-unlink release could instead remove the lock it creates in that gap.
    expect(acquireLock(cfg())).toBe(true);
    const body = readFileSync(lockPath, "utf-8");
    const marker = markerFor(lockPath, body);
    writeFileSync(marker, `${process.pid}:busy-reclaimer`, "utf-8");
    releaseLock(cfg());
    expect(readFileSync(lockPath, "utf-8")).toBe(body);
    expect(readFileSync(marker, "utf-8")).toBe(`${process.pid}:busy-reclaimer`);
  });

  it("never reclaims a just-created lock whose body is not written yet (older writer mid-create)", () => {
    writeFileSync(lockPath, "", "utf-8"); // O_EXCL open done, body not yet written
    expect(acquireLock(cfg())).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe("");
  });

  it("reclaims an unparsable lock file once it is past the grace period", () => {
    writeFileSync(lockPath, "", "utf-8");
    const past = new Date(Date.now() - 6_000);
    utimesSync(lockPath, past, past);
    expect(acquireLock(cfg())).toBe(true);
  });

  it("leaves no marker or temp files behind after a reclaim and a release", () => {
    writeFileSync(lockPath, "999999:dead-holder", "utf-8");
    expect(acquireLock(cfg())).toBe(true);
    releaseLock(cfg());
    expect(readdirSync(tempDir)).toEqual([]);
  });
});
