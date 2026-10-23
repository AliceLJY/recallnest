// 回放后处理：用修过的 normalizeForMatch 重新核账本里的锚点，更新「anchor:未核」标记与 frontmatter 的 anchors_unverified。
// 只改账本文件里这两处，不动别的。输出改了多少条。
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSessionFile } from "../../src/session-events.js";
import { verifyAnchor } from "../../src/session-ledger.js";
import { discoverTranscripts, truthRoots } from "../../src/sessions-sweep.js";

const ledgerRoot = process.argv[2];
if (!ledgerRoot) throw new Error("usage: reverify-anchors.ts <ledgersDir>");
const disc = discoverTranscripts(truthRoots(), { sinceMs: Date.now() - 40 * 86_400_000 });
const byId = new Map(disc.files.map((f) => [f.sessionId, f]));
let files = 0, lines = 0, fixed = 0, stillBad = 0;
for (const ym of readdirSync(ledgerRoot)) {
  const dir = join(ledgerRoot, ym);
  if (!statSync(dir).isDirectory()) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    let md = readFileSync(path, "utf-8");
    const sid = md.match(/^session: (\S+)/m)?.[1];
    const f = sid ? byId.get(sid) : undefined;
    if (!f) continue;
    files++;
    const doc = parseSessionFile(f.path, { source: f.source });
    let unverified = 0;
    md = md.replace(/^(- .*? ｜原文：「(.*?)」 ｜src:[A-Za-z0-9]+#(\d+|\?))( ｜anchor:未核)?$/gm, (whole, head: string, anchor: string, seq: string, flag?: string) => {
      lines++;
      const v = verifyAnchor(doc, anchor, seq === "?" ? null : Number(seq));
      if (v.verified) { if (flag) fixed++; return head.replace(/#(\d+|\?)$/, `#${v.seq ?? "?"}`); }
      unverified++; stillBad++;
      return `${head}${flag ?? " ｜anchor:未核"}`;
    });
    md = md.replace(/^anchors_unverified: \d+$/m, `anchors_unverified: ${unverified}`);
    writeFileSync(path, md);
  }
}
console.log(JSON.stringify({ files, experienceLines: lines, flippedToVerified: fixed, stillUnverified: stillBad }));
