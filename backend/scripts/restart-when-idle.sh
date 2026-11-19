#!/usr/bin/env bash
# Restarts valkyrie-api only when no Raven or agent run is going: a restart kills
# every run in flight (a half-filled cart, a reply Brendon waits on).
# Waits up to MAX_WAIT seconds (default 900), then restarts anyway with a warning.
#   backend/scripts/restart-when-idle.sh            wait, then restart
#   MAX_WAIT=60 backend/scripts/restart-when-idle.sh
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
db="${VALKYRIE_DATA_DIR:-$here/data}/agents.sqlite"
max="${MAX_WAIT:-900}"
waited=0
busy() {
  [ -f "$db" ] || { echo 0; return; }
  # a run older than an hour is a leftover, not a live one
  sqlite3 -readonly "$db" "SELECT count(*) FROM runs WHERE status = 'running' AND startedAt > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 minutes');" 2>/dev/null || echo 0
}
while n="$(busy)"; [ "${n:-0}" -gt 0 ]; do
  if [ "$waited" -ge "$max" ]; then
    echo "restart-when-idle: still $n run(s) after ${max}s; restarting anyway" >&2
    break
  fi
  [ "$waited" -eq 0 ] && echo "restart-when-idle: waiting on $n run(s)..."
  sleep 5
  waited=$((waited + 5))
done
systemctl --user restart valkyrie-api
echo "restart-when-idle: restarted after ${waited}s"
