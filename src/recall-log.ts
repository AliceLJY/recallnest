/**
 * recall-log — 「这场会话被注入了哪些记忆」的落盘账本（plan.md v2.1 D5 / research G5）。
 *
 * 为什么另起一个文件而不是扩 recall-ledger.ts：那个是进程内 30 分钟窗口的 join key，MCP 进程 ≈ 一场 CC 会话；
 * 这里要的是跨进程、按 session_id 归档、事后能回放核对的记录——API 进程常驻，一场会话的多次查询才能落到同一个文件。
 *
 * 只在调用方带了 session_id 时写（现有 hook 走 /v1/search 不带 sid，行为不变）；写失败只记 stderr，绝不影响请求。
 * 不写记忆正文：只记 id 前 8 位、分数、scope、canonicalKey 与截短并脱敏过的查询——账本本身不该成为第二份泄露。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { redactSecrets } from "./pii-detector.js";

export interface RecallLogResult {
  id8: string;
  score: number | null;
  scope?: string;
  canonicalKey?: string;
  category?: string;
}

export interface RecallLogEntry {
  ts: string;
  sessionId: string;
  operation: string;
  /** 截短 + 脱敏后的查询 */
  query: string;
  scope?: string;
  mode?: string;
  resultCount: number;
  results: RecallLogResult[];
  /** 四态闭环（P2）：used / unused / missed / undeterminable；P0 只落 null */
  outcome: null;
}

export const RECALL_LOG_DIRNAME = "recall-log";
export const RECALL_LOG_QUERY_MAX = 200;
export const RECALL_LOG_RESULTS_CAP = 10;

export function recallLogFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return `${safe || "unknown"}.jsonl`;
}

export function buildRecallLogEntry(input: {
  sessionId: string;
  operation: string;
  query: string;
  scope?: string;
  mode?: string;
  results: Array<{ id?: unknown; score?: unknown; scope?: unknown; canonicalKey?: unknown; category?: unknown; entry?: { id?: unknown; scope?: unknown; category?: unknown; metadata?: unknown } }>;
  now?: number;
}): RecallLogEntry {
  const results: RecallLogResult[] = input.results.slice(0, RECALL_LOG_RESULTS_CAP).map((r) => {
    const id = typeof r.id === "string" ? r.id : typeof r.entry?.id === "string" ? r.entry.id : "";
    const scope = typeof r.scope === "string" ? r.scope : typeof r.entry?.scope === "string" ? r.entry.scope : undefined;
    const category = typeof r.category === "string" ? r.category : typeof r.entry?.category === "string" ? r.entry.category : undefined;
    let canonicalKey = typeof r.canonicalKey === "string" ? r.canonicalKey : undefined;
    if (!canonicalKey && typeof r.entry?.metadata === "string") {
      try {
        const md = JSON.parse(r.entry.metadata) as { canonicalKey?: unknown };
        if (typeof md.canonicalKey === "string") canonicalKey = md.canonicalKey;
      } catch {
        /* ignore */
      }
    }
    const score = typeof r.score === "number" && Number.isFinite(r.score) ? Math.round(r.score * 1000) / 1000 : null;
    return { id8: id.slice(0, 8), score, scope, canonicalKey: canonicalKey?.slice(0, 80), category };
  });
  return {
    ts: new Date(input.now ?? Date.now()).toISOString(),
    sessionId: input.sessionId,
    operation: input.operation,
    query: redactSecrets(input.query).text.replace(/\s+/g, " ").slice(0, RECALL_LOG_QUERY_MAX),
    scope: input.scope,
    mode: input.mode,
    resultCount: input.results.length,
    results,
    outcome: null,
  };
}

/** 追加一行；返回写到的文件路径。任何异常都吞掉并返回 null（调用方在请求热路径上）。 */
export function appendRecallLog(dataDir: string, entry: RecallLogEntry): string | null {
  try {
    const dir = join(dataDir, RECALL_LOG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, recallLogFileName(entry.sessionId));
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return file;
  } catch (error) {
    console.error(`[recall-log] append failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
