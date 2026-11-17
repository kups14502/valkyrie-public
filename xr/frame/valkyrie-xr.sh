#!/bin/sh
# Valkyrie XR launcher on the Steam Frame. Starts the offscreen Chromium the panels
# render in, then the VR app, and stops that Chromium when the app exits.
# Extra arguments go to the app, for example: valkyrie-xr.sh --panels=front
# Steam passes none, so ~/.config/valkyrie-xr/args (one line) adds them there,
# for example --base=http://localhost:5180 for the vite dev server.
dir="$HOME/apps/valkyrie-xr"
state="$HOME/.local/state/valkyrie-xr"
args_file="$HOME/.config/valkyrie-xr/args"
if [ -f "$args_file" ]; then
  # shellcheck disable=SC2046
  set -- $(cat "$args_file") "$@"
fi
profile="$HOME/.var/app/org.chromium.Chromium/config/valkyrie-xr"
port=9233
mkdir -p "$state" "$profile"

# A Chromium left over from a crash would hold the port and the profile lock.
pkill -f "remote-debugging-port=[9]233" 2>/dev/null
sleep 0.5

flatpak run org.chromium.Chromium \
  --headless=new \
  --remote-debugging-port=$port \
  --user-data-dir="$profile" \
  --proxy-server=socks5://127.0.0.1:1055 \
  --no-first-run --no-default-browser-check \
  --hide-scrollbars --mute-audio \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  about:blank > "$state/chromium.log" 2>&1 &

stop_browser() { pkill -f "remote-debugging-port=[9]233" 2>/dev/null; }
trap stop_browser EXIT INT TERM

[ -f "$state/xr.log" ] && mv -f "$state/xr.log" "$state/xr.prev.log"
"$dir/valkyrie-xr.arm64" -- "$@" > "$state/xr.log" 2>&1
