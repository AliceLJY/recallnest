// 用新解析层扫 30 天统一树，按端输出形状统计（P0 数②的第一遍 + 解析器体检：与 research §4 的 measure4.py 口径对照）
// 文件发现与扫描器同一套（discoverTranscripts：跳 CC subagents、Kimi 只认 agents/main、agy 一场一文件），
// 过滤与 measure-silence 同一套（导入会话、子 agent 单列），0 / 1 / 2 / ≥3 轮分开给（互审 R1 Grok #5）。
import { parseSessionFile, summarizeSession, type SessionSource } from "../../src/session-events.js";
import { discoverTranscripts, truthRoots } from "../../src/sessions-sweep.js";

const SINCE = Date.now() - 30 * 86_400_000;
const disc = discoverTranscripts(truthRoots(), { sinceMs: SINCE });
const t0 = performance.now();
const report: Record<string, unknown> = {};
for (const source of ["cc", "codex", "kimi", "antigravity"] as SessionSource[]) {
  const recent = disc.files.filter((f) => f.source === source).map((f) => f.path);
  let parsed = 0, failed = 0, imported = 0, subagent = 0, zero = 0, one = 0, two = 0, ge3 = 0, rich = 0, rich3k = 0, withErr = 0, withMem = 0, chk = 0, cases = 0, closeLast = 0, malformed = 0;
  const bySub: Record<string, number> = {};
  for (const p of recent) {
    try {
      const doc = parseSessionFile(p, { source });
      if (doc.importedSource) { imported++; continue; }
      if (doc.isSubagent) { subagent++; continue; }
      const s = summarizeSession(doc);
      parsed++; malformed += doc.malformedLines;
      if (s.userTurns === 0) zero++; else if (s.userTurns === 1) one++; else if (s.userTurns === 2) two++; else ge3++;
      if (s.rich) rich++; if (s.richWithout3k) rich3k++;
      if (s.toolErrors > 0) withErr++;
      if (s.memoryWrites.length) withMem++;
      if (s.memoryWrites.some((m) => /checkpoint_session$/.test(m.tool))) chk++;
      if (s.memoryWrites.some((m) => /store_case$/.test(m.tool))) cases++;
      if (s.closeSignal) closeLast++;
      for (const m of s.memoryWrites) bySub[m.tool] = (bySub[m.tool] ?? 0) + 1;
    } catch (e) { failed++; if (failed <= 3) console.error(source, p, String(e).slice(0, 120)); }
  }
  report[source] = { files30d: recent.length, parsed, imported, subagent, failed, malformedLines: malformed, sessionsWithHumanTurn: parsed - zero, userTurns: { zero, one, two, ge3 }, rich, richWithout3k: rich3k, withToolError: withErr, closeInLast2: closeLast, withMemoryWrite: withMem, withCheckpoint: chk, withStoreCase: cases, memoryWriteCalls: bySub };
}
console.log(JSON.stringify({ parseWallMs: Math.round(performance.now() - t0), ...report }, null, 2));
