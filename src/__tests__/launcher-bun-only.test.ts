/**
 * bin/recallnest.mjs 只交给 Bun（2026-10-17，PR #27 复审）。
 *
 * 锁改成经 bun:ffi 调 flock 之后，Node + tsx 那条回退路在加载 src/flock.ts 时就会崩
 * （ERR_UNSUPPORTED_ESM_URL_SCHEME）。owner 拍板：RecallNest 只支持 Bun（CLAUDE.md §1）。这里钉住：
 *   - 启动脚本源码里不再有 tsx / Node 回退，唯一拉起的运行时是 bun；
 *   - PATH 里没有 bun 时以 1 退出，说清需要 Bun、怎么装，不去跑别的运行时；
 *   - 有 bun 时照常转交（参数原样传下去、退出码原样带回）。
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LAUNCHER = resolve(import.meta.dir, "../../bin/recallnest.mjs");
const SRC = readFileSync(LAUNCHER, "utf-8");
const NODE = Bun.which("node");

function runLauncher(runtime: string, path: string, args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "rn-launcher-"));
  try {
    return spawnSync(runtime, [LAUNCHER, ...args], {
      env: { PATH: path, HOME: home },
      encoding: "utf-8",
      timeout: 30_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("launcher is Bun-only", () => {
  it("has no tsx / Node fallback in its source; bun is the only runtime it spawns", () => {
    expect(SRC).not.toMatch(/tsx/);
    expect(SRC).not.toMatch(/node_modules/);
    const spawned = [...SRC.matchAll(/\bspawn\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(spawned).toEqual(["bun"]);
  });

  it("without bun on PATH: exits 1 with a message saying Bun is required and how to install it", () => {
    // Run the launcher with Bun's own binary by absolute path, but a PATH where `bun` cannot be found.
    const run = runLauncher(process.execPath, "/nonexistent-bin", ["--help"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("RecallNest requires Bun");
    expect(run.stderr).toContain("does not run on Node.js");
    expect(run.stderr).toContain("https://bun.sh/install");
    expect(run.stdout).toBe("");
  });

  it.skipIf(NODE === null)("under Node with no bun on PATH: the same clear message, not a module-load crash", () => {
    const run = runLauncher(NODE!, "/nonexistent-bin", ["--version"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("RecallNest requires Bun");
    expect(run.stderr).not.toContain("ERR_UNSUPPORTED_ESM_URL_SCHEME");
  });

  it("with bun on PATH: hands the arguments to the CLI and passes its exit code back", () => {
    const bunDir = resolve(process.execPath, "..");
    const run = runLauncher(NODE ?? process.execPath, `${bunDir}:/usr/bin:/bin`, ["--version"]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
