/**
 * memory:pivot 写入必带字段的服务端保证（2026-11-03，「错误转脚本检查」第 1 条）。
 *
 * shared-behaviors §5.3 要求 pivot 每条必带 canonicalKey、`pinned`、`src:<sessionId 前 8 位>`、triggers。
 * 文字规则一直在漏：2026-10-15 起 808 次 pivot 写入里缺 key 47、缺 pinned 19、缺 src 58
 * （AI产出/2026-11-03-错误转脚本检查/候选清单.md 第 2 名）。真实坏样本：
 * session 08ef14a1（2026-09-04）两条 preferences 不带 canonicalKey；session 778f0856（2026-11-02）
 * 一条 eval 不带 src: 标签。
 *
 * 处理：缺 `pinned` 自动补（防 decay-engine 时间衰减）；缺 `src:` 时用当前会话 id 前 8 位补；
 * 缺 canonicalKey 拒写。triggers 维持回执里的提醒，不在这里管。
 * 关闭：环境变量 RECALLNEST_PIVOT_GUARD=off。
 */

export const PIVOT_GUARD_SCOPE = "memory:pivot";
const MAX_TAGS = 8;

export interface PivotGuardInput {
  scope: string;
  tags: readonly string[];
  canonicalKey?: string;
}

export type PivotGuardResult =
  | { ok: true; tags: string[]; notes: string[] }
  | { ok: false; error: string };

export function isPivotScope(scope: string): boolean {
  return scope === PIVOT_GUARD_SCOPE || scope.startsWith(`${PIVOT_GUARD_SCOPE}:`);
}

/** 当前会话 id：Claude Code 给子进程的环境变量，或手动指定的 RECALLNEST_SESSION_ID。 */
export function currentSessionId(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.RECALLNEST_SESSION_ID || env.CLAUDE_CODE_SESSION_ID;
  return raw && raw.trim() ? raw.trim() : undefined;
}

export function applyPivotWriteGuard(
  input: PivotGuardInput,
  opts: { sessionId?: string; env?: Record<string, string | undefined> } = {},
): PivotGuardResult {
  const env = opts.env ?? process.env;
  if (!isPivotScope(input.scope) || env.RECALLNEST_PIVOT_GUARD === "off") {
    return { ok: true, tags: [...input.tags], notes: [] };
  }

  if (!input.canonicalKey || !input.canonicalKey.trim()) {
    return {
      ok: false,
      error: [
        "Not stored: memory:pivot 写入必须带 canonicalKey（shared-behaviors §5.3）。",
        "理由：没有 key 的条目以后无法同 key 修订，只能再写一份重复的；2026-11-03 起由服务端拦（错误转脚本检查第 1 条，坏样本 session 08ef14a1）。",
        "改法：给这条判断起一个稳定 key（否决类用 rejected:<主题>）再存一次。",
      ].join("\n"),
    };
  }

  const tags = [...input.tags];
  const notes: string[] = [];
  if (!tags.includes("pinned")) {
    tags.unshift("pinned");
    notes.push("已自动补 pinned 标签（pivot 不补会按时间衰减，§5.3）");
  }
  if (!tags.some((t) => t.startsWith("src:"))) {
    const sid = opts.sessionId ?? currentSessionId(env);
    if (sid) {
      tags.push(`src:${sid.slice(0, 8)}`);
      notes.push(`已自动补 src:${sid.slice(0, 8)} 标签`);
    } else {
      notes.push("⚠️ 缺 src: 标签且拿不到当前会话 id，没法自动补；同 canonicalKey 再存一次并带上 src:<sessionId 前 8 位>");
    }
  }
  if (tags.length > MAX_TAGS) {
    // 自动补的两个标签优先保留，挤掉调用方给的最后几个
    const keep = new Set(tags.filter((t) => t === "pinned" || t.startsWith("src:")));
    const rest = tags.filter((t) => !keep.has(t)).slice(0, MAX_TAGS - keep.size);
    const dropped = tags.filter((t) => !keep.has(t) && !rest.includes(t));
    notes.push(`标签超过 ${MAX_TAGS} 个，丢掉了：${dropped.join(", ")}`);
    return { ok: true, tags: [...tags.filter((t) => keep.has(t)), ...rest], notes };
  }
  return { ok: true, tags, notes };
}
