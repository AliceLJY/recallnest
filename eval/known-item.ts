// known-item.ts —— 已知条目判据：每条 trigger 原话当一条查询，看它的宿主排第几。
//
// 【它回答什么，不回答什么】
// 回答：一条记忆被它自己写下的问法问到时，能不能排在最前面（第 1 / 前 3 / 前 10），
// 按宿主存入天数、按宿主自身频次倍数分组；两次运行可以比较，逐条列出救回与掉出。
// 不回答：答案质量。单一目标、查询就是 trigger 原文（上限情形），它是改评分链时 shadow 判据的一部分，
// 不是 open-loops「公共尺子」要的那把判官。来由见 open-loops「RecallNest 检索评分链」症状 C（2026-09-24）。
//
// 【只读】检索走 source:"auto-recall"（三处强化写入都门控在 source !== "auto-recall"），
// 审计日志换成空实现（否则每跑一遍往 audit.jsonl 追加五百行 retrieve）；读 trigger 与宿主只用 query()。
// 报告只含 id 与数字，不含 trigger 原文。查询嵌入缓存默认放库旁边的 data 目录（含原文，gitignore 了）。
//
// 用法（在 recallnest 仓根目录）：
//   bun run eval/known-item.ts run                         # 生产库，只读
//   bun run eval/known-item.ts run --db <快照的 lancedb 目录> --now <毫秒或 ISO>   # 快照 + 冻结时钟，可逐字节复现
//   bun run eval/known-item.ts compare <前一次报告.json> <后一次报告.json>
// 其余参数：--limit N（默认 20）、--scope S（可多次）、--label 名字、--out 报告路径、
//           --embed-cache 路径 / --no-embed-cache、--verbose（逐条打印未排第 1 的用例，含原文，只上屏不落盘）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// 自带 env 加载：与 lengthnorm-shadow.ts 同款。mcp.env 是生产 MCP 启动器读的同一份，
// 里面除了 JINA_API_KEY 还有 RECALLNEST_LAYER_ADMISSION——要按生产真实态跑就得带上它。
// ~/.proxy.env 只在当前环境没有代理时读（嵌入 API 在 mini 上要走代理，见 recallnest-mcp 启动器注释）。
function loadEnvFile(path: string, onlyIfUnset: (key: string) => boolean): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const body = t.startsWith("export ") ? t.slice(7) : t;
    const i = body.indexOf("=");
    if (i <= 0) continue;
    const key = body.slice(0, i).trim();
    const value = body.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (onlyIfUnset(key)) process.env[key] = value;
  }
}
loadEnvFile(join(homedir(), ".config", "recallnest", "mcp.env"), (k) => !process.env[k]);
if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
  loadEnvFile(join(homedir(), ".proxy.env"), (k) => !process.env[k]);
}

const RECALLNEST_ROOT = process.env.RECALLNEST_ROOT || resolve(import.meta.dir, "..");
const rc = await import(join(RECALLNEST_ROOT, "src/runtime-config.ts"));
const kie = await import(join(RECALLNEST_ROOT, "src/known-item-eval.ts"));
const envConfig = await import(join(RECALLNEST_ROOT, "src/env-config.ts"));

