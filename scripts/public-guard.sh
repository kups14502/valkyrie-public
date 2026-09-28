#!/usr/bin/env bash
# Stops anything on the private denylist from reaching the public GitHub repo.
#
# The denylist holds the very names it protects (clients, employers, work
# accounts), so it lives outside the repo: $VALKYRIE_DENYLIST, default
# ~/.config/valkyrie/public-denylist.txt, one extended regex per line, matched
# case-insensitively, '#' lines ignored. No list means no push: it fails closed.
#
# What it reads: every text file in the tree being pushed, plus every commit
# that GitHub does not have yet (patch, message, author and committer), plus
# the messages of tags on the tip. A commit that adds a name and a later one
# that removes it still leaks the name, which is why commits are read too.
#
# Two ways in:
#   scripts/public-guard.sh [<tip>]     release.sh runs this before it tags
#   .git/hooks/pre-push                 ln -s ../../scripts/public-guard.sh .git/hooks/pre-push
set -euo pipefail

LIST="${VALKYRIE_DENYLIST:-$HOME/.config/valkyrie/public-denylist.txt}"
ZERO=0000000000000000000000000000000000000000

if [[ ! -s "$LIST" ]]; then
  echo "public-guard: no denylist at $LIST, refusing to publish" >&2
  exit 1
fi
PATTERNS="$(mktemp)"
trap 'rm -f "$PATTERNS"' EXIT
grep -vE '^\s*(#|$)' "$LIST" > "$PATTERNS" || true
if [[ ! -s "$PATTERNS" ]]; then
  echo "public-guard: $LIST has no patterns, refusing to publish" >&2
  exit 1
fi

HITS=0
check() { # <tip> <rev-list args...>
  local tip="$1"; shift
  local out
  if out="$(git grep -I -n -i -E -f "$PATTERNS" "$tip" -- . 2>/dev/null)"; then
    echo "public-guard: denylisted text in the tree at $(git rev-parse --short "$tip"):" >&2
    echo "$out" | head -40 >&2
    HITS=1
  fi
  if out="$(git log -p --format='commit %H%nAuthor: %an <%ae>%nCommitter: %cn <%ce>%n%n%B' "$@" \
      | grep -a -n -i -E -f "$PATTERNS")"; then
    echo "public-guard: denylisted text in commits not yet on GitHub:" >&2
    echo "$out" | head -40 >&2
    HITS=1
  fi
  if out="$(git for-each-ref --points-at "$tip" --format='%(refname:short): %(contents)' refs/tags \
      | grep -a -i -E -f "$PATTERNS")"; then
    echo "public-guard: denylisted text in a tag message:" >&2
    echo "$out" >&2
    HITS=1
  fi
}

if [[ "$(basename "$0")" == "pre-push" ]]; then
  REMOTE="${1:-origin}"
  while read -r _lref lsha _rref rsha; do
    [[ "$lsha" == "$ZERO" ]] && continue
    if [[ "$rsha" == "$ZERO" ]] || ! git cat-file -e "$rsha^{commit}" 2>/dev/null; then
      check "$lsha" "$lsha" --not --remotes="$REMOTE"
    else
      check "$lsha" "$rsha..$lsha"
    fi
  done
else
  TIP="${1:-HEAD}"
  BASE=""
  for ref in public/main origin/main; do
    if git rev-parse -q --verify "$ref" >/dev/null; then BASE="$ref"; break; fi
  done
  if [[ -n "$BASE" ]]; then
    check "$TIP" "$BASE..$TIP"
  else
    check "$TIP" "$TIP"
  fi
fi

if [[ "$HITS" -ne 0 ]]; then
  echo "public-guard: push refused. Move the text out of the repo or into an ignored config file." >&2
  exit 1
fi
echo "public-guard: clean" >&2
