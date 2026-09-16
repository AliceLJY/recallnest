#!/bin/bash
# RecallNest dream-consolidation scheduled task
# 2026-06-11: P3 dream-pipeline 调度化落地(设计骨架 2026-05-27,见 DREAM_SCHEDULING_PLAN.md)
# dream 是 auto-gc / usageStatus 快照 / consolidation 的唯一生产触发点。
# fail-closed 护栏 + 瞬态失败重试 + 失败告警 + dry-run/force 策略 + last run state

set -e
cd "$(dirname "$0")/.."

# 2026-08-16: 走系统代理。mini 直连 api.jina.ai 会撞 ERR_TLS_CERT_ALTNAME_INVALID（DNS 污染，时好时坏），
# 表现为 "Failed to generate embedding: Connection error"（08-15 ingest 日志实证）；bun fetch 遵守 HTTPS_PROXY。
if [ -r "$HOME/.proxy.env" ]; then
  set -a
  source "$HOME/.proxy.env"
  set +a
fi

LOG_DIR="${HOME}/recallnest/logs"
mkdir -p "$LOG_DIR"

# ── 失败报警(2026-09-17 加,mini 定时任务「失败不出声」统一排查;写法同 recallnest-backup.sh)──
# 此前失败只弹 macOS 通知(osascript),mini 无显示器等于没发;本脚本只在 mini 跑,直接换成 TG。
# tg 自己永远返回 0(发送失败只记一行日志),不会被上面的 set -e 打死。
NOTIFY="$HOME/Downloads/sync-bridge/scripts-bin/cobbler-notify.sh"
tg() { "$NOTIFY" "${1}" >/dev/null 2>&1 || echo "⚠ TG 报警发送失败(cobbler-notify 退出码 $?)"; }

NOW=$(date '+%Y-%m-%d %H:%M:%S')

# dream --auto: 从 activity-counter 拉写计数达标(>= minWritesForDream)的所有 scope,逐个跑 dream
# (单 scope 失败不阻断其他)。per-scope 计数 = 每个活跃 scope 独立触发,不再全局单点。
#
# 2026-07-30: DREAM_SCOPE 从"仅供手动调试"的死变量(以前设了也没用——第 47 行硬编码 --auto)
# 接成真正的模式开关。动机:巨型 scope 需要独立排期,否则它一个人吃光 --auto 的 wall-clock
# 预算——07-30 那轮 6h 只跑完 15/507 个 scope,而 memory 一个占了全部记忆条数的 79%。
#   未设 DREAM_SCOPE  → --auto,日常轮次(com.recallnest.dream-consolidation,每天 04:00)
#   DREAM_SCOPE=<s>   → --scope <s> --exact-scope,专用轮次(com.recallnest.dream-memory-weekly,周日 12:00)
# 代码侧有两份名单,**语义不同别混**(dream-pipeline.ts 的 DreamConfig):
#   autoExcludeScopes  = 交给专用 schedule 跑(deferred,别处会跑) —— 当前 ["memory"],就是本 job
#   neverDreamScopes   = 根本不参与巩固(never,没有任何 job 会跑) —— 当前 ["memory:pivot"]
#
# 2026-08-16 补 --exact-scope:store 层对不含冒号的 scope 默认是**前缀**匹配,于是
# `--scope memory` 连 `memory:pivot`(手写提炼层)一起卷进同一轮聚类,实测已产生 14 条
# 来源横跨两个 scope 的 insight。别指望把 DREAM_SCOPE 写成 `memory:` 来绕开——那是精确
# 匹配一个不存在的 scope,命中 0 行、永久 noop,而 STATUS 照样报 ok,存在性闸也发现不了。
#
# Last run state (调度面调试 + 漏跑判断) 也按模式分开,否则两个 job 会互相盖掉对方的
# "上次跑成功"时间,漏跑判断直接失真。
# 2026-09-17 同样按模式分开的还有两样:TG 报警末行的日志路径(两个 job 的 plist 各自重定向到不同文件),
# 以及「连续 skip」状态文件(只有专用轮次才有,见末尾 skip 分支)。
if [ -n "${DREAM_SCOPE:-}" ]; then
    DREAM_ARGS="--scope $DREAM_SCOPE --exact-scope"
    MODE_LABEL="scope=$DREAM_SCOPE"
    LAST_RUN_FILE="${HOME}/recallnest/data/.last-dream-run-${DREAM_SCOPE}"
    LOG_SHOW="~/recallnest/logs/dream-memory-weekly-launchd.log(专用轮次)"
    SKIP_STREAK_FILE="${HOME}/recallnest/data/.dream-skip-streak-${DREAM_SCOPE}"
