#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/proxy.pid"
LOG_FILE="$LOG_DIR/proxy.out.log"

mkdir -p "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE")"
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "proxy is already running (pid: $OLD_PID)"
    exit 0
  fi
fi

nohup node "$ROOT_DIR/src/index.js" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "proxy started (pid: $NEW_PID)"
echo "log file: $LOG_FILE"
