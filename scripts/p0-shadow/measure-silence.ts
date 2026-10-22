// 数①：静默 ≥30 分钟 / 60 分钟 / 6 小时之后「又续写」的占比（四端，统一树 30 天）。
// 口径一：按静默段（episode）——扫描器每撞见一次 ≥X 的静默就会处理一次，其中多少次之后用户又说话了 = 误判率（会被重处理）。
//        分母 = 所有 ≥X 的段 + 每场会话结尾那一段（结尾段永远不会被续写，所以算一次「正确判断」）。
// 口径二：按会话——有过 ≥X 静默且之后续写的会话 / 有 ≥3 轮的会话（D2 原话的写法）。
// 资格（互审 R1 Codex #11）：一次静默段只有在「静默发生那一刻会话已经有 ≥3 轮人话」时才算扫描器会处理的段；
// 结尾那一段只有在「到现在为止已经静默 ≥ 阈值」时才算一次真结束（刚结束不到阈值的会话还没到判定时刻）。
import { statSync, writeFileSync } from "node:fs";
import { idleGaps, parseSessionFile, summarizeSession, type SessionSource } from "../../src/session-events.js";
import { discoverTranscripts, truthRoots } from "../../src/sessions-sweep.js";

const out = process.argv[2];
const SINCE = Date.now() - 30 * 86_400_000;
const THRESH: Array<[string, number]> = [["30m", 30 * 60_000], ["60m", 60 * 60_000], ["6h", 360 * 60_000]];
const disc = discoverTranscripts(truthRoots(), { sinceMs: SINCE });
const NOW = Date.now();
const MIN_TURNS = 3;
type Row = { source: SessionSource; sessions: number; ge3: number; rich: number; byThresh: Record<string, { episodes: number; resumed: number; endEpisodes: number; sessionsWithResume: number; sessionsGe3WithResume: number; richWithResume: number; medianResumeGapMin: number | null; p90ResumeGapMin: number | null }> };
const rows: Record<string, Row> = {};
const resumeGaps: Record<string, Record<string, number[]>> = {};
for (const f of disc.files) {
  const doc = parseSessionFile(f.path, { source: f.source });
  if (doc.importedSource || doc.isSubagent) continue;
  const s = summarizeSession(doc);
  if (s.userTurns < 1) continue; // 零人话的（bot 自动跑的）不算会话
  const row = (rows[f.source] ??= { source: f.source, sessions: 0, ge3: 0, rich: 0, byThresh: Object.fromEntries(THRESH.map(([k]) => [k, { episodes: 0, resumed: 0, endEpisodes: 0, sessionsWithResume: 0, sessionsGe3WithResume: 0, richWithResume: 0, medianResumeGapMin: null, p90ResumeGapMin: null }])) });
  row.sessions++;
  if (s.userTurns >= 3) row.ge3++;
  if (s.rich) row.rich++;
  const userSeqs = doc.events.filter((e) => e.kind === "user" && !e.injected).map((e) => e.seq);
  const turnsBefore = (seq: number) => userSeqs.filter((q) => q <= seq).length;
  const lastMs = doc.endedAt ? Date.parse(doc.endedAt) : NaN;
  for (const [k, ms] of THRESH) {
    // 只算静默发生时已满 MIN_TURNS 轮的段（扫描器对不满的会话 skip-short，不会处理）
    const gaps = idleGaps(doc, ms).filter((g) => turnsBefore(g.afterSeq) >= MIN_TURNS);
    const b = row.byThresh[k];
    b.episodes += gaps.length;
    if (s.userTurns >= MIN_TURNS && Number.isFinite(lastMs) && NOW - lastMs >= ms) b.endEpisodes += 1;
    const resumed = gaps.filter((g) => g.resumedByUser);
    b.resumed += resumed.length;
    if (resumed.length) {
      b.sessionsWithResume++;
      if (s.userTurns >= 3) b.sessionsGe3WithResume++;
      if (s.rich) b.richWithResume++;
      ((resumeGaps[f.source] ??= {})[k] ??= []).push(...resumed.map((g) => g.gapMs / 60_000));
    }
  }
}
const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
const q = (arr: number[], p: number) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const summary: Record<string, unknown> = {};
for (const row of Object.values(rows)) {
  const t: Record<string, unknown> = {};
  for (const [k] of THRESH) {
    const b = row.byThresh[k];
    b.medianResumeGapMin = q(resumeGaps[row.source]?.[k] ?? [], 0.5);
    b.p90ResumeGapMin = q(resumeGaps[row.source]?.[k] ?? [], 0.9);
    t[k] = { ...b, prematureRatePct: pct(b.resumed, b.episodes + b.endEpisodes), sessionRatePct_all: pct(b.sessionsWithResume, row.sessions), sessionRatePct_ge3: pct(b.sessionsGe3WithResume, row.ge3), sessionRatePct_rich: pct(b.richWithResume, row.rich) };
  }
  summary[row.source] = { sessions: row.sessions, ge3: row.ge3, rich: row.rich, thresholds: t };
}
const result = { generatedAt: new Date().toISOString(), window: "30d", files: disc.files.length, note: "prematureRate = resumed eligible episodes / (eligible ≥X idle episodes + terminal episodes already idle ≥X); eligible = ≥3 user turns before the gap; sessionRate = sessions with ≥1 resumed gap / denominator", summary };
console.log(JSON.stringify(result, null, 2));
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
