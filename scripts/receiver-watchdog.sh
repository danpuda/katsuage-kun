#!/bin/bash
# GPT54 Receiver v2 Watchdog (Bug #5, #10, #12 fixes)
# cron: */5 * * * * /home/yama/katsuage-kun/scripts/receiver-watchdog.sh

LOGFILE="/tmp/receiver-v2-watchdog.log"
SCRIPT="/home/yama/katsuage-kun/src/receiver_v2.py"
WORK_DIR="/home/yama/katsuage-kun"
LOCKFILE="/tmp/receiver-v2-watchdog.lock"
PIDFILE="/tmp/receiver-v2.pid"
OPENCLAW="/home/yama/.nvm/versions/node/v22.22.0/bin/openclaw"

# Bug #12 fix: prevent multiple watchdog instances
exec 9>"$LOCKFILE"
flock -n 9 || { echo "$(date '+%H:%M:%S') ⏭️ watchdog already running" >> "$LOGFILE"; exit 0; }

# Bug #5/#10 fix: use /health endpoint instead of just port check
if curl -sf --max-time 3 http://127.0.0.1:8854/health >/dev/null 2>&1; then
    exit 0
fi

# Receiver is down or unhealthy — restart
echo "$(date '+%Y-%m-%d %H:%M:%S') ⚠️ receiver v2 DOWN — restarting..." >> "$LOGFILE"

# Kill stale process if PID file exists
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE")
    kill "$OLD_PID" 2>/dev/null
    sleep 1
fi

cd "$WORK_DIR"
nohup python3 "$SCRIPT" >> /tmp/receiver_v2.log 2>&1 &
echo $! > "$PIDFILE"
sleep 2

if curl -sf --max-time 3 http://127.0.0.1:8854/health >/dev/null 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ✅ receiver v2 RECOVERED (PID $(cat $PIDFILE))" >> "$LOGFILE"
    "$OPENCLAW" message send \
        --channel telegram --target 8596625967 \
        --message "🔧 GPT54 Receiver v2がダウンしてたから自動復旧したよ！ ($(date '+%H:%M'))" 2>/dev/null || true
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') ❌ receiver v2 FAILED TO RESTART" >> "$LOGFILE"
    "$OPENCLAW" message send \
        --channel telegram --target 8596625967 \
        --message "🔴 GPT54 Receiver v2の再起動に失敗！手動確認して！" 2>/dev/null || true
fi
