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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { isSyncConflictFile, type CurrentChunk, type DocReconcileSource } from "./memory-reconcile.js";
import { redactSecrets } from "./pii-detector.js";
import { normalizeDedupText } from "./text-fingerprint.js";

export const LEDGER_DOC_SCOPE = "memory:ledger";

/** 不进索引的节（标题前缀） */
const SKIP_SECTIONS = ["当场写过的记忆"];
const EMPTY_LINE_RE = /^-\s*（(无|未生成)）\s*$/;

export interface ParsedLedger {
  frontmatter: Record<string, string>;
  title: string;
  sections: Array<{ heading: string; body: string }>;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith("\"") && t.endsWith("\"")) {
    try {
      return String(JSON.parse(t));
    } catch {
      return t.slice(1, -1);
    }
  }
  return t === "null" ? "" : t;
}

/** 解析一份账本 markdown：frontmatter（逐行 key: value）、`# ` 标题、`## ` 各节。不是账本形状的返回 null。 */
export function parseLedgerMarkdown(md: string): ParsedLedger | null {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const frontmatter: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    frontmatter[line.slice(0, i).trim()] = unquote(line.slice(i + 1));
  }
  if (!frontmatter.session) return null;
  const rest = md.slice(m[0].length);
  const title = rest.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const sections: ParsedLedger["sections"] = [];
  const parts = rest.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl >= 0 ? part.slice(0, nl) : part).trim();
    // 节内容到下一个 `## ` 为止；文末「> 生成失败」这类引用行不算正文
    const body = (nl >= 0 ? part.slice(nl + 1) : "")
      .split("\n")
      .filter((l) => !l.startsWith("> "))
      .join("\n")
      .trim();
    sections.push({ heading, body });
  }
  return { frontmatter, title, sections };
}

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

/** 递归列出目录下的 *.md（跳过点开头的目录 / 文件，比如 Syncthing 的 .stversions），返回相对路径（用 / 分隔） */
export function listLedgerFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // 悬空链接 / 刚被挪走
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith(".md")) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
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
