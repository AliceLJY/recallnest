/**
 * 「最短长度」的共用口径（2026-11-01，任务 Z）。
 *
 * 汉字（含扩展区与兼容区）、平假名、片假名、谚文每个算 2 个单位，其余每个 code point 算 1。
 * 一个中文字承载的信息约等于两三个英文字母，按 UTF-16 计会把「我对花生过敏」这类短事实挡掉。
 * 写入准入（admission-control）、稳定上下文选材（context-composer-stable-selection）、
 * KG 抽取的短文本门槛（kg-extractor）、pivot-apply 的输入 schema 都用这一个函数，
 * 能存进来的短事实不会在下游某一处又被另一种口径挡掉。
 *
 * - 用 Unicode script 属性而不是码位区间：扩展区、兼容区汉字不会漏；CJK 标点、全角数字、
 *   长音符「ー」属于 Common，按 1 计。
 * - 先做 NFC：谚文可能以 NFD（初声 + 中声 + 终声分开）到达，不归一会被数成两三倍。
 * - 按 code point 而不是 UTF-16 下标：扩展区汉字（代理对）算一个字、2 个单位，emoji 算 1。
 */

/**
 * 一条记忆正文的最短长度（按 weightedTextLength 计）：写入准入的默认下限、KG 抽取门槛、
 * pivot-apply 输入 schema 共用。
 */
export const MIN_MEMORY_TEXT_UNITS = 10;

const DOUBLE_WIDTH_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function weightedTextLength(text: string): number {
  let units = 0;
  for (const ch of text.normalize("NFC")) {
    units += DOUBLE_WIDTH_SCRIPT.test(ch) ? 2 : 1;
  }
  return units;
}
