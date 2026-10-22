/**
 * 错误签名的「具体性」分档（plan.md v2.1 D4 / D5：只有具体性签名精确命中才注入）。
 *
 * 为什么要分档：`extractErrorSignatures` 抽出来的指纹里有一类几乎每个会话都会撞——`exit code 1`、
 * 裸的 `No such file or directory`、`command not found`、中文的「失败」「错误」。拿它们去精确匹配 cases，
 * 命中的是「上次也有个命令退出码 1」，不是「上次一模一样的坑」。D5 的报错召回只认 specific 档。
 *
 * 判据写死、零 LLM、读写两侧共用：
 *   - generic：裸退出码 / 裸 HTTP 状态 / 裸「not found / no such file / permission denied / failed」/ 太短 /
 *              去掉错误套话后没有任何可定位的记号
 *   - specific：剩下的——至少带一个「记号」：路径段、带点或下划线的标识符、CamelCase 错误名、引号里的东西、
 *               带数字的错误码（ENOENT / E401 / 0x…）、连字符参数名、中文里的专名（≥4 个连续汉字且不是套话）
 */

export type SignatureTier = "specific" | "generic";

const GENERIC_WHOLE = [
  /^exit (?:code|status)\s*[:=]?\s*\d+\s*$/i,
  /^(?:4\d\d|5\d\d)\s+[A-Za-z ]+$/,
  /^no such file or directory$/i,
  /^(?:[a-z]+\s+)?command not found$/i,
  /^permission denied$/i,
  /^(?:error|fatal|failed|exception)\s*:?\s*$/i,
  /^(?:失败|错误|报错|出错|异常)[:：]?$/,
];

const BOILERPLATE = /\b(error|errors|exception|fatal|failed|failure|fail|not|found|no|such|file|directory|command|cannot|can't|could|couldn't|is|are|was|be|to|the|a|an|of|in|on|at|for|with|required|must|invalid|unknown|missing|unable|exit|code|status|please|try|again|while|when|during|after|before|running|run|got|get|has|have|had|this|that|from|into|and|or|but|returned|return|request|response|occurred)\b/gi;
const TOKENS = [
  /\/[A-Za-z0-9_.-]+/, // 路径段
  /\b[A-Za-z][A-Za-z0-9]*[._-][A-Za-z0-9_.-]+\b/, // foo_bar / foo.bar / foo-bar
  /\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+\b/, // CamelCase
  /["'`「」『』][^"'`「」『』]{2,}["'`「」『』]/, // 引号里的东西
  /\b(?:E[A-Z]{3,}|E\d{2,}|0x[0-9a-f]+|[A-Z]{2,}_[A-Z_]+)\b/, // ENOENT / E401 / 0x1f / QUOTA_EXHAUSTED
  /--?[a-z][a-z0-9-]{2,}/, // 参数名
  /\b[A-Za-z]{3,}\d+\b/, // 带数字的名字：xmlsec1 / python3 / gpt4
  /\b\d{3,}\b.*\b[A-Za-z]{4,}\b|\b[A-Za-z]{4,}\b.*\b\d{3,}\b/, // 数字 + 词（如 429 Too Many Requests 之外的组合）
];

export function classifySignatureSpecificity(signature: string): SignatureTier {
  const s = signature.trim();
  if (s.length < 12) return "generic";
  if (GENERIC_WHOLE.some((re) => re.test(s))) return "generic";
  // 去掉套话后还剩多少「肉」
  const meat = s.replace(BOILERPLATE, " ").replace(/[^\p{L}\p{N}_./:'"`「」『』-]+/gu, " ").trim();
  if (meat.replace(/\s+/g, "").length < 6) return "generic";
  if (TOKENS.some((re) => re.test(s))) return "specific";
  // 中文：有 ≥4 个连续汉字且不是套话本身
  const han = s.match(/[一-鿿]{4,}/g) ?? [];
  if (han.some((h) => !/^(失败|错误|报错|出错|异常|请重试|无法|不能)/.test(h))) return "specific";
  // 英文：去套话后仍有两个以上 ≥4 字母的词，或一个 ≥6 字母的专名
  const words = meat.match(/[A-Za-z]{4,}/g) ?? [];
  return words.length >= 2 || words.some((w) => w.length >= 6) ? "specific" : "generic";
}

export function specificSignatures(signatures: readonly string[]): string[] {
  return signatures.filter((s) => classifySignatureSpecificity(s) === "specific");
}
