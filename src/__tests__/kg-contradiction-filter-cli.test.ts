import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { KGStore } from "../kg-store.js";
import { loadLanceDB, MemoryStore } from "../store.js";

/**
 * `conflicts kg-candidates` / `conflicts kg-compare` 的过滤选项（--predicates / --functional-min /
 * --functional-min-subjects / --min-second-mentions）走到命令行这一层：
 * - 一个选项都不传时，stdout 与改动前的实现逐字节一致（golden 由改动前的代码在同一夹具上生成）；
 * - 传了选项时输出 funnel（JSON 另有 predicateStats），kg-compare 用过滤后的候选对照；
 * - 仍然只读：跑完表、版本号、行数、逐行内容都不变。
 * 过滤与统计本身的行为见 kg-contradiction.test.ts。
 */

const REPO_ROOT = resolve(import.meta.dir, "../..");
const GOLDEN_DIR = join(import.meta.dir, "fixtures", "kg-contradiction-golden");
const BUN = Bun.which("bun")!;
const DIM = 4;
const SCOPE = "memory:pivot";
/** 固定的抽取时间，让输出里的日期与时间戳不随运行时刻变化 */
const FIXED_MS = 1_750_000_000_000;
const tmpDirs: string[] = [];

afterAll(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

type TripleSeed = { subject: string; predicate: string; object: string; source: string; scope?: string };

/**
 * 夹具（scope = memory:pivot）：
 * - located_in：5 个工具，tool-e 有两个位置（hooks / 废纸篓，各 2 条来源记忆）；
 *   tool-a 的 "Hooks" 与 "hooks" 归一化后同值。functionality = 5 / 6。
 * - has：2 个主体，proj-x 三个取值、proj-y 两个取值。functionality = 2 / 5。
 * - 是：部署机 MacBook / mini、负责人 张三 / 李四（带一对正则命中）。functionality = 2 / 4。
 * - 另有别的 scope 一行，不该进任何统计。
 */
const SEEDS: TripleSeed[] = [
  { subject: "tool-a", predicate: "located_in", object: "Hooks", source: "mem-1" },
  { subject: "tool-a", predicate: "located_in", object: "hooks", source: "mem-2" },
  { subject: "tool-b", predicate: "located_in", object: "bin", source: "mem-3" },
  { subject: "tool-c", predicate: "located_in", object: "bin", source: "mem-4" },
  { subject: "tool-d", predicate: "located_in", object: "opt", source: "mem-5" },
  { subject: "tool-e", predicate: "located_in", object: "~/.claude/hooks", source: "mem-e1" },
  { subject: "tool-e", predicate: "located_in", object: "~/.claude/hooks", source: "mem-e2" },
  { subject: "tool-e", predicate: "located_in", object: "~/.Trash", source: "mem-e3" },
  { subject: "tool-e", predicate: "located_in", object: "~/.Trash", source: "mem-e4" },
  { subject: "proj-x", predicate: "has", object: "tests", source: "mem-6" },
  { subject: "proj-x", predicate: "has", object: "docs", source: "mem-7" },
  { subject: "proj-x", predicate: "has", object: "ci", source: "mem-8" },
  { subject: "proj-y", predicate: "has", object: "cli", source: "mem-9" },
  { subject: "proj-y", predicate: "has", object: "ui", source: "mem-10" },
  { subject: "部署机", predicate: "是", object: "MacBook", source: "mem-a" },
  { subject: "部署机", predicate: "是", object: "mini", source: "mem-b" },
  { subject: "负责人", predicate: "是", object: "张三", source: "mem-c" },
  { subject: "负责人", predicate: "是", object: "李四", source: "mem-d" },
  { subject: "负责人", predicate: "是", object: "王五", source: "mem-x", scope: "cc:other" },
];

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "rn-kgc-filter-cli-"));
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
  // 逐条写，让同一 (S,P,O) 的多条来源走 KGStore 自己的合并路径
  const kg = new KGStore({ dbPath });
  for (const s of SEEDS) {
    await kg.createTriples([
      { scope: s.scope ?? SCOPE, subject: s.subject, predicate: s.predicate, object: s.object, confidence: 0.9, source_memory_id: s.source, source_text: "" },
    ]);
  }
  // 抽取时间固定下来（夹具准备，不是被测命令的写入）
  const db = await (await loadLanceDB()).connect(dbPath);
  const table = await db.openTable("kg_triples");
  await table.update({ where: "id != '__schema__'", values: { timestamp: FIXED_MS, first_seen: FIXED_MS } });
  // 记忆的时间各不相同且固定：正则检测输入按时间排序，同毫秒写入时对内先后会漂
  const memories = await db.openTable("memories");
  for (const [i, id] of ["mem-a", "mem-b", "mem-c", "mem-d"].entries()) {
    await memories.update({ where: `id = '${id}'`, values: { timestamp: FIXED_MS + (i + 1) * 1000 } });
  }

  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    dbPath,
    embedding: { provider: "jina", apiKey: "test-key-not-used", model: "test-model", baseURL: "http://127.0.0.1:9/v1", dimensions: DIM },
    sources: {},
  }));
  return { dbPath, env: { LOCAL_MEMORY_CONFIG: configPath, RECALLNEST_DATA_DIR: dataDir } };
}

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

