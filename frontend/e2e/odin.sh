#!/usr/bin/env bash
# Runs the e2e suite ON ODIN with this working tree, so thor's memory stays free
# (2026-10-19: thor's background test runs were being stopped for low memory
# while Brendon played). From frontend/ on thor:
#
#   bash e2e/odin.sh                       the full suite
#   bash e2e/odin.sh --group hosts,lights  any run.mjs arguments
#   bash e2e/odin.sh --stop                stop odin's probe and browser
#
# It copies this frontend's tracked and new files (not lab/, not the untracked
# vite configs) into odin's ~/valkyrie-e2e/frontend, makes sure odin's read-only
# probe (:5197, proxying to the backend on odin's loopback) and headless browser
# (:9333) run, then runs node e2e/run.mjs there and prints its output.
# Screenshots a run writes stay on odin under ~/valkyrie-e2e/frontend.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--stop" ]; then
  ssh -o BatchMode=yes odin 'bash ~/valkyrie-e2e/e2e-up.sh --stop'
  exit 0
fi

git ls-files -co --exclude-standard -- . \
  | grep -v -E '^(lab/|vite\.v2probe\.config\.ts$|vite\.frame\.config\.ts$)' \
  | tar -czf - -T - \
  | ssh -o BatchMode=yes odin 'cd ~/valkyrie-e2e/frontend && rm -rf src e2e public && tar -xzf -'
# the backend's code too: the chat contract tests build pages with the server's own parser
( cd .. && git ls-files -co --exclude-standard -- backend/src backend/scripts backend/package.json backend/tsconfig.json \
  | tar -czf - -T - ) \
  | ssh -o BatchMode=yes odin 'cd ~/valkyrie-e2e && rm -rf backend/src backend/scripts && tar -xzf - && { [ -e backend/node_modules ] || ln -s ~/valkyrie/backend/node_modules backend/node_modules; }'
ssh -o BatchMode=yes odin 'bash ~/valkyrie-e2e/e2e-up.sh'
args=""
for a in "$@"; do args="$args '${a//\'/\'\\\'\'}'"; done
ssh -o BatchMode=yes odin "cd ~/valkyrie-e2e/frontend && node e2e/run.mjs $args"
