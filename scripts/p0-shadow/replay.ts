// 回放：30 天真实会话 → 影子账本（LLM 版，隐藏当场写过的记忆），分三组：
//   A) CC 里当场写过 checkpoint_session / store_case 的会话（账本召回的对照组，已知偏乐观）
//   B) CC 无声结束的有料会话（最后两条没有收尾语；没有 checkpoint / store_case——那些进 A 组；store_memory 不作排除条件，
//      回放时所有记忆写入都已从转录里隐藏）随机 30 场（双读者抽检）。互审 R1 Codex #12 指出原注释写成「没有记忆写入」与代码不符，已改注释。
//   C) 其余三端的全部有料会话（四端形状太小，全量）
// 输出：<out>/ledgers/YYYY-MM/<sid8>.md + <out>/replay-index.json（分组、sid、是否生成成功、token）
// P1 ③（2026-10-23）加两个开关：
//   --groups A,B,C        只跑这几组（敏感性比较只需 A 组）
//   --mask-restatement    含记忆写入的那一轮助手发言也遮掉（「助手先复述再写记忆」的上界，互审 P0 R1 Codex N6）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLLMClient } from "../../src/llm-client.js";
import { loadConfig, loadDotEnv, resolveEnv } from "../../src/runtime-config.js";
import { parseSessionFile, summarizeSession } from "../../src/session-events.js";
import { discoverTranscripts, truthRoots } from "../../src/sessions-sweep.js";
import { runSweep } from "../../src/sessions-sweep-run.js";

loadDotEnv();
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const out = positional[0];
const silentN = Number(positional[1] ?? 30);
const limitA = Number(positional[2] ?? 0);
const groupsFlag = flags.find((f) => f.startsWith("--groups="))?.slice("--groups=".length);
const wantGroups = new Set((groupsFlag ?? "A,B,C").split(",").map((g) => g.trim().toUpperCase()));
const maskRestatement = flags.includes("--mask-restatement");
if (!out) throw new Error("usage: replay.ts <outDir> [silentN] [limitA] [--groups=A,B,C] [--mask-restatement]");
mkdirSync(out, { recursive: true });
const SINCE = Date.now() - 30 * 86_400_000;
const NOW_REPLAY = Date.parse("2026-12-01T00:00:00Z"); // 远在所有会话之后：一次 pass 同时出账本与候选

const disc = discoverTranscripts(truthRoots(), { sinceMs: SINCE });
type Pick = { group: "A-manual" | "B-silent" | "C-otherEnds"; source: string; sessionId: string; sid8: string; userTurns: number; toolErrors: number; memoryWrites: string[]; closeSignal: boolean; endedAt: string | null };
const picks: Pick[] = [];
const silentPool: Pick[] = [];
for (const f of disc.files) {
  const doc = parseSessionFile(f.path, { source: f.source });
  if (doc.importedSource || doc.isSubagent) continue;
  const s = summarizeSession(doc);
  if (!s.rich) continue;
  // 还在进行或刚停的会话不算「结束」（P1 复测：生产的候选等待是 12 小时，回放同样只取停了 12 小时以上的）
  if (doc.endedAt && Date.now() - Date.parse(doc.endedAt) < 12 * 3_600_000) continue;
  const base = { source: f.source, sessionId: doc.sessionId, sid8: doc.sessionId.slice(0, 8), userTurns: s.userTurns, toolErrors: s.toolErrors, memoryWrites: s.memoryWrites.map((m) => m.tool.replace(/^mcp__recallnest__/, "")), closeSignal: s.closeSignal, endedAt: doc.endedAt };
  if (f.source !== "cc") { picks.push({ group: "C-otherEnds", ...base }); continue; }
  // plan §7：A = 「收工」场里当场写了 checkpoint / store_case 的；B = 全部无声场（有没有写过记忆都算，回放时记忆写入已隐藏）
  //（R3 Codex #17：此前把所有写过 checkpoint / case 的场都划进 A，包括无声场，B 池因此偏向没写过记忆的会话——代码已改，
  //   本轮已出的数仍是旧分组，复测时按新分组重抽）
  const manual = s.memoryWrites.some((m) => /checkpoint_session|store_case$/.test(m.tool));
  if (!s.closeSignal) silentPool.push({ group: "B-silent", ...base });
  else if (manual) picks.push({ group: "A-manual", ...base });
}
// 稳定随机：按 sid8 哈希排序取前 N
const h = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
silentPool.sort((a, b) => h(a.sid8) - h(b.sid8));
picks.push(...silentPool.slice(0, silentN));
let groupA = picks.filter((p) => p.group === "A-manual");
if (limitA && groupA.length > limitA) {
  groupA.sort((a, b) => h(a.sid8) - h(b.sid8));
  const keep = new Set(groupA.slice(0, limitA).map((p) => p.sessionId));
  for (let i = picks.length - 1; i >= 0; i--) if (picks[i].group === "A-manual" && !keep.has(picks[i].sessionId)) picks.splice(i, 1);
}
for (let i = picks.length - 1; i >= 0; i--) if (!wantGroups.has(picks[i].group[0])) picks.splice(i, 1);
console.log("picks:", JSON.stringify(picks.reduce((a, p) => { a[p.group] = (a[p.group] ?? 0) + 1; return a; }, {} as Record<string, number>)), "silent pool", silentPool.length);

const config = loadConfig();
const llm = config.llm ? createLLMClient({ ...config.llm, apiKey: resolveEnv(config.llm.apiKey), timeoutMs: 90_000 }) : null;
if (!llm) throw new Error("no llm");
const t0 = Date.now();
const result = await runSweep({ roots: truthRoots(), shadowDir: out, sinceDays: 30, nowMs: NOW_REPLAY, llm, render: { maskMemoryWrites: true, maskRestatement, maxTokens: 2600 }, onlySessionIds: new Set(picks.map((p) => p.sessionId)), trigger: "replay", log: (l) => console.log(l) });
writeFileSync(join(out, "replay-index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), wallMs: Date.now() - t0, groups: [...wantGroups], maskRestatement, silentPool: silentPool.length, picks, result: { ...result, ledgersWritten: result.ledgersWritten.map((p) => p.slice(out.length + 1)) } }, null, 2));
console.log(JSON.stringify({ ledgers: result.ledgersWritten.length, llmCalls: result.llmCalls, tokens: [result.llmPromptTokens, result.llmCompletionTokens], failures: result.llmFailures, wallMs: Date.now() - t0 }));
