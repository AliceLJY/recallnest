/**
 * 跨进程锁的多进程用例（2026-10-17；PR #27 互审后锁改成内核 flock）。distill-lock.test.ts 只在单进程里跑，
 * 这里把锁交给真的子进程：
 *
 *   1. 同时抢：上一个持有者死了、锁文件留在原地，8 个子进程在同一时刻 `acquireLock`，100 轮，每轮恰好一个赢家，
 *      锁文件里留着的就是赢家写的那份。改成 flock 之前是「读 → 删 → 建」，40 轮里 15–17 轮不止一个赢家。
 *      旧格式锁文件写着活着的 pid（还没停掉的旧版进程）：100 轮里一个赢家都没有。
 *   2. 任意时刻 SIGKILL：6 个子进程不停地进出 `withWriteLock`，父进程每隔几十毫秒随机杀掉一个再补一个
 *      ——落在拿锁中、临界区里、放锁中都有可能。临界区里用写着 pid 的哨兵文件探测「同时有两个活进程在里面」。
 *   3. 持有者被杀：哪怕它登记的预计持有是 30 分钟，别的进程立刻就能拿到，不用等任何过期。
 *   4. 持有超时：子进程登记 300 ms、却一直不出临界区；锁文件 mtime 再往回拨两小时。别的进程照样拿不到
 *      （不会因为超时被抢），等待方超时报错时点出持有者 pid，持有方和等待方都打出告警。
 *
 * 一律在临时目录里跑，不碰 data/。
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { acquireLock, lockPathForKey, releaseLock, withWriteLock } from "../distill-lock.js";

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
  const pid = spawnSync("true").pid;
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

/** Start a child and resolve once its stdout contains `marker`. */
function startUntil(script: string, args: string[], marker: string): Promise<{ child: ChildProcess; out: () => string; err: () => string; closed: Promise<number | null> }> {
  return new Promise((done, fail) => {
    const child = spawn(BUN, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const closed = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", fail);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(marker)) done({ child, out: () => stdout, err: () => stderr, closed });
    });
    void closed.then(() => { if (!stdout.includes(marker)) fail(new Error(`child exited before '${marker}': ${stderr}`)); });
  });
}

// ---------------------------------------------------------------------------
// 1. 同时抢一把空出来的锁
// ---------------------------------------------------------------------------

const RACE_CHILD = `
import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, roundsArg, t0Arg, gapArg] = process.argv.slice(2);
const rounds = Number(roundsArg), t0 = Number(t0Arg), gap = Number(gapArg);
const results = [];
for (let r = 0; r < rounds; r++) {
  const start = t0 + r * gap;
  while (Date.now() < start) { /* 自旋等到这一轮的发令时刻，让 8 个进程尽量同时出手 */ }
  const lockPath = join(dir, "round-" + r + ".lock");
  const won = acquireLock({ lockPath, expireMs: 60_000 });
  results.push({ round: r, won, body: won ? readFileSync(lockPath, "utf-8") : null });
}
// 不放锁，也先别退出：赢家一退出，落在后面的进程就能合法拿到锁，那就测不出同时有两个了。
const end = t0 + rounds * gap + 1500;
while (Date.now() < end) await new Promise((r) => setTimeout(r, 20));
console.log(JSON.stringify({ pid: process.pid, results }));
`;

interface RaceResult {
  pid: number;
  results: Array<{ round: number; won: boolean; body: string | null }>;
}

async function race(leftover: string): Promise<{ winnersPerRound: number[]; dir: string; parsed: RaceResult[] }> {
  const CHILDREN = 8;
  const ROUNDS = 100;
  const GAP_MS = 30;
  const dir = tempDir("rn-lock-race-");
  const script = join(dir, "child.ts");
  writeFileSync(script, RACE_CHILD);
  for (let r = 0; r < ROUNDS; r++) writeFileSync(join(dir, `round-${r}.lock`), leftover);
  // 子进程启动要几百毫秒，发令时刻留足余量；晚到的进程照样参赛，只是对手少了，不影响断言。
  const t0 = Date.now() + 2_500;
  const runs = await Promise.all(
    Array.from({ length: CHILDREN }, () => runChild(script, [dir, String(ROUNDS), String(t0), String(GAP_MS)])),
  );
  const parsed: RaceResult[] = runs.map((run) => {
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout.trim()) as RaceResult;
  });
  const winnersPerRound = Array.from({ length: ROUNDS }, (_, r) =>
    parsed.reduce((n, p) => n + p.results.filter((x) => x.round === r && x.won).length, 0));
  return { winnersPerRound, dir, parsed };
}

