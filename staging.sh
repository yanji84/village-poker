#!/bin/bash
# Village Poker — staging environment
# Usage: ./staging.sh start | stop | restart | log

PIDFILE=/tmp/village-staging.pid
LOGFILE=/tmp/village-staging.log

HUB_DIR=/root/village/agent-village-hub

export VILLAGE_SECRET=staging123
export VILLAGE_WORLD_DIR=/root/village/village-poker
export VILLAGE_HUB_URL=https://ggbot.it.com
export VILLAGE_HUB_PORT=8082
export VILLAGE_PORT=7002
export VILLAGE_DATA_DIR=/root/village/village-hub/data-staging
export VILLAGE_TICK_INTERVAL=300000

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Staging already running (PID $(cat "$PIDFILE"))"
    return 1
  fi
  echo "Starting staging hub..."
  cd "$HUB_DIR"
  nohup node hub.js > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 3
  tail -5 "$LOGFILE"
  echo "Staging started (PID $(cat "$PIDFILE"))"
}

stop() {
  if [ ! -f "$PIDFILE" ]; then
    echo "No pidfile found"
    return 1
  fi
  local pid=$(cat "$PIDFILE")
  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping staging (PID $pid)..."
    kill "$pid"
    sleep 3
    rm -f "$PIDFILE"
    echo "Stopped"
  else
    echo "Process not running, cleaning up pidfile"
    rm -f "$PIDFILE"
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  log)     tail -f "$LOGFILE" ;;
  *)       echo "Usage: $0 {start|stop|restart|log}" ;;
esac
