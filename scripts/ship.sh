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
# They go to the GitHub release, which only signed-in viewers of the repo see.
NOTES="$(git log "app-v${LATEST}..HEAD" --pretty=format:'- %s' 2>/dev/null | grep -v '^- ci:' | head -20 || true)"
[[ -z "$NOTES" ]] && NOTES="Maintenance update"

# The updater manifest's one line is served to anyone who asks, so it never
# names a private feature: subjects whose prefix or words are on the private
# list (VALKYRIE_PUBLIC_WORDS, kept outside the repo; see
# public-export/README.md) are skipped. Without the list, or with one that does
# not load cleanly (public-export/lib.sh), it says only the version.
WORDS="${VALKYRIE_PUBLIC_WORDS:-$HOME/.config/valkyrie/public-words.txt}"
keep() { # <in> <out> <grep args...>: the lines of <in> that do not match; 1 when grep itself fails
  local in="$1" out="$2" rc=0
  shift 2
  grep -v "$@" "$in" > "$out" || rc=$?
  [[ "$rc" -le 1 ]]
}
public_note() { # <words dir>: the newest subject that names nothing private
  local d="$1" pre
  git log "app-v${LATEST}..HEAD" --pretty=format:'%s' > "$d/s0" 2>/dev/null || true
  keep "$d/s0" "$d/s1" -E '^ci:' || return 1
  pre="$(paste -sd'|' "$d/prefix")"
  if [[ -n "$pre" ]]; then keep "$d/s1" "$d/s2" -i -E "^($pre)([:( ]|$)" || return 1; else cp "$d/s1" "$d/s2"; fi
  keep "$d/s2" "$d/s3" -i -E -f "$d/ci" || return 1
  keep "$d/s3" "$d/s4" -E -f "$d/cs" || return 1
  head -n 1 "$d/s4"
}
ONE_LINE="Valkyrie v${NEXT}"
if [[ -f "$ROOT/public-export/lib.sh" ]]; then
  # shellcheck source=public-export/lib.sh
  source "$ROOT/public-export/lib.sh"
  W="$(mktemp -d)"
  if WHY="$(words_load "$WORDS" "$W")"; then
    if NOTE="$(public_note "$W")"; then
      ONE_LINE="${NOTE:-Maintenance update}"
    else
      echo "updater note: a search with the words list failed, so it says only the version" >&2
    fi
  else
    echo "updater note: $WHY, so it says only the version" >&2
  fi
  rm -rf "$W"
fi

echo "Latest released: v${LATEST}  →  shipping v${NEXT}"
echo "Notes:"; echo "$NOTES"; echo

export RELEASE_NOTES="$NOTES"
export MANIFEST_NOTES="$ONE_LINE"
exec "$ROOT/scripts/release.sh" "$NEXT"
