#!/bin/bash
# RecallNest 增量更新脚本 — LaunchAgent 调用
# 只处理新增/修改的文件，已处理的自动跳过
# 超时保护：最多运行 2 小时，超时自动 kill

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load API key from .env (CLI also reads .env, this is for LaunchAgent)
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi
# 2026-08-16: 走系统代理。mini 直连 api.jina.ai 会撞 ERR_TLS_CERT_ALTNAME_INVALID（DNS 污染，时好时坏），
# 表现为 "Failed to generate embedding: Connection error"（08-15 ingest 日志实证）；bun fetch 遵守 HTTPS_PROXY。
if [ -r "$HOME/.proxy.env" ]; then
  set -a
  source "$HOME/.proxy.env"
  set +a
fi
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/ingest-$(date +%Y-%m-%d).log"

# 超时时间（秒）：2 小时 = 7200 秒
TIMEOUT=7200

# ── 失败报警(2026-09-17 加,mini 定时任务「失败不出声」统一排查;写法同 recallnest-backup.sh)──
# 此前超时 / 非零退出只 echo 进 $LOG_FILE,而脚本最后一句是 find,退出码永远是 find 的 0——launchd 与
# pull-from-macbook.sh(另一条调用入口,每天 4 次,L703)拿到的都是 0(stderr 里 7 次 Terminated: 15 对应的
# last exit 全是 0)。本次:超时与非零退出各发一条 TG,脚本以真实 $EXIT_CODE 退出。
# tg 发送失败只往 $LOG_FILE 记一行——本脚本的 stdout 不是日志(launchd 的 launchagent-stdout.log 至今 0 字节)。
# INGEST_ALERT_BY_CALLER=1(pull-from-macbook.sh 调用时传)→ 不发 TG,只记一行,由调用方汇总发;退出码语义不变。
# launchd 直接触发的 3 次/天不带这个变量,照旧自己发。(2026-09-17 owner 定「同一次 ingest 失败只发一条」)
NOTIFY="$HOME/Downloads/sync-bridge/scripts-bin/cobbler-notify.sh"
LOG_SHOW="~${LOG_FILE#"$HOME"}"
tg() {
  if [ "${INGEST_ALERT_BY_CALLER:-}" = "1" ]; then
    echo "报警由调用方(pull-from-macbook)发,本脚本不重复发" >> "$LOG_FILE"; return 0
  fi
  "$NOTIFY" "${1}" >/dev/null 2>&1 || echo "⚠ TG 报警发送失败(cobbler-notify 退出码 $?)" >> "$LOG_FILE"
}

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 增量更新开始 ===" >> "$LOG_FILE"

cd "$SCRIPT_DIR" || exit 1

# Minis 的目录在 ~/Desktop 下、走 iCloud，文件很可能只是占位符（读会报 EDEADLK）。
# brctl download 是异步的：2026-08-20 实测 download 后立刻读仍失败、下一轮才成功，
# 所以这里 download 完要等它真的落地，否则每天 3 点这一源都会静默读不到。
MINIS_DIR="$HOME/Desktop/minis-outbox/ingest"
if [ -d "$MINIS_DIR" ]; then
  for f in "$MINIS_DIR"/*.jsonl; do
    [ -e "$f" ] || continue
    brctl download "$f" 2>/dev/null || true
  done
  for f in "$MINIS_DIR"/*.jsonl; do
    [ -e "$f" ] || continue
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      head -c 1 "$f" >/dev/null 2>&1 && break
      sleep 1
    done
  done
fi


# 用 timeout 命令限制运行时间（macOS 需要 gtimeout 或用 perl 替代）
if command -v gtimeout &>/dev/null; then
  gtimeout "$TIMEOUT" bun run src/cli.ts ingest --source all >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
elif command -v timeout &>/dev/null; then
  timeout "$TIMEOUT" bun run src/cli.ts ingest --source all >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
else
  # macOS 没有 timeout，用后台进程 + kill 实现
  bun run src/cli.ts ingest --source all >> "$LOG_FILE" 2>&1 &
  INGEST_PID=$!

  # 监控进程
  ELAPSED=0
  while kill -0 "$INGEST_PID" 2>/dev/null; do
    sleep 60
    ELAPSED=$((ELAPSED + 60))
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
      echo "⚠️  $(date '+%H:%M:%S') 超时 ${TIMEOUT}s，强制终止进程 $INGEST_PID" >> "$LOG_FILE"
      kill "$INGEST_PID" 2>/dev/null
      sleep 5
      kill -9 "$INGEST_PID" 2>/dev/null
      EXIT_CODE=124
      break
    fi
  done

  if [ -z "$EXIT_CODE" ]; then
    wait "$INGEST_PID"
    EXIT_CODE=$?
  fi
fi

# 只保留最近 7 天的日志(2026-09-17 挪到判定之前:脚本最后一句必须是 exit,不能再让 find 的 0 顶掉真实退出码)
find "$LOG_DIR" -name "ingest-*.log" -mtime +7 -delete 2>/dev/null

if [ "$EXIT_CODE" -eq 124 ]; then
  echo "⚠️  $(date '+%Y-%m-%d %H:%M:%S') 增量更新超时（${TIMEOUT}s），已自动终止" >> "$LOG_FILE"
  tg "RecallNest ingest 超时 ${TIMEOUT}s 被终止@$(hostname -s),日志 $LOG_SHOW"
elif [ "$EXIT_CODE" -ne 0 ]; then
  echo "❌  $(date '+%Y-%m-%d %H:%M:%S') 增量更新异常退出（exit code: ${EXIT_CODE}）" >> "$LOG_FILE"
  tg "RecallNest ingest 异常退出 exit=${EXIT_CODE}@$(hostname -s),日志 $LOG_SHOW"
else
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') 增量更新完成 ===" >> "$LOG_FILE"
fi

echo "" >> "$LOG_FILE"

# 2026-09-17: 以真实退出码退出(124 = 超时),launchd 与 pull-from-macbook.sh 才看得见失败
exit "${EXIT_CODE:-1}"
