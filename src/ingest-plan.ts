/**
 * `ingest` 命令这一轮跑哪些来源。
 *
 * 2026-10-06 起对话原文默认不再入库（开关 `RECALLNEST_TRANSCRIPT_INGEST`，见 env-config.ts `transcriptIngest`）。
 * 入库有两个触发入口——launchd 定时那一轮、pull-from-macbook.sh 拉完之后那一轮——两个都跑
 * `scripts/incremental-ingest.sh` → `cli.ts ingest --source all`，所以闸放在命令内部，而不是去改脚本或卸定时任务。
 *
 * 关着的时候三件事不能跟着停，这也是把决定单独抽成一个函数、逐格测到的原因：
 *   - 记忆文件对账（memory 来源）照常；
 *   - Minis 投递目录里的文件照样挪进 data/minis-archive：Deja 靠那个存档读 Minis 的对话，而挪存档原先拿
 *     「台账里记着已入库」当闸——只跳过入库的话，文件永远不会被标成已处理，也就永远不会被挪，而且不报错；
 *   - 显式点名一个对话来源（`--source cc`）时要说清没有执行，不能安静地什么都不做。
 */

export const CONVERSATION_SOURCES = ["cc", "codex", "kimi", "gemini", "desktop", "minis"] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

export type MinisMode =
  /** 入库（切片、嵌入），再把台账里记着已入库的文件挪进存档——开关打开时的行为 */
  | "ingest-then-archive"
  /** 不入库；能解析出对话的文件直接挪进存档——开关关着时的行为 */
  | "archive-only"
  /** 这一轮不碰 Minis 投递目录 */
  | "skip";

export interface IngestPlan {
  /** 这一轮要切片、嵌入、写库的对话来源（不含 minis，它单独看 `minis`） */
  transcriptSources: Exclude<ConversationSource, "minis">[];
  minis: MinisMode;
  /** 记忆文件（memory 来源） */
  memory: boolean;
  /** 待处理队列里攒的是没有 LLM 时跳过的对话切片，回填等于入库，跟着开关走 */
  drainPendingQueue: boolean;
  /** 这一轮点到了、但因为开关关着而没有入库的对话来源（含 minis），日志里要说出来 */
  skippedTranscriptSources: ConversationSource[];
}

export function isConversationSource(source: string): source is ConversationSource {
  return (CONVERSATION_SOURCES as readonly string[]).includes(source);
}

export function planIngest(source: string, transcriptIngestOn: boolean): IngestPlan {
  const wants = (name: string) => source === "all" || source === name;
  const requested = CONVERSATION_SOURCES.filter((name) => wants(name));
  const requestedTranscripts = requested.filter(
    (name): name is Exclude<ConversationSource, "minis"> => name !== "minis",
  );

  return {
    transcriptSources: transcriptIngestOn ? requestedTranscripts : [],
    minis: !wants("minis") ? "skip" : transcriptIngestOn ? "ingest-then-archive" : "archive-only",
    memory: wants("memory"),
    drainPendingQueue: transcriptIngestOn,
    skippedTranscriptSources: transcriptIngestOn ? [] : requested,
  };
}
