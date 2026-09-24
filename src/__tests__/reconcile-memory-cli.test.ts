import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MemoryStore } from "../store.js";

/**
 * `reconcile-memory` 命令的入口护栏（2026-09-24，第三轮互审 N1）：锁 / 审计目录必须与库所在目录一致、
 * 库里必须已有 memories 表、记忆路径必须显式配置；只看计划时不写库、不留对账日志。
 * 对账本身的行为见 memory-reconcile.test.ts。
 */

const REPO_ROOT = resolve(import.meta.dir, "../..");
const BUN = Bun.which("bun")!;
const DIM = 8;
const tmpDirs: string[] = [];

afterAll(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function harness(opts: { memoryPath?: "auto" | "explicit"; createDb?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rn-reconcile-cli-"));
  tmpDirs.push(root);
  const dataDir = join(root, "data");
  const memDir = join(root, "memory");
  mkdirSync(dataDir);
  mkdirSync(memDir);
  writeFileSync(join(memDir, "a.md"), "## 一节\n\n这是一段足够长的现行文字，用来让对账计划里有一条要插入的切片。\n");
  const dbPath = join(dataDir, "lancedb");
  if (opts.createDb !== false) {
    const store = new MemoryStore({ dbPath, vectorDim: DIM });
    await store.storeBatch([{ text: "别的 scope 的一行，只为让库里有 memories 表", vector: Array.from({ length: DIM }, (_, i) => (i + 1) / DIM), category: "facts", scope: "cc:other", importance: 0.5, metadata: "{}" }]);
  }
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    dbPath,
    embedding: { provider: "jina", apiKey: "test-key-not-used", model: "test-model", baseURL: "http://127.0.0.1:9/v1", dimensions: DIM },
    sources: { memory: { path: opts.memoryPath === "auto" ? "auto" : memDir, glob: "*.md", description: "test" } },
  }));
  return { root, dataDir, memDir, configPath };
}

function cli(args: string[], env: Record<string, string>) {
  const r = spawnSync(BUN, ["run", join(REPO_ROOT, "src/cli.ts"), "reconcile-memory", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("reconcile-memory CLI 入口护栏", () => {
  it("锁 / 审计目录与库所在目录不一致：拒绝，退出码 2", async () => {
    const h = await harness();
    const other = join(h.root, "elsewhere");
    mkdirSync(other);
    const r = cli([], { LOCAL_MEMORY_CONFIG: h.configPath, RECALLNEST_DATA_DIR: other });
    expect(r.code).toBe(2);
    expect(r.out).toContain("不一致");
  }, 90_000);

  it("库里还没有 memories 表（路径写错会对着空库对账）：拒绝，退出码 2", async () => {
    const h = await harness({ createDb: false });
    const r = cli([], { LOCAL_MEMORY_CONFIG: h.configPath, RECALLNEST_DATA_DIR: h.dataDir });
    expect(r.code).toBe(2);
    expect(r.out).toContain("memories 表");
  }, 90_000);

  it("记忆路径是 auto：拒绝，退出码 2", async () => {
    const h = await harness({ memoryPath: "auto" });
    const r = cli([], { LOCAL_MEMORY_CONFIG: h.configPath, RECALLNEST_DATA_DIR: h.dataDir });
    expect(r.code).toBe(2);
    expect(r.out).toContain("显式配置");
  }, 90_000);

  it("路径都对：只看计划，JSON 里给出计划，不写库、不留对账日志", async () => {
    const h = await harness();
    const r = cli(["--json"], { LOCAL_MEMORY_CONFIG: h.configPath, RECALLNEST_DATA_DIR: h.dataDir });
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)) as Record<string, unknown>;
    expect(json.mode).toBe("dry-run");
    expect((json.plan as Record<string, unknown>).insert).toBe(1);
    expect(json.applied).toBeNull();
    expect(existsSync(join(h.dataDir, "reconcile-journals"))).toBe(false);
    const store = new MemoryStore({ dbPath: join(h.dataDir, "lancedb"), vectorDim: DIM });
    expect(await store.listPage({ scopeFilter: ["memory"], scopeMatch: "exact" })).toHaveLength(0);
  }, 90_000);
});
