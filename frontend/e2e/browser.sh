#!/usr/bin/env bash
# The e2e suite's browser on odin: chrome-headless-shell on CDP 127.0.0.1:9333,
# no windows (the old headless shell has none). Installed once with
#   npx -y @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/chrome-headless-shell
# Usage: e2e/browser.sh        start it (no-op when it already answers)
#        e2e/browser.sh -stop  stop it
set -u
PROFILE="${E2E_PROFILE:-$HOME/.cache/valkyrie-e2e-shell}"
BIN="${E2E_CHS:-$(ls -d "$HOME"/.cache/chrome-headless-shell/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort -V | tail -1)}"

if [ "${1:-}" = "-stop" ]; then
  pkill -f -- "--user-data-dir=$PROFILE" && echo stopped || echo "not running"
  exit 0
fi
if curl -s -m 2 http://127.0.0.1:9333/json/version >/dev/null; then echo "already running"; exit 0; fi
if [ ! -x "$BIN" ]; then echo "chrome-headless-shell not installed (see the header)"; exit 1; fi
mkdir -p "$PROFILE"
setsid nohup "$BIN" --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --remote-allow-origins='*' \
  "--user-data-dir=$PROFILE" --no-first-run --no-default-browser-check --hide-scrollbars --mute-audio \
  --disable-gpu --renderer-process-limit=2 --no-sandbox about:blank >/dev/null 2>&1 < /dev/null &
for _ in $(seq 1 40); do
  curl -s -m 2 http://127.0.0.1:9333/json/version >/dev/null && { echo started; exit 0; }
  sleep 0.25
done
echo "did not come up on :9333"
exit 1
