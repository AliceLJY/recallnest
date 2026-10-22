// 数⑥：向量路径的误配率——把具体性报错文本嵌入后对 cases 做余弦检索，top-1 ≥0.85 的算「向量命中」，
// 抽样交双读者判是不是同一个坑。只读 LanceDB（直连 lancedb），嵌入走 config 的 Jina（query 任务）。
// 乐观偏差处理：只认 timestamp 早于报错时刻的 case；同一签名只嵌一次（去重后抽样）。
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createEmbedder } from "../../src/embedder.js";
import { loadConfig, loadDotEnv, resolveEnv } from "../../src/runtime-config.js";
import { extractErrorSignatures } from "../../src/error-signature.js";
import { classifySignatureSpecificity } from "../../src/error-signature-specificity.js";
import { parseSessionFile, summarizeSession } from "../../src/session-events.js";
import { discoverTranscripts, truthRoots } from "../../src/sessions-sweep.js";
import { redactSecrets } from "../../src/pii-detector.js";

loadDotEnv();
const outJson = process.argv[2];
const materialsDir = process.argv[3]; // 给读者的材料（本机 700 目录，不进 AI产出）
const MAX_EMBED = Number(process.argv[4] ?? 120);
const THRESH = 0.85;
const SINCE = Date.now() - 30 * 86_400_000;
const config = loadConfig();
const embedder = createEmbedder({ provider: "openai-compatible", apiKey: resolveEnv(config.embedding.apiKey), model: config.embedding.model, baseURL: config.embedding.baseURL, dimensions: config.embedding.dimensions, taskQuery: config.embedding.taskQuery, taskPassage: config.embedding.taskPassage });
const require = createRequire(join(homedir(), "recallnest", "package.json"));
const lancedb = require("@lancedb/lancedb");
const table = await (await lancedb.connect(join(homedir(), "recallnest", "data", "lancedb"))).openTable("memories");

// 1) 收集 30 天具体性报错，按（签名）去重
const disc = discoverTranscripts(truthRoots(), { sinceMs: SINCE });
type Err = { source: string; sid8: string; ts: string | null; tsMs: number; tool?: string; text: string; sigs: string[] };
const bySig = new Map<string, Err>();
let totalSpecificErrors = 0;
for (const f of disc.files) {
  const doc = parseSessionFile(f.path, { source: f.source });
  if (doc.importedSource || doc.isSubagent) continue;
  const s = summarizeSession(doc);
  if (s.userTurns < 1) continue;
  for (const e of s.errors) {
    const sigs = extractErrorSignatures({ problem: e.text.slice(0, 4000) }).filter((x) => classifySignatureSpecificity(x) === "specific");
    if (!sigs.length) continue;
    totalSpecificErrors++;
    const key = sigs[0].toLowerCase();
    if (!bySig.has(key)) bySig.set(key, { source: f.source, sid8: doc.sessionId.slice(0, 8), ts: e.ts, tsMs: e.ts ? Date.parse(e.ts) : Date.now(), tool: e.toolName, text: e.text.replace(/\s+/g, " ").slice(0, 600), sigs });
  }
}
const uniq = [...bySig.values()];
// 稳定抽样（按 sid8 排序取模），上限 MAX_EMBED
const sample = uniq.sort((a, b) => (a.sid8 + a.sigs[0]).localeCompare(b.sid8 + b.sigs[0])).filter((_, i) => i % Math.max(1, Math.ceil(uniq.length / MAX_EMBED)) === 0).slice(0, MAX_EMBED);

