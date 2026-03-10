#!/bin/bash
# GPT54 Receiver v2 Watchdog
# cron: */5 * * * * /home/yama/katsuage-kun/scripts/receiver-watchdog.sh

LOGFILE="/tmp/receiver-v2-watchdog.log"
SCRIPT="/home/yama/katsuage-kun/src/receiver_v2.py"
WORK_DIR="/home/yama/katsuage-kun"

if lsof -i :8854 >/dev/null 2>&1; then
    exit 0
fi

# 落ちてた → 再起動
echo "$(date '+%Y-%m-%d %H:%M:%S') ⚠️ receiver v2 DOWN — restarting..." >> "$LOGFILE"
cd "$WORK_DIR"
nohup python3 "$SCRIPT" >> /tmp/receiver_v2.log 2>&1 &
echo $! > /tmp/receiver-v2.pid
sleep 2

if lsof -i :8854 >/dev/null 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ✅ receiver v2 RECOVERED (PID $(cat /tmp/receiver-v2.pid))" >> "$LOGFILE"
    /home/yama/.nvm/versions/node/v22.22.0/bin/openclaw message send \
        --channel telegram --target 8596625967 \
        --message "🔧 GPT54 Receiver v2がダウンしてたから自動復旧したよ！ ($(date '+%H:%M'))" 2>/dev/null || true
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') ❌ receiver v2 FAILED TO RESTART" >> "$LOGFILE"
    /home/yama/.nvm/versions/node/v22.22.0/bin/openclaw message send \
        --channel telegram --target 8596625967 \
        --message "🔴 GPT54 Receiver v2の再起動に失敗！手動確認して！" 2>/dev/null || true
fi
