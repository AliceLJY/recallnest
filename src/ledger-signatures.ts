/**
 * ledger-signatures — 账本「报错（机器抽取）」节里的具体性签名索引（P1 ⑥：复发节 + 报错召回）。
 *
 * 为什么查账本不查 case：P0 数⑤实测，30 天 525 种具体性签名对上既有 case 0 种——case 的 problem 是 agent 转述的中文，
 * 抽不出和工具原始报错同形的签名；账本的报错节是从 tool_result 原文用同一个抽取器抽的，读写两侧同形。
 *
 * 两种签名不算「又踩」：hook 拦截（bash-guard 的 RM-GUARD、makoto 等，P0 里 91 + 58 次，它们是规矩在起作用，不是失败），
 * 以及 generic 档（裸退出码、裸 not found——分档器 error-signature-specificity.ts）。
 *
 * 只用 node:fs + 轻依赖：报错召回的 hook 每次工具报错都要跑一次（scripts/error-recall.ts）。
 */

import { readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { extractErrorSignatures } from "./error-signature.js";
import { classifySignatureSpecificity } from "./error-signature-specificity.js";
import { listLedgerFiles, parseLedgerMarkdown } from "./ledger-files.js";
import { redactSecrets } from "./pii-detector.js";

export const SIGNATURE_INDEX_FILE = "ledger-signature-index.json";
/** 账本里一条签名最多存多少字（session-ledger.ts 渲染报错节时截到 100） */
export const SIG_MAX = 100;

const HOOK_INTERCEPT_RE = /hook error|\.claude\/hooks\/|\bRM-GUARD\b|\bmakoto\b|cannot determine the safety|\bPreToolUse\b|\bPostToolUse\b|blocked by hook/i;

export function isHookInterception(sig: string): boolean {
  return HOOK_INTERCEPT_RE.test(sig);
}

/**
 * 一条原始报错是不是钩子拦截：看它的第一行（前 300 字）。不能只看抽出来的签名——抽取会把「PreToolUse:Bash hook error:」
 * 这类前缀丢掉（P1 互审 R4 Codex #6）；也不看全文——第二行起偶然出现的拦截字样不该把第一行的真报错一起排除。
 * 写账本（session-ledger.ts 报错节标「钩子拦截」、不写签名）与查召回（recurrenceSignatures）用的是这同一个判断。
 */
export function isHookInterceptionText(errorText: string): boolean {
  const first = errorText.split("\n").find((l) => l.trim()) ?? "";
  return HOOK_INTERCEPT_RE.test(first.slice(0, 300));
}

/** 签名比较用的键：先脱敏、截到账本里存的长度，再小写、压空白（账本存的是脱敏截断后的原形） */
export function sigKey(sig: string): string {
  return redactSecrets(sig).text.slice(0, SIG_MAX).toLowerCase().replace(/\s+/g, " ").trim();
}

/** 从一段原始报错里抽「能算又踩」的签名（具体性档、非 hook 拦截），返回键 → 展示用原形 */
export function recurrenceSignatures(errorText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (isHookInterceptionText(errorText)) return out;
  for (const s of extractErrorSignatures({ problem: errorText.slice(0, 4000) })) {
    if (classifySignatureSpecificity(s) !== "specific" || isHookInterception(s)) continue;
    const k = sigKey(s);
    if (k && !out.has(k)) out.set(k, redactSecrets(s).text.slice(0, SIG_MAX));
  }
  return out;
}

/** 账本 markdown 的报错节里记下的签名（「｜签名：a ‖ b」），按同一规则过滤 */
export function ledgerFileSignatures(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const sec = md.split(/^## 报错（机器抽取/m)[1]?.split(/^## /m)[0] ?? "";
  for (const line of sec.split("\n")) {
    const i = line.indexOf("｜签名：");
    if (i < 0) continue;
    for (const raw of line.slice(i + "｜签名：".length).split("‖")) {
      const s = raw.trim();
      if (!s || isHookInterception(s) || classifySignatureSpecificity(s) !== "specific") continue;
      const k = sigKey(s);
      if (k && !out.has(k)) out.set(k, s);
    }
  }
  return out;
}

export interface SigRef {
  session: string;
  sid8: string;
  /** 会话结束日期 YYYY-MM-DD */
  date: string;
  ended: string;
  /** 相对账本根目录的路径 */
  file: string;
  title: string;
}

export interface SignatureIndex {
  builtAt: string;
  /** 账本根目录（报错召回要回读命中那份账本的「解决了什么」） */
  ledgerDir: string;
  files: number;
  /** 签名键 → 出现过的会话（每场一次） */
  sigs: Record<string, { display: string; refs: SigRef[] }>;
}

export function buildSignatureIndex(ledgerDir: string, nowIso = new Date().toISOString()): SignatureIndex {
  const index: SignatureIndex = { builtAt: nowIso, ledgerDir, files: 0, sigs: {} };
  let files: string[] = [];
  try {
    files = listLedgerFiles(ledgerDir);
  } catch {
    return index;
  }
  for (const file of files) {
    if (/sync-conflict/i.test(file)) continue;
    let md: string;
    try {
      md = readFileSync(join(ledgerDir, file), "utf-8");
    } catch {
      continue;
    }
    const p = parseLedgerMarkdown(md);
    if (!p) continue;
    index.files++;
    addToIndex(index, { session: p.frontmatter.session, ended: p.frontmatter.ended || p.frontmatter.started || "", file, title: p.title }, ledgerFileSignatures(md));
  }
  return index;
}

export function addToIndex(index: SignatureIndex, ref: { session: string; ended: string; file: string; title: string }, sigs: Map<string, string>): void {
  const sid8 = ref.session.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  // 标题压成一行：报错召回把它拼进注入文本（P1 互审 R4 Kimi #3）
  const full: SigRef = { session: ref.session, sid8, date: ref.ended.slice(0, 10), ended: ref.ended, file: ref.file, title: ref.title.replace(/\s+/g, " ").trim().slice(0, 60) };
  for (const [k, display] of sigs) {
    const slot = (index.sigs[k] ??= { display, refs: [] });
    const at = slot.refs.findIndex((r) => r.session === ref.session);
    if (at >= 0) slot.refs[at] = full;
    else slot.refs.push(full);
  }
}

/** 这些签名以前在别的会话里出现过吗（只算结束早于 beforeIso 的；不给就不限） */
export function lookupSignatures(index: SignatureIndex, sigs: Map<string, string>, opts: { excludeSession?: string; beforeIso?: string } = {}): Array<{ key: string; display: string; refs: SigRef[] }> {
  const before = opts.beforeIso ? Date.parse(opts.beforeIso) : Number.POSITIVE_INFINITY;
  const out: Array<{ key: string; display: string; refs: SigRef[] }> = [];
  for (const [k, display] of sigs) {
    const slot = index.sigs[k];
    if (!slot) continue;
    const refs = slot.refs
      .filter((r) => r.session !== opts.excludeSession && (Number.isNaN(Date.parse(r.ended)) || Date.parse(r.ended) <= before))
      .sort((a, b) => a.ended.localeCompare(b.ended));
    if (refs.length) out.push({ key: k, display, refs });
  }
  return out;
}

/** 账本「疑似又踩（机器抽取）」节的行：签名、第几次、之前哪几场（最多列 3 场） */
export function recurrenceLines(hits: Array<{ display: string; refs: SigRef[] }>): string[] {
  return hits.map((h) => {
    const prev = h.refs.slice(-3).map((r) => `${r.date} ${r.sid8}「${r.title}」`).join("、");
    return `${h.display}：第 ${h.refs.length + 1} 次（之前：${prev}${h.refs.length > 3 ? ` 等 ${h.refs.length} 场` : ""}）`;
  });
}

export function writeSignatureIndex(path: string, index: SignatureIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(index));
  renameSync(tmp, path);
}

/** 账本目录里最新那份账本的修改时间（毫秒）；没有账本或读不了返回 0 */
export function newestLedgerMtimeMs(ledgerDir: string): number {
  let files: string[];
  try {
    files = listLedgerFiles(ledgerDir);
  } catch {
    return 0;
  }
  let newest = 0;
  for (const f of files) {
    try {
      newest = Math.max(newest, statSync(join(ledgerDir, f)).mtimeMs);
    } catch {
      /* 刚被挪走 */
    }
  }
  return newest;
}

export function readSignatureIndex(path: string): SignatureIndex | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SignatureIndex;
  } catch {
    return null;
  }
}

