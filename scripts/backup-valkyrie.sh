#!/usr/bin/env bash
# Daily online backup of Valkyrie's SQLite databases (auth, code-deck).
# Uses `sqlite3 .backup`, which takes a consistent snapshot while the apps hold
# their WAL open — safe to run against the live services, unlike a plain cp.
# Snapshots are gzipped and rotated (keep the newest KEEP per database).
set -euo pipefail

DEST="${VALKYRIE_BACKUP_DIR:-$HOME/backups/valkyrie}"
KEEP="${VALKYRIE_BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

# Discover the databases rather than hardcoding, so new DBs are covered too.
mapfile -t DBS < <(find \
  "$HOME/valkyrie/backend/data" \
  -maxdepth 1 -type f -name '*.sqlite' 2>/dev/null | sort)

if [[ ${#DBS[@]} -eq 0 ]]; then
  echo "backup: no databases found" >&2
  exit 1
fi

fail=0
declare -A seen
for db in "${DBS[@]}"; do
  name="$(basename "$db" .sqlite)"
  seen["$name"]=1
  out="$DEST/${name}-${STAMP}.sqlite"
  # .backup is the safe online path; integrity_check guards against a snapshot
  # taken mid-corruption before we rotate older good copies away.
  if sqlite3 "$db" ".backup '$out'" 2>/dev/null \
     && [[ "$(sqlite3 "$out" 'PRAGMA integrity_check;' 2>/dev/null)" == "ok" ]]; then
    gzip -f "$out"
    echo "backup: $name ok ($(du -h "${out}.gz" | cut -f1))"
  else
    rm -f "$out"
    echo "backup: FAILED for $db" >&2
    fail=1
  fi
done

# Rotation: keep the newest KEEP gz snapshots per database name.
for name in "${!seen[@]}"; do
  # shellcheck disable=SC2012
  ls -1t "$DEST/${name}-"*.sqlite.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old" && echo "backup: rotated out $(basename "$old")"
  done
done

exit "$fail"
