/**
 * recall-outcome — recall-log 四态判定（P1 ⑥，plan §5 第 2 条）。扫描器处理一场会话（它已经静默够久）时调。
 *
 * 只有报错签名路径能机械判：
 *   - missed：注入之后，同一个签名在这场会话里又报了一次（提醒了还是踩了）；
 *   - used：注入之后同签名没再出现，且之后还有成功的工具调用（上界——也可能是 agent 自己解掉的，不全是召回的功劳）；
 *   - undeterminable：注入之后这场会话就没有工具调用了，看不出结果。
 * 第一条消息路径（/v1/auto-recall）一律 undeterminable：用没用上要读者看（plan §7「首条消息召回有没有用」抽 40 条双读者）。
 * unused（后文完全没沾边）机械判不出来，不在这里判。
 *
 * 判定结果写进同目录的 `<sid>.outcomes.jsonl`（只追加），主日志一个字都不改：主日志由十来个 MCP 进程和报错召回钩子随时追加，
 * 整份重写会把「读快照之后、改名之前」追加的行盖掉（P1 互审 R4 Codex #1）。每条判定带 key = 「行号:行内容哈希」——主日志只追加，
 * 行号与内容都不会变；已判过的不重判。
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { recurrenceSignatures, sigKey } from "./ledger-signatures.js";
import { RECALL_LOG_DIRNAME, recallLogFileName, type RecallLogEntry, type RecallOutcome } from "./recall-log.js";

/** 判定结果的落点：与主日志同目录、同名加 .outcomes（session id 已被 recallLogFileName 清成 [A-Za-z0-9_-]，撞不上别场的主日志） */
export function recallOutcomeFileName(sessionId: string): string {
  return recallLogFileName(sessionId).replace(/\.jsonl$/, ".outcomes.jsonl");
}

export interface RecallOutcomeRecord {
  /** 主日志里的「行号:行内容 sha256 前 16 位」 */
  key: string;
  ts: string;
  operation: string;
  query: string;
  outcome: RecallOutcome;
  outcomeReason: string;
  judgedAt: string;
}

function lineKey(lineNo: number, line: string): string {
  return `${lineNo}:${createHash("sha256").update(line).digest("hex").slice(0, 16)}`;
}
import type { SessionDoc } from "./session-events.js";

export function judgeEntry(entry: RecallLogEntry, doc: SessionDoc): { outcome: RecallOutcome; reason: string } {
  if (entry.operation !== "error-signature") return { outcome: "undeterminable", reason: "第一条消息路径，用没用上要读者判" };
  const at = Date.parse(entry.ts);
  const key = sigKey(entry.query);
  const later = doc.events.filter((e) => e.kind === "tool_result" && e.tsMs !== null && e.tsMs !== undefined && e.tsMs > at);
  const again = later.find((e) => e.isError && recurrenceSignatures(e.text).has(key));
  if (again) return { outcome: "missed", reason: `注入后同签名又出现（事件 #${again.seq}）` };
  const ok = later.filter((e) => !e.isError).length;
  if (ok > 0) return { outcome: "used", reason: `注入后同签名没再出现，之后 ${ok} 次工具调用成功（上界：也可能是自己解掉的）` };
  return { outcome: "undeterminable", reason: "注入后没有工具调用，看不出结果" };
}

/** 判这场会话 recall-log 里还没判的记录，结果追加到 sidecar；返回本次判出的各态计数（主日志不存在返回 null） */
export function judgeRecallLog(recallLogRoot: string, doc: SessionDoc, nowIso = new Date().toISOString()): Partial<Record<RecallOutcome, number>> | null {
  const dir = join(recallLogRoot, RECALL_LOG_DIRNAME);
  const path = join(dir, recallLogFileName(doc.sessionId));
  if (!existsSync(path)) return null;
  const outPath = join(dir, recallOutcomeFileName(doc.sessionId));
  const judged = new Set<string>();
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Partial<RecallOutcomeRecord>;
        if (typeof r.key === "string") judged.add(r.key);
      } catch {
        /* 写到一半的尾行：那条下一轮再判 */
      }
    }
  }
  const counts: Partial<Record<RecallOutcome, number>> = {};
  const add: RecallOutcomeRecord[] = [];
  // 只看以换行结尾的完整行：最后一行可能正被别的进程写到一半
  const lines = readFileSync(path, "utf-8").split("\n").slice(0, -1);
  lines.forEach((line, lineNo) => {
    if (!line.trim()) return;
    const key = lineKey(lineNo, line);
    if (judged.has(key)) return;
    let entry: RecallLogEntry;
    try {
      entry = JSON.parse(line) as RecallLogEntry;
    } catch {
      return;
    }
    if (entry.outcome) return;
    // 会话结束之后才写的记录（另一场同 id 的续聊）留给下一轮
    if (doc.endedAt && Date.parse(entry.ts) > Date.parse(doc.endedAt)) return;
    const j = judgeEntry(entry, doc);
    counts[j.outcome] = (counts[j.outcome] ?? 0) + 1;
    add.push({ key, ts: entry.ts, operation: entry.operation, query: entry.query, outcome: j.outcome, outcomeReason: j.reason, judgedAt: nowIso });
  });
  if (add.length) appendFileSync(outPath, `${add.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return counts;
}