else
    DREAM_ARGS="--auto"
    # 这个字符串要和原来逐字一致:dream-checkup.sh 靠 "Dream consolidation starting" 起止行取耗时。
    MODE_LABEL="auto: 所有写计数达标的 scope"
    LAST_RUN_FILE="${HOME}/recallnest/data/.last-dream-run"
    LOG_SHOW="~/recallnest/logs/dream-consolidation-launchd.log"
    SKIP_STREAK_FILE=""
fi

# Dry-run mode: DREAM_DRY_RUN=1 ./dream-consolidation.sh
if [ "${DREAM_DRY_RUN:-0}" = "1" ]; then
    echo "[$NOW] DRY RUN — would invoke dream pipeline ($MODE_LABEL); skipping"
    exit 0
fi

# Force mode (skip min-writes gate): DREAM_FORCE=1
FORCE_FLAG=""
if [ "${DREAM_FORCE:-0}" = "1" ]; then
    FORCE_FLAG="--force"
    echo "[$NOW] FORCE mode — skipping min-writes gate"
fi

echo "[$NOW] Dream consolidation starting ($MODE_LABEL)"

DREAM_OUT=$(mktemp /tmp/rn-dream.XXXXXX)
trap "rm -f $DREAM_OUT" EXIT

DREAM_EXIT=1
STATUS_LINE=""
attempt=0
for attempt in 1 2 3; do
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] dream 尝试 $attempt/3"
    : > "$DREAM_OUT"

    "$HOME/.bun/bin/bun" run "$HOME/recallnest/src/cli.ts" dream $DREAM_ARGS $FORCE_FLAG 2>&1 | tee "$DREAM_OUT"
    DREAM_EXIT=${PIPESTATUS[0]}

    STATUS_LINE=$(grep -aoE '\[\[DREAM_STATUS\]\] (ok|blocked|skip)' "$DREAM_OUT" 2>/dev/null | tail -1)
    METRICS_LINE=$(grep -a '\[\[DREAM_METRICS\]\]' "$DREAM_OUT" 2>/dev/null | tail -1)

    # 2026-08-12 存在性闸：报了 ok 就必须同时报出产出计量。
    #
    # 防的不是「今天没产出」（合法的 noop 照样是 ok），而是「断言本身不在了」——
    # 某次重构把 METRICS 那行删掉 / 改名，而 status 照常报 ok，于是整套产出监控
    # 无声消失，跟它要治的 2716 次零 insight 是同一个病。
    #
    # 它不需要任何阈值，只问「这行在不在」，因此不会随数据分布漂移而误伤 ——
    # 同 hippo-wiki 装订器的空壳闸（只认 0 字节，不猜"过小"）。
    # 失败方向是安全的：改名而忘了同步这里，会天天红，不会静默绿。
    #
    # 2026-08-13 修复：下面两行原为 `| tee -a "$LOG_FILE"`，而 LOG_FILE 这个变量
    # 本脚本从未定义（只有 LOG_DIR）。`tee -a ""` 报 "No such file or directory" 并
    # 返回非 0，配合第 7 行的 `set -e` 直接把脚本打死在这里 —— 于是 08-11 起每一轮
    # dream 都拿不到收尾：没有「完成 status=ok」行、没写 .last-dream-run（停在 08-10）、
    # launchd 收到非 0 退出码，而 dream 本身其实跑成功了。典型的假红 + 记账断档。
    # 修法是直接 echo：stdout/stderr 本来就被 plist 重定向进同一个日志文件
    # （StandardOutPath = StandardErrorPath = dream-consolidation-launchd.log），
    # tee 到"日志文件"是重复写，本来就多余。
    if [ "$STATUS_LINE" = "[[DREAM_STATUS]] ok" ] && [ -z "$METRICS_LINE" ]; then
        echo "  [错误] STATUS=ok 但没有 [[DREAM_METRICS]] 行 —— 产出断言缺失，按失败处理"
        STATUS_LINE="[[DREAM_STATUS]] blocked"
        DREAM_EXIT=1
    fi
    [ -n "$METRICS_LINE" ] && echo "  $METRICS_LINE"

    if [ "$STATUS_LINE" = "[[DREAM_STATUS]] ok" ] || [ "$STATUS_LINE" = "[[DREAM_STATUS]] skip" ]; then
        break
    fi

    # 鉴权 / 网络瞬态错误重试 + 退避(同 weekly-distill 5-22 模式)
    #
    # 2026-07-29: 匹配范围必须限定在 "dream failed:" 之后的错误消息里,不能在整个输出上 grep。
    # 旧写法 `grep -qaiE "403|..." "$DREAM_OUT"` 会扫到达标 scope 列表——那里印着全部 scope ID
    # (十六进制),`cc:44036269` 的 "44036269" 含 "403" 子串 → 假命中 → 判定为瞬态错误 → 重跑
    # 全量 scope。07-24 那次就是这么跑了 4 天 15 小时的(三轮 11h→39h→61h,scope 数 395→404→451,
    # 重试跨天期间又攒出新 scope,越重试越多)。
    # 日志实证:07-18/19 匹配 0 次 → 只跑 1 轮;07-23/24 匹配 3/2 次 → 重试满 3 轮。
    # 概率:单个 8 位 hex ID 含 "403" 约 0.146%,475 个 ID 至少中一个约 50%——scope 越多越容易中。
    # 词表故意不扩:`lock ... timed out` 不匹配 "timeout" 是对的,重跑全量去重试一次锁竞争
    # 代价不成比例(该类失败改由 cli.ts 的失败分级消化)。
    if [ "$attempt" -lt 3 ] && grep -a "dream failed:" "$DREAM_OUT" 2>/dev/null \
        | sed 's/.*dream failed: //' \
        | grep -qaiE "403|ECONNRESET|timeout|Request not allowed"; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 瞬态失败,退避 30s 后重试..."
        sleep 30
    else
        break
    fi
