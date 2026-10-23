/**
 * recall-outcome — recall-log 四态判定（P1 ⑥，plan §5 第 2 条）。扫描器处理一场会话（它已经静默够久）时调。
 *
 * 只有报错签名路径能机械判：
 *   - missed：注入之后，同一个签名在这场会话里又报了一次（提醒了还是踩了）；
 *   - used：注入之后同签名没再出现，且之后还有成功的工具调用（上界——也可能是 agent 自己解掉的，不全是召回的功劳）；
 *   - undeterminable：注入之后这场会话就没有工具调用了，看不出结果。
 * 第一条消息路径（/v1/auto-recall）一律 undeterminable：用没用上要读者看（plan §7「首条消息召回有没有用」抽 40 条双读者）。
 * unused（后文完全没沾边）机械判不出来，不在这里判。
 * 已判过的记录不重判；文件整份重写（先写临时文件再改名），判不了的行原样保留。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { recurrenceSignatures, sigKey } from "./ledger-signatures.js";
import { RECALL_LOG_DIRNAME, recallLogFileName, type RecallLogEntry, type RecallOutcome } from "./recall-log.js";
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

/** 判这场会话 recall-log 里还没判的记录；返回各态计数（文件不存在返回 null） */
export function judgeRecallLog(recallLogRoot: string, doc: SessionDoc, nowIso = new Date().toISOString()): Partial<Record<RecallOutcome, number>> | null {
  const path = join(recallLogRoot, RECALL_LOG_DIRNAME, recallLogFileName(doc.sessionId));
  if (!existsSync(path)) return null;
  const counts: Partial<Record<RecallOutcome, number>> = {};
  let changed = false;
  const lines = readFileSync(path, "utf-8").split("\n");
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let entry: RecallLogEntry;
    try {
      entry = JSON.parse(line) as RecallLogEntry;
    } catch {
      return line;
    }
    if (entry.outcome) return line;
    // 会话结束之后才写的记录（另一场同 id 的续聊）留给下一轮
    if (doc.endedAt && Date.parse(entry.ts) > Date.parse(doc.endedAt)) return line;
    const j = judgeEntry(entry, doc);
    counts[j.outcome] = (counts[j.outcome] ?? 0) + 1;
    changed = true;
    return JSON.stringify({ ...entry, outcome: j.outcome, outcomeReason: j.reason, judgedAt: nowIso });
  });
  if (changed) {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, out.join("\n"));
    renameSync(tmp, path);
  }
  return counts;
}