/** 不带任何新选项的五种调用：golden 文件名 → 参数 */
const UNFILTERED_RUNS: Array<[string, string[]]> = [
  ["kg-candidates.json.txt", ["kg-candidates", "--scope", SCOPE, "--json"]],
  ["kg-candidates.text.txt", ["kg-candidates", "--scope", SCOPE]],
  ["kg-candidates.sample.txt", ["kg-candidates", "--scope", SCOPE, "--sample", "2", "--seed", "7"]],
  ["kg-compare.json.txt", ["kg-compare", "--scope", SCOPE, "--json"]],
  ["kg-compare.text.txt", ["kg-compare", "--scope", SCOPE, "--limit", "2"]],
];

describe("conflicts kg-candidates / kg-compare 过滤选项（命令行）", () => {
  it("一个新选项都不传：stdout 与改动前逐字节一致", async () => {
    const h = await harness();
    for (const [file, args] of UNFILTERED_RUNS) {
      const r = cli(args, h.env);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(readFileSync(join(GOLDEN_DIR, file), "utf-8"));
    }
  }, 180_000);

  it("传了过滤选项：kg-candidates 带 funnel 与 predicateStats，kg-compare 用过滤后的候选对照；库不变", async () => {
    const h = await harness();
    const before = await snapshot(h.dbPath);

    type Funnel = Array<{ step: string; status: string; remaining: number; removed: number }>;
    type CandOut = {
      candidateCount: number;
      funnel: Funnel;
      predicateStats: Array<{ predicate: string; subjects: number; pairs: number; functionality: number; multiValuedSubjects: number }>;
      candidates: Array<{ subject: string; predicate: string }>;
    };
    const steps = (f: Funnel) => f.map((x) => `${x.step}:${x.status === "skipped" ? "skipped" : x.remaining}`);

    // (a) 只开 --functional-min 0.8
    const a = cli(["kg-candidates", "--scope", SCOPE, "--functional-min", "0.8", "--json"], h.env);
    expect(a.code).toBe(0);
    const aj = JSON.parse(a.stdout) as CandOut;
    expect(Object.keys(aj)).toEqual(["scope", "tripleCount", "candidateCount", "mode", "funnel", "predicateStats", "candidates"]);
    expect(steps(aj.funnel)).toEqual(["all:5", "predicates:skipped", "functional:1", "min-second-mentions:skipped"]);
    expect(aj.candidateCount).toBe(1);
    expect(aj.candidates.map((c) => c.subject)).toEqual(["tool-e"]);
    // 别的 scope 那行不进统计；tool-a 的 Hooks / hooks 只算一对
    expect(aj.predicateStats.map((s) => [s.predicate, s.subjects, s.pairs, s.multiValuedSubjects])).toEqual([
      ["located_in", 5, 6, 1],
      ["是", 2, 4, 2],
      ["has", 2, 5, 2],
    ]);

    // (b) 再加 --min-second-mentions 2；--min-second-mentions 3 砍光
    const b = JSON.parse(cli(["kg-candidates", "--scope", SCOPE, "--functional-min", "0.8", "--min-second-mentions", "2", "--json"], h.env).stdout) as CandOut;
    expect(steps(b.funnel)).toEqual(["all:5", "predicates:skipped", "functional:1", "min-second-mentions:1"]);
    const b3 = JSON.parse(cli(["kg-candidates", "--scope", SCOPE, "--functional-min", "0.8", "--min-second-mentions", "3", "--json"], h.env).stdout) as CandOut;
    expect(steps(b3.funnel)).toEqual(["all:5", "predicates:skipped", "functional:1", "min-second-mentions:0"]);
    expect(b3.candidates).toEqual([]);

    // (c) 只开 --predicates
    const c = JSON.parse(cli(["kg-candidates", "--scope", SCOPE, "--predicates", "是,located_in", "--json"], h.env).stdout) as CandOut;
    expect(steps(c.funnel)).toEqual(["all:5", "predicates:3", "functional:skipped", "min-second-mentions:skipped"]);
    expect(c.candidates.map((x) => `${x.subject}/${x.predicate}`)).toEqual(["tool-e/located_in", "负责人/是", "部署机/是"]);

    // 文本输出同样带漏斗
    const text = cli(["kg-candidates", "--scope", SCOPE, "--functional-min", "0.8"], h.env);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("candidate groups=1  showing=1 (top 20)\nfunnel (same triples, steps applied in order):\n");
    expect(text.stdout).toContain("  functional predicates   1 (-4)  functionality >= 0.8 and subjects >= 3\n");
    expect(text.stdout).toContain("  predicate whitelist     skipped\n");

    // kg-compare：只留「是」时正则那一对照样被覆盖；只留 located_in 时那一对落进方向一 b
    type CmpOut = {
      candidateCount: number;
      regexPairCount: number;
      funnel: Funnel;
      predicateStats: unknown[];
      regexCovered: unknown[];
      regexOnlyBlindSpot: unknown[];
      candidatesUncaught: Array<{ candidate: { subject: string } }>;
    };
    const cmpShi = JSON.parse(cli(["kg-compare", "--scope", SCOPE, "--predicates", "是", "--json"], h.env).stdout) as CmpOut;
    expect(steps(cmpShi.funnel)).toEqual(["all:5", "predicates:2", "functional:skipped", "min-second-mentions:skipped"]);
    expect(cmpShi.predicateStats).toHaveLength(3);
    expect([cmpShi.regexPairCount, cmpShi.candidateCount, cmpShi.regexCovered.length]).toEqual([1, 2, 1]);
    expect(cmpShi.candidatesUncaught.map((x) => x.candidate.subject)).toEqual(["负责人"]);

    const cmpLoc = JSON.parse(cli(["kg-compare", "--scope", SCOPE, "--predicates", "located_in", "--json"], h.env).stdout) as CmpOut;
    expect([cmpLoc.regexPairCount, cmpLoc.candidateCount, cmpLoc.regexCovered.length, cmpLoc.regexOnlyBlindSpot.length]).toEqual([1, 1, 0, 1]);
    expect(cmpLoc.candidatesUncaught.map((x) => x.candidate.subject)).toEqual(["tool-e"]);

    const cmpText = cli(["kg-compare", "--scope", SCOPE, "--functional-min", "0.8"], h.env);
    expect(cmpText.code).toBe(0);
    expect(cmpText.stdout).toContain("direction 2 — group candidates regex missed: 1\nfunnel (same triples, steps applied in order):\n");

    expect(await snapshot(h.dbPath)).toBe(before);
  }, 180_000);

  it("非法选项值直接拒绝", async () => {
    const h = await harness();
    const bad: Array<[string[], string]> = [
      [["kg-candidates", "--scope", SCOPE, "--functional-min", "1.5"], "--functional-min"],
      [["kg-candidates", "--scope", SCOPE, "--min-second-mentions", "0"], "--min-second-mentions"],
      [["kg-compare", "--scope", SCOPE, "--functional-min-subjects", "two"], "--functional-min-subjects"],
      [["kg-compare", "--scope", SCOPE, "--predicates", ","], "--predicates"],
    ];
    for (const [args, flag] of bad) {
      const r = cli(args, h.env);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(flag);
    }
  }, 180_000);
});
