// 把回放产物整理成给双读者的材料（本机 700 目录，不进 AI产出），三套：
//   recall/     A 组：当场写的 checkpoint / case 条目 vs 自动账本 → 每条「账本里有没有覆盖」
//   silent/     B 组：无声场账本 vs 压缩转录 → 「账本对不对」
//   candidates/ 从全部账本的「经验（待确认）」里抽 40 条 → 忠实度 A/B/C（与校准集同一道总题）
// 读者拿到的材料不带分数、不带分组标签、编号打乱；key 文件单放。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseSessionFile, summarizeSession, type SessionDoc } from "../../src/session-events.js";
import { renderTranscriptForLLM } from "../../src/session-ledger.js";
import { discoverTranscripts, truthRoots, ledgerRelPath } from "../../src/sessions-sweep.js";
import { redactSecrets } from "../../src/pii-detector.js";

const replayDir = process.argv[2];
const outDir = process.argv[3];
const CAND_N = Number(process.argv[4] ?? 40);
if (!replayDir || !outDir) throw new Error("usage: build-judge-materials.ts <replayDir> <outDir> [candN]");
const index = JSON.parse(readFileSync(join(replayDir, "replay-index.json"), "utf-8")) as { picks: Array<{ group: string; source: string; sessionId: string; sid8: string; endedAt: string | null }> };
const disc = discoverTranscripts(truthRoots(), { sinceMs: Date.now() - 40 * 86_400_000 });
const byId = new Map(disc.files.map((f) => [f.sessionId, f]));
const red = (s: string) => redactSecrets(s).text;
const h = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

function ledgerFor(p: { sessionId: string; endedAt: string | null }): string | null {
  const rel = ledgerRelPath(p.sessionId, p.endedAt ?? "2026-10-01T00:00:00Z");
  const path = join(replayDir, "ledgers", rel);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}
function ledgerBodyOnly(md: string): string {
  // 去 frontmatter 与机器抽取两节，读者只看 LLM 写的三节
  const noFm = md.replace(/^---[\s\S]*?---\n/, "");
  const cut = noFm.indexOf("## 报错（机器抽取");
  return (cut >= 0 ? noFm.slice(0, cut) : noFm).trim();
}
function str(v: unknown): string { return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v); }