interface Args {
  cmd: string;
  positional: string[];
  db?: string;
  limit: number;
  scopes: string[];
  label?: string;
  out?: string;
  now?: number;
  embedCache?: string | null;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: argv[0] ?? "", positional: [], limit: 20, scopes: [], verbose: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺参数值`);
      return v;
    };
    if (a === "--db") args.db = next();
    else if (a === "--limit") args.limit = Number(next());
    else if (a === "--scope") args.scopes.push(next());
    else if (a === "--label") args.label = next();
    else if (a === "--out") args.out = next();
    else if (a === "--now") {
      const v = next();
      const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      if (!Number.isFinite(n)) throw new Error(`--now 认不出：${v}`);
      args.now = n;
    } else if (a === "--embed-cache") args.embedCache = next();
    else if (a === "--no-embed-cache") args.embedCache = null;
    else if (a === "--verbose") args.verbose = true;
    else if (a.startsWith("--")) throw new Error(`不认识的参数 ${a}`);
    else args.positional.push(a);
  }
  if (!Number.isFinite(args.limit) || args.limit < 1 || args.limit > 20) throw new Error("--limit 要在 1–20 之间");
  return args;
}

const NOOP_AUDIT = { log() {}, getRecent: () => [], exportAll: () => [], count: () => 0 };

async function run(args: Args): Promise<void> {
  const config = rc.loadConfig();
  if (args.db) {
    const abs = resolve(args.db);
    // validateStoragePath 遇到不存在的路径会 mkdir——外接盘没挂上时那会在原路径造出一个空库、失败无声。
    if (!existsSync(join(abs, "memories.lance"))) {
      throw new Error(`--db ${abs} 下没有 memories.lance，拒绝运行（不在不存在的路径上建空库）`);
    }
    config.dbPath = abs;
  }
  const dbPath: string = rc.resolveDbPath(config);
  const dataDir: string = rc.resolveDataDir(config);
  const components = rc.createComponents(config);
  const { retriever, embedder, frequencyTracker } = components;
  retriever.setAuditLogger(NOOP_AUDIT);

  // 查询嵌入缓存：键 = 模型|任务|原文。命中就不调 API；时钟冻结时，未命中那一次临时放开时钟去调。
  const realNow = Date.now.bind(Date);
  const frozenNow = args.now !== undefined ? () => args.now as number : null;
  const cachePath = args.embedCache === null ? null : resolve(args.embedCache ?? join(dataDir, "known-item-embed-cache.json"));
  const cache: Record<string, number[]> = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf-8")) : {};
  let misses = 0;
  const originalEmbedQuery = embedder.embedQuery.bind(embedder);
  embedder.embedQuery = async (text: string): Promise<number[]> => {
    const key = `${config.embedding.model}|${config.embedding.taskQuery ?? ""}|${text}`;
    const hit = cache[key];
    if (hit) return hit;
    if (frozenNow) Date.now = realNow;
    try {
      const v = Array.from(await originalEmbedQuery(text)) as number[];
      cache[key] = v;
      misses++;
      return v;
    } finally {
      if (frozenNow) Date.now = frozenNow;
    }
  };
  if (frozenNow) Date.now = frozenNow;

  const load = await kie.loadKnownItemCases(dbPath, { scopes: args.scopes });
  const startedAt = realNow();
  const results = await kie.runKnownItemEval(retriever, load.cases, {
    limit: args.limit,
    onProgress: (done: number, total: number) => {
      if (done % 50 === 0 || done === total) process.stderr.write(`… ${done}/${total}\n`);
    },
  });
  const now = Date.now();
  const summary = kie.summarizeKnownItem(results, load.hosts, {
    now,
    limit: args.limit,
    freqMultiplier: (id: string) => frequencyTracker.getBoostMultiplier(id),
  });
  Date.now = realNow;
  if (cachePath && misses > 0) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
  }

  const retrieval = retriever.getConfig();
  const report = {
    kind: "recallnest-known-item-eval",
    version: 1,
    label: args.label ?? null,
    db: dbPath,
    frozenNow: args.now !== undefined ? new Date(args.now).toISOString() : null,
    limit: args.limit,
    scopes: args.scopes,
    retrieval: {
      mode: retrieval.mode,
      hardMinScore: retrieval.hardMinScore,
      recencyHalfLifeDays: retrieval.recencyHalfLifeDays,
      recencyWeight: retrieval.recencyWeight,
      timeDecayHalfLifeDays: retrieval.timeDecayHalfLifeDays,
      lengthNormAnchor: retrieval.lengthNormAnchor,
      hotnessWeight: retrieval.hotnessWeight,
      utilityWeight: retrieval.utilityWeight,
      sourceDiversity: retrieval.sourceDiversity,
    },
    env: {
      layerAdmission: envConfig.layerAdmission(),
      layerAdmissionMin: envConfig.layerAdmissionMin(),
      triggerRecall: envConfig.triggerRecall(),
      triggerGate: envConfig.triggerGate(),
      triggerSoftGate: envConfig.triggerSoftGate(),
      triggerTopK: envConfig.triggerTopK(),
    },
    triggerRows: load.triggerRows,
    skipped: load.skipped.reduce((acc: Record<string, number>, s: { reason: string }) => {
      acc[s.reason] = (acc[s.reason] ?? 0) + 1;
      return acc;
    }, {}),
    summary,
    cases: results,
  };
  const outPath = resolve(
    args.out ?? join(RECALLNEST_ROOT, "eval", "reports", `known-item-${new Date(startedAt).toISOString().slice(0, 10)}${args.label ? `-${args.label}` : ""}.json`),
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 1));

  console.log(`已知条目判据：${load.cases.length} 条用例（trigger 行 ${load.triggerRows}，剔除 ${load.skipped.length}：${JSON.stringify(report.skipped)}）`);
  console.log(`库：${dbPath}${report.frozenNow ? `｜时钟冻结在 ${report.frozenNow}` : ""}｜limit ${args.limit}`);
  console.log(kie.formatKnownItemSummary(summary));
  console.log(`报告：${outPath}${misses > 0 ? `｜本次新调嵌入 ${misses} 次` : ""}`);
  if (args.verbose) {
    const byId = new Map(load.cases.map((c: { triggerId: string; query: string }) => [c.triggerId, c.query]));
    for (const r of results.filter((x: { rank: number | null }) => x.rank !== 1)) {
      console.log(`  ${r.label} 第 ${r.rank ?? "—"}（第 1 名 ${r.top1}）「${byId.get(r.triggerId)}」`);
    }
  }
}

function compare(args: Args): void {
  const [a, b] = args.positional;
  if (!a || !b) throw new Error("用法：compare <前一次报告.json> <后一次报告.json>");
  const before = JSON.parse(readFileSync(a, "utf-8"));
  const after = JSON.parse(readFileSync(b, "utf-8"));
  for (const r of [before, after]) {
    if (r.kind !== "recallnest-known-item-eval") throw new Error("不是 known-item 报告");
  }
  if (before.limit !== after.limit) console.log(`⚠️ 两次 limit 不同（${before.limit} vs ${after.limit}），前 N 名的口径不可比`);
  console.log(kie.formatKnownItemComparison(kie.compareKnownItemRuns(before.cases, after.cases)));
}

const args = parseArgs(process.argv.slice(2));
if (args.cmd === "run") await run(args);
else if (args.cmd === "compare") compare(args);
else {
  console.error("用法：bun run eval/known-item.ts run [--db 路径] [--now 时刻] … ｜ compare A.json B.json");
  process.exit(2);
}
process.exit(0);