done

# 2026-09-17: .last-dream-run 改为只在 ok / skip 两个成功分支写(原来在这里无条件写,失败那天照样更新,
# 拿它当「上次成功时间」会误判)。目前全仓只有本脚本自己引用它,改法对现有读者零影响。

echo ""
NOW_END=$(date '+%Y-%m-%d %H:%M:%S')
if [ "$STATUS_LINE" = "[[DREAM_STATUS]] ok" ]; then
    echo "$NOW" > "$LAST_RUN_FILE"
    if [ -n "$SKIP_STREAK_FILE" ]; then echo 0 > "$SKIP_STREAK_FILE"; fi
    echo "[$NOW_END] Dream consolidation 完成 status=ok (用了 $attempt 次)"
    exit 0
elif [ "$STATUS_LINE" = "[[DREAM_STATUS]] skip" ]; then
    echo "$NOW" > "$LAST_RUN_FILE"
    echo "[$NOW_END] Dream consolidation 跳过 status=skip(未达 min-writes 门槛)"
    # 2026-09-17 连续 skip 检测,只在专用轮次(DREAM_SCOPE 非空)做:精确匹配一个写错的 scope 会永远 skip、
    # exit 0、STATUS 照报 ok,存在性闸也发现不了(见上面 08-16 注释)。连着两周没干活 = 任务目的失效,
    # 按失败处理(TG + exit 1),不是提醒。daily 轮次的 skip 是 --auto 没有达标 scope,正常波动,不计不报。
    # 计数:skip +1、ok 归 0、blocked 不动(blocked 走下面的失败分支,自己会报)。
    if [ -n "$SKIP_STREAK_FILE" ]; then
        SKIP_N=$(cat "$SKIP_STREAK_FILE" 2>/dev/null || true)
        case "$SKIP_N" in ''|*[!0-9]*) SKIP_N=0 ;; esac
        SKIP_N=$((SKIP_N + 1))
        echo "$SKIP_N" > "$SKIP_STREAK_FILE"
        if [ "$SKIP_N" -ge 2 ]; then
            echo "[$NOW_END] ❌ 专用轮次已连续 ${SKIP_N} 次 skip,按任务目的失效处理(TG + exit 1)"
            tg "RecallNest dream 专用轮次(scope=$DREAM_SCOPE)已连续 ${SKIP_N} 周 skip@$(hostname -s)——检查 DREAM_SCOPE 值与写计数(scope 写错会永远 skip 且 STATUS 照报 ok);日志 $LOG_SHOW"
            exit 1
        fi
    fi
    exit 0
else
    # fail-closed 失败告警(2026-09-17: osascript 换成 TG——mini 无显示器,通知等于没发;本脚本只在 mini 跑)
    echo "[$NOW_END] ❌ Dream consolidation 失败 status='$STATUS_LINE' exit=$DREAM_EXIT"
    LAST_ERR=$(grep -a 'dream failed:' "$DREAM_OUT" 2>/dev/null | tail -1 | cut -c1-200 || true)
    [ -n "$LAST_ERR" ] || LAST_ERR="(输出里没有 dream failed 行)"
    tg "RecallNest dream 失败@$(hostname -s)（${MODE_LABEL}）status='${STATUS_LINE:-无}' exit=$DREAM_EXIT
最后一条错误: $LAST_ERR
日志 $LOG_SHOW"
    exit 1
fi
