/**
 * Centralized RECALLNEST_* environment variable accessors (P3-C config 收口).
 *
 * Single source of truth for every fixed `RECALLNEST_*` env flag read across `src/`:
 * the env NAME, its default, and its parsing all live here. Consumers call these
 * accessors instead of reading `process.env` directly.
 *
 * This is a PURE-MOVEMENT refactor — each accessor preserves the exact original
 * parsing. Do not "improve" them; the following invariants are load-bearing:
 *
 * - Boolean flags use strict `=== "true"` — no trim, no case-folding, no truthy
 *   coercion. `"True"` / `" true "` / `"1"` must NOT enable a flag.
 * - String defaults use `||`, NOT `??` — an empty string falls through to the
 *   default (matches the original inline reads).
 * - Raw-value accessors (recall mode, ports) return the UNPARSED env value so the
 *   caller keeps its existing validation / clamping / config-fallback logic. In
 *   particular `recallModeRaw()` must not default to "summary" here, or it would
 *   bypass the `config.recallMode` fallback in resolveRecallMode().
 * - `mcpTier()` keeps only the type assertion with NO runtime validation — an
 *   illegal non-empty value is preserved as-is (downstream shouldRegisterTool()
 *   relies on this), so do not coerce unknown values back to the default.
 *
 * Accessors are FUNCTIONS (lazy): they read `process.env` at call time. Never
 * freeze them into module-load constants — 100+ tests toggle `process.env` at
 * runtime. Consumers must substitute in place and never relocate a read across
 * the `loadDotEnv()` boundary or into a different evaluation phase: five reads are
 * intentionally module-init-time eager (mcp-server tier, api/ui ports,
 * activity-counter / distill-lock data dir) and must stay eager.
 *
 * Intentionally NOT centralized here:
 * - scope-policy.ts's RECALLNEST_DEFAULT_SCOPE / _SCOPE / _PROJECT_SCOPE /
 *   _SESSION_ID — an injectable `options.env || process.env` policy entry that is
 *   already consolidated in that module with caller-injection semantics.
 * - store.ts's `RECALLNEST_NS` — a local hash-namespace constant, not an env var.
 * - config-template `${VAR}` expansion in runtime-config / embedder / llm-client.
 */

// --- Boolean feature flags (strict === "true") ---

export const multiVector = (): boolean => process.env.RECALLNEST_MULTI_VECTOR === "true";

// --- 写入时预演触发器（T-Mem 借鉴，2026-09-22）---
// 默认开；显式 "false" 关。侧表 memory_triggers 不存在时 TriggerStore 自建，读路径失败一律 fail-open。
export const triggerRecall = (): boolean => process.env.RECALLNEST_TRIGGER_RECALL !== "false";
/**
 * trigger 命中的余弦硬闸。T-Mem 论文默认 0.85 是他们的嵌入器；本库 jina-embeddings-v5-text-small
 * query↔query 余弦压得很紧：2026-09-22 用 12 条 canary 校准——真联想命中 0.52–0.67、无关噪声最高 0.53，
 * 0.50 让 canary-A-mem0-borrow 从 70% 掉到 40%，0.55 与接线前逐条一致。要换嵌入器先跑 `triggers-calibrate` 重定。
 */
export const triggerGate = (): number => {
  const raw = Number(process.env.RECALLNEST_TRIGGER_GATE);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.55;
};
/**
 * 软闸：余弦没过硬闸、但 query 与 trigger 词面重合够高时也放行（trigger 是她自己的口语问法，
 * 她将来的问法与预演的问法常常共用同几个字：榜 / 排名 / 清一清）。09-22 校准：真命中 overlap 0.20–0.64，
 * 无关噪声 0–0.20，但关键词短 query 会被共用词撑高——所以再加一道 query 长度门槛（见下）；取余弦 ≥0.40 且 overlap ≥0.40。
 */
export const triggerSoftGate = (): number => {
  const raw = Number(process.env.RECALLNEST_TRIGGER_SOFT_GATE);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.40;
};
export const triggerMinOverlap = (): number => {
  const raw = Number(process.env.RECALLNEST_TRIGGER_MIN_OVERLAP);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.40;
};
/**
 * 软闸只对「像一句话的问法」开：query 去停用词后至少这么多 token（CJK 按字）。
 * 09-22 实测：「OpenClaw 记忆系统」(5 token) 与「taobao 这个 mcp 是官方的吗」(7 token) 这类关键词 query，
 * 词面重合被一个共用词（记忆系统 / mcp）撑到 0.3–0.7，把同话题的旁支宿主顶到第一、二名，
 * 20 条回归掉了两条；联想入口本来就是给「换个情境重提旧事」的整句问法用的，关键词 query 走向量 / BM25 就够。
 */
