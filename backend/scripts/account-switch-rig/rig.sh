#!/bin/bash
# Throwaway rig on odin: fake API + Claude Code (fullscreen by default, like
# Valkyrie odin panes) in scratch dirs, on its own tmux socket ccsw-svc.
# Dummy tokens only. Never touches the valkyrie socket or ~/.claude.
set -e
umask 077
T=${T:-/tmp/ccsw-svc}
PORT=${PORT:-18791}
SOCK=ccsw-svc
HERE=$(cd "$(dirname "$0")" && pwd)
PANE=vk-00cc5e7700
case "$1" in
up)
  rm -rf "$T"
  mkdir -p "$T/cfg" "$T/store" "$T/work" "$T/sw/tokens"
  chmod 700 "$T" "$T/sw" "$T/sw/tokens"
  cp "$HERE/fakeapi.py" "$T/fakeapi.py"
  nohup python3 "$T/fakeapi.py" "$PORT" "$T/api.log" >/dev/null 2>&1 &
  echo $! > "$T/api.pid"
  python3 "$HERE/rigsetup.py" "$T" "$PORT"
  tmux -L $SOCK new-session -d -s $PANE -x 150 -y 40 "NOFLICKER=${NOFLICKER:-1} $T/run.sh; sleep 600"
  tmux -L $SOCK set-option -t $PANE @vk_host odin
  echo "rig up at $T"
  ;;
pane)
  tmux -L $SOCK kill-session -t $PANE 2>/dev/null || true
  tmux -L $SOCK new-session -d -s $PANE -x 150 -y 40 "NOFLICKER=${NOFLICKER:-1} $T/run.sh; sleep 600"
  tmux -L $SOCK set-option -t $PANE @vk_host odin
  echo "pane restarted"
  ;;
down)
  tmux -L $SOCK kill-server 2>/dev/null || true
  if [ -f "$T/api.pid" ]; then kill "$(cat "$T/api.pid")" 2>/dev/null || true; fi
  rm -rf "$T"
  echo "rig down"
  ;;
cap)
  tmux -L $SOCK capture-pane -p -J -t $PANE
  ;;
type)
  shift
  tmux -L $SOCK send-keys -t $PANE -l -- "$*"
  sleep 0.4
  tmux -L $SOCK send-keys -t $PANE Enter
  ;;
typeonly)
  shift
  tmux -L $SOCK send-keys -t $PANE -l -- "$*"
  ;;
esac