// ---------- A 组：账本召回
mkdirSync(join(outDir, "recall"), { recursive: true });
type RecallItem = { n: number; sid8: string; tool: string; field: string; item: string };
const recallItems: RecallItem[] = [];
const recallSessions: Array<{ sid8: string; ledger: string; items: RecallItem[] }> = [];
for (const p of index.picks.filter((x) => x.group === "A-manual")) {
  const f = byId.get(p.sessionId); const md = ledgerFor(p);
  if (!f || !md) continue;
  const s = summarizeSession(parseSessionFile(f.path, { source: f.source }));
  const items: RecallItem[] = [];
  for (const w of s.memoryWrites) {
    const inp = (w.input ?? {}) as Record<string, unknown>;
    const tool = w.tool.replace(/^mcp__recallnest__/, "");
    if (tool === "checkpoint_session") {
      if (inp.summary) items.push({ n: 0, sid8: p.sid8, tool, field: "summary", item: red(str(inp.summary)) });
      for (const k of ["decisions", "openLoops", "nextActions"]) for (const it of (Array.isArray(inp[k]) ? inp[k] as unknown[] : [])) items.push({ n: 0, sid8: p.sid8, tool, field: k, item: red(str(it)) });
    } else if (tool === "store_case") {
      for (const k of ["title", "problem", "solution", "rootCause"]) if (inp[k]) items.push({ n: 0, sid8: p.sid8, tool, field: k, item: red(str(inp[k])) });
      for (const it of (Array.isArray(inp.solutionSteps) ? inp.solutionSteps as unknown[] : [])) items.push({ n: 0, sid8: p.sid8, tool, field: "solutionSteps", item: red(str(it)) });
    }
  }
  if (!items.length) continue;
  recallSessions.push({ sid8: p.sid8, ledger: red(ledgerBodyOnly(md)), items });
  recallItems.push(...items);
}
recallItems.forEach((it, i) => (it.n = i + 1));
writeFileSync(join(outDir, "recall", "recall-key.json"), JSON.stringify({ sessions: recallSessions.length, items: recallItems }, null, 1));
const recallChunks: string[][] = [];
recallSessions.forEach((rs, i) => { (recallChunks[Math.floor(i / 18)] ??= []).push(`# 会话 ${rs.sid8}\n\n【自动账本】\n${red(rs.ledger)}\n\n【当场人工记录的条目——逐条判账本有没有覆盖】\n${rs.items.map((it) => `- 条目 ${it.n}（${it.tool}.${it.field}）：${red(it.item).replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}\n`); });
recallChunks.forEach((c, i) => writeFileSync(join(outDir, "recall", `recall-for-readers-${i + 1}.md`), c.join("\n\n---\n\n")));
writeFileSync(join(outDir, "recall", "judge-prompt.md"), `你是账本覆盖度的读者。每个会话给你两样：【自动账本】（机器从对话转录里写的）和【当场人工记录的条目】（当时的 AI 助手手写进记忆库的 checkpoint / case 字段，已拆成条目）。
对每一条人工条目回答：账本有没有把它覆盖到？
- A 覆盖：账本里有一句或几句说的是同一件事（措辞不同没关系，细节少一点没关系）。
- B 没覆盖：账本里完全没提这件事。
- C 部分：提到了但丢了关键的一半（比如只说做了什么、没说决定/没做完的那部分）。
只看给出的材料。输出纯 JSON 数组，每项 {"n": 条目号, "verdict": "A"|"B"|"C", "why": "≤30 字"}，条目号齐全。`);

// ---------- B 组：无声场账本对不对
mkdirSync(join(outDir, "silent"), { recursive: true });
const silentPicks = index.picks.filter((x) => x.group === "B-silent");
const silent: Array<{ n: number; sid8: string; ledger: string; transcript: string }> = [];
for (const p of silentPicks) {
  const f = byId.get(p.sessionId); const md = ledgerFor(p);
  if (!f || !md) continue;
  const doc = parseSessionFile(f.path, { source: f.source });
  const t = renderTranscriptForLLM(doc, { maxChars: 9_000, assistantClip: 260, errorClip: 160, maskMemoryWrites: true });
  silent.push({ n: 0, sid8: p.sid8, ledger: red(ledgerBodyOnly(md)), transcript: red(t.text) });
}
silent.sort((a, b) => h(a.sid8) - h(b.sid8)).forEach((x, i) => (x.n = i + 1));
writeFileSync(join(outDir, "silent", "silent-key.json"), JSON.stringify(silent.map((x) => ({ n: x.n, sid8: x.sid8 })), null, 1));
const silentChunks: string[][] = [];
silent.forEach((x, i) => { (silentChunks[Math.floor(i / 10)] ??= []).push(`# 会话 ${x.n}\n\n【自动账本】\n${red(x.ledger)}\n\n【对话转录（压缩版）】\n${red(x.transcript)}\n`); });
silentChunks.forEach((c, i) => writeFileSync(join(outDir, "silent", `silent-for-readers-${i + 1}.md`), c.join("\n\n---\n\n")));
writeFileSync(join(outDir, "silent", "judge-prompt.md"), `你是账本正确性的读者。每个会话给你【自动账本】和【对话转录（压缩版）】。
判一道总题：账本的「解决了什么 / 经验 / 没做完」三节，与转录对不对得上？
- A 基本对：三节说的事转录里都有，没有编造，没有把没做完说成做完。
- B 有实质错漏：出现了转录里没有的事、把计划写成已完成、把助手建议写成用户决定、或漏掉了这场会话最主要的事。
- C 看不出：转录太短或被削得太狠，判不了。
只看给出的材料。输出纯 JSON 数组，每项 {"n": 会话号, "verdict": "A"|"B"|"C", "why": "≤40 字"}。`);

// ---------- 候选忠实度（40 条）
mkdirSync(join(outDir, "candidates"), { recursive: true });
type Cand = { n: number; sid8: string; group: string; text: string; anchor: string; anchorSeq: number | null; anchorVerified: boolean; context: string };
const cands: Cand[] = [];
for (const p of index.picks) {
  const f = byId.get(p.sessionId); const md = ledgerFor(p);
  if (!f || !md) continue;
  const sec = md.split("## 经验（待确认）")[1]?.split("\n## ")[0] ?? "";
  const lines = sec.split("\n").filter((l) => l.startsWith("- ") && !l.includes("（无）"));
  if (!lines.length) continue;
  let doc: SessionDoc | null = null;
  for (const l of lines) {
    const m = l.match(/^- (.*?)(?:（[^）]*）)? ｜原文：「(.*?)」 ｜src:[A-Za-z0-9]+#(\d+|\?)( ｜anchor:未核)?$/);
    if (!m) continue;
    const seq = m[3] === "?" ? null : Number(m[3]);
    doc ??= parseSessionFile(f.path, { source: f.source });
    const ctx = seq !== null ? doc.events.slice(Math.max(0, seq - 2), seq + 3).filter((e) => e.kind === "user" || e.kind === "assistant" || e.kind === "tool_result").map((e) => `[${e.kind}#${e.seq}] ${red(e.text.replace(/\s+/g, " ")).slice(0, 400)}`).join("\n") : "";
    cands.push({ n: 0, sid8: p.sid8, group: p.group, text: red(m[1]), anchor: red(m[2]), anchorSeq: seq, anchorVerified: !m[4], context: red(ctx) });
  }
}
cands.sort((a, b) => h(a.sid8 + a.text) - h(b.sid8 + b.text));
const picked = cands.slice(0, CAND_N).map((c, i) => ({ ...c, n: i + 1 }));
writeFileSync(join(outDir, "candidates", "candidates-key.json"), JSON.stringify({ total: cands.length, verifiedTotal: cands.filter((c) => c.anchorVerified).length, picked }, null, 1));
writeFileSync(join(outDir, "candidates", "candidates-for-readers.md"), picked.map((c) => `## 条目 ${c.n}\n\n【提炼后的记忆】\n${red(c.text)}\n\n【原文证据（当时的对话原话）】\n- ${red(c.anchor)}\n\n【原话前后几句（上下文）】\n${red(c.context) || "（无）"}\n`).join("\n"));
writeFileSync(join(outDir, "candidates", "judge-prompt.md"), readFileSync(join(outDir, "calib", "judge-prompt.md"), "utf-8").replace("【原文证据】是它所依据的对话原话。", "【原文证据】是它所依据的对话原话，【上下文】是原话前后几句，帮助你判断原话的语境。"));
console.log(JSON.stringify({ recallChunks: recallChunks.length, silentChunks: silentChunks.length, recallSessions: recallSessions.length, recallItems: recallItems.length, silent: silent.length, candidatesTotal: cands.length, candidatesVerified: cands.filter((c) => c.anchorVerified).length, picked: picked.length }));
