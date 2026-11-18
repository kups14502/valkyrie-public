#!/usr/bin/env bash
# Stops anything on the private denylist from reaching the public GitHub repo.
#
# The denylist holds the very names it protects (clients, employers, work
# accounts), so it lives outside the repo: $VALKYRIE_DENYLIST, default
# ~/.config/valkyrie/public-denylist.txt, one extended regex per line, matched
# case-insensitively, '#' lines ignored. No list means no push: it fails closed,
# and so does a list with CR line endings or a pattern that does not compile
# or matches an empty line (it would check nothing, or everything).
#
# What it reads: every text file in the tree being pushed, plus every commit
# that GitHub does not have yet (patch, message, author and committer), plus
# the messages of tags on the tip. A commit that adds a name and a later one
# that removes it still leaks the name, which is why commits are read too.
#
# Since 2026-11-18 only export commits go to the public repo (one snapshot per
# release, public-export/export.sh), and this guard runs on exactly those:
#   scripts/public-guard.sh <commit>    export.sh, before it publishes; the
#                                       range is public/main..<commit>
#   valkyrie-public-guard.sh <commit>   the copy odin's pre-push hook runs on
#                                       every push to the public repo
#                                       (public-export/install-hook.sh)
# Named pre-push (the old symlinked hook) it still reads git's hook input.
set -euo pipefail

LIST="${VALKYRIE_DENYLIST:-$HOME/.config/valkyrie/public-denylist.txt}"
ZERO=0000000000000000000000000000000000000000

if [[ ! -s "$LIST" ]]; then
  echo "public-guard: no denylist at $LIST, refusing to publish" >&2
  exit 1
fi
PATTERNS="$(mktemp)"
trap 'rm -f "$PATTERNS" "$PATTERNS.empty"' EXIT
grep -vE '^\s*(#|$)' "$LIST" > "$PATTERNS" || true
if [[ ! -s "$PATTERNS" ]]; then
  echo "public-guard: $LIST has no patterns, refusing to publish" >&2
  exit 1
fi
# A pattern that cannot match checks nothing and still reports no hit, so a
# list that cannot be trusted refuses every push. These lines never print a pattern.
refuse_list() {
  echo "public-guard: $LIST $*, refusing to publish" >&2
  exit 1
}
if grep -q $'\r' "$LIST"; then refuse_list "has CR line endings (save it with LF only)"; fi
rc=0; grep -q -i -E -f "$PATTERNS" /dev/null 2> /dev/null || rc=$?
[[ "$rc" -eq 1 ]] || refuse_list "has a pattern grep cannot compile"
rc=0; (cd "$(dirname "$PATTERNS")" && : > "$PATTERNS.empty" && git grep --no-index -q -i -E -f "$PATTERNS" -- "$(basename "$PATTERNS").empty") > /dev/null 2>&1 || rc=$?
rm -f "$PATTERNS.empty"
[[ "$rc" -eq 1 ]] || refuse_list "has a pattern git grep cannot compile"
rc=0; printf '\n' | grep -q -i -E -f "$PATTERNS" || rc=$?
[[ "$rc" -eq 1 ]] || refuse_list "has a pattern that matches an empty line"

# grep and git grep exit 1 for no hit; anything above that is a failed search
searched() { # <exit code> <what>
  [[ "$1" -le 1 ]] && return 0
  echo "public-guard: the search of $2 failed (exit $1), refusing to publish" >&2
  exit 1
}

HITS=0
check() { # <tip> <rev-list args...>
  local tip="$1"; shift
  local out rc
  rc=0; out="$(git grep -I -n -i -E -f "$PATTERNS" "$tip" -- . 2>/dev/null)" || rc=$?
  searched "$rc" "the tree"
  if [[ "$rc" -eq 0 ]]; then
    echo "public-guard: denylisted text in the tree at $(git rev-parse --short "$tip"):" >&2
    echo "$out" | head -40 >&2
    HITS=1
  fi
  rc=0; out="$(git log -p --format='commit %H%nAuthor: %an <%ae>%nCommitter: %cn <%ce>%n%n%B' "$@" \
      | grep -a -n -i -E -f "$PATTERNS")" || rc=$?
  searched "$rc" "the commits"
  if [[ "$rc" -eq 0 ]]; then
    echo "public-guard: denylisted text in commits not yet on GitHub:" >&2
    echo "$out" | head -40 >&2
    HITS=1
  fi
  rc=0; out="$(git for-each-ref --points-at "$tip" --format='%(refname:short): %(contents)' refs/tags \
      | grep -a -i -E -f "$PATTERNS")" || rc=$?
  searched "$rc" "the tag messages"
  if [[ "$rc" -eq 0 ]]; then
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
