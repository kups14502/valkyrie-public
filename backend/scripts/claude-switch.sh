#!/bin/sh
# claude-switch: the account switcher from a shell on odin.
#
#   claude-switch status            what each host uses, the pool, the last switches
#   claude-switch off               kill switch on (works with the API down)
#   claude-switch on                kill switch off
#   claude-switch enable|disable    auto-switch on or off (config.json)
#   claude-switch dry-run on|off    log and DM decisions without writing
#   claude-switch resume <host>     let the switcher own thor or odin again
#   claude-switch pause <host>      stop switching one host
#   claude-switch now <host|all> <account-id>   switch by hand
#   claude-switch log [N]           the last N entries (default 20)
#
# Talks to the Valkyrie API on 127.0.0.1 (loopback is trusted). Prints account
# ids, labels and percentages only; there is no token in anything it reads.
set -eu
API="http://127.0.0.1:${PORT:-3001}/api/account-switch"
DIR="${CLAUDE_SWITCH_DIR:-$HOME/.config/claude-switch}"

post() { curl -sS -m 90 -X POST -H 'content-type: application/json' --data "$2" "$API/$1"; echo; }
host_ok() { case "${1:-}" in thor|odin|all) ;; *) echo "host must be thor or odin${2:-}" >&2; exit 2 ;; esac; }

case "${1:-status}" in
status)
  curl -sS -m 30 "$API?refresh=1" | python3 -c '
import json, sys
s = json.load(sys.stdin)
c = s["config"]
print("auto-switch: %s%s%s | threshold %s%% | target under %s%% | weekly cap %s%%" % (
  "on" if s["enabled"] else "off", " (dry run)" if s["dryRun"] else "", " | KILL SWITCH ON" if s["killed"] else "",
  c["thresholdPct"], c["targetMaxPct"], c["weeklyMaxPct"]))
v = s["vault"]
print("vault: %s, %d entries%s%s" % (v["dir"], v["entries"], "" if v["modeOk"] else ", PERMISSIONS TOO OPEN", (", unreadable: " + ", ".join(v["badFiles"])) if v["badFiles"] else ""))
for h in s["hosts"]:
  a = h["active"]["label"] if h["active"] else "-"
  n = h["next"]["label"] if h["next"] else "none (" + h["nextReason"] + ")"
  print("%-5s auto %-3s using %-22s owner=%-11s %snext: %s" % (h["host"], "on" if h["enabled"] else "off", a, h["owner"], ("PAUSED: " + h["pausedReason"] + " | ") if h["paused"] else "", n))
for a in s["accounts"]:
  q = a["quota"]
  qs = "session %3s%% weekly %3s%%" % (q["sessionPct"], q["weeklyPct"]) if q else "no reading"
  tok = "token" if a["token"]["present"] and not a["token"]["dead"] else ("token REFUSED" if a["token"]["dead"] else "no token")
  print("  %-22s %-13s %-28s %s" % (a["label"], tok, qs, a["why"]))
'
  ;;
off) umask 077; mkdir -p "$DIR"; date -u +%FT%TZ > "$DIR/disabled"; echo "kill switch on: $DIR/disabled" ;;
on) rm -f "$DIR/disabled"; echo "kill switch off" ;;
enable) post config '{"enabled":true}' ;;
disable) post config '{"enabled":false}' ;;
dry-run)
  case "${2:-}" in on) post config '{"dryRun":true}' ;; off) post config '{"dryRun":false}' ;; *) echo "dry-run on|off" >&2; exit 2 ;; esac ;;
resume) host_ok "${2:-}" ""; [ "$2" = all ] && { echo "resume one host at a time" >&2; exit 2; }; post resume "{\"host\":\"$2\"}" ;;
pause) host_ok "${2:-}" ""; [ "$2" = all ] && { echo "pause one host at a time" >&2; exit 2; }; post pause "{\"host\":\"$2\"}" ;;
now)
  host_ok "${2:-}" ", or all"
  case "${3:-}" in ''|*[!a-z0-9-]*) echo "account must be an account id" >&2; exit 2 ;; esac
  post switch "{\"host\":\"$2\",\"account\":\"$3\",\"confirm\":true}" ;;
log)
  curl -sS -m 30 "$API/log?limit=${2:-20}" | python3 -c '
import json, sys
from datetime import datetime
from zoneinfo import ZoneInfo
for e in json.load(sys.stdin)["entries"]:
  t = datetime.fromisoformat(e["at"].replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York")).strftime("%a %-I:%M %p ET")
  print("%-16s %-9s %-5s %s -> %s  %s%s" % (t, e["kind"], e.get("host") or "-", e.get("from") or "-", e.get("to") or "-", e["reason"], (" | " + e["detail"]) if e.get("detail") else ""))
'
  ;;
*) sed -n '2,14p' "$0"; exit 2 ;;
esac
