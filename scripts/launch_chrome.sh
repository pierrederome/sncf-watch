#!/usr/bin/env bash
# Launch Chrome with --remote-debugging-port=9222. Reuses an isolated profile
# under ~/.sncf-watch/chrome-profile so cookies persist across runs.
# Idempotent: if the port is already serving Chrome, exits 0 immediately.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-9222}"
PROFILE="${SNCF_WATCH_PROFILE:-$HOME/.sncf-watch/chrome-profile}"
START_URL="${START_URL:-https://www.sncf-connect.com/}"
mkdir -p "$PROFILE"

# Already running?
if curl -sS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "[launch] Chrome already on port $PORT — reusing"
  exit 0
fi

# Resolve OS
OS="unknown"
case "$(uname -s)" in
  Linux*) if grep -qi microsoft /proc/version 2>/dev/null; then OS="wsl"; else OS="linux"; fi ;;
  Darwin*) OS="macos" ;;
esac

# Resolve Chrome binary via puppeteer (uses the bundled Chromium it downloaded)
CHROME_BIN="$(cd "$SCRIPT_DIR" && node -e "console.log(require('puppeteer').executablePath())")"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "[launch] ERROR: cannot find puppeteer's Chrome. Re-run install.sh first." >&2
  exit 1
fi
echo "[launch] platform=$OS chrome=$CHROME_BIN"

LOG="$HOME/.sncf-watch/chrome.log"
mkdir -p "$(dirname "$LOG")"

# On WSL: GUI shows via WSLg automatically (DISPLAY/$WAYLAND_DISPLAY pre-set).
# On Linux: needs an X session (assume the user has DISPLAY set).
# On macOS: launches a window normally.

# shellcheck disable=SC2086
nohup "$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --lang=fr-FR \
  --window-size=1400,950 \
  "$START_URL" \
  >"$LOG" 2>&1 &
disown
PID=$!
echo "[launch] started PID=$PID, waiting for debug endpoint..."

for i in $(seq 1 30); do
  sleep 1
  if curl -sS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "[launch] OK — debug endpoint live on port $PORT"
    exit 0
  fi
done

echo "[launch] ERROR: timed out waiting for Chrome debug endpoint. Check $LOG" >&2
tail -20 "$LOG" >&2 || true
exit 1
