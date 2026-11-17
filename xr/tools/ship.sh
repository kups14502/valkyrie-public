#!/bin/bash
# Build Valkyrie XR on odin and install it on the Steam Frame. Run from Git Bash on thor.
#   xr/tools/ship.sh           build the arm64 app, copy it to the headset, run install.sh
#   xr/tools/ship.sh build     build only; the binary lands in xr/build/
#   xr/tools/ship.sh check     headless parse and smoke run on odin (x86_64), no headset
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
remote="valkyrie-xr"
godot='$HOME/tools/godot/4.7.2/Godot_v4.7.2-stable_linux.x86_64'
what="${1:-ship}"

ssh -o BatchMode=yes odin "rm -rf ~/$remote/src ~/$remote/tools ~/$remote/frame && mkdir -p ~/$remote"
tar -czf - --exclude=.godot --exclude=build -C "$here" . | ssh -o BatchMode=yes odin "tar -xzf - -C ~/$remote"

run() { ssh -o BatchMode=yes odin "cd ~/$remote && $*"; }

# Import once so class_name scripts resolve.
run "timeout 120 $godot --headless --import >/tmp/$remote-import.log 2>&1 || { tail -20 /tmp/$remote-import.log; exit 1; }"
# The action map is generated, never hand-edited: make it fresh every build.
run "timeout 60 $godot --headless --script res://tools/make_action_map.gd"
scp -q -o BatchMode=yes "odin:$remote/openxr_action_map.tres" "$here/openxr_action_map.tres"
run "timeout 120 $godot --headless --import >/dev/null 2>&1"

if [ "$what" = check ]; then
  run "timeout 60 $godot --headless --check-only --script res://src/main.gd 2>&1 | grep -v '^Godot Engine' || true"
  run "timeout 20 $godot --headless --quit-after 300 2>&1 | grep -v '^Godot Engine' | head -40 || true"
  exit 0
fi

run "mkdir -p build && timeout 300 $godot --headless --export-release 'Linux arm64' build/valkyrie-xr.arm64 2>&1 | grep -iE 'error|warn|export' | grep -v 'savepack' | head -20; test -s build/valkyrie-xr.arm64"
mkdir -p "$here/build/valkyrie-xr"
scp -q -o BatchMode=yes "odin:$remote/build/valkyrie-xr.arm64" "$here/build/valkyrie-xr/valkyrie-xr.arm64"
cp "$here/frame/"* "$here/build/valkyrie-xr/"
ls -la "$here/build/valkyrie-xr"
[ "$what" = build ] && exit 0

powershell.exe -NoProfile -File 'C:\Thor\frame\frame.ps1' deploy "$(cygpath -w "$here/build/valkyrie-xr")" -Name valkyrie-xr
