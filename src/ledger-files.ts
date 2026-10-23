/**
 * ledger-files — 会话账本文件的读取（只用 node:fs，不碰库）。ledger-docs.ts（对账）、ledger-signatures.ts（签名索引）
 * 与报错召回的 hook 脚本共用；hook 每次工具报错都要跑，所以这里不能间接加载 LanceDB（P1 ⑥）。
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

