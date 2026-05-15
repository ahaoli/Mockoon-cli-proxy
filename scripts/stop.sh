#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT_DIR/logs/proxy.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "proxy is not running (no pid file)"
  exit 0
fi

PID="$(cat "$PID_FILE")"

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "proxy stopped (pid: $PID)"
else
  echo "stale pid file found (pid: $PID), process not running"
fi

rm -f "$PID_FILE"