/** 账本某一节的前几行（报错召回带上「那次解决了什么」）；读不了返回空 */
export function ledgerSectionLines(ledgerDir: string, file: string, heading: string, max = 3): string[] {
  try {
    const p = parseLedgerMarkdown(readFileSync(join(ledgerDir, file), "utf-8"));
    const sec = p?.sections.find((x) => x.heading.startsWith(heading));
    return (sec?.body ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ") && !/^-\s*（(无|未生成)）$/.test(l)).slice(0, max);
  } catch {
    return [];
  }
}

/**
 * 报错召回要注入的文字（P1 ⑥，D5 ②）：签名精确命中才有，最多两条签名、每条最近两场。
 * 措辞是「以前遇到过、那次怎么收场的」，不是「照做」——同签名不一定同一个坑。
 */
export function errorRecallContext(index: SignatureIndex, hits: Array<{ display: string; refs: SigRef[] }>): string {
  const parts: string[] = ["RecallNest：这个报错的签名在以前的会话账本里出现过（精确命中，同签名不一定是同一个坑，先核对再用）："];
  for (const h of hits.slice(0, 2)) {
    parts.push(`- 签名「${h.display}」，之前 ${h.refs.length} 场：`);
    for (const r of h.refs.slice(-2).reverse()) {
      const solved = ledgerSectionLines(index.ledgerDir, r.file, "解决了什么", 2);
      parts.push(`  · ${r.date} ${r.sid8}「${r.title}」（账本 ${r.file}）${solved.length ? `；那次解决了：${solved.map((l) => l.slice(2)).join("；")}` : ""}`);
    }
  }
  return redactSecrets(parts.join("\n")).text.slice(0, 4000);
}
