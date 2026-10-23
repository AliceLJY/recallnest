#!/bin/bash
# RecallNest 会话扫描（P1 ④）— LaunchAgent com.recallnest.sessions-sweep 每 10 分钟调一次
# 一轮：扫 conversation-truth 里静默够久的会话 → 写/重写账本到 sources.ledgers.path（cc-memory/ledgers/YYYY-MM/<sid8>.md）。
# 上一轮没跑完时 CLI 自己按锁跳过（sessions-sweep）。心跳写 data/sessions-sweep-heartbeat.json，doctor 看它。
# 安装 / 卸载：scripts/setup-sessions-sweep.sh install | uninstall
#
# 失败报警（写法同 incremental-ingest.sh / 2026-09-17 实施规范）：单次失败（网络抖、LLM 429）不报，
# 连续 3 次失败（只数真正失败的轮次，锁忙与空轮不算也不清零）才发一条 TG，之后每再失败 18 次提醒一次；成功一轮清零。
# 失败轮以真实退出码结束；锁忙 / 空轮以 0 结束（launchd 不必看到它们）。

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR" || exit 1

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi
# 扫描专用的本机补充（.gitignore 已忽略 .env.*）：sessionsSweep.llm 用的 key 若不在 .env 里，在这里从别处派生，
# 例：export DEEPSEEK_API_KEY="$(set -a; . "$HOME/.config/xxx.env"; printf %s "$SOME_TOKEN")"——只写引用，不抄原值
if [ -f "$SCRIPT_DIR/.env.sessions-sweep" ]; then
  set -a
  source "$SCRIPT_DIR/.env.sessions-sweep"
  set +a
fi
# 走系统代理（同 incremental-ingest.sh：mini 直连 api.jina.ai 撞 DNS 污染）；已有 HTTPS_PROXY 就不再 source
if [ -z "${HTTPS_PROXY:-}" ] && [ -r "$HOME/.proxy.env" ]; then
  set -a
  source "$HOME/.proxy.env"
  set +a
fi
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/sessions-sweep-$(date +%Y-%m-%d).log"
STATE_FILE="$LOG_DIR/.sessions-sweep-failures"
NOTIFY="${SESSIONS_SWEEP_NOTIFY:-$HOME/Downloads/sync-bridge/scripts-bin/cobbler-notify.sh}"
LOG_SHOW="~${LOG_FILE#"$HOME"}"
tg() { "$NOTIFY" "${1}" >/dev/null 2>&1 || echo "⚠ TG 报警发送失败(cobbler-notify 退出码 $?)" >> "$LOG_FILE"; }

# 单轮超时 45 分钟（正常一轮几秒到几分钟；积压时 LLM 慢，锁保证不叠跑）
TIMEOUT="${SESSIONS_SWEEP_TIMEOUT:-2700}"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') sessions sweep ===" >> "$LOG_FILE"
bun run src/cli.ts sessions sweep >> "$LOG_FILE" 2>&1 &
PID=$!
( sleep "$TIMEOUT" && kill "$PID" 2>/dev/null ) &
WATCH=$!
wait "$PID"
EXIT_CODE=$?
kill "$WATCH" 2>/dev/null
wait "$WATCH" 2>/dev/null

# 退出码（cli.ts sessions sweep）：0 正常 → 清零；5 锁忙（上一轮还在跑）、6 本轮没调 LLM 但之前的 LLM 故障未恢复 →
# 既不算失败、也不清零（10 分钟一轮多数轮没事可做，空轮清零会让连续失败永远凑不齐）；其余（4 = LLM 全失败、崩溃、超时）计一次
case "$EXIT_CODE" in
  0)
    echo 0 > "$STATE_FILE"
    exit 0
    ;;
  5|6)
    exit 0
    ;;
esac

N=$(( $(cat "$STATE_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$N" > "$STATE_FILE"
echo "✗ 退出码 ${EXIT_CODE}（连续第 ${N} 轮失败）" >> "$LOG_FILE"
if [ "$N" -eq 3 ] || { [ "$N" -gt 3 ] && [ $(( (N - 3) % 18 )) -eq 0 ]; }; then
  tg "RecallNest 会话扫描连续 ${N} 轮失败@$(hostname -s)
• 最近一轮退出码 ${EXIT_CODE}
日志 ${LOG_SHOW}"
fi
exit "$EXIT_CODE"
