/**
 * 每一处 `store-write` 临界区用的锁参数（2026-10-17，PR #27 互审后改成 flock）。
 *
 * 锁现在是内核 flock：活着的持有者谁都拿不走，参数只剩「等多久」和「持有多久算卡住、要报警」。这里钉住：
 *   - 等待预算不短于正常持有的上限：原先等 10 s、持有方按 30 s 算，持锁 10–30 s 期间等待方直接抛错；
 *   - 全表扫描的单例版本组修复按 30 分钟算卡住，到点在批与批之间停下，把锁还回去；
 *   - src/ 下每一处 `withWriteLock("store-write", …)` 都用 store.ts 的共享参数，不另写字面量
 *     （互审：checkpoint-mirror.ts 的嵌套 store-write 当时还是 30 s / 默认等 10 s）。
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { STORE_WRITE_LOCK_OPTS, STORE_WRITE_LONG_LOCK_OPTS } from "../store.js";

const SRC_DIR = resolve(import.meta.dir, "..");
const STORE_SRC = readFileSync(join(SRC_DIR, "store.ts"), "utf-8");

/** Argument text of every `withWriteLock("store-write", …)` call, found by matching parentheses. */
function storeWriteCalls(src: string): string[] {
  const calls: string[] = [];
  const needle = 'withWriteLock("store-write"';
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    const open = at + "withWriteLock".length;
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    calls.push(src.slice(open, end + 1));
  }
  return calls;
}

describe("store-write lock options", () => {
  it("waiters wait at least as long as a normal hold may last", () => {
    expect(STORE_WRITE_LOCK_OPTS.waitTimeoutMs).toBeGreaterThanOrEqual(STORE_WRITE_LOCK_OPTS.maxHoldMs);
    expect(STORE_WRITE_LONG_LOCK_OPTS.waitTimeoutMs).toBe(STORE_WRITE_LOCK_OPTS.waitTimeoutMs);
  });

  it("the full-table pass only counts as stuck after 30 minutes", () => {
    expect(STORE_WRITE_LONG_LOCK_OPTS.maxHoldMs).toBe(30 * 60_000);
  });

  it("every store-write call under src/ passes the shared options and no literal of its own", () => {
    const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    let total = 0;
    for (const f of files) {
      for (const call of storeWriteCalls(readFileSync(join(SRC_DIR, f), "utf-8"))) {
        total++;
        if (!/STORE_WRITE_(LONG_)?LOCK_OPTS/.test(call) || /(expireMs|maxHoldMs|waitTimeoutMs)\s*:/.test(call)) {
          offenders.push(`${f}: ${call.slice(-120)}`);
        }
      }
    }
    expect(total).toBeGreaterThanOrEqual(10); // 9 in store.ts + checkpoint-mirror's purge
    expect(offenders).toEqual([]);
    expect(storeWriteCalls(readFileSync(join(SRC_DIR, "checkpoint-mirror.ts"), "utf-8")).length).toBe(1);
  });

  it("repairSingletonVersionGroups holds store-write with the long options and stops between batches past them", () => {
    const start = STORE_SRC.indexOf("async repairSingletonVersionGroups(");
    expect(start).toBeGreaterThan(-1);
    const body = STORE_SRC.slice(start, STORE_SRC.indexOf("\n  async ", start + 1));
    const [call] = storeWriteCalls(body);
    expect(call).toContain("STORE_WRITE_LONG_LOCK_OPTS");
    expect(body).toMatch(/for \(let i = 0; i < repairs\.length; i \+= BATCH\) \{[\s\S]*?if \(signal\.aborted\)/);
  });
});
