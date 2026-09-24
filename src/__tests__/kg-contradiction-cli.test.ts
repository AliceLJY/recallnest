import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { KGStore } from "../kg-store.js";
import { loadLanceDB, MemoryStore } from "../store.js";

/**
 * `conflicts kg-candidates` / `conflicts kg-compare` 只读：在临时目录的真实 LanceDB 上跑完，
 * 表名集合、每张表的版本号、行数与逐行内容都不变；库里没有 kg_triples 时也不建表。
 * 分组与对照本身的行为见 kg-contradiction.test.ts。
 */

const REPO_ROOT = resolve(import.meta.dir, "../..");
const BUN = Bun.which("bun")!;
const DIM = 4;
const SCOPE = "memory:pivot";
const tmpDirs: string[] = [];

afterAll(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function harness(opts: { withTriples: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "rn-kgc-cli-"));
  tmpDirs.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const dbPath = join(dataDir, "lancedb");

  const store = new MemoryStore({ dbPath, vectorDim: DIM });
  await store.storeBatch([
    { id: "mem-a", text: "never deploy from the macbook anymore", vector: [1, 0, 0, 0], category: "preferences", scope: SCOPE, importance: 0.5, metadata: "{}" },
    { id: "mem-b", text: "always deploy from the macbook", vector: [1, 0, 0, 0], category: "preferences", scope: SCOPE, importance: 0.5, metadata: "{}" },
    { id: "mem-c", text: "负责人是张三", vector: [0, 1, 0, 0], category: "entities", scope: SCOPE, importance: 0.5, metadata: "{}" },
    { id: "mem-d", text: "负责人换成李四", vector: [0, 1, 0, 0], category: "entities", scope: SCOPE, importance: 0.5, metadata: "{}" },
  ]);
  if (opts.withTriples) {
    const kg = new KGStore({ dbPath });
    await kg.createTriples([
      { scope: SCOPE, subject: "部署机", predicate: "是", object: "MacBook", confidence: 0.9, source_memory_id: "mem-a", source_text: "" },
      { scope: SCOPE, subject: "部署机", predicate: "是", object: "mini", confidence: 0.9, source_memory_id: "mem-b", source_text: "" },
      { scope: SCOPE, subject: "负责人", predicate: "是", object: "张三", confidence: 0.9, source_memory_id: "mem-c", source_text: "" },
      { scope: SCOPE, subject: "负责人", predicate: "是", object: "李四", confidence: 0.9, source_memory_id: "mem-d", source_text: "" },
      { scope: "cc:other", subject: "负责人", predicate: "是", object: "王五", confidence: 0.9, source_memory_id: "mem-x", source_text: "" },
    ]);
  }

  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    dbPath,
    embedding: { provider: "jina", apiKey: "test-key-not-used", model: "test-model", baseURL: "http://127.0.0.1:9/v1", dimensions: DIM },
    sources: {},
  }));
  return { dbPath, configPath, dataDir };
}

/** 表名、每张表的版本号、行数、按 id 排序的逐行内容（去掉向量以外全部列，向量转成普通数组）。 */
async function snapshot(dbPath: string): Promise<string> {
  const db = await (await loadLanceDB()).connect(dbPath);
  const names = (await db.tableNames()).sort();
  const out: Record<string, unknown> = { names };
  for (const name of names) {
    const table = await db.openTable(name);
    const rows = (await table.query().toArray()) as Array<Record<string, unknown>>;
    const plain = rows
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "vector" ? Array.from(v as Iterable<number>) : v])))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    out[name] = { version: await table.version(), count: rows.length, rows: plain };
  }
  return JSON.stringify(out);
}

function cli(args: string[], env: Record<string, string>) {
  const r = spawnSync(BUN, ["run", join(REPO_ROOT, "src/cli.ts"), "conflicts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, out: `${r.stdout}\n${r.stderr}` };
}

describe("conflicts kg-candidates / kg-compare 只读", () => {
  it("跑完两条命令，库的表、版本号、行数、内容都不变", async () => {
    const h = await harness({ withTriples: true });
    const env = { LOCAL_MEMORY_CONFIG: h.configPath, RECALLNEST_DATA_DIR: h.dataDir };
    const before = await snapshot(h.dbPath);

    const cand = cli(["kg-candidates", "--scope", SCOPE, "--json"], env);
    expect(cand.code).toBe(0);
    const candJson = JSON.parse(cand.stdout) as { tripleCount: number; candidateCount: number; candidates: Array<{ subject: string; distinctValueCount: number }> };
    expect(candJson.tripleCount).toBe(4);
    expect(candJson.candidateCount).toBe(2);
    expect(candJson.candidates.map((c) => c.subject).sort()).toEqual(["负责人", "部署机"]);

    const text = cli(["kg-candidates", "--scope", SCOPE, "--sample", "1", "--seed", "3"], env);
    expect(text.code).toBe(0);
    expect(text.out).toContain("候选，不是判决");
    expect(text.out).toContain("random sample n=1 seed=3");

    const cmp = cli(["kg-compare", "--scope", SCOPE, "--json"], env);
    expect(cmp.code).toBe(0);
    const cmpJson = JSON.parse(cmp.stdout) as {
      regexPairCount: number;
      regexCovered: Array<{ pair: { a: string; b: string } }>;
      candidatesUncaught: Array<{ candidate: { subject: string } }>;
    };
    expect(cmpJson.regexPairCount).toBe(1);
    expect(cmpJson.regexCovered.map((x) => [x.pair.a, x.pair.b].sort())).toEqual([["mem-a", "mem-b"]]);
    expect(cmpJson.candidatesUncaught.map((x) => x.candidate.subject)).toEqual(["负责人"]);

    const cmpText = cli(["kg-compare", "--scope", SCOPE], env);
    expect(cmpText.code).toBe(0);
    expect(cmpText.out).toContain("Direction 2");

    expect(await snapshot(h.dbPath)).toBe(before);
  }, 120_000);

  it("库里没有 kg_triples：输出空候选，不建表", async () => {
    const h = await harness({ withTriples: false });
    const env = { LOCAL_MEMORY_CONFIG: h.configPath, RECALLNEST_DATA_DIR: h.dataDir };
    const before = await snapshot(h.dbPath);

    const cand = cli(["kg-candidates", "--scope", SCOPE, "--json"], env);
    expect(cand.code).toBe(0);
    expect((JSON.parse(cand.stdout) as { candidateCount: number }).candidateCount).toBe(0);
    const cmp = cli(["kg-compare", "--scope", SCOPE, "--json"], env);
    expect(cmp.code).toBe(0);

    const after = await snapshot(h.dbPath);
    expect(after).toBe(before);
    expect((JSON.parse(after) as { names: string[] }).names).toEqual(["memories"]);
  }, 120_000);

  it("缺 --scope 直接拒绝", async () => {
    const h = await harness({ withTriples: false });
    const r = cli(["kg-candidates"], { LOCAL_MEMORY_CONFIG: h.configPath });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--scope");
  }, 120_000);
});
