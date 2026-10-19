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
#   claude-switch signins           sign-ins and "Set up all accounts", newest first
#   claude-switch setup [stop]      start (or stop) Set up all accounts: one DM per account
#   claude-switch signin <account-id>   one one-tap sign-in (a DM with the link)
#   claude-switch code <request-id> paste code#state (or the callback URL) on stdin
#   claude-switch copy <account-id> copy odin's token for one account to thor's vault
#
# Talks to the Valkyrie API on 127.0.0.1 (loopback is trusted). Prints account
# ids, labels and percentages only; there is no token in anything it reads.
set -eu
API="http://127.0.0.1:${PORT:-3001}/api/account-switch"
DIR="${CLAUDE_SWITCH_DIR:-$HOME/.config/claude-switch}"

post() { curl -sS -m 90 -X POST -H 'content-type: application/json' --data "$2" "$API/$1"; echo; }
host_ok() { case "${1:-}" in thor|odin|all) ;; *) echo "host must be thor or odin${2:-}" >&2; exit 2 ;; esac; }
id_ok() { case "${1:-}" in ''|*[!a-z0-9-]*) echo "${2:-account} must be an id" >&2; exit 2 ;; esac; }

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
accts = s["accounts"]
on_odin = sum(1 for a in accts if a["token"]["present"])
thor = [a.get("onThor") for a in accts]
thor_txt = "unknown (thor not checked yet)" if all(t is None for t in thor) else "%d of %d" % (sum(1 for t in thor if t), len(accts))
print("vault: odin %d of %d, thor %s%s%s" % (on_odin, len(accts), thor_txt, "" if v["modeOk"] else " | ODIN PERMISSIONS TOO OPEN", (" | unreadable: " + ", ".join(v["badFiles"])) if v["badFiles"] else ""))
for h in s["hosts"]:
  a = h["active"]["label"] if h["active"] else {"grant": "its own /login sign-in", "missing": "its own sign-ins", "unknown": "an unknown token", "unreachable": "(no answer)"}.get(h["owner"], "-")
  n = h["next"]["label"] if h["next"] else "none (" + h["nextReason"] + ")"
  print("%-5s auto %-3s using %-22s owner=%-11s %snext: %s" % (h["host"], "on" if h["enabled"] else "off", a, h["owner"], ("PAUSED: " + h["pausedReason"] + " | ") if h["paused"] else "", n))
for a in accts:
  q = a["quota"]
  qs = "session %3s%% weekly %3s%%" % (q["sessionPct"], q["weeklyPct"]) if q else "no reading"
  tok = "token" if a["token"]["present"] and not a["token"]["dead"] else ("token REFUSED" if a["token"]["dead"] else "NEEDS A SIGN-IN")
  where = "" if not a["token"]["present"] else (" (odin+thor)" if a.get("onThor") else (" (odin only)" if a.get("onThor") is False else ""))
  print("  %-22s %-27s %-28s %s" % (a["label"], tok + where, qs, a["why"]))
  if a.get("identityWarning"): print("  %-22s WARNING: %s" % ("", a["identityWarning"]))
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
  id_ok "${3:-}"
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
signins)
  curl -sS -m 30 "$API/signin" | python3 -c '
import json, sys
from datetime import datetime
from zoneinfo import ZoneInfo
et = lambda iso: datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York")).strftime("%a %-I:%M %p ET") if iso else "-"
s = json.load(sys.stdin)
p = s.get("plan") or {}
print("to do: sign in %s | copy to thor %s | already set up %s" % (", ".join(p.get("signin") or []) or "none", ", ".join(p.get("copy") or []) or "none", p.get("already", "?")))
q = s.get("queue")
if q:
  print("setup %s: %s%s (started %s)" % (q["id"], q["state"], (": " + q["reason"]) if q.get("reason") else "", et(q["startedAt"])))
  for i in q["items"]:
    print("  %-8s %-6s %-26s %s" % (i["status"], i["kind"], i["label"], i.get("detail") or ""))
for r in s["requests"][:10]:
  extra = ""
  if r["stage"] == "needs-code": extra = " | waits until %s, DM %s" % (et(r.get("waitUntil")), "sent" if r["dmSent"] else "FAILED")
  if r.get("identity"): extra += " | " + r["identity"]
  print("%-16s %s %-24s %-10s %s%s" % (et(r["startedAt"]), r["id"], r["label"], r["stage"], r.get("detail") or "", extra))
'
  ;;
setup)
  case "${2:-}" in
    '') post signin/queue '{}' ;;
    stop) post signin/queue/cancel '{}' ;;
    *) echo "setup [stop]" >&2; exit 2 ;;
  esac ;;
signin) id_ok "${2:-}"; post signin "{\"accountId\":\"$2\"}" ;;
copy) id_ok "${2:-}"; post signin/sync-thor "{\"accountId\":\"$2\"}" ;;
code)
  case "${2:-}" in ''|*[!0-9a-f]*) echo "code <request-id> (from claude-switch signins), then paste the code on stdin" >&2; exit 2 ;; esac
  [ -t 0 ] && printf 'paste code#state or the callback URL, then Enter: ' >&2
  # The code goes from stdin into the JSON body, never onto a command line.
  python3 -c 'import json, sys; print(json.dumps({"code": sys.stdin.readline().strip()}))' \
    | curl -sS -m 30 -X POST -H 'content-type: application/json' --data @- "$API/signin/$2/code"; echo ;;
*) sed -n '2,19p' "$0"; exit 2 ;;
esac