export const triggerSoftMinQueryTokens = (): number => {
  const raw = Number(process.env.RECALLNEST_TRIGGER_SOFT_MIN_QUERY_TOKENS);
  return Number.isFinite(raw) && raw >= 1 && raw <= 64 ? Math.floor(raw) : 8;
};
/** 每次检索最多让多少个宿主经 trigger 进入候选池。 */
export const triggerTopK = (): number => {
  const raw = Number(process.env.RECALLNEST_TRIGGER_TOP_K);
  return Number.isFinite(raw) && raw >= 1 && raw <= 50 ? Math.floor(raw) : 10;
};

export const emotionScoring = (): boolean => process.env.RECALLNEST_EMOTION_SCORING === "true";

export const predictiveMemory = (): boolean => process.env.RECALLNEST_PREDICTIVE_MEMORY === "true";

export const synthesize = (): boolean => process.env.RECALLNEST_SYNTHESIZE === "true";

export const llmConsolidation = (): boolean => process.env.RECALLNEST_LLM_CONSOLIDATION === "true";

export const constructiveRetrieval = (): boolean =>
  process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL === "true";

export const narrativeMode = (): boolean => process.env.RECALLNEST_NARRATIVE_MODE === "true";

export const kgMode = (): boolean => process.env.RECALLNEST_KG_MODE === "true";

export const coreSummary = (): boolean => process.env.RECALLNEST_CORE_SUMMARY === "true";

export const errorSignatureBoost = (): boolean =>
  process.env.RECALLNEST_ERROR_SIGNATURE_BOOST === "true";

export const usageDecay = (): boolean => process.env.RECALLNEST_USAGE_DECAY === "true";

// --- LA-1: Layer admission (tri-state, defaults to off) ---

/**
 * 资格层准入模式：默认检索是否只召回 durable 层（提炼结论），把 evidence
 * （transcript 碎片）留给 deja / 显式溯源。
 *
 *   off      — 默认，完全不生效（现网行为不变）
 *   observe  — 只计算并记录"会过滤掉什么"，返回结果不变（影子期）
 *   on       — 真正过滤
 */
export const layerAdmission = (): "off" | "observe" | "on" => {
  const v = process.env.RECALLNEST_LAYER_ADMISSION;
  return v === "on" || v === "observe" ? v : "off";
};

/** durable 层命中数低于此值时回退到全量候选池，避免"宁缺毋滥"变成"什么都没有"。 */
export const layerAdmissionMin = (): number => {
  const n = Number(process.env.RECALLNEST_LAYER_ADMISSION_MIN);
  return Number.isFinite(n) && n > 0 ? n : 3;
};

// --- 排序上把相关度与流行度拆开（2026-09-25，open-loops「RecallNest 检索评分链」症状 C）---

/**
 * 流行度信号怎么进排序：
 *   bounded — 默认（2026-09-25 起，Alice 看过正式 shadow 后拍板切）：三环都不跑；链尾一步
 *             score × (1 + popularityBonusMax · h)，h = min(1, log2(1+evolution.accessCount)/5)，
 *             只加不减、这一环不截平（检索器内部按原值排序，retrieve() 出口才截到 1）；下游「给全文」档用 0.80
 *   legacy  — 只在显式设 `legacy` 时走：切默认之前的行为逐字节不变（访问计数加成、热度混合、频次加成三环，各自截在 1.0）。
 *             切回旧行为只要在 mcp.env 里加这一行。
 */
export const popularityRanking = (): "legacy" | "bounded" =>
  process.env.RECALLNEST_POPULARITY_RANKING === "legacy" ? "legacy" : "bounded";

/**
 * trigger 那一路不做长度归一：以 trigger 分为底走一遍与正文相同的前置环节，长度归一后取两路较大。
 * trigger 独自带入或主导的宿主两路相同，等于免长度归一。默认开（2026-09-25 起），只有显式设 `false` 才关，
 * 同 RECALLNEST_TRIGGER_RECALL 的写法。
 */
export const triggerLengthExempt = (): boolean =>
  process.env.RECALLNEST_TRIGGER_LENGTH_EXEMPT !== "false";

/**
 * 下游「给全文」那一档的分数线（adaptive 全文、resume_context 折叠视图 L2）。
 * bounded 下热门条目不再被乘到 1.0，分数回到相关度的水平，0.85 那条线就太高了——
 * 同一份快照上判过分档的前 5 条目里，正确答案拿全文的从 26 条掉到 18 条；0.80 是 32 条
 * （第二步 plan §一.1，正式 shadow 用整组渲染回放复核）。legacy 下仍是 0.85。
 */
export const fullTextScoreThreshold = (): number =>
  popularityRanking() === "bounded" ? 0.80 : 0.85;

// --- String settings with `||` default (empty string falls through) ---

