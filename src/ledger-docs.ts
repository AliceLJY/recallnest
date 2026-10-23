/**
 * ledger-docs — 会话账本文件的对账源（plan.md v3 第 1 条；P1 ①，2026-10-23）。
 *
 * 账本落 `<ledgerDir>/YYYY-MM/<sid8>.md`（一场一文件，session-ledger.ts 渲染）。记忆文件对账只认目录顶层
 * `*.md`（P0 沙箱实测：子目录里的账本不进计划，RecallNest e3307b52），所以账本走自己的源：
 *   - scope `memory:ledger`（`memory` 家族的一员：不带冒号按 `memory` 查会一起出来，精确查只出账本）；
 *   - 递归读子目录，文件名记相对路径（`2026-10/abcd1234.md`），换月份目录不撞名；
 *   - 按节切片，每片带一行出处头（日期 / 端 / 会话号 / 一句话标题），切出来的片单独被召回时
 *     还知道是哪场会话、哪天的事，也明说是机器生成（碎片拼接失真的「时间拼贴」「指代断裂」）。
 * 不切「当场写过的记忆」一节（只有工具名计数，没有可召回的内容），空节（「（无）」「（未生成）」）不切。
 * 插入 / 恢复 / 下架、锁、日志、撤销全部复用 memory-reconcile.ts，只是 scope 与锁键不同。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listLedgerFiles, parseLedgerMarkdown, type ParsedLedger } from "./ledger-files.js";
import { isSyncConflictFile, type CurrentChunk, type DocReconcileSource } from "./memory-reconcile.js";
import { redactSecrets } from "./pii-detector.js";
import { normalizeDedupText } from "./text-fingerprint.js";

/**
 * 账本切片的 scope。它在 `memory` 家族里（不带冒号的 `memory` 查询会带出它），按 durable 全权重参与召回——这是有意的：
 * 账本本来就是要被召回的。量约每月 700 片、没有上限，会不会挤掉别的记忆没有数字（P1 互审 R3 Kimi N2）。
 * 2026-10-23 定：先接受，部署满一个月量「search_memory scope=memory 前 10 名里账本的占比」，过半再在「移出家族」与
 * 「单独降权」里二选一。跟进在 sync-bridge cc-memory/open-loops.md「RecallNest 会话账本（memory:ledger）按 durable 全权重…」条
 */
export const LEDGER_DOC_SCOPE = "memory:ledger";
export { listLedgerFiles, parseLedgerMarkdown, type ParsedLedger } from "./ledger-files.js";

/** 不进索引的节（标题前缀） */
const SKIP_SECTIONS = ["当场写过的记忆"];
const EMPTY_LINE_RE = /^-\s*（(无|未生成)）\s*$/;

/** 出处头：切片单独被召回时也知道是哪天、哪个端、哪场会话、机器写的 */
export function ledgerChunkHeader(p: ParsedLedger): string {
  const fm = p.frontmatter;
  const date = (fm.ended || fm.started || "").slice(0, 10) || "日期不详";
  const sid8 = fm.session.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `【会话账本·机器生成｜${date}｜${fm.source || "?"}｜${sid8}】${p.title}`;
}

/** 一份账本切成的片：每个有内容的节一片，正文 = 出处头 + 节标题 + 节内容 */
export function ledgerSections(p: ParsedLedger): Array<{ heading: string; text: string }> {
  const header = ledgerChunkHeader(p);
  const out: Array<{ heading: string; text: string }> = [];
  for (const s of p.sections) {
    if (SKIP_SECTIONS.some((k) => s.heading.startsWith(k))) continue;
    const lines = s.body.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !EMPTY_LINE_RE.test(l.trim()));
    if (lines.length === 0) continue;
    out.push({ heading: s.heading, text: `${header}\n## ${s.heading}\n${lines.join("\n")}` });
  }
  return out;
}

export function collectLedgerChunks(dir: string): { chunks: CurrentChunk[]; fileNames: Set<string> } {
  const fileNames = new Set(listLedgerFiles(dir));
  const chunks: CurrentChunk[] = [];
  for (const file of [...fileNames].sort()) {
    if (isSyncConflictFile(file)) continue;
    let md: string;
    try {
      md = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    const parsed = parseLedgerMarkdown(md);
    if (!parsed) continue; // README 之类不是账本的文件：不切，但留在 fileNames 里
    ledgerSections(parsed).forEach((section, idx) => {
      // 与记忆文件对账同一套：先脱敏、换掉半截代理对，比对与入库都用这个文本
      const text = redactSecrets(section.text).text.toWellFormed();
      chunks.push({ file, idx, heading: section.heading, text, norm: normalizeDedupText(text) });
    });
  }
  return { chunks, fileNames };
}

export const LEDGER_DOC_SOURCE: DocReconcileSource = {
  scope: LEDGER_DOC_SCOPE,
  name: "ledger-reconcile",
  // dream 合并对 scope 的锁是 `consolidate-<scope>`；GC 是全库的
  lockKeys: ["ledger-reconcile", `consolidate-${LEDGER_DOC_SCOPE}`, "gc-run"],
  dirLabel: "账本目录",
  collect: (dir) => collectLedgerChunks(dir),
};
