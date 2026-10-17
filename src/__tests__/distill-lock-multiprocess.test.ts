/**
 * 跨进程锁的多进程用例（2026-10-17）。distill-lock.test.ts 只在单进程里跑，这里把锁交给真的子进程去抢。
 *
 *   1. 回收过期锁的竞态：留一把过期锁（持有者 pid 已死 / 持有者活着但锁文件过期），8 个子进程在同一时刻
 *      `acquireLock`，重复 100 轮，每轮恰好一个赢家，锁文件里留着的就是赢家写进去的那份。
 *      改之前是「读 → 删 → 建」，A 的删会删掉 B 刚建好的新锁，这台云端机器上 40 轮里 15–17 轮不止一个赢家。
 *   2. 端到端互斥：几个子进程用 `withWriteLock` 在锁内对同一个计数文件做读改写，中途有进程持锁时被
 *      SIGKILL，剩下的进程回收它的锁后继续；临界区用 O_EXCL 哨兵文件探测「同时有两个在里面」。
 *   3. 过期时间以持锁方为准：子进程以 30 分钟过期持锁，锁文件 mtime 往回拨 31 秒，按 30 秒判断的
 *      等待方仍然拿不到锁；子进程跑完自己放锁。
 *
 * 一律在临时目录里跑，不碰 data/。
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { acquireLock, lockPathForKey } from "../distill-lock.js";

const LOCK_MODULE = resolve(import.meta.dir, "../distill-lock.ts");
const BUN = Bun.which("bun")!;
const tmpDirs: string[] = [];

afterAll(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 一个确定已经退出的进程的 pid：起一个立刻结束的进程，等它退出再拿它的 pid。 */
function deadPid(): number {
  const child = spawnSync("true");
  const pid = child.pid;
  if (typeof pid !== "number") throw new Error("could not obtain a dead pid");
  return pid;
}

interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(script: string, args: string[]): Promise<ChildRun> {
  return new Promise((done, fail) => {
    const child = spawn(BUN, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", fail);
    child.on("close", (code, signal) => done({ code, signal, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// 1. 同时回收同一把过期锁：每轮至多（也恰好）一个赢家
// ---------------------------------------------------------------------------

const RECLAIM_CHILD = `
import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, roundsArg, t0Arg, gapArg, expireArg] = process.argv.slice(2);
const rounds = Number(roundsArg), t0 = Number(t0Arg), gap = Number(gapArg), expireMs = Number(expireArg);
const results = [];
for (let r = 0; r < rounds; r++) {
  const start = t0 + r * gap;
  while (Date.now() < start) { /* 自旋等到这一轮的发令时刻，让 8 个进程尽量同时出手 */ }
  const lockPath = join(dir, "round-" + r + ".lock");
  const won = acquireLock({ lockPath, expireMs });
  // 赢了就立刻记下自己写进去的内容：别的进程若把它删掉重建，终局内容就对不上了。
  results.push({ round: r, won, body: won ? readFileSync(lockPath, "utf-8") : null });
}
// 不放锁，也先别退出：赢家的 pid 一死，落在后面的进程就能合法回收，那就测不出竞态了。
const end = t0 + rounds * gap + 1500;
while (Date.now() < end) await new Promise((r) => setTimeout(r, 20));
console.log(JSON.stringify({ pid: process.pid, results }));
`;

interface ReclaimResult {
  pid: number;
  results: Array<{ round: number; won: boolean; body: string | null }>;
}

async function raceReclaim(staleBody: string, staleMtime: Date | null): Promise<void> {
  const CHILDREN = 8;
  const ROUNDS = 100;
  const GAP_MS = 30;
  const EXPIRE_MS = 60_000;
  const dir = tempDir("rn-lock-reclaim-");
  const script = join(dir, "child.ts");
  writeFileSync(script, RECLAIM_CHILD);
  for (let r = 0; r < ROUNDS; r++) {
    const p = join(dir, `round-${r}.lock`);
    writeFileSync(p, staleBody);
    if (staleMtime) utimesSync(p, staleMtime, staleMtime);
  }
  // 子进程启动要几百毫秒，发令时刻留足余量；晚到的进程照样参赛，只是对手少了，不影响断言。
  const t0 = Date.now() + 2_500;
  const runs = await Promise.all(
    Array.from({ length: CHILDREN }, () =>
      runChild(script, [dir, String(ROUNDS), String(t0), String(GAP_MS), String(EXPIRE_MS)])),
  );
  const parsed: ReclaimResult[] = runs.map((run) => {
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout.trim()) as ReclaimResult;
  });

  const multiWinnerRounds: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const winners = parsed.flatMap((p) => p.results.filter((x) => x.round === r && x.won));
    if (winners.length !== 1) multiWinnerRounds.push(r);
    if (winners.length === 1) {
      // 锁文件里留着的就是赢家写的那份：没有别的进程把它删了重建。
      expect(readFileSync(join(dir, `round-${r}.lock`), "utf-8")).toBe(winners[0]!.body!);
    }
  }
  expect(multiWinnerRounds).toEqual([]);
}

describe("reclaiming a stale lock from many processes at once", () => {
  it("dead holder: exactly one of 8 processes wins, in every one of 100 rounds", async () => {
    await raceReclaim(`${deadPid()}:dead-holder-token`, null);
  }, 30_000);

  it("expired holder that is still alive: exactly one of 8 processes wins, in every one of 100 rounds", async () => {
    // 持有者是测试进程本身（活着），锁文件两小时没动过，按 60 秒判定为过期。
    await raceReclaim(`${process.pid}:expired-holder-token`, new Date(Date.now() - 7_200_000));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. 端到端：持锁进程被杀掉之后，剩下的写方之间仍然互斥
// ---------------------------------------------------------------------------

const WORKER_CHILD = `
import { withWriteLock, lockPathForKey } from ${JSON.stringify(LOCK_MODULE)};
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [dir, itersArg, t0Arg] = process.argv.slice(2);
const iters = Number(itersArg), t0 = Number(t0Arg);
const counter = join(dir, "counter");
const sentinel = join(dir, "inside");
while (Date.now() < t0) await new Promise((r) => setTimeout(r, 2));
for (let i = 0; i < iters; i++) {
  await withWriteLock("mp-counter", async () => {
    let fd;
    try { fd = openSync(sentinel, "wx"); } catch {
      appendFileSync(join(dir, "violations"), process.pid + "\\n");
    }
    const n = Number(readFileSync(counter, "utf-8"));
    await new Promise((r) => setTimeout(r, 1));
    writeFileSync(counter, String(n + 1));
    if (fd !== undefined) { closeSync(fd); unlinkSync(sentinel); }
  }, { lockDir: dir, expireMs: 20_000, waitTimeoutMs: 25_000, pollMs: 1 });
}
console.log("done");
`;

const VICTIM_CHILD = `
import { acquireLock, lockPathForKey } from ${JSON.stringify(LOCK_MODULE)};
const [dir, t0Arg, delayArg] = process.argv.slice(2);
const at = Number(t0Arg) + Number(delayArg);
while (Date.now() < at) await new Promise((r) => setTimeout(r, 1));
const lockPath = lockPathForKey("mp-counter", dir);
for (;;) {
  if (acquireLock({ lockPath, expireMs: 20_000 })) {
    console.log("holding");
    process.kill(process.pid, "SIGKILL"); // 持锁时被杀，锁文件留在原地、持有者 pid 已死
  }
  await new Promise((r) => setTimeout(r, 1));
}
`;

describe("mutual exclusion survives holders being SIGKILLed", () => {
  it("counter read-modify-write under withWriteLock loses no update and never has two writers inside", async () => {
    const WORKERS = 6;
    const ITERS = 25;
    const dir = tempDir("rn-lock-kill-");
    const worker = join(dir, "worker.ts");
    const victim = join(dir, "victim.ts");
    writeFileSync(worker, WORKER_CHILD);
    writeFileSync(victim, VICTIM_CHILD);
    writeFileSync(join(dir, "counter"), "0");
    // 一开始就有一把死掉的持有者留下的锁：第一批写方一起来回收。
    writeFileSync(lockPathForKey("mp-counter", dir), `${deadPid()}:dead-holder-token`);

    const t0 = Date.now() + 2_500;
    const runs = await Promise.all([
      ...Array.from({ length: WORKERS }, () => runChild(worker, [dir, String(ITERS), String(t0)])),
      ...[30, 120, 260].map((delay) => runChild(victim, [dir, String(t0), String(delay)])),
    ]);
    const workers = runs.slice(0, WORKERS);
    const victims = runs.slice(WORKERS);
    for (const run of workers) {
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
    }
    for (const run of victims) {
      expect(run.signal).toBe("SIGKILL");
      expect(run.stdout.trim()).toBe("holding");
    }
    expect(existsSync(join(dir, "violations")) ? readFileSync(join(dir, "violations"), "utf-8") : "").toBe("");
    expect(Number(readFileSync(join(dir, "counter"), "utf-8"))).toBe(WORKERS * ITERS);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. 过期时间以持锁方写进锁文件的为准
// ---------------------------------------------------------------------------

const LONG_HOLDER_CHILD = `
import { withLock } from ${JSON.stringify(LOCK_MODULE)};
import { existsSync } from "node:fs";
import { join } from "node:path";
const [dir] = process.argv.slice(2);
await withLock("long-holder", async () => {
  console.log("HELD");
  // 一直占着，直到父进程放下 go 文件
  while (!existsSync(join(dir, "go"))) await new Promise((r) => setTimeout(r, 10));
  console.log("CHILD_DONE");
}, { lockDir: dir, expireMs: 30 * 60_000 });
`;

describe("expiry is the holder's, not the waiter's", () => {
  it("a waiter judging by 30 s cannot take a lock its live holder declared for 30 min", async () => {
    const dir = tempDir("rn-lock-expire-");
    const script = join(dir, "holder.ts");
    writeFileSync(script, LONG_HOLDER_CHILD);
    const lockPath = lockPathForKey("long-holder", dir);

    const child = spawn(BUN, [script, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
    await new Promise<void>((done) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("HELD")) done();
      });
    });

    // 持锁方 31 秒没刷新过锁文件；等待方自己按 30 秒判断的话会当成过期锁回收。
    const past = new Date(Date.now() - 31_000);
    utimesSync(lockPath, past, past);
    const bodyBefore = readFileSync(lockPath, "utf-8");
    expect(acquireLock({ lockPath, expireMs: 30_000 })).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(bodyBefore);

    writeFileSync(join(dir, "go"), "");
    expect(await closed).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("CHILD_DONE");
    expect(existsSync(lockPath)).toBe(false); // 持锁方自己放的锁，没被别人动过
  }, 20_000);
});
