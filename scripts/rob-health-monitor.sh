#!/bin/bash
# rob-health-monitor.sh — ロブ🦞フリーズ検知→Telegram即通知
# cron: * * * * * (毎分) or systemd timer
# 
# 検知パターン:
#   1. embedded run timeout — execが600秒タイムアウト
#   2. lane wait exceeded   — セッション詰まり
#   3. Profile timed out    — APIプロバイダータイムアウト
#   4. stale-socket         — Telegram接続断
#
# INC-029教訓: ロブが止まっても他は動く。でもやまちゃんに通知がないと気づけない

LOCKFILE="/tmp/rob-health-monitor.lock"
STATEFILE="/tmp/rob-health-monitor-last"
LOGFILE="/tmp/rob-health-monitor.log"
OPENCLAW="/home/yama/.nvm/versions/node/v22.22.0/bin/openclaw"
CHAT_ID="8596625967"

# flock排他（多重起動防止）
exec 9>"$LOCKFILE"
flock -n 9 || exit 0

# 最終チェック時刻（初回は5分前）
if [ -f "$STATEFILE" ]; then
    SINCE=$(cat "$STATEFILE")
else
    SINCE=$(date -d '5 minutes ago' '+%Y-%m-%d %H:%M:%S')
fi
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "$NOW" > "$STATEFILE"

# Gatewayログから異常パターン検索
ALERTS=$(journalctl --user -u openclaw-gateway --since "$SINCE" --until "$NOW" --no-pager 2>/dev/null | \
    grep -E "embedded run timeout|lane wait exceeded|Profile.*timed out|health-monitor.*restarting" | \
    head -5)

if [ -z "$ALERTS" ]; then
    exit 0
fi

# 各パターンを人間語に翻訳
MSG="🔴 ロブ異常検知\n"
ALERT_COUNT=0

while IFS= read -r line; do
    ALERT_COUNT=$((ALERT_COUNT + 1))
    TIMESTAMP=$(echo "$line" | grep -oP '\d{2}:\d{2}:\d{2}' | head -1)
    
    if echo "$line" | grep -q "embedded run timeout"; then
        MSG+="⏰ ${TIMESTAMP} execタイムアウト（600秒制限）— ロブが長いsleepで固まった可能性\n"
    elif echo "$line" | grep -q "lane wait exceeded"; then
        WAIT_MS=$(echo "$line" | grep -oP 'waitedMs=\K\d+')
        MSG+="🚧 ${TIMESTAMP} セッション詰まり（${WAIT_MS}ms待ち）— ロブが応答不能\n"
    elif echo "$line" | grep -q "Profile.*timed out"; then
        MSG+="🔌 ${TIMESTAMP} APIプロバイダー接続切れ — 別アカウントに切替中\n"
    elif echo "$line" | grep -q "health-monitor.*restarting"; then
        REASON=$(echo "$line" | grep -oP 'reason: \K\S+')
        MSG+="🔄 ${TIMESTAMP} Telegram再接続（理由: ${REASON}）\n"
    fi
done <<< "$ALERTS"

MSG+="\n📋 対応: ロブに話しかけて起きるか確認。起きなければ gateway restart"
MSG+="\n📂 詳細: journalctl --user -u openclaw-gateway --since '$SINCE'"

# ログ記録
echo "$(date '+%Y-%m-%d %H:%M:%S') ⚠️ ${ALERT_COUNT}件検知" >> "$LOGFILE"
echo "$ALERTS" >> "$LOGFILE"

# Telegram通知（やまちゃんに）
"$OPENCLAW" message send \
    --channel telegram --target "$CHAT_ID" \
    --message "$(echo -e "$MSG")" 2>/dev/null || true

# system event（ロブ起床用 — 起きられるなら自己修復のチャンス）
"$OPENCLAW" system event \
    --text "🔴 ロブ異常検知: ${ALERT_COUNT}件のアラート。journalctl確認しろ" \
    --mode now 2>/dev/null || true

echo "$(date '+%Y-%m-%d %H:%M:%S') ✅ 通知送信完了" >> "$LOGFILE"
