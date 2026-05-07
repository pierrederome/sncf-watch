#!/usr/bin/env bash
# Cross-platform alert beep — repeat 6 times.
set -u
COUNT="${COUNT:-6}"

beep_one() {
  if grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -Command "[console]::beep(900,400); Start-Sleep -Milliseconds 150; [console]::beep(1200,400)" >/dev/null 2>&1
  elif [ "$(uname -s)" = "Darwin" ]; then
    afplay /System/Library/Sounds/Ping.aiff 2>/dev/null
    afplay /System/Library/Sounds/Glass.aiff 2>/dev/null
  elif command -v paplay >/dev/null 2>&1; then
    paplay /usr/share/sounds/freedesktop/stereo/bell.oga 2>/dev/null \
      || paplay /usr/share/sounds/alsa/Front_Center.wav 2>/dev/null \
      || printf '\a'
  else
    printf '\a'
  fi
}

for i in $(seq 1 "$COUNT"); do
  beep_one || true
  sleep 0.6
done
