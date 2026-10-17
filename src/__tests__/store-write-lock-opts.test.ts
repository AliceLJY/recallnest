/**
 * store.ts 里每一处 `store-write` 临界区用的锁参数（2026-10-17）。
 *
 * 过期时间写进锁文件、等待方按持锁方的值判断（distill-lock.test.ts「holder-declared expiry」），这里钉住
 * store.ts 这一侧：
 *   - 等待预算不短于过期时间：原先等 10 s、过期 30 s，持锁 10–30 s 期间等待方直接抛错；
 *   - 全表扫描的单例版本组修复不再用 30 分钟过期（只有它自己等锁时才生效），改成同样 30 s 过期 + 心跳；
 *   - 每一处 `withWriteLock("store-write", …)` 都用这两组共享参数之一，不另写字面量。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { STORE_WRITE_LOCK_OPTS, STORE_WRITE_LONG_LOCK_OPTS } from "../store.js";

const STORE_SRC = readFileSync(resolve(import.meta.dir, "../store.ts"), "utf-8");

describe("store-write lock options", () => {
  it("waiters wait at least as long as a holder's expiry", () => {
    expect(STORE_WRITE_LOCK_OPTS.waitTimeoutMs).toBeGreaterThanOrEqual(STORE_WRITE_LOCK_OPTS.expireMs);
    expect(STORE_WRITE_LONG_LOCK_OPTS.waitTimeoutMs).toBeGreaterThanOrEqual(STORE_WRITE_LONG_LOCK_OPTS.expireMs);
  });

  it("the long critical section refreshes its lock well inside the shared expiry", () => {
    expect(STORE_WRITE_LONG_LOCK_OPTS.expireMs).toBe(STORE_WRITE_LOCK_OPTS.expireMs);
    expect(STORE_WRITE_LONG_LOCK_OPTS.heartbeatMs).toBeGreaterThan(0);
    expect(STORE_WRITE_LONG_LOCK_OPTS.heartbeatMs * 3).toBeLessThanOrEqual(STORE_WRITE_LONG_LOCK_OPTS.expireMs);
  });

  it("every store-write call in store.ts passes one of the shared option sets", () => {
    const calls = STORE_SRC.split('withWriteLock("store-write"').length - 1;
    const shared = (STORE_SRC.match(/STORE_WRITE_(LONG_)?LOCK_OPTS\);/g) ?? []).length;
    expect(calls).toBeGreaterThan(0);
    expect(shared).toBe(calls);
    // The only expiry literal left is the shared constant's own definition.
    expect(STORE_SRC.match(/expireMs:\s*[0-9]/g)?.length).toBe(1);
  });

  it("repairSingletonVersionGroups holds store-write with the heartbeat options", () => {
    const start = STORE_SRC.indexOf("async repairSingletonVersionGroups(");
    expect(start).toBeGreaterThan(-1);
    const end = STORE_SRC.indexOf("\n  async ", start + 1);
    const body = STORE_SRC.slice(start, end);
    expect(body).toContain('withWriteLock("store-write"');
    expect(body).toContain("STORE_WRITE_LONG_LOCK_OPTS);");
  });
});
