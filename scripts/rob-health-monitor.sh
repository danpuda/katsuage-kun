#!/bin/bash
# rob-health-monitor.sh v2 — ロブ🦞フリーズ検知→Telegram即通知
# cron: * * * * * (毎分)
#
# 要件: memory/ops/ROB-CRASH-PATTERN-ANALYSIS.md
# 29件のINCから抽出した11パターンを検知
#
# カテゴリA: ロブのexec/設定ミス（INC-017,019,025,027,028,029）
# カテゴリB: コンパクション/コンテキスト系（INC-012,018,2/16,2/19）
# カテゴリC: 外部障害（INC-016,021,028,Discord 1005）
# カテゴリD: 通知系（INC-022,023,026）

set -euo pipefail

LOCKFILE="/tmp/rob-health-monitor.lock"
STATEFILE="/tmp/rob-health-monitor-last"
LOGFILE="/tmp/rob-health-monitor.log"
DEDUP_DIR="/tmp/rob-health-dedup"
DEDUP_MINUTES=10  # 同じパターンは10分間抑制
OPENCLAW="/home/yama/.nvm/versions/node/v22.22.0/bin/openclaw"
CHAT_ID="8596625967"

# flock排他
exec 9>"$LOCKFILE"
flock -n 9 || exit 0

mkdir -p "$DEDUP_DIR"

# 最終チェック時刻
if [ -f "$STATEFILE" ]; then
    SINCE=$(cat "$STATEFILE")
else
    SINCE=$(date -d '2 minutes ago' '+%Y-%m-%d %H:%M:%S')
fi
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "$NOW" > "$STATEFILE"

# Gatewayログ取得
LOGS=$(journalctl --user -u openclaw-gateway --since "$SINCE" --until "$NOW" --no-pager 2>/dev/null || true)
[ -z "$LOGS" ] && exit 0

# --- 検知関数 ---
ALERTS=""
ALERT_COUNT=0

check_pattern() {
    local pattern="$1"
    local severity="$2"  # 🔴 or 🟡
    local message="$3"
    local inc_ref="$4"
    local dedup_key="$5"
    
    local matches
    matches=$(echo "$LOGS" | grep -c "$pattern" 2>/dev/null || true)
    [ "$matches" -eq 0 ] && return
    
    # 重複抑制チェック
    local dedup_file="$DEDUP_DIR/$dedup_key"
    if [ -f "$dedup_file" ]; then
        local last_alert
        last_alert=$(cat "$dedup_file")
        local age
        age=$(( $(date +%s) - last_alert ))
        [ "$age" -lt $((DEDUP_MINUTES * 60)) ] && return
    fi
    
    # タイムスタンプ抽出
    local timestamp
    timestamp=$(echo "$LOGS" | grep "$pattern" | tail -1 | grep -oP '\d{2}:\d{2}:\d{2}' | head -1)
    
    ALERTS+="${severity} ${timestamp:-??:??} ${message}"
    [ -n "$inc_ref" ] && ALERTS+=" (${inc_ref})"
    ALERTS+=" [${matches}回]\n"
    ALERT_COUNT=$((ALERT_COUNT + 1))
    
    echo "$(date +%s)" > "$dedup_file"
}

# --- 11パターン検知 ---

# 🔴 HIGH (即通知)
# #1: exec タイムアウト (INC-029)
check_pattern "embedded run timeout" "🔴" \
    "execタイムアウト — ロブが長いsleepで固まった" "INC-029" "embedded-timeout"

# #2: セッション詰まり (2/16事故, INC-028)
check_pattern "lane wait exceeded" "🔴" \
    "セッション詰まり — レーンがロック状態" "INC-028" "lane-wait"

# #4: コンパクション失敗 (INC-018)
check_pattern "compaction-diag.*outcome=failed\|compaction.*timeout" "🔴" \
    "コンパクション失敗 — 17分フリーズの前兆" "INC-018" "compaction-fail"

# #6: ループ検知 (INC-017)
check_pattern "loop-detection\|loop.*breaker" "🔴" \
    "ループ検知 — 設定閾値が低すぎる可能性" "INC-017" "loop-detect"

# #8: 応答なし2分超え (INC-018)
check_pattern "typing TTL reached" "🔴" \
    "2分以上応答なし — コンパクション失敗兆候" "INC-018" "typing-ttl"

# #10: Gatewayクラッシュ (INC-028)
check_pattern "undici.*null\|unhandledRejection\|uncaughtException" "🔴" \
    "Gatewayクラッシュ — 自動再起動待ち" "INC-028" "gateway-crash"

# #11: ポート競合 (INC-016, INC-028)
check_pattern "EADDRINUSE\|address already in use" "🔴" \
    "ポート競合 — 二重起動の可能性" "INC-016" "port-conflict"

# 🟡 MED (まとめ通知)
# #3: APIプロバイダー接続切れ
check_pattern "Profile.*timed out" "🟡" \
    "APIプロバイダー接続切れ — 別アカウントに切替中" "" "profile-timeout"

# #5: Telegram/WA再接続
check_pattern "health-monitor.*restarting" "🟡" \
    "チャンネル再接続" "" "channel-restart"

# #7: Anthropic API障害 (INC-021)
check_pattern "overloaded" "🟡" \
    "Anthropic API障害 — 復旧待ち" "INC-021" "api-overloaded"

# #9: Telegram送信失敗 (INC-023)
check_pattern "Delivery failed\|delivery.*failed" "🟡" \
    "Telegram送信失敗 — 通知が届いてない" "INC-023" "delivery-fail"

# --- 結果処理 ---
[ "$ALERT_COUNT" -eq 0 ] && exit 0

# ログ記録
echo "$(date '+%Y-%m-%d %H:%M:%S') ⚠️ ${ALERT_COUNT}件検知" >> "$LOGFILE"

# 通知メッセージ組み立て
MSG="🔴 ロブ異常検知（${ALERT_COUNT}件）\n\n"
MSG+="$ALERTS"
MSG+="\n📋 対応:\n"
MSG+="1. ロブに話しかけて起きるか確認\n"
MSG+="2. 起きなければ: openclaw gateway restart\n"
MSG+="3. それでもダメ: openclaw reset --scope sessions"

# Telegram通知
"$OPENCLAW" message send \
    --channel telegram --target "$CHAT_ID" \
    --message "$(echo -e "$MSG")" 2>/dev/null || true

# system event（ロブ起床）
"$OPENCLAW" system event \
    --text "🔴 異常${ALERT_COUNT}件検知。journalctl確認しろ" \
    --mode now 2>/dev/null || true

echo "$(date '+%Y-%m-%d %H:%M:%S') ✅ 通知送信完了 (${ALERT_COUNT}件)" >> "$LOGFILE"
