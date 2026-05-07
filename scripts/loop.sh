#!/usr/bin/env bash
# Polling loop. Reads MAX_CORR / MAX_PRICE / INTERVAL / RUN_DIR from env.
# On match (poll.js exit 0), runs beep.sh and stops.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${INTERVAL:-300}"
MAX_CORR="${MAX_CORR:-1}"
MAX_PRICE="${MAX_PRICE:-9999}"
RUN_DIR="${RUN_DIR:-$HOME/.sncf-watch/runs/_default}"
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/loop.log"
export MAX_CORR MAX_PRICE RUN_DIR

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
echo "[$(stamp)] loop start interval=${INTERVAL}s MAX_CORR=${MAX_CORR} MAX_PRICE=${MAX_PRICE} RUN_DIR=${RUN_DIR}" >> "$LOG"

i=0
while true; do
  i=$((i+1))
  out="$(timeout 90 node "$SCRIPT_DIR/poll.js" 2>&1)"
  rc=$?
  echo "[$(stamp)] iter=$i rc=$rc $out" >> "$LOG"
  case $rc in
    0)
      echo "[$(stamp)] MATCH FOUND, beeping" >> "$LOG"
      bash "$SCRIPT_DIR/beep.sh" >/dev/null 2>&1 || true
      break
      ;;
    3)
      echo "[$(stamp)] WARN search state lost — retrying in 60s" >> "$LOG"
      sleep 60
      continue
      ;;
    1)
      echo "[$(stamp)] WARN poll error — retrying in $INTERVAL s" >> "$LOG"
      ;;
  esac
  sleep "$INTERVAL"
done
echo "[$(stamp)] loop end" >> "$LOG"
