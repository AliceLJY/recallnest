import { createHash } from "node:crypto";

/**
 * 判重与对账共用的文本归一：去掉转录行首的「[用户]」「[助手]」标记，空白折叠。
 * （原定义在 ingest.ts，2026-09-24 挪到这里，免得 forget 引擎为一个五行函数载入整个导入模块；ingest.ts 原样再导出，行为不变。）
 */
export function normalizeDedupText(value: string): string {
  return value
    .replace(/^\[(用户|助手)\]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 已归一文本的指纹（sha256 前 16 位十六进制）。 */
export function fingerprintNormalized(norm: string): string {
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/**
 * 文本指纹：先归一再取指纹。forget 的审计事件记它（`norm=<指纹>`），记忆文件对账据此认出「被 forget 的是这段文字」，
 * 不管当时删的是同文的哪一行、原文空白差多少——只记 id 的话，删掉一行，同文的另一行照样会被恢复回来。
 */
export function textFingerprint(text: string): string {
  return fingerprintNormalized(normalizeDedupText(text));
}