// 2) 嵌入 + 检索
type Hit = { id8: string; sim: number; writtenAt: number; textHead: string; scope: string };
type Row = { err: Err; top: Hit[]; topPrior: Hit | null; vectorHit: boolean; vectorHitPrior: boolean };
const rows: Row[] = [];
let embedCalls = 0;
for (const err of sample) {
  const q = `${err.tool ? `${err.tool}: ` : ""}${err.text}`.slice(0, 500);
  let vec: number[];
  try {
    vec = await embedder.embedQuery(q);
    embedCalls++;
  } catch (e) {
    console.error("embed failed", String(e).slice(0, 120));
    continue;
  }
  const res = await table.vectorSearch(vec).distanceType("cosine").where("category = 'cases'").select(["id", "scope", "timestamp", "text", "metadata"]).limit(5).toArray();
  const top: Hit[] = res.map((r: any) => ({ id8: String(r.id).slice(0, 8), sim: Math.round((1 - Number(r._distance)) * 1000) / 1000, writtenAt: Number(r.timestamp), textHead: redactSecrets(String(r.text)).text.replace(/\s+/g, " ").slice(0, 160), scope: String(r.scope) })).filter((h: Hit) => (JSON.parse((res.find((r: any) => String(r.id).startsWith(h.id8))?.metadata) || "{}").evolution?.status ?? "active") === "active");
  const topPrior = top.find((h) => h.writtenAt < err.tsMs) ?? null;
  rows.push({ err, top: top.slice(0, 3), topPrior, vectorHit: !!top[0] && top[0].sim >= THRESH, vectorHitPrior: !!topPrior && topPrior.sim >= THRESH });
}
const sims = rows.map((r) => r.top[0]?.sim ?? 0).sort((a, b) => a - b);
const q = (p: number) => sims[Math.min(sims.length - 1, Math.floor(p * sims.length))];
const summary = {
  generatedAt: new Date().toISOString(),
  threshold: THRESH,
  totalSpecificErrors,
  uniqueSpecificSignatures: uniq.length,
  embedded: rows.length,
  embedCalls,
  top1SimQuantiles: { p50: q(0.5), p90: q(0.9), max: sims[sims.length - 1] ?? null },
  vectorHitsAtThreshold: rows.filter((r) => r.vectorHit).length,
  vectorHitsAtThresholdPriorOnly: rows.filter((r) => r.vectorHitPrior).length,
  hitsAt080: rows.filter((r) => (r.top[0]?.sim ?? 0) >= 0.8).length,
  hitsAt075: rows.filter((r) => (r.top[0]?.sim ?? 0) >= 0.75).length,
};
console.log(JSON.stringify(summary, null, 2));
if (outJson) writeFileSync(outJson, JSON.stringify({ summary, rows: rows.map((r) => ({ source: r.err.source, sid8: r.err.sid8, tool: r.err.tool, sig: r.err.sigs[0].slice(0, 100), top1: r.top[0] ? { id8: r.top[0].id8, sim: r.top[0].sim, prior: r.top[0].writtenAt < r.err.tsMs } : null, top1Prior: r.topPrior ? { id8: r.topPrior.id8, sim: r.topPrior.sim } : null })) }, null, 2));
if (materialsDir) {
  mkdirSync(materialsDir, { recursive: true });
  // 读者材料：所有 top-1 ≥0.75 的配对（含 0.85 以上），打乱编号，不带分数
  const pairs = rows.filter((r) => (r.top[0]?.sim ?? 0) >= 0.75).map((r, i) => ({ idx: i, source: r.err.source, sid8: r.err.sid8, sim: r.top[0]!.sim, caseId8: r.top[0]!.id8, errorText: redactSecrets(`${r.err.tool ? `${r.err.tool}: ` : ""}${r.err.text}`).text, caseText: r.top[0]!.textHead }));
  const seed = 20261023; const shuffled = [...pairs].sort((a, b) => ((a.idx * 2654435761 + seed) % 1000003) - ((b.idx * 2654435761 + seed) % 1000003));
  writeFileSync(join(materialsDir, "vector-pairs-key.json"), JSON.stringify(shuffled.map((p, i) => ({ n: i + 1, ...p })), null, 2));
  writeFileSync(join(materialsDir, "vector-pairs-for-readers.md"), shuffled.map((p, i) => `## 配对 ${i + 1}\n\n【这次的报错】\n${p.errorText}\n\n【库里召回的 case（节选）】\n${p.caseText}\n`).join("\n"));
  console.log("materials:", pairs.length, "pairs ≥0.75 written to", materialsDir);
}
