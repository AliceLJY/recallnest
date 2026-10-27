// 报错召回（P1 ⑥，plan D5 ②）：Claude Code 的 PostToolUseFailure 钩子调它。
// stdin = 钩子入参 JSON（session_id、tool_name、error、is_interrupt…）；报错里的具体性签名在账本签名索引里精确命中，
// 才往 stdout 写 {hookSpecificOutput:{hookEventName, additionalContext}}，并记一行 recall-log（outcome 由扫描器事后判）。
// 没命中、没索引、读不了、任何异常：什么都不输出、退出 0——钩子绝不能拦住工具调用或吐噪音。
// 只引轻模块（node:fs + 签名 / 脱敏），不碰 LanceDB：每次工具报错都要跑。
// 用法：bun run scripts/error-recall.ts [--data-dir <dir>]（默认 $RECALLNEST_DATA_DIR，再默认仓库的 data/）
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { lookupSignatures, readSignatureIndex, recurrenceSignatures, errorRecallContext, SIGNATURE_INDEX_FILE } from "../src/ledger-signatures.js";
import { appendRecallLog, buildRecallLogEntry } from "../src/recall-log.js";

function main(): void {
  const i = process.argv.indexOf("--data-dir");
  const dataDir = resolve(i > 0 ? process.argv[i + 1] : process.env.RECALLNEST_DATA_DIR || join(import.meta.dir, "..", "data"));
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(readFileSync(0, "utf-8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (input.is_interrupt === true) return;
  const error = typeof input.error === "string" ? input.error : "";
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!error.trim()) return;
  const index = readSignatureIndex(join(dataDir, SIGNATURE_INDEX_FILE));
  if (!index) return;
  const hits = lookupSignatures(index, recurrenceSignatures(error), { excludeSession: sessionId || undefined });
  if (hits.length === 0) return;
  const context = errorRecallContext(index, hits);
  if (sessionId) {
    for (const h of hits.slice(0, 2)) {
      appendRecallLog(dataDir, buildRecallLogEntry({
        sessionId,
        operation: "error-signature",
        query: h.display,
        scope: "memory:ledger",
        mode: typeof input.tool_name === "string" ? input.tool_name : undefined,
        results: h.refs.slice(-2).map((r) => ({ id: r.sid8, scope: "memory:ledger", canonicalKey: r.file })),
      }));
    }
  }
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "PostToolUseFailure";
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
}

try {
  main();
} catch {
  /* 钩子不吐错 */
}
