#!/usr/bin/env bash
# Idempotent setup for sncf-watch. Installs node deps + verifies Chrome can launch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Detect platform
OS="unknown"
case "$(uname -s)" in
  Linux*)
    if grep -qi microsoft /proc/version 2>/dev/null; then OS="wsl"; else OS="linux"; fi
    ;;
  Darwin*) OS="macos" ;;
esac
echo "[install] platform: $OS"

# Check node
if ! command -v node >/dev/null 2>&1; then
  echo "[install] ERROR: node is not installed. Install Node.js 18+ first."
  case "$OS" in
    wsl|linux) echo "  e.g. sudo apt-get install -y nodejs npm   # or use nvm" ;;
    macos) echo "  e.g. brew install node" ;;
  esac
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[install] ERROR: node $NODE_MAJOR is too old, need >= 18"
  exit 1
fi
echo "[install] node $(node -v)"

# Install puppeteer locally inside the skill dir
if [ ! -d "$SCRIPT_DIR/node_modules/puppeteer" ]; then
  echo "[install] installing puppeteer locally (will download bundled Chromium)..."
  ( cd "$SCRIPT_DIR" && npm init -y >/dev/null && npm install puppeteer --silent )
else
  echo "[install] puppeteer already installed"
fi

# On Linux/WSL, verify the bundled Chrome can find its libs
if [ "$OS" = "wsl" ] || [ "$OS" = "linux" ]; then
  CHROME_BIN="$(node -e "
    const p = require('puppeteer');
    try { console.log(p.executablePath()); } catch(e) { process.exit(1); }
  " 2>/dev/null || true)"
  if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
    echo "[install] WARN: could not resolve puppeteer's Chrome path"
  else
    echo "[install] chrome at: $CHROME_BIN"
    MISSING="$(ldd "$CHROME_BIN" 2>/dev/null | awk '/not found/ {print $1}' | sort -u || true)"
    if [ -n "$MISSING" ]; then
      echo "[install] missing shared libraries:"
      echo "$MISSING" | sed 's/^/    /'
      echo
      echo "[install] On Debian/Ubuntu, install them with:"
      # Best-guess mapping for the most common one
      if echo "$MISSING" | grep -q "libasound.so.2"; then
        echo "    sudo apt-get install -y libasound2t64"
      else
        echo "    sudo apt-get install -y \\"
        echo "      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \\"
        echo "      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \\"
        echo "      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64"
      fi
      echo
      echo "[install] Run that command, then re-run install.sh."
      exit 2
    fi
  fi
fi

echo "[install] OK"
