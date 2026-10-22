// 用新解析层扫 30 天统一树，按端输出形状统计（P0 数②的第一遍 + 解析器体检：与 research §4 的 measure4.py 口径对照）
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseSessionFile, summarizeSession, type SessionSource } from "../../src/session-events.js";

const TRUTH = join(homedir(), "conversation-truth");
const SINCE = Date.now() - 30 * 86_400_000;
const roots: Array<[SessionSource, string]> = [
  ["cc", join(TRUTH, "claude", "projects")],
  ["codex", join(TRUTH, "codex", "sessions", "by-session")],
  ["kimi", join(TRUTH, "kimi", "sessions")],
  ["antigravity", join(TRUTH, "antigravity", "brain")],
];
function walk(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "subagents") walk(p, out); }
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
}
const t0 = performance.now();
const report: Record<string, unknown> = {};
for (const [source, root] of roots) {
  const files: string[] = [];
  walk(root, files);
  const recent = files.filter((p) => statSync(p).mtimeMs >= SINCE);
  let parsed = 0, failed = 0, imported = 0, le1 = 0, two = 0, ge3 = 0, rich = 0, rich3k = 0, withErr = 0, withMem = 0, chk = 0, cases = 0, closeLast = 0, malformed = 0;
  const bySub: Record<string, number> = {};
  for (const p of recent) {
    try {
      const doc = parseSessionFile(p, { source });
      if (doc.importedSource) { imported++; continue; }
      const s = summarizeSession(doc);
      parsed++; malformed += doc.malformedLines;
      if (s.userTurns <= 1) le1++; else if (s.userTurns === 2) two++; else ge3++;
      if (s.rich) rich++; if (s.richWithout3k) rich3k++;
      if (s.toolErrors > 0) withErr++;
      if (s.memoryWrites.length) withMem++;
      if (s.memoryWrites.some((m) => /checkpoint_session$/.test(m.tool))) chk++;
      if (s.memoryWrites.some((m) => /store_case$/.test(m.tool))) cases++;
      if (s.closeSignal) closeLast++;
      for (const m of s.memoryWrites) bySub[m.tool] = (bySub[m.tool] ?? 0) + 1;
    } catch (e) { failed++; if (failed <= 3) console.error(source, p, String(e).slice(0, 120)); }
  }
  report[source] = { files30d: recent.length, parsed, imported, failed, malformedLines: malformed, userTurns: { le1, two, ge3 }, rich, richWithout3k: rich3k, withToolError: withErr, closeInLast2: closeLast, withMemoryWrite: withMem, withCheckpoint: chk, withStoreCase: cases, memoryWriteCalls: bySub };
}
console.log(JSON.stringify({ parseWallMs: Math.round(performance.now() - t0), ...report }, null, 2));
