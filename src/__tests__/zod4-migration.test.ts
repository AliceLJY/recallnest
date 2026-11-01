/**
 * zod 3 → 4 迁移钉住的三件事。
 *
 * 1. 安全修复本身（GHSA-mrhx-c7xc-m3w5）：zod < 4.6.6 解析带上限的数组时先逐个解析每个元素、
 *    每个失败元素记一条 issue，超长输入能把内存吃光。4.6.6 起超过上限直接只报一条 too_big，
 *    元素一个都不解析。zod 3（以及 zod 4 包里的 `zod/v3` 兼容层）没有这道闸，退回去这里就红。
 * 2. `schema-utils` 里 `required_error` 改成 zod 4 的 `error` 函数之后，缺字段仍报「<field> is required」，
 *    类型不对时不冒充「is required」。
 * 3. `classifyError` 靠报错文字分类：zod 4 的枚举报错不再带「received」，补了 `invalid option` 之后
 *    仍归 invalid_input / peer。
 * 4. `isoDateTimeSchema()` 接受的写法与 zod 3 的 `z.string().datetime()` 完全相同（zod 4 的要求必须有秒）。
 *    下面的期望值是在 zod 3.25.76 上实跑 `z.string().datetime().safeParse()` 录下来的，不是手写的。
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { classifyError } from "../error-taxonomy.js";
import { boundedStringSchema, identifierSchema, isoDateTimeSchema, normalizedStringListSchema } from "../schema-utils.js";
import { SessionCheckpointInputSchema } from "../session-schema.js";

const OVERSIZED = 200_000;

describe("bounded collections fail fast (GHSA-mrhx-c7xc-m3w5)", () => {
  it("an oversized array of bad elements yields one too_big issue, not one issue per element", () => {
    const result = z.array(z.string()).max(500).safeParse(Array.from({ length: OVERSIZED }, () => 1));
    expect(result.success).toBe(false);
    expect(result.error?.issues.length).toBe(1);
    expect(result.error?.issues[0]?.code).toBe("too_big");
  });

  it("elements are not parsed at all once the upper bound is exceeded", () => {
    let parsed = 0;
    const schema = z.array(z.string().refine(() => ++parsed > 0)).max(2);
    expect(schema.safeParse(["a", "b", "c"]).success).toBe(false);
    expect(parsed).toBe(0);
  });

  it("a real tool-input schema (normalizedStringListSchema) gets the same gate", () => {
    // tags in store_memory etc.: max 8 items; oversized input of non-strings
    const schema = z.array(boundedStringSchema("tags", 64)).max(8);
    const result = schema.safeParse(Array.from({ length: OVERSIZED }, () => 1));
    expect(result.error?.issues.length).toBe(1);
    // the deduping list schema still enforces its own cap after the transform
    const list = normalizedStringListSchema("tags", 2, 64).safeParse(["a", "b", "c"]);
    expect(list.success).toBe(false);
    expect(list.error?.issues[0]?.message).toBe("tags must contain at most 2 items");
  });
});

describe("required message survives the required_error → error migration", () => {
  for (const [name, schema] of [
    ["boundedStringSchema", boundedStringSchema("text", 10)],
    ["identifierSchema", identifierSchema("id")],
  ] as const) {
    it(`${name}: missing field says "<field> is required"; a wrong type does not`, () => {
      const field = name === "boundedStringSchema" ? "text" : "id";
      const missing = z.object({ [field]: schema }).safeParse({});
      expect(missing.error?.issues.map((i) => i.message)).toEqual([`${field} is required`]);

      const blank = z.object({ [field]: schema }).safeParse({ [field]: "   " });
      expect(blank.error?.issues.map((i) => i.message)).toEqual([`${field} is required`]);

      const wrongType = z.object({ [field]: schema }).safeParse({ [field]: 42 });
      expect(wrongType.success).toBe(false);
      expect(wrongType.error?.issues[0]?.message).not.toContain("is required");
      expect(wrongType.error?.issues[0]?.code).toBe("invalid_type");
    });
  }
});

describe("classifyError still treats zod validation failures as caller input", () => {
  function zodError(fn: () => unknown): unknown {
    try {
      fn();
    } catch (err) {
      return err;
    }
    throw new Error("expected the parse to throw");
  }

  it("enum mismatch → invalid_input / peer", () => {
    const err = zodError(() => z.object({ category: z.enum(["profile", "events"]) }).parse({ category: "nope" }));
    expect(classifyError(err)).toEqual({ reasonCode: "invalid_input", retryable: false, responsibility: "peer" });
  });

  it("type mismatch → invalid_input / peer", () => {
    const err = zodError(() => z.object({ limit: z.number() }).parse({ limit: "ten" }));
    expect(classifyError(err).reasonCode).toBe("invalid_input");
  });
});

describe("isoDateTimeSchema accepts exactly what zod 3's z.string().datetime() accepted", () => {
  // recorded on zod 3.25.76
  const ZOD3_RESULTS: Array<[string, boolean]> = [
    ["2026-11-01T10:00:00Z", true],
    ["2026-11-01T10:00:00.123Z", true],
    ["2026-11-01T10:00:00.123456789Z", true],
    ["2026-11-01T10:00Z", true],
    ["2024-02-29T00:00Z", true],
    ["2023-02-29T00:00:00Z", false],
    ["2026-02-30T10:00:00Z", false],
    ["2026-04-31T10:00:00Z", false],
    ["2026-11-01T24:00:00Z", false],
    ["2026-11-01T10:60:00Z", false],
    ["2026-11-01T10:00:00+08:00", false],
    ["2026-11-01T10:00:00", false],
    ["2026-11-01 10:00:00Z", false],
    ["2026-11-01T10:00:00z", false],
    ["2026-11-01", false],
    ["", false],
    ["2026-11-01T10:00:00.Z", false],
    ["2000-02-29T12:00Z", true],
    ["1900-02-29T12:00Z", false],
  ];

  for (const [input, accepted] of ZOD3_RESULTS) {
    it(`${JSON.stringify(input)} → ${accepted ? "accepted" : "rejected"}`, () => {
      expect(isoDateTimeSchema().safeParse(input).success).toBe(accepted);
    });
  }

  it("keeps zod 3's error message", () => {
    expect(isoDateTimeSchema().safeParse("nope").error?.issues[0]?.message).toBe("Invalid datetime");
  });

  it("a stored checkpoint whose updatedAt has no seconds still loads", () => {
    const parsed = SessionCheckpointInputSchema.safeParse({
      sessionId: "s-1",
      summary: "minute-precision override written before the zod 4 upgrade",
      updatedAt: "2026-10-30T08:15Z",
    });
    expect(parsed.success).toBe(true);
  });
});
