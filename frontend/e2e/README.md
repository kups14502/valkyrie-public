# v2 end-to-end suite

Run it before every ship of v2 (`src/v2`, `/m/*`): the UI on the phone, the iPad, the desktop browser and the desktop app.

```bash
# from frontend/, with the read-only probe up (npx vite --config vite.v2probe.config.ts)
node e2e/run.mjs                        # everything, about 8 minutes
node e2e/run.mjs --only writes          # a group: routes, navigation, writes, upload, terminal, gaps, desktop, parity, accounts, freshness, schemes
node e2e/run.mjs --only route:lights    # any part of a test name, comma separated
node e2e/run.mjs --shots ../shots/e2e   # also save a screenshot per test (JPEG)
node e2e/run.mjs --list
```

Exit code 0 means every test passed. The table prints at the end, and `e2e/report.json` holds every
result with its failures and notes. A route that has no live data after 8 s lists the reads that
were slow: when those are thor's (`/api/hosts/thor/...`, `/api/session-board`), thor is asleep or
busy, not the page; rerun that route with `--only`.

## What it covers

| Group | Tests |
|---|---|
| routes | Every v2 route (the tabs, Settings, the terminal preview, and the full Calendar and Meals pages) on seven screens: the iPhone at 390x844 and 844x390, the iPad at 820x1180 and 1180x820, a 1600x900 window, and 1920x1080 and 2560x1440 monitors at the app zoom of 1.2: no console errors, nothing wider than the viewport, tabs at the top, lights button bottom-left and uncovered, live data on screen 8 s after opening. Also Brendon's notes: no 5h meter in the status strip and the date whole, the ticker shows bot online state, up or down and the 7-day change, AI usage under AI > Usage and not on System > Hosts. |
| navigation | Tab and sub-tab taps, Settings behind the gear and the way back (button, phone back, gear), swiping between tabs, the ticker opening Trades and the usage meters (Dashboard, AI > Sessions) opening AI > Usage, old addresses. Every profile opening v2: the iPhone, the desktop and the iPad (picked or detected) land on `/m/dashboard` from `/`, `/dashboard`, `/pad` and `/phone`, and on the desktop the classic addresses (`/lights`, `/trade`, `/calendar`, `/meals` and the rest) land on their v2 screens while Vault and Activity stay classic. Settings > Classic opening the device's own classic home with `?classic=1` (desktop, phone, iPad), a reload keeping the tab classic, the classic menu's New UI going back, `?classic=1` on a fresh tab, and no `html[data-v2]` left on a classic page. |
| writes | Every real action, answered 200 and then 500 or 403: lights button, a bulb, a preset, Thor RGB relight and dark, tracker tick and Undo, Quick Start, new session on thor in the page, on thor's screen and on odin, session Done (and Undo) and Stop, a media request, a service restart with its confirm. Each checks the method, path and body, then the success state or the rollback and error toast. |
| freshness | The trade status is read about every 60 s on System > Trades and on the Dashboard, and a new figure reaches the screen (about 130 s each, run first and alongside the rest). |
| upload | Pictures to thor from the Dashboard's Upload block and the AI > Sessions button: picked through the real tap (file chooser intercepted), every chunk answered in the browser. Order under Quick Start, camera and multi-file pickers, rows newest first with thumbnails, a 502 retried with the same upload id, copy the path, the kept list after a reload, a refusal with Retry, a PDF refused before sending, desktop without the camera plate, old uploads folded behind Recent, the Sessions toast with Copy path and Retry. |
| terminal | The v2 terminal (`/m/ai/term/<name>`) on a real tmux pane: a throwaway odin shell pane each test makes, names and kills (see Safety). Attach over the probe's `/ws` proxy, a composer line run by the shell (the text as a paste, Enter on its own 120 ms later), every quick key's bytes (read back through `cat -vT`) and Ctrl folding the next key, tool lines on the screen counted in the activity strip, no plates on a shell pane, an upload's path typed with no Enter, rotation refitting the grid with `stty size` agreeing, the same pane shown as a Claude pane drawing a permission prompt as plates (and plate 2 sending 2), Not open with no reconnect once the pane is killed. Also `/sessions/terminal?s=<name>` landing on the v2 terminal for the iPhone profile and on the desktop, More > Classic terminal, `?classic=1` keeping the classic page on the desktop and typing there, and `/m/ai/term` with no name or a bad one going to AI > Sessions. |
| gaps | One test per feature of the gap pass: AI > Sessions' done fold and Undo per row, select mode (long press, Mark done, Undo), open terminals (two-tap close, reattach by name), Stop all (panes first, then sessions, one at a time), search over title, project and folder, resume on thor's screen; a project's detail (tick and add tasks, cancel and add reminders, edit the next action); the tracker's day stepping and other-day line, hold to skip Exercise, the calendar sheet; Settings > Hero and the classic Slop row; a model-only device on System > Hosts; Custom color for one bulb and for the room (one command per pick); Open Plex and Spotify on the Media dashboard. |
| desktop | The desktop app's window chrome over a stand-in Tauri bridge with Tauri's own drag script (`lib/tauri.mjs`), at 1600x900 and at 1920x1080 zoom 1.2: `/` opens v2, the strip is a deep drag region, Minimize, Maximize and Close sit in the corner with nothing under them, an empty part of the strip or the tab row sends start_dragging and a double-click internal_toggle_maximize, the buttons, tabs and gear never drag, Settings > Build shows the app's version, and the same chrome on Settings, Calendar and the terminal preview. The Ctrl+K palette (open, search, arrows, Enter, Escape giving the focus back, the strip's search button, Calendar and Meals as v2 pages, a running pane by name, the arrows paging again once it closes). The zoom keys (Ctrl+=, Ctrl+-, Ctrl+0, kept across a reload) with the caret on the lit tab and the shell filling the window. Settings' Sign out (two presses, the first one timing out) bringing up the sign-in card. Alert taps: `public/push-sw.js` run in node against a stand-in worker (session, quota, sign-in, disk and project alerts, an open window, the push itself), and in the page, the `?v2=` hint followed in a v2 tab, dropped in a classic tab, refused when it is not a v2 path, and `/m/ai/open` finding a pane by label or by board session or landing on AI > Sessions with a toast. |
| parity | The classic pages' functions in v2, on a fake backend: Movies' search (accents, every word, the year) and its four sorts, the A to Z strip, the title pane beside the grid on a monitor; Music's search over the index and the server; Trades' positions, fills (an order's legs summed) and judged scans in the phone's view tabs and the monitor's three columns; Restart on a running container and a user unit (two taps, 200 and 500) and none on a system unit; the Dashboard's Calendar block opening the sheet on an upright iPad (still open after the tap, closed by its backdrop) and the page on a monitor; the calendar's five views with stepping, Today and the arrow keys, adding, editing and deleting an event with Undo (monitor and iPad), a read-only feed event, a refused save and delete; Meals' log by hand, servings, delete with Undo and the day bar (monitor and phone); New project by hand, Edit sending only what changed, Archive in two taps, Show archived and Restore, and refused archive and save. |
| accounts | The Claude account switcher on AI > Usage (`Accounts.tsx`) over a fake `/api/account-switch`: both hosts' accounts, next picks, threshold, auto-switch, sign-in states and the last switches in ET (phone and desktop); Switch now with its pick and Confirm (200 and 500) and Cancel; the auto-switch toggle (200 with a whole status, 403); raising the threshold and Save; Re-sign in (two taps, 200 and 500), its steps, the code#state box refusing a code without # and clearing after the send; dry run, a paused host, no next pick; a 404 (not deployed) as a quiet note. |
| schemes | Dashboard and Trades in Cyan and Matrix; the Trades chart canvas and the Trades view have no yellow. |

## Safety

- Nothing a test does can reach odin. Every `/api` request pauses in the browser (CDP Fetch); every
  write is answered there by the test, or with a 418 that fails the test. The probe also refuses
  writes on its own.
- The in-page terminal never loads: navigations to `/sessions/terminal` are refused in the page and
  a document load of it fails the test. Sockets to `/api` or a terminal path are refused.
- The terminal tests are the one exception, and only for a pane they made: each creates a plain shell
  in odin's home labeled "v2 test" (`lib/odin.mjs`, a POST to odin's API over ssh, since the probe
  refuses writes), opens its page with `term: <name>`, and kills the pane in a `finally`, pass or
  fail. That page may load `/sessions/terminal?s=<name>` and open `/ws/terminal?s=<name>` and no
  other terminal name; the pane list it reads is cut down to that one pane, so even the classic
  page's "land on the latest session" can only land on it. `run.mjs` kills any pane a crashed test
  left (at the end and on Ctrl+C). Never point a test at one of Brendon's sessions. The probe's `/ws`
  proxy is not covered by its read-only guard, which is why only these panes ever reach it.
