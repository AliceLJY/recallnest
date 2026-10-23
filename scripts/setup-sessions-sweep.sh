#!/bin/bash
# 安装 / 卸载 / 查看会话扫描的 LaunchAgent（com.recallnest.sessions-sweep，每 10 分钟一轮，P1 ④）
# 用法：bash scripts/setup-sessions-sweep.sh install | uninstall | status
#
# 前提：config.json 里显式配置了 sources.ledgers.path（账本落点）；没配时 install 拒绝（否则每轮都以 2 退出、30 分钟后报警）。
# 装完跑一次 `bun run src/cli.ts doctor`，看「Sessions sweep」那一行：心跳 ≤20 分钟是绿。
# 只在 macOS 上用（launchd）；仓库路径取本脚本所在仓库，plist 写 ~/Library/LaunchAgents/。

set -euo pipefail

LABEL="com.recallnest.sessions-sweep"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="${SESSIONS_SWEEP_PLIST_DIR:-$HOME/Library/LaunchAgents}/${LABEL}.plist"
INTERVAL="${SESSIONS_SWEEP_INTERVAL:-600}"
DOMAIN="gui/$(id -u)"

ledgers_configured() {
  (cd "$REPO" && bun -e '
    const { loadConfig } = await import("./src/runtime-config.ts");
    const s = loadConfig().sources?.ledgers;
    process.exit(s && s.path && s.path !== "auto" ? 0 : 1);
  ') >/dev/null 2>&1
}

write_plist() {
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${REPO}/scripts/sessions-sweep.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO}</string>
    <key>StartInterval</key>
    <integer>${INTERVAL}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${REPO}/logs/sessions-sweep-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${REPO}/logs/sessions-sweep-launchd.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>
EOF
}

case "${1:-}" in
  install)
    if ! ledgers_configured; then
      echo "❌ config.json 没有显式配置 sources.ledgers.path，不安装（例：\"ledgers\": {\"path\": \"~/Downloads/sync-bridge/cc-memory/ledgers\", \"glob\": \"**/*.md\", \"description\": \"会话账本\"}）"
      exit 2
    fi
    mkdir -p "$REPO/logs"
    write_plist
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "✅ 已安装 ${LABEL}（每 ${INTERVAL} 秒一轮）：$PLIST"
    echo "   验活：launchctl print $DOMAIN/$LABEL | grep -E 'state|last exit'；bun run src/cli.ts doctor"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    if [ -f "$PLIST" ]; then
      mkdir -p "$HOME/.Trash"
      mv "$PLIST" "$HOME/.Trash/${LABEL}.plist.$(date +%Y%m%d%H%M%S)"
    fi
    echo "已卸载 ${LABEL}（plist 移到废纸篓）。游标 data/session-state/ 与账本文件不动。"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|last exit code|run interval" || echo "未加载"
    ;;
  *)
    echo "用法：bash scripts/setup-sessions-sweep.sh install | uninstall | status"
    exit 2
    ;;
esac
