#!/bin/bash
# GPT54 Receiver v5 Watchdog
# cron: */2 * * * * /home/yama/fx-backtest-v2/scripts/gpt54_receiver_watchdog.sh

PIDFILE="/tmp/gpt54-receiver-v5.pid"
LOGFILE="/tmp/gpt54-v5.log"
SCRIPT="/home/yama/fx-backtest-v2/scripts/gpt54_receiver_v5.py"

if lsof -i :8854 >/dev/null 2>&1; then
    exit 0
fi

# 落ちてた → 再起動
echo "$(date '+%Y-%m-%d %H:%M:%S') ⚠️ v5 server DOWN — restarting..." >> "$LOGFILE"
cd /home/yama/fx-backtest-v2
nohup python3 "$SCRIPT" >> "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
sleep 2

if lsof -i :8854 >/dev/null 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ✅ v5 server RECOVERED (PID $(cat $PIDFILE))" >> "$LOGFILE"
    # やまちゃんに通知
    openclaw notify "🔧 GPT54 Receiver v5がダウンしてたから自動復旧したよ！ ($(date '+%H:%M'))" 2>/dev/null || true
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') ❌ v5 server FAILED TO RESTART" >> "$LOGFILE"
    openclaw notify "🔴 GPT54 Receiver v5の再起動に失敗！手動確認して！" 2>/dev/null || true
fi