- The only browser is chrome-headless-shell on `127.0.0.1:9333`, started by `e2e/browser.ps1` when
  it is down. It creates no window at all. Each test gets its own browser context.
- A request straight to odin's tailnet API (the desktop app's start-up probe, `lib/api`
  resolveApiBase) is refused in the browser, so the page falls back to the probe's `/api`.
- While `deadlock.exe` or SteamVR runs, the suite pauses (up to 30 minutes, `--force` skips this).
  Add more process names with `E2E_GAMES=game.exe,other.exe`.

## Layout

- `run.mjs`: options, the game pause, the run, the table and `report.json`.
- `lib/cdp.mjs`: the browser connection, a page per context, the fence, taps and swipes.
- `lib/harness.mjs`: the test context and the pool. `lib/checks.mjs`: in-page reads.
- `lib/fixtures.mjs`: the fake backend state the write tests use (generic names only).
- `lib/tauri.mjs` and `lib/tauri-drag.js`: the stand-in desktop app bridge and Tauri's drag script.
- `lib/odin.mjs`: the throwaway odin panes for the terminal tests.
- `tests/*.mjs`: one file per group.

The backend half is `backend/scripts/termOdinSmoke.mts` (odin targets, odin request validation,
the sh wrapper's quoting, the equity tail parser). It runs on odin from a scratch copy; its header
has the commands.
