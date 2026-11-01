/**
 * LME-8: Admission Control — 写入准入控制
 *
 * 在 capture-engine.ts 的 persistMemory 入口处执行写前门控，
 * 拦截低质量记忆，避免垃圾进库再过滤。
 *
 * 4 层准入检查：
 *   1. 最短文本长度 — 过短文本拒绝。按 admissionLength() 计：汉字 / 假名 / 谚文每个算 2 个单位，
 *      其余字符（按 code point）每个算 1 个，所以「我是左撇子」= 10 过线，「hi」= 2 仍被拒。
 *   2. Noise filter — 噪声模式前置过滤
 *   3. Importance 下限 — 低 importance 拒绝
 *   4. Scope 写入频率限制 — 防 flood。**只在调用方显式注入 `ScopeRateLimiter` 时才生效，默认未启用**：
 *      生产写入入口（MCP store_memory / batch_store / 其余写工具、HTTP、CLI、对话导入、
 *      session 提炼、pivot-apply）都不传 rateLimiter，所以「每 scope 每分钟 50 条」目前不限任何东西。
 *      `admission-control.test.ts` 有一条源码守卫钉住这一点；要接上属于改写入行为，另议。
 */

import { isNoise } from "./noise-filter.js";
import { logInfo } from "./stderr-log.js";

// ============================================================================
// Configuration
// ============================================================================

export interface AdmissionConfig {
  /** Minimum text length to accept, measured by admissionLength() (default: 10) */
  minTextLength: number;
  /** Enable noise-filter pre-check (default: true) */
  noiseFilterEnabled: boolean;
  /** Minimum importance to accept (default: 0.2) */
  minImportance: number;
  /**
   * Max writes per scope within the rate window (default: 50). Only enforced when the
   * caller injects a ScopeRateLimiter — no production entry point does (see file header).
   */
  maxWritesPerScope: number;
  /** Rate limit window in milliseconds (default: 60_000 = 1 minute) */
  rateLimitWindowMs: number;
}

const DEFAULT_CONFIG: AdmissionConfig = {
  minTextLength: 10,
  noiseFilterEnabled: true,
  minImportance: 0.2,
  maxWritesPerScope: 50,
  rateLimitWindowMs: 60_000,
};

export function resolveAdmissionConfig(
  overrides?: Partial<AdmissionConfig>,
): AdmissionConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ============================================================================
// Admission Result
// ============================================================================

export type AdmissionVerdict = "accepted" | "rejected";
export type RejectionReason =
  | "text_too_short"
  | "noise_detected"
  | "importance_too_low"
  | "rate_limited";

export interface AdmissionResult {
  verdict: AdmissionVerdict;
  reason?: RejectionReason;
}

const ACCEPTED: AdmissionResult = { verdict: "accepted" };

// ============================================================================
// Length measure — CJK counts double
// ============================================================================

/**
 * 汉字（含扩展区）、平假名、片假名、谚文按 2 个单位计。标点、全角符号不在这几个 script 里，
 * 照常按 1 计。用 Unicode script 属性而不是码位区间，扩展区与兼容区的汉字不会漏。
 */
const DOUBLE_WIDTH_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * 准入最短长度用的长度：汉字 / 假名 / 谚文每个 2，其余每个 code point 1。
 * 一个中文字承载的信息约等于两三个英文字母，按 UTF-16 计会把「我对花生过敏」这类短事实挡掉。
 * 按 code point 而不是 UTF-16 下标计：扩展区汉字（代理对）算一个字、2 个单位，emoji 算 1。
 */
export function admissionLength(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += DOUBLE_WIDTH_SCRIPT.test(ch) ? 2 : 1;
  }
  return units;
}

/**
 * 回执里给人看的拒绝原因说明。`reason` 枚举值照旧原样给出，这里只附一句话。
 * 数字取默认配置：会出回执的入口（store_memory / batch_store）都不覆盖准入配置。
 */
export function describeRejectionReason(reason: RejectionReason): string {
  switch (reason) {
    case "text_too_short":
      return `below the minimum length of ${DEFAULT_CONFIG.minTextLength} units; CJK characters count as 2, other characters as 1`;
    case "noise_detected":
      return "matched the noise filter (greeting, filler or boilerplate)";
    case "importance_too_low":
      return `importance below the floor of ${DEFAULT_CONFIG.minImportance}`;
    case "rate_limited":
      return "too many writes to this scope within the rate window";
  }
}

// ============================================================================
// Rate Limiter — per-scope write frequency tracking
// ============================================================================

export class ScopeRateLimiter {
  private readonly windows = new Map<string, number[]>();

  /**
   * Record a write for a scope and check if rate limit is exceeded.
   * Returns true if the write should be allowed.
   */
  check(scope: string, config: AdmissionConfig): boolean {
    const now = Date.now();
    const cutoff = now - config.rateLimitWindowMs;

    let timestamps = this.windows.get(scope);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(scope, timestamps);
    }

    // Prune expired timestamps
    const firstValid = timestamps.findIndex((t) => t >= cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1) {
      timestamps.length = 0;
    }

    if (timestamps.length >= config.maxWritesPerScope) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /** Number of scopes currently tracked. */
  get size(): number {
    return this.windows.size;
  }

  /** Clear all tracking state. */
  clear(): void {
    this.windows.clear();
  }
}

// ============================================================================
// Public API — admission gate
// ============================================================================

/**
 * Check whether a memory write should be admitted.
 * Call this at the top of persistMemory, before embedding.
 *
 * @param text       - Memory text to evaluate
 * @param importance - Importance score (0–1)
 * @param scope      - Target scope
 * @param rateLimiter - Optional shared rate limiter instance. Omitted → no rate limit,
 *                      which is what every production caller does today.
 * @param config     - Optional config overrides
 */
export function checkAdmission(
  text: string,
  importance: number,
  scope: string,
  rateLimiter?: ScopeRateLimiter,
  config?: Partial<AdmissionConfig>,
): AdmissionResult {
  const cfg = resolveAdmissionConfig(config);

  // Layer 1: minimum text length
  const trimmed = text.trim();
  const length = admissionLength(trimmed);
  if (length < cfg.minTextLength) {
    logInfo(`[admission-control] rejected: text too short (${length} < ${cfg.minTextLength} units)`);
    return { verdict: "rejected", reason: "text_too_short" };
  }

  // Layer 2: noise filter pre-check
  if (cfg.noiseFilterEnabled && isNoise(trimmed)) {
    logInfo(`[admission-control] rejected: noise detected`);
    return { verdict: "rejected", reason: "noise_detected" };
  }

  // Layer 3: importance floor
  if (importance < cfg.minImportance) {
    logInfo(`[admission-control] rejected: importance too low (${importance} < ${cfg.minImportance})`);
    return { verdict: "rejected", reason: "importance_too_low" };
  }

  // Layer 4: scope rate limiting
  if (rateLimiter && !rateLimiter.check(scope, cfg)) {
    logInfo(`[admission-control] rejected: rate limited for scope "${scope}"`);
    return { verdict: "rejected", reason: "rate_limited" };
  }

  return ACCEPTED;
}