export const dataDir = (): string => process.env.RECALLNEST_DATA_DIR || "data";

export const mcpTier = (): "core" | "advanced" | "full" =>
  (process.env.RECALLNEST_MCP_TIER || "advanced") as "core" | "advanced" | "full";

// --- LanceDB read consistency (cross-process visibility) ---

/**
 * Read consistency interval (seconds) resolved for lancedb.connect().
 * Without it a long-lived table handle pins its manifest version and never
 * sees writes committed by other processes (CLI ingest vs resident MCP/API/UI
 * servers). Explicit StoreConfig.readConsistencyInterval wins over this env.
 *
 * Unset / empty  → 0 (strong consistency: check for external commits per read)
 * "off" | "none" → undefined (legacy unchecked-handle behavior, escape hatch)
 * number ≥ 0     → bounded staleness window in seconds (invalid values → 0)
 */
export const readConsistencyInterval = (): number | undefined => {
  const raw = process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL;
  if (raw === undefined || raw === "") return 0;
  if (raw === "off" || raw === "none") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Wall-clock budget (ms) for one `dream --auto` sweep.
 *
 * NOT a pure movement (unlike every accessor above): the original inline read in
 * cli.ts was `Number(process.env.X ?? DEFAULT)`, which had two silent failure
 * modes — `""` slipped past `??` and became **0** (every scope skipped, run is a
 * no-op that still reports ok), and any non-numeric value became **NaN**, making
 * the `Date.now() > deadline` guard permanently false. The second one silently
 * reverts the very incident this budget exists to prevent: the 2026-07-24 sweep
 * ran 4d15h and blocked three days of scheduled runs. Both are corrected here
 * on purpose; do not "restore" the original parsing.
 *
 * Unset / empty / non-finite / <= 0 → caller's fallback.
 */
export const dreamBudgetMs = (fallbackMs: number): number => {
  const raw = process.env.RECALLNEST_DREAM_BUDGET_MS;
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
};

/**
 * dream 合成（cluster insight / cross-memory pattern）专用模型，覆盖 config.llm.model。
 *
 * 独立于全局模型的理由（2026-08-23）：合成是全库唯一一处「产物质量直接决定库的
 * 可用性」的 LLM 调用 —— 它写进去的东西会被当成记忆检索出来，而 ingest 侧的
 * smartExtract 只是给原文打标签，错了还能回原文。三臂实验里模型贡献了约 1/3 的
 * 改善（同提示词下 32.3% → 45.2%），把这一档单独抬上去，不必让全库调用一起涨价。
 *
 * 未设 / 空串 → 用 config.llm.model（即全局默认），保持老行为。
 */
export const synthesisModel = (): string | undefined => {
  const raw = process.env.RECALLNEST_SYNTHESIS_MODEL;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Per-request timeout (ms) for the embedding client, overriding `embedding.timeoutMs`
 * in config.json.
 *
 * Exists so the timeout can be set per deployment (the resident MCP server, a one-off
 * CLI ingest) without editing the shared config file — the same reason
 * `RECALLNEST_LAYER_ADMISSION` lives here.
 *
 * Unset / empty / non-finite / <= 0 → undefined, i.e. fall through to config.json and
 * ultimately to the SDK default. **Not setting it anywhere keeps the old behavior.**
 */
export const embeddingTimeoutMs = (): number | undefined => {
  const raw = process.env.RECALLNEST_EMBEDDING_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * 记忆文件对账（memory-reconcile.ts）单轮下架上限，覆盖默认的 max(300, 活跃文档切片数的 25%)。
 * 首轮存量清理用 `reconcile-memory --max-retire` 放行更合适；这个变量留给「某台部署想长期调严 / 调松」。
 * 未设 / 空 / 非有限数 / 负数 → undefined，走默认公式；0 是合法值（本部署只插入不下架）。
 */
export const memoryReconcileMaxRetire = (): number | undefined => {
  const raw = process.env.RECALLNEST_MEMORY_RECONCILE_MAX_RETIRE;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};

// --- Raw env values (caller validates / clamps / falls back to config) ---

export const recallModeRaw = (): string | undefined => process.env.RECALLNEST_RECALL_MODE;

export const uiPortRaw = (): string | undefined => process.env.RECALLNEST_UI_PORT;

export const apiPortRaw = (): string | undefined => process.env.RECALLNEST_API_PORT;

// --- Gateway (read-only front door; caller validates / clamps) ---

export const gatewayPortRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_PORT;

export const gatewayHostRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_HOST;

export const gatewayTokenRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_TOKEN;

export const gatewayRateMaxRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_RATE_MAX;

export const gatewayFileRootsRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_FILE_ROOTS;

export const gatewayRgRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_RG;

export const apiUrlRaw = (): string | undefined => process.env.RECALLNEST_API_URL;
