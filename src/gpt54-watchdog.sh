#!/bin/bash
# ============================================================
# GPT54 Watchdog 🔔 — ロブ起こしくん流用
# ============================================================
# /tmp/gpt54-latest をinotifywaitで監視
# ファイルが更新されたら openclaw agent でロブ🦞を起こす
# receiver通知のthrottleを補完する二重安全網
# ============================================================

set -euo pipefail

export PATH="/home/yama/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

WATCH_FILE="/tmp/gpt54-latest"
LOCK_FILE="/tmp/gpt54-watchdog.lock"
LOG_FILE="/tmp/gpt54-watchdog.log"
COOLDOWN_SECONDS=30  # 30秒に1回まで

# 排他ロック
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "$(date '+%H:%M:%S') already running" >> "$LOG_FILE"; exit 0; }

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE"
}

log "🔔 GPT54 Watchdog 起動"

LAST_NOTIFY=0

notify_rob() {
    local NOW
    NOW=$(date +%s)
    local ELAPSED=$((NOW - LAST_NOTIFY))

    if [ "$ELAPSED" -lt "$COOLDOWN_SECONDS" ]; then
        log "⏭ cooldown残 $((COOLDOWN_SECONDS - ELAPSED))秒"
        return
    fi

    # /tmp/gpt54-latest の中身を読む（1行目: ファイルパス）
    local RESPONSE_PATH
    RESPONSE_PATH=$(head -1 "$WATCH_FILE" 2>/dev/null || echo "")
    if [ -z "$RESPONSE_PATH" ] || [ ! -f "$RESPONSE_PATH" ]; then
        log "⏭ response file not found: $RESPONSE_PATH"
        return
    fi

    # テキスト長チェック（500文字未満はスキップ）
    local CHAR_COUNT
    CHAR_COUNT=$(wc -c < "$RESPONSE_PATH" 2>/dev/null || echo "0")
    if [ "$CHAR_COUNT" -lt 500 ]; then
        log "⏭ 短文スキップ: ${CHAR_COUNT}文字"
        return
    fi

    local BUNDLE_DIR
    BUNDLE_DIR=$(dirname "$RESPONSE_PATH")
    local BUNDLE_NAME
    BUNDLE_NAME=$(basename "$BUNDLE_DIR")

    log "🔔 ロブ🦞起床! bundle=$BUNDLE_NAME (${CHAR_COUNT}文字)"

    openclaw agent --agent main --deliver --channel telegram \
        --message "📥 😎GPT54 Watchdog: 新しい回答を検知。
cat $RESPONSE_PATH で中身を読め。
bundle: $BUNDLE_NAME" \
        --timeout 120 >> "$LOG_FILE" 2>&1 || log "⚠️ agent turn失敗"

    LAST_NOTIFY=$NOW
}

# inotifywaitが使えるか確認
if command -v inotifywait &>/dev/null; then
    log "📡 inotifywait監視モード"
    while true; do
        inotifywait -q -e modify -e create "$WATCH_FILE" 2>/dev/null || sleep 5
        sleep 2  # receiverの書き込み完了を待つ
        notify_rob
    done
else
    log "📡 polling監視モード (inotifywait未インストール)"
    LAST_MTIME=0
    while true; do
        if [ -f "$WATCH_FILE" ]; then
            MTIME=$(stat -c %Y "$WATCH_FILE" 2>/dev/null || echo "0")
            if [ "$MTIME" -gt "$LAST_MTIME" ]; then
                LAST_MTIME=$MTIME
                sleep 2
                notify_rob
            fi
        fi
        sleep 10  # 10秒ポーリング
    done
fi