describe("many processes acquiring the same free lock at once", () => {
  it("lock file left by a dead holder: exactly one of 8 wins, in every one of 100 rounds", async () => {
    const { winnersPerRound, dir, parsed } = await race(`${deadPid()}:dead-holder:flock:${Date.now()}:30000`);
    expect(winnersPerRound.filter((n) => n !== 1)).toEqual([]);
    for (let r = 0; r < winnersPerRound.length; r++) {
      const winner = parsed.flatMap((p) => p.results).find((x) => x.round === r && x.won)!;
      expect(readFileSync(join(dir, `round-${r}.lock`), "utf-8")).toBe(winner.body!);
    }
  }, 30_000);

  it("pre-flock lock file naming a live pid: nobody takes it, in any of 100 rounds", async () => {
    const { winnersPerRound } = await race(`${process.pid}:legacy-holder`);
    expect(winnersPerRound.filter((n) => n !== 0)).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. 随机时刻 SIGKILL，互斥照样成立、也不会卡死
// ---------------------------------------------------------------------------

const WORKER_CHILD = `
import { withWriteLock } from ${JSON.stringify(LOCK_MODULE)};
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const [dir] = process.argv.slice(2);
const sentinel = join(dir, "inside");
// A SIGKILLed worker stays a zombie until the test runner reaps it: kill(pid, 0) still succeeds,
// but the process is gone and the kernel has already dropped its flock. Count zombies as dead.
const statState = (line) => line.slice(line.lastIndexOf(") ") + 2, line.lastIndexOf(") ") + 3);
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  const stat = existsSync("/proc/" + pid + "/stat")
    ? statState(readFileSync("/proc/" + pid + "/stat", "utf-8"))
    : spawnSync("ps", ["-o", "stat=", "-p", String(pid)]).stdout.toString().trim().slice(0, 1);
  return stat !== "Z" && stat !== "";
};
console.log("up");
for (;;) {
  await withWriteLock("mp-kill", async () => {
    // 哨兵写着当前在临界区里的 pid。还在、且那个 pid 活着 = 有两个活进程同时在里面。
    // 还在但 pid 已死 = 上一个持有者在临界区里被杀了，不算违例。
    try {
      const fd = openSync(sentinel, "wx"); writeFileSync(fd, String(process.pid)); closeSync(fd);
    } catch {
      const other = Number(readFileSync(sentinel, "utf-8"));
      if (other && other !== process.pid && alive(other)) appendFileSync(join(dir, "violations"), other + " " + process.pid + " " + Date.now() + "\\n");
      writeFileSync(sentinel, String(process.pid));
    }
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    if (readFileSync(sentinel, "utf-8") === String(process.pid)) unlinkSync(sentinel);
    appendFileSync(join(dir, "done-" + process.pid), "x");
  }, { lockDir: dir, maxHoldMs: 30_000, waitTimeoutMs: 60_000, pollMs: 1 });
}
`;

describe("mutual exclusion survives SIGKILL at any point", () => {
  it("6 workers, one killed and replaced every 15–60 ms for 6 s: never two live writers inside, never wedged", async () => {
    const dir = tempDir("rn-lock-kill-");
    const worker = join(dir, "worker.ts");
    writeFileSync(worker, WORKER_CHILD);
    const workers = new Set<ChildProcess>();
    const spawnWorker = (): void => {
      const child = spawn(BUN, [worker, dir], { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr!.on("data", (chunk: Buffer) => { stderrAll += chunk.toString(); });
      workers.add(child);
      child.on("close", () => workers.delete(child));
    };
    let stderrAll = "";
    for (let i = 0; i < 6; i++) spawnWorker();
    await new Promise((r) => setTimeout(r, 1_500)); // let them start

    let kills = 0;
    const killedAt = new Map<number, number>();
    const until = Date.now() + 6_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 45));
      const list = [...workers];
      const victim = list[Math.floor(Math.random() * list.length)];
      if (victim?.pid !== undefined && !killedAt.has(victim.pid)) {
        killedAt.set(victim.pid, Date.now()); // recorded before the signal is sent
        if (victim.kill("SIGKILL")) kills++;
      }
      spawnWorker();
    }
    const doneBefore = countDone(dir);
    // Still making progress after the storm: the lock is not wedged by any of the killed holders.
    await new Promise((r) => setTimeout(r, 1_000));
    const doneAfter = countDone(dir);
    for (const w of workers) w.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));

    expect(kills).toBeGreaterThan(80);
    // A process being SIGKILLed has its flock dropped in the kernel's exit path a moment before it
    // shows up as a zombie, so a check landing in that gap still sees it "alive". It cannot run any
    // code by then; such a sighting is only discounted when the parent had already sent that pid
    // SIGKILL before the sighting. Anything else is two live writers inside at once.
    const sightings = existsSync(join(dir, "violations")) ? readFileSync(join(dir, "violations"), "utf-8").trim().split("\n") : [];
    const violations = sightings.filter((line) => {
      const [other, , at] = line.split(" ").map(Number);
      const killed = killedAt.get(other!);
      return !(killed !== undefined && killed <= at!);
    });
    expect(violations).toEqual([]);
    expect(doneBefore).toBeGreaterThan(200);
    expect(doneAfter).toBeGreaterThan(doneBefore);
    expect(stderrAll).not.toMatch(/timed out|Error/);
    // And this process gets it right away once everyone is gone.
    expect(acquireLock({ lockPath: lockPathForKey("mp-kill", dir) })).toBe(true);
    releaseLock({ lockPath: lockPathForKey("mp-kill", dir) });
  }, 30_000);
});

function countDone(dir: string): number {
  let n = 0;
  for (const f of require("node:fs").readdirSync(dir) as string[]) {
    if (f.startsWith("done-")) n += readFileSync(join(dir, f), "utf-8").length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 3. 持有者被杀：立刻能拿到，不等任何过期
// ---------------------------------------------------------------------------

const HOLDER_CHILD = `
import { withLock } from ${JSON.stringify(LOCK_MODULE)};
const [dir, key, maxHold] = process.argv.slice(2);
await withLock(key, async () => {
  console.log("HELD");
  await new Promise(() => { setInterval(() => {}, 1000); }); // 一直不出临界区
}, { lockDir: dir, maxHoldMs: Number(maxHold) });
`;

describe("a killed holder frees the lock at once", () => {
  it("holder that declared 30 min is SIGKILLed: the next process acquires within a second", async () => {
    const dir = tempDir("rn-lock-killed-holder-");
    const script = join(dir, "holder.ts");
    writeFileSync(script, HOLDER_CHILD);
    const lockPath = lockPathForKey("killed-holder", dir);
    const h = await startUntil(script, [dir, "killed-holder", String(30 * 60_000)], "HELD");
    expect(acquireLock({ lockPath })).toBe(false);
    h.child.kill("SIGKILL");
    await h.closed;
    const start = Date.now();
    let got = false;
    while (!got && Date.now() - start < 1_000) {
      got = acquireLock({ lockPath });
      if (!got) await new Promise((r) => setTimeout(r, 10));
    }
    expect(got).toBe(true);
    releaseLock({ lockPath });
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 4. 持有超过 maxHold：告警，但锁不会被抢
// ---------------------------------------------------------------------------

describe("max-hold deadline across processes", () => {
  it("a stuck holder past its max hold is never pushed out; waiter times out naming it; both sides warn", async () => {
    const dir = tempDir("rn-lock-deadline-");
    const script = join(dir, "holder.ts");
    writeFileSync(script, HOLDER_CHILD);
    const lockPath = lockPathForKey("stuck", dir);
    const h = await startUntil(script, [dir, "stuck", "300"], "HELD");
    const holderPid = h.child.pid!;
    try {
      await new Promise((r) => setTimeout(r, 600)); // well past the 300 ms max hold
      const twoHoursAgo = new Date(Date.now() - 7_200_000);
      utimesSync(lockPath, twoHoursAgo, twoHoursAgo); // stale mtime means nothing either
      expect(acquireLock({ lockPath, expireMs: 1_000 })).toBe(false);

      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
      try {
        await expect(withWriteLock("stuck", async () => 1, { lockDir: dir, waitTimeoutMs: 400, pollMs: 20 }))
          .rejects.toThrow(new RegExp(`timed out after 400ms \\(held by pid ${holderPid}, held \\d+ s \\(max hold 0 s\\)\\)`));
      } finally {
        console.warn = original;
      }
      expect(warnings.some((w) => w.includes(`held by pid ${holderPid}`) && w.includes("past its max hold"))).toBe(true);
      expect(h.err()).toContain("past its max hold");
      expect(h.child.exitCode).toBeNull(); // still running, still holding
    } finally {
      h.child.kill("SIGKILL");
      await h.closed;
    }
  }, 20_000);
});
