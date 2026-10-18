# v2 end-to-end suite

Run it before every ship of the phone UI (`src/v2`, `/m/*`).

```bash
# from frontend/, with the read-only probe up (npx vite --config vite.v2probe.config.ts)
node e2e/run.mjs                        # everything, about 3 minutes
node e2e/run.mjs --only writes          # a group: routes, navigation, writes, freshness, schemes
node e2e/run.mjs --only route:lights    # any part of a test name, comma separated
node e2e/run.mjs --shots ../shots/e2e   # also save a screenshot per test
node e2e/run.mjs --list
```

Exit code 0 means every test passed. The table prints at the end, and `e2e/report.json` holds every
result with its failures and notes. A route that has no live data after 8 s lists the reads that
were slow: when those are thor's (`/api/hosts/thor/...`, `/api/session-board`), thor is asleep or
busy, not the page; rerun that route with `--only`.

## What it covers

| Group | Tests |
|---|---|
| routes | Every v2 route at 390x844, 844x390 and 1600x900: no console errors, nothing wider than the viewport, tabs at the top, lights button bottom-left and uncovered, live data on screen 8 s after opening. Also Brendon's notes: no 5h meter in the status strip and the date whole, the ticker shows bot online state, up or down and the 7-day change, AI usage under AI > Usage and not on System > Hosts. |
| navigation | Tab and sub-tab taps, Settings behind the gear and the way back (button, phone back, gear), swiping between tabs, the ticker opening Trades and the usage meters (Dashboard, AI > Sessions) opening AI > Usage, old addresses, the iPhone profile landing on `/m/dashboard`, classic `/dashboard` and `/phone` left without `html[data-v2]`. |
| writes | Every real action, answered 200 and then 500 or 403: lights button, a bulb, a preset, Thor RGB relight and dark, tracker tick and Undo, Quick Start, new session on thor in the page, on thor's screen and on odin, session Done (and Undo) and Stop, a media request, a service restart with its confirm. Each checks the method, path and body, then the success state or the rollback and error toast. |
| freshness | The trade status is read about every 60 s on System > Trades and on the Dashboard, and a new figure reaches the screen (about 130 s each, run first and alongside the rest). |
| schemes | Dashboard and Trades in Cyan and Matrix; the Trades chart canvas and the Trades view have no yellow. |

## Safety

- Nothing a test does can reach odin. Every `/api` request pauses in the browser (CDP Fetch); every
  write is answered there by the test, or with a 418 that fails the test. The probe also refuses
  writes on its own.
- The in-page terminal never loads: navigations to `/sessions/terminal` are refused in the page and
  a document load of it fails the test. Sockets to `/api` or a terminal path are refused.
- The only browser is the headless Edge on `127.0.0.1:9333`, started by `e2e/browser.ps1` on a
  private desktop when it is down. No window ever shows. Each test gets its own browser context.
- While `deadlock.exe` or SteamVR runs, the suite pauses (up to 30 minutes, `--force` skips this).
  Add more process names with `E2E_GAMES=game.exe,other.exe`.

## Layout

- `run.mjs`: options, the game pause, the run, the table and `report.json`.
- `lib/cdp.mjs`: the browser connection, a page per context, the fence, taps and swipes.
- `lib/harness.mjs`: the test context and the pool. `lib/checks.mjs`: in-page reads.
- `lib/fixtures.mjs`: the fake backend state the write tests use (generic names only).
- `tests/*.mjs`: one file per group.

The backend half is `backend/scripts/termOdinSmoke.mts` (odin targets, odin request validation,
the sh wrapper's quoting, the equity tail parser). It runs on odin from a scratch copy; its header
has the commands.
