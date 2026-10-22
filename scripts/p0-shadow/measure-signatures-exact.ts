// 数⑤（精确配对部分）：30 天四端工具报错 → extractErrorSignatures → 具体性分档 → 与现有 cases 的 metadata.error_signature 精确配对。
// 只读 LanceDB（直接 lancedb 连接，不经 MemoryStore，不写访问计数）。cases 过滤「写入时间早于报错时间」以免拿事后写的 case 冒充命中。
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractErrorSignatures } from "../../src/error-signature.js";
import { classifySignatureSpecificity } from "../../src/error-signature-specificity.js";
import { parseSessionFile, summarizeSession } from "../../src/session-events.js";
import { discoverTranscripts, truthRoots } from "../../src/sessions-sweep.js";

const require = createRequire(join(homedir(), "recallnest", "package.json"));
const lancedb = require("@lancedb/lancedb");
const out = process.argv[2];
const SINCE = Date.now() - 30 * 86_400_000;

const table = await (await lancedb.connect(join(homedir(), "recallnest", "data", "lancedb"))).openTable("memories");
const caseRows = await table.query().where("category = 'cases'").select(["id", "scope", "timestamp", "metadata"]).limit(500000).toArray();
type CaseSig = { id8: string; sig: string; tier: string; writtenAt: number; active: boolean };
const caseSigs: CaseSig[] = [];
for (const r of caseRows) {
  const md = JSON.parse(r.metadata || "{}");
  const sigs: unknown = md.error_signature;
  if (!Array.isArray(sigs)) continue;
  for (const s of sigs) if (typeof s === "string") caseSigs.push({ id8: String(r.id).slice(0, 8), sig: s.toLowerCase(), tier: classifySignatureSpecificity(s), writtenAt: Number(r.timestamp), active: (md.evolution?.status ?? "active") === "active" });
}
const sigIndex = new Map<string, CaseSig[]>();
for (const c of caseSigs) (sigIndex.get(c.sig) ?? sigIndex.set(c.sig, []).get(c.sig)!).push(c);

const disc = discoverTranscripts(truthRoots(), { sinceMs: SINCE });
type ErrRec = { source: string; sid8: string; ts: string | null; toolName?: string; sigs: string[]; specific: string[]; matchAny: string[]; matchSpecific: string[]; matchSpecificPrior: string[]; matchSpecificPriorActive: string[] };
const errs: ErrRec[] = [];
const perSource: Record<string, { sessions: number; sessionsWithErr: number; errors: number; withSig: number; withSpecific: number; matchAny: number; matchSpecific: number; matchSpecificPrior: number; matchSpecificPriorActive: number; sessionsMatchedPrior: number }> = {};
const sigFreq = new Map<string, number>();
const specFreq = new Map<string, number>();
for (const f of disc.files) {
  const doc = parseSessionFile(f.path, { source: f.source });
  if (doc.importedSource || doc.isSubagent) continue;
  const s = summarizeSession(doc);
  if (s.userTurns < 1) continue;
  const ps = (perSource[f.source] ??= { sessions: 0, sessionsWithErr: 0, errors: 0, withSig: 0, withSpecific: 0, matchAny: 0, matchSpecific: 0, matchSpecificPrior: 0, matchSpecificPriorActive: 0, sessionsMatchedPrior: 0 });
  ps.sessions++;
  if (s.errors.length) ps.sessionsWithErr++;
  let sessionMatched = false;
  for (const e of s.errors) {
    const sigs = extractErrorSignatures({ problem: e.text.slice(0, 4000) });
    const specific = sigs.filter((x) => classifySignatureSpecificity(x) === "specific");
    for (const x of sigs) sigFreq.set(x.toLowerCase(), (sigFreq.get(x.toLowerCase()) ?? 0) + 1);
    for (const x of specific) specFreq.set(x.toLowerCase(), (specFreq.get(x.toLowerCase()) ?? 0) + 1);
    const errMs = e.ts ? Date.parse(e.ts) : Number.POSITIVE_INFINITY;
    const hits = (list: string[], pred: (c: CaseSig) => boolean) => [...new Set(list.flatMap((x) => (sigIndex.get(x.toLowerCase()) ?? []).filter(pred).map((c) => c.id8)))];
    const rec: ErrRec = {
      source: f.source, sid8: doc.sessionId.slice(0, 8), ts: e.ts, toolName: e.toolName, sigs, specific,
      matchAny: hits(sigs, () => true),
      matchSpecific: hits(specific, () => true),
      matchSpecificPrior: hits(specific, (c) => c.writtenAt < errMs),
      matchSpecificPriorActive: hits(specific, (c) => c.writtenAt < errMs && c.active),
    };
    errs.push(rec);
    ps.errors++;
    if (sigs.length) ps.withSig++;
    if (specific.length) ps.withSpecific++;
    if (rec.matchAny.length) ps.matchAny++;
    if (rec.matchSpecific.length) ps.matchSpecific++;
    if (rec.matchSpecificPrior.length) { ps.matchSpecificPrior++; sessionMatched = true; }
    if (rec.matchSpecificPriorActive.length) ps.matchSpecificPriorActive++;
  }
  if (sessionMatched) ps.sessionsMatchedPrior++;
}
const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k.slice(0, 90), v]);
const result = {
  generatedAt: new Date().toISOString(),
  cases: { rows: caseRows.length, withSignatures: new Set(caseSigs.map((c) => c.id8)).size, signatures: caseSigs.length, specificSignatures: caseSigs.filter((c) => c.tier === "specific").length, genericSignatures: caseSigs.filter((c) => c.tier === "generic").length },
  perSource,
  totals: Object.values(perSource).reduce((a, b) => { for (const k of Object.keys(b) as Array<keyof typeof b>) a[k] = (a[k] ?? 0) + b[k]; return a; }, {} as Record<string, number>),
  topSignatures: top(sigFreq, 25),
  topSpecificSignatures: top(specFreq, 25),
  matchedExamples: errs.filter((e) => e.matchSpecificPrior.length).slice(0, 30).map((e) => ({ source: e.source, sid8: e.sid8, ts: e.ts, tool: e.toolName, specific: e.specific.map((x) => x.slice(0, 90)), cases: e.matchSpecificPrior })),
};
console.log(JSON.stringify({ cases: result.cases, totals: result.totals, perSource: result.perSource }, null, 2));
console.log("top specific:", JSON.stringify(result.topSpecificSignatures.slice(0, 12)));
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
