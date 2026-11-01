import { z } from "zod";

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * zod 3 的 `z.string().datetime()` 接受的写法，逐字照搬它的正则（zod 3.25.76 `datetimeRegex`，默认选项）：
 * 日期带闰年校验 + `T` + `HH:MM`，秒与小数秒可省，必须以 `Z` 结尾。zod 4 的 `z.iso.datetime()` 要求必须有秒，
 * 没有「秒可省」的选项；直接换过去会让 `2026-11-01T10:00Z` 这类旧写法的输入被拒、已落盘的 checkpoint /
 * conflict / skill 文件读不出来。
 */
const ZOD3_ISO_DATETIME =
  /^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z)$/;

/**
 * ISO 8601 UTC 时间字符串，接受范围与 zod 3 的 `z.string().datetime()` 相同、报错文字同为「Invalid datetime」。
 * JSON Schema 仍只写 `format: "date-time"`（用 refine 而不是 regex，tools/list 里不多出一长串 pattern）。
 */
export function isoDateTimeSchema() {
  return z.string()
    .refine((value) => ZOD3_ISO_DATETIME.test(value), { message: "Invalid datetime" })
    .meta({ format: "date-time" });
}

export function boundedStringSchema(field: string, maxLength: number) {
  return z.string({ error: (issue) => (issue.input === undefined ? `${field} is required` : undefined) })
    .transform(collapseWhitespace)
    .pipe(
      z.string()
        .min(1, `${field} is required`)
        .max(maxLength, `${field} must be at most ${maxLength} characters`),
    );
}

export function optionalBoundedStringSchema(maxLength: number) {
  return z.string()
    .transform(collapseWhitespace)
    .pipe(z.string().min(1).max(maxLength))
    .optional();
}

export function identifierSchema(field: string, maxLength = 160) {
  return z.string({ error: (issue) => (issue.input === undefined ? `${field} is required` : undefined) })
    .transform(collapseWhitespace)
    .pipe(
      z.string()
        .min(1, `${field} is required`)
        .max(maxLength, `${field} must be at most ${maxLength} characters`),
    );
}

export function normalizedStringListSchema(
  field: string,
  maxItems: number,
  maxItemLength: number,
) {
  return z.array(boundedStringSchema(field, maxItemLength))
    .default([])
    .transform((items) => {
      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }
      return deduped;
    })
    .pipe(
      z.array(z.string())
        .max(maxItems, `${field} must contain at most ${maxItems} items`),
    );
}
