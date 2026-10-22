/**
 * sessions-sweep-run — 把发现 / 决策 / 账本生成串起来的一轮扫描（CLI `recallnest sessions sweep` 的实现）。
 *
 * P0 只实现影子模式：`shadowDir` 必填；账本写到 `<shadowDir>/ledgers/YYYY-MM/<sid8>.md`，游标写到
 * `<shadowDir>/session-state/`，每个决策追加一行到 `<shadowDir>/sweep-log.jsonl`。正式落点（cc-memory/ledgers/）
 * 与 launchd 安装在 P1。
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { LLMClient } from "./llm-client.js";
import { redactSecrets } from "./pii-detector.js";
import { buildLedger, type GenerateLedgerOptions } from "./session-ledger.js";
import type { SessionSource } from "./session-events.js";
import { applyDecision, decide, DEFAULT_POLICY, discoverTranscripts, ledgerRelPath, SessionStateStore, type RootSpec, type SweepAction, type SweepPolicy, type TranscriptFile } from "./sessions-sweep.js";

export interface SweepRunOptions {
  roots: RootSpec[];
  shadowDir: string;
  policy?: Partial<SweepPolicy>;
  /** 只看最近 N 天的转录（按 mtime 粗筛，正式判据仍是消息时间） */
  sinceDays?: number;
  nowMs?: number;
  sources?: SessionSource[];
  /** 最多处理（真正生成账本）多少场；0 = 不限 */
  limit?: number;
  llm: LLMClient | null;
  render?: GenerateLedgerOptions;
  /** 只决策不写账本（游标照常更新为「已看过」？不——dry-run 什么都不写） */
  dryRun?: boolean;
  /** 只处理这些 sid（回放用），空 = 全部 */
  onlySessionIds?: Set<string>;
  trigger?: "auto-sweep" | "replay";
  /** 两次 LLM 调用之间至少隔多久（毫秒），给限速留余量；0 = 不等 */
  llmDelayMs?: number;
  log?: (line: string) => void;
}

export interface SweepRunResult {
  discovered: number;
  statCalls: number;
  discoveryWallMs: number;
  missingRoots: string[];
  actions: Record<SweepAction, number>;
  ledgersWritten: string[];
  llmCalls: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  llmFailures: number;
  wallMs: number;
}

export async function runSweep(opts: SweepRunOptions): Promise<SweepRunResult> {
  const t0 = performance.now();
  const policy: SweepPolicy = { ...DEFAULT_POLICY, ...opts.policy };
  const nowMs = opts.nowMs ?? Date.now();
  // mtime 粗筛按真实墙钟算，不按 --now：回放把「现在」定到未来时，30 天窗口不该跟着整体平移
  const sinceMs = opts.sinceDays ? Date.now() - opts.sinceDays * 86_400_000 : 0;
  const log = opts.log ?? (() => {});
  const disc = discoverTranscripts(opts.roots, { sinceMs });
  let files = disc.files;
  if (opts.sources?.length) files = files.filter((f) => opts.sources!.includes(f.source));
  if (opts.onlySessionIds?.size) files = files.filter((f) => opts.onlySessionIds!.has(f.sessionId) || opts.onlySessionIds!.has(f.sessionId.slice(0, 8)));
  // 老的先处理：回放时顺序稳定，影子期也让积压的先出
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const stateStore = new SessionStateStore(join(opts.shadowDir, "session-state"));
  const ledgerRoot = join(opts.shadowDir, "ledgers");
  const sweepLog = join(opts.shadowDir, "sweep-log.jsonl");
  if (!opts.dryRun) mkdirSync(opts.shadowDir, { recursive: true });

  const actions = {} as Record<SweepAction, number>;
  const result: SweepRunResult = { discovered: disc.files.length, statCalls: disc.statCalls, discoveryWallMs: disc.wallMs, missingRoots: disc.missingRoots, actions, ledgersWritten: [], llmCalls: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmFailures: 0, wallMs: 0 };
  let produced = 0;

  for (const file of files) {
    if (opts.limit && produced >= opts.limit) break;
    const key = stateStore.fresh(file).key;
    const state = stateStore.load(key) ?? stateStore.fresh(file);
    let decision;
    try {
      decision = decide(file, state, nowMs, policy);
    } catch (error) {
      log(`! ${file.source} ${file.sessionId.slice(0, 8)} parse failed: ${error instanceof Error ? error.message : String(error)}`);
      actions["skip-no-timestamp"] = (actions["skip-no-timestamp"] ?? 0) + 1;
      continue;
    }
    actions[decision.action] = (actions[decision.action] ?? 0) + 1;
    const needsLedger = decision.action === "ledger" || decision.action === "ledger+candidates" || decision.action === "candidates";
    let ledgerPath: string | undefined;
    let usageNote: Record<string, unknown> = {};
    if (needsLedger && decision.doc && !opts.dryRun) {
      if (opts.llm && opts.llmDelayMs && result.llmCalls > 0) await new Promise((r) => setTimeout(r, opts.llmDelayMs));
      const pass = decision.action === "candidates" ? state.pass : state.pass + 1;
      // D2 两步：第一次静默只写事实账本，候选到期（ledger+candidates / candidates）才出经验
      const includeCandidates = decision.action !== "ledger";
      const render = await buildLedger(decision.doc, { trigger: opts.trigger ?? "auto-sweep", pass, machine: file.machine, generatedAt: new Date(nowMs).toISOString() }, opts.llm, { ...opts.render, includeCandidates });
      if (opts.llm) {
        result.llmCalls++;
        if (render.usage) {
          result.llmPromptTokens += render.usage.promptTokens;
          result.llmCompletionTokens += render.usage.completionTokens;
        }
        if (render.generator === "llm-failed") result.llmFailures++;
        usageNote = { generator: render.generator, tokens: render.usage ? [render.usage.promptTokens, render.usage.completionTokens] : null, wallMs: render.usage?.wallMs ?? null, failure: render.failure ? redactSecrets(render.failure).text.slice(0, 300) : undefined, candidates: includeCandidates, experience: render.body?.experience.length ?? 0, anchorsUnverified: render.body?.experience.filter((x) => !x.anchorVerified).length ?? 0 };
      }
      ledgerPath = join(ledgerRoot, ledgerRelPath(decision.doc.sessionId, decision.lastMessageAt ?? decision.doc.endedAt ?? new Date(nowMs).toISOString()));
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, render.markdown);
      result.ledgersWritten.push(ledgerPath);
      produced++;
    }
    if (!opts.dryRun) {
      stateStore.save(applyDecision(state, file, decision, nowMs, policy, ledgerPath));
      appendFileSync(sweepLog, `${JSON.stringify({ ts: new Date(nowMs).toISOString(), source: file.source, sid8: file.sessionId.slice(0, 8), action: decision.action, reason: decision.reason, userTurns: decision.summary?.userTurns ?? null, rich: decision.summary?.rich ?? null, lastMessageAt: decision.lastMessageAt ?? null, ledger: ledgerPath ? ledgerPath.slice(opts.shadowDir.length + 1) : null, ...usageNote })}\n`);
    }
    if (needsLedger) log(`${decision.action.padEnd(18)} ${file.source.padEnd(11)} ${file.sessionId.slice(0, 8)} ${decision.reason}${ledgerPath ? ` → ${ledgerPath.slice(opts.shadowDir.length + 1)}` : ""}`);
  }
  result.wallMs = Math.round(performance.now() - t0);
  return result;
}
