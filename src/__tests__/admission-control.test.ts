import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import {
  admissionLength,
  checkAdmission,
  describeRejectionReason,
  resolveAdmissionConfig,
  ScopeRateLimiter,
} from "../admission-control.js";

// ---------------------------------------------------------------------------
// resolveAdmissionConfig
// ---------------------------------------------------------------------------

describe("resolveAdmissionConfig", () => {
  it("returns defaults when no overrides", () => {
    const cfg = resolveAdmissionConfig();
    expect(cfg.minTextLength).toBe(10);
    expect(cfg.noiseFilterEnabled).toBe(true);
    expect(cfg.minImportance).toBe(0.2);
    expect(cfg.maxWritesPerScope).toBe(50);
    expect(cfg.rateLimitWindowMs).toBe(60_000);
  });

  it("merges partial overrides", () => {
    const cfg = resolveAdmissionConfig({ minImportance: 0.5 });
    expect(cfg.minImportance).toBe(0.5);
    expect(cfg.minTextLength).toBe(10); // unchanged
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — text length
// ---------------------------------------------------------------------------

describe("checkAdmission — text length", () => {
  it("rejects text shorter than minTextLength", () => {
    const result = checkAdmission("short", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("text_too_short");
  });

  it("rejects empty text", () => {
    const result = checkAdmission("", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("text_too_short");
  });

  it("rejects whitespace-only text", () => {
    const result = checkAdmission("         ", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("text_too_short");
  });

  it("accepts text at exactly minTextLength", () => {
    const result = checkAdmission("abcdefghij", 0.8, "project:test");
    expect(result.verdict).toBe("accepted");
  });

  it("respects custom minTextLength", () => {
    const result = checkAdmission("hello world", 0.8, "project:test", undefined, { minTextLength: 20 });
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("text_too_short");
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — noise filter
// ---------------------------------------------------------------------------

describe("checkAdmission — noise filter", () => {
  it("rejects denial patterns", () => {
    const result = checkAdmission("I don't have any information about that topic", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("noise_detected");
  });

  it("rejects boilerplate greetings", () => {
    const result = checkAdmission("hello there!", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("noise_detected");
  });

  it("can be disabled via config", () => {
    const result = checkAdmission(
      "I don't have any information about that topic",
      0.8,
      "project:test",
      undefined,
      { noiseFilterEnabled: false },
    );
    expect(result.verdict).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — importance floor
// ---------------------------------------------------------------------------

describe("checkAdmission — importance floor", () => {
  it("rejects importance below default threshold (0.2)", () => {
    const result = checkAdmission("This is a valid memory text", 0.1, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("importance_too_low");
  });

  it("accepts importance at exactly the threshold", () => {
    const result = checkAdmission("This is a valid memory text", 0.2, "project:test");
    expect(result.verdict).toBe("accepted");
  });

  it("accepts importance above threshold", () => {
    const result = checkAdmission("This is a valid memory text", 0.8, "project:test");
    expect(result.verdict).toBe("accepted");
  });

  it("respects custom minImportance", () => {
    const result = checkAdmission("This is a valid memory text", 0.4, "project:test", undefined, { minImportance: 0.5 });
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("importance_too_low");
  });
});

// ---------------------------------------------------------------------------
// ScopeRateLimiter
// ---------------------------------------------------------------------------

describe("ScopeRateLimiter", () => {
  it("allows writes within limit", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig({ maxWritesPerScope: 3 });
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(true);
  });

  it("blocks writes exceeding limit", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig({ maxWritesPerScope: 2 });
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(false); // 3rd blocked
  });

  it("tracks scopes independently", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig({ maxWritesPerScope: 1 });
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s2", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(false); // s1 exhausted
    expect(limiter.check("s2", cfg)).toBe(false); // s2 exhausted
  });

  it("reports correct size", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig();
    limiter.check("a", cfg);
    limiter.check("b", cfg);
    expect(limiter.size).toBe(2);
  });

  it("clears all state", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig();
    limiter.check("a", cfg);
    limiter.clear();
    expect(limiter.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — rate limiting
// ---------------------------------------------------------------------------

describe("checkAdmission — rate limiting", () => {
  it("rejects when rate limit exceeded", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = { maxWritesPerScope: 2 } as const;
    // First two pass
    checkAdmission("valid memory text here", 0.8, "project:test", limiter, cfg);
    checkAdmission("another valid memory text", 0.8, "project:test", limiter, cfg);
    // Third is rate limited
    const result = checkAdmission("yet another valid text", 0.8, "project:test", limiter, cfg);
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("rate_limited");
  });

  it("skips rate limiting when no limiter provided", () => {
    const result = checkAdmission("valid memory text here", 0.8, "project:test");
    expect(result.verdict).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — happy path
// ---------------------------------------------------------------------------

describe("checkAdmission — happy path", () => {
  it("accepts valid memory with all checks passing", () => {
    const result = checkAdmission(
      "User prefers dark mode in all applications",
      0.8,
      "project:test",
    );
    expect(result.verdict).toBe("accepted");
    expect(result.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// admissionLength — CJK characters count as 2 units (task Z, 2026-11-01)
// ---------------------------------------------------------------------------

describe("checkAdmission — CJK-weighted minimum length", () => {
  // owner 定的五个样例：下限数字不动（10），改计数口径
  it("「我对花生过敏」(6 字 = 12) is accepted", () => {
    expect(checkAdmission("我对花生过敏", 0.8, "project:test")).toEqual({ verdict: "accepted" });
  });

  it("「我是左撇子」(5 字 = 10, exactly the floor) is accepted", () => {
    expect(checkAdmission("我是左撇子", 0.8, "project:test")).toEqual({ verdict: "accepted" });
  });

  it("「女儿生日是三月五号」(9 字 = 18) is accepted", () => {
    expect(checkAdmission("女儿生日是三月五号", 0.8, "project:test")).toEqual({ verdict: "accepted" });
  });

  it("「hi」(2) is still rejected as too short", () => {
    expect(checkAdmission("hi", 0.8, "project:test")).toEqual({ verdict: "rejected", reason: "text_too_short" });
  });

  it("「Alice likes tea」(15) is accepted, unchanged", () => {
    expect(checkAdmission("Alice likes tea", 0.8, "project:test")).toEqual({ verdict: "accepted" });
  });

  it("four CJK characters (8 units) are still too short", () => {
    expect(checkAdmission("我爱吃辣", 0.8, "project:test")).toEqual({ verdict: "rejected", reason: "text_too_short" });
  });

  it("CJK punctuation does not count double: 4 字 + 「。」 = 9 is rejected", () => {
    expect(checkAdmission("我爱吃辣。", 0.8, "project:test")).toEqual({ verdict: "rejected", reason: "text_too_short" });
  });

  it("short Chinese boilerplate that now clears the length floor is still caught by the noise filter", () => {
    expect(checkAdmission("好的好的好的", 0.8, "project:test")).toEqual({ verdict: "rejected", reason: "noise_detected" });
  });
});

describe("admissionLength", () => {
  it("counts ASCII as 1 per character", () => {
    expect(admissionLength("Alice likes tea")).toBe(15);
    expect(admissionLength("hi")).toBe(2);
  });

  it("counts Han, kana and Hangul as 2 per character", () => {
    expect(admissionLength("我是左撇子")).toBe(10);
    expect(admissionLength("ひらがな")).toBe(8);
    expect(admissionLength("カタカナ")).toBe(8);
    expect(admissionLength("한국어")).toBe(6);
  });

  it("counts CJK / fullwidth punctuation as 1", () => {
    expect(admissionLength("。，、！？「」")).toBe(7);
  });

  it("counts by code point: an Extension-B ideograph (surrogate pair) is 2, an emoji is 1", () => {
    expect(admissionLength("𠀀")).toBe(2);
    expect(admissionLength("🎉")).toBe(1);
  });

  it("mixed text adds up per character", () => {
    expect(admissionLength("用 Bun 跑")).toBe(2 + 1 + 3 + 1 + 2);
  });
});

describe("describeRejectionReason", () => {
  it("text_too_short says it is below the minimum length and how CJK is counted", () => {
    const text = describeRejectionReason("text_too_short");
    expect(text).toContain("below the minimum length of 10 units");
    expect(text).toContain("CJK characters count as 2");
    expect(text).not.toContain("noise");
  });
});

// ---------------------------------------------------------------------------
// Rate limiter is off by default: behaviour + source guard (task Z)
// ---------------------------------------------------------------------------

/**
 * 「每 scope 每分钟 50 条」只在调用方注入 ScopeRateLimiter 时生效，而生产入口一个都不传——
 * 文档已改成「可选注入、默认未启用」。下面两条一起防止有人悄悄接上（接上会改写入行为，要另议，
 * 届时连同这些用例与文档一起改）：
 *
 * 1. 行为：不传 limiter 连续调 checkAdmission 60 次（超过默认的 50），全部 accepted。
 *    这是「默认未启用」的直接证据——在 admission-control.ts 里藏一个模块级单例当默认值，源码守卫未必认得出，这条一定红。
 * 2. 源码守卫：扫 src/（不含测试）、scripts/、eval/ 下的 .ts，**admission-control.ts 也扫**，只豁免
 *    `rateLimiter?:` 这种可选字段 / 参数声明行；`//`、`/*`、`*` 开头的注释行跳过。以下任一出现就红：
 *    - `new ScopeRateLimiter`
 *    - `rateLimiter:` / `rateLimiter =` / `??=` / `||=` / `{ …, rateLimiter }` 简写
 *    - 带引号的属性：`deps["rateLimiter"]`、`"rateLimiter":`
 *    - checkAdmission 在 capture-engine.ts（转交 deps.rateLimiter）与 pivot-apply.ts（第 4 个参数写死 undefined）以外被调用
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src", "scripts", "eval"];

function productionSources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const rel of readdirSync(abs, { recursive: true, encoding: "utf8" })) {
      const path = `${dir}/${rel.split(sep).join("/")}`;
      if (!path.endsWith(".ts") || path.includes("/__tests__/") || path.includes("/node_modules/")) continue;
      out.push({ path, text: readFileSync(join(REPO_ROOT, path), "utf8") });
    }
  }
  return out;
}

/** 注释行与 `rateLimiter?:` 声明行去掉之后剩下的代码。 */
function codeLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false;
      if (/^(?:readonly\s+)?rateLimiter\?\s*:/.test(t)) return false;
      return true;
    })
    .join("\n");
}

/** 返回违规描述；空数组 = 没有接上限流器。 */
function rateLimiterWiring(path: string, text: string): string[] {
  const hits: string[] = [];
  const code = codeLines(text);
  if (/new\s+ScopeRateLimiter\b/.test(code)) hits.push(`${path}: constructs ScopeRateLimiter`);
  if (/\brateLimiter\s*(?::|\?\?=|\|\|=|=(?!=))/.test(code)) hits.push(`${path}: sets rateLimiter`);
  if (/[{,]\s*rateLimiter\s*[,}]/.test(code)) hits.push(`${path}: passes rateLimiter by shorthand`);
  if (/\[\s*["'`]rateLimiter["'`]\s*\]|["'`]rateLimiter["'`]\s*:/.test(code)) {
    hits.push(`${path}: uses a quoted rateLimiter property`);
  }
  const calls = [...code.matchAll(/(?<!function\s+)\bcheckAdmission\s*\(([^;]*?)\);/gs)].map((m) => m[1]);
  for (const args of calls) {
    if (path === "src/capture-engine.ts" && /deps\.rateLimiter\s*\?\?\s*undefined/.test(args)) continue;
    if (path === "src/pivot-apply.ts" && /^[^,]+,[^,]+,[^,]+,\s*undefined\s*,/.test(args)) continue;
    hits.push(`${path}: checkAdmission call not on the allowlist`);
  }
  return hits;
}

describe("rate limiter is off by default", () => {
  it("60 calls to checkAdmission without a limiter on one scope are all accepted (default cap is 50)", () => {
    const verdicts = Array.from({ length: 60 }, (_, i) =>
      checkAdmission(`distinct valid memory number ${i}`, 0.8, "project:rate-default").verdict,
    );
    expect(verdicts.filter((v) => v !== "accepted")).toEqual([]);
  });

  it("no production source (admission-control.ts included) constructs, passes or assigns a rate limiter", () => {
    const files = productionSources();
    // 扫描确实扫到了定义处和两个调用点，不是空跑
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining([
      "src/admission-control.ts", "src/capture-engine.ts", "src/pivot-apply.ts", "src/mcp-tools-core.ts",
    ]));
    expect(files.flatMap((f) => rateLimiterWiring(f.path, f.text))).toEqual([]);
  });

  it("the detector catches the ways it could be wired and skips declarations and comments (calibration)", () => {
    const caught = [
      "const l = new ScopeRateLimiter();",
      "const SHARED = new ScopeRateLimiter();\nexport function checkAdmission(text: string, rateLimiter: ScopeRateLimiter | undefined = SHARED) {}",
      "persistMemory({ store, embedder, rateLimiter: shared }, input);",
      "persistMemory({ store, rateLimiter }, input);",
      "deps.rateLimiter = limiter;",
      "rateLimiter ??= SHARED;",
      'deps["rateLimiter"] = limiter;',
      "persistMemory({ ...deps, ['rateLimiter']: limiter }, input);",
      'persistMemory({ "rateLimiter": limiter }, input);',
      "checkAdmission(text, 0.5, scope, limiter);",
    ];
    for (const snippet of caught) expect(rateLimiterWiring("src/x.ts", snippet)).not.toEqual([]);
    expect(rateLimiterWiring("src/pivot-apply.ts", "checkAdmission(text, imp, PIVOT_SCOPE, limiter, cfg);")).not.toEqual([]);

    const allowed = [
      "checkAdmission(text, imp, PIVOT_SCOPE, undefined, cfg);",
      "  rateLimiter?: ScopeRateLimiter | null;",
      "  rateLimiter?: ScopeRateLimiter,",
      "// e.g. persistMemory({ rateLimiter: new ScopeRateLimiter() }, input)",
      "/* rateLimiter: new ScopeRateLimiter() */",
      " * const limiter = new ScopeRateLimiter();",
      "export function checkAdmission(\n  text: string,\n  rateLimiter?: ScopeRateLimiter,\n): AdmissionResult {\n  const cfg = resolveAdmissionConfig(config);\n  if (rateLimiter && !rateLimiter.check(scope, cfg)) return REJECTED;\n}",
    ];
    for (const snippet of allowed) expect(rateLimiterWiring("src/pivot-apply.ts", snippet)).toEqual([]);
  });
});
