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
import { HTTP_WRITE_IDLE_TIMEOUT_S, STORE_WRITE_NESTED_WAIT_MS } from "../store-write-budget.js";

const SRC_DIR = resolve(import.meta.dir, "..");
const STORE_SRC = readFileSync(join(SRC_DIR, "store.ts"), "utf-8");

/** Argument text of every `withWriteLock("store-write", …)` call, found by matching parentheses. */
function storeWriteCalls(src: string): string[] {
  return callsOf(src, 'withWriteLock("store-write"', "withWriteLock".length).map((c) => c.args);
}

/** Every call starting with `needle`: its argument text and the source line just above it. */
function callsOf(src: string, needle: string, nameLength: number): Array<{ args: string; lineAbove: string; method: boolean }> {
  const calls: Array<{ args: string; lineAbove: string; method: boolean }> = [];
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    const open = at + nameLength;
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    const lineStart = src.lastIndexOf("\n", at) + 1;
    const prevStart = src.lastIndexOf("\n", lineStart - 2) + 1;
    calls.push({ args: src.slice(open, end + 1), lineAbove: src.slice(prevStart, lineStart), method: src.slice(at - 5, at) === "this." });
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

describe("lock waits around store-write", () => {
  it("HTTP servers that run or proxy writes keep connections open past the store-write wait", () => {
    expect(HTTP_WRITE_IDLE_TIMEOUT_S * 1000).toBeGreaterThanOrEqual(STORE_WRITE_LOCK_OPTS.waitTimeoutMs + 30_000);
    expect(HTTP_WRITE_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255); // Bun.serve's maximum
    for (const f of ["api-server.ts", "ui-server.ts", "gateway-server.ts"]) {
      const src = readFileSync(join(SRC_DIR, f), "utf-8");
      const serve = src.slice(src.indexOf("Bun.serve({"), src.indexOf("async fetch(", src.indexOf("Bun.serve({")));
      expect(`${f}: ${/idleTimeout:\s*HTTP_WRITE_IDLE_TIMEOUT_S/.test(serve)}`).toBe(`${f}: true`);
    }
  });

  it("an outer lock that may take store-write inside waits at least the store-write wait plus a margin", () => {
    expect(STORE_WRITE_NESTED_WAIT_MS).toBeGreaterThan(STORE_WRITE_LOCK_OPTS.waitTimeoutMs);
  });

  it("every waiting lock under src/ either uses the nested budget or says why it never takes store-write", () => {
    // Waiting locks: withWriteLock / withCrossProcessLock (its alias in trigger-store.ts) other than
    // store-write itself, and withLock calls that do not skip when busy. In-process write chains
    // (`this.withWriteLock(` in kg-store / trigger-store) are not cross-process locks.
    const offenders: string[] = [];
    let total = 0;
    for (const f of readdirSync(SRC_DIR).filter((name) => name.endsWith(".ts") && name !== "distill-lock.ts")) {
      const src = readFileSync(join(SRC_DIR, f), "utf-8");
      const calls = [
        ...callsOf(src, "withWriteLock(", "withWriteLock".length),
        ...callsOf(src, "withCrossProcessLock(", "withCrossProcessLock".length),
        ...callsOf(src, "withLock(", "withLock".length),
      ];
      for (const call of calls) {
        if (call.method || call.args.startsWith('("store-write"')) continue;
        if (call.args.startsWith("<T>(") || call.args.startsWith("(fn")) continue; // a definition, not a call
        if (/onBusy:\s*"skip"/.test(call.args)) continue;
        total++;
        const justified = /\/\/ lock-wait: no store-write inside/.test(call.lineAbove);
        if (!justified && !/STORE_WRITE_NESTED_WAIT_MS/.test(call.args)) offenders.push(`${f}: ${call.args.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(6);
  });

  it("the known nested sites use the nested budget (not just a comment)", () => {
    const mirror = readFileSync(join(SRC_DIR, "checkpoint-mirror.ts"), "utf-8");
    const mirrorCalls = callsOf(mirror, "withWriteLock(MIRROR_LOCK_KEY", "withWriteLock".length);
    expect(mirrorCalls).toHaveLength(2);
    for (const call of mirrorCalls) expect(call.args).toMatch(/waitTimeoutMs:\s*(2 \* )?STORE_WRITE_NESTED_WAIT_MS/);
    const distiller = readFileSync(join(SRC_DIR, "session-distiller.ts"), "utf-8");
    const [distill] = callsOf(distiller, "withWriteLock(", "withWriteLock".length).filter((c) => c.args.includes("distill-"));
    expect(distill!.args).toMatch(/waitTimeoutMs:\s*STORE_WRITE_NESTED_WAIT_MS/);
  });
});
