#!/usr/bin/env bash
# One-command desktop release: auto-bumps the patch version from the latest
# app-v* tag (or takes an explicit version arg), generates release notes from
# the commits since that tag, and hands off to release.sh (which builds Linux +
# cross-builds Windows, signs, and publishes the GitHub Release + updater
# manifest). No GitHub Actions, $0.
#
# Usage:
#   scripts/ship.sh            # auto-bump patch (0.2.1 -> 0.2.2)
#   scripts/ship.sh 0.3.0      # explicit version (e.g. for a minor bump)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git fetch --tags --quiet origin || true
LATEST="$(git tag -l 'app-v*' | sed 's/^app-v//' | sort -V | tail -1)"
LATEST="${LATEST:-0.2.1}"

if [[ -n "${1:-}" ]]; then
  NEXT="$1"
else
  IFS=. read -r MA MI PA <<< "$LATEST"
  NEXT="${MA}.${MI}.$((PA + 1))"
fi

# Release notes = commit subjects since the last released tag (fallback: generic).
NOTES="$(git log "app-v${LATEST}..HEAD" --pretty=format:'- %s' 2>/dev/null | grep -v '^- ci:' | head -20 || true)"
[[ -z "$NOTES" ]] && NOTES="Maintenance update"
ONE_LINE="$(git log "app-v${LATEST}..HEAD" --pretty=format:'%s' 2>/dev/null | grep -v '^ci:' | head -1 || true)"
[[ -z "$ONE_LINE" ]] && ONE_LINE="Maintenance update"

echo "Latest released: v${LATEST}  →  shipping v${NEXT}"
echo "Notes:"; echo "$NOTES"; echo

export RELEASE_NOTES="$NOTES"
export MANIFEST_NOTES="$ONE_LINE"
exec "$ROOT/scripts/release.sh" "$NEXT"
