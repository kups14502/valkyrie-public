# Valkyrie

Personal server control dashboard. Single pane for server health, AI usage, active sessions, projects, plus dedicated tabs for Home Assistant lights, Vaultwarden, the trade bot, and a live terminal for driving Claude Code from the phone.

## Architecture

- **Frontend** — React + Vite + Tailwind v4 (`/frontend`). Deployed to Cloudflare Pages.
- **Backend** — Express + TypeScript (`/backend`). Runs locally on `127.0.0.1:3001`, exposed to Cloudflare via Cloudflare Tunnel.
- **Auth** — Cloudflare Access (Zero Trust) on the public hostname. Backend verifies the `Cf-Access-Jwt-Assertion` JWT for defense in depth. Local requests (127.0.0.1) bypass auth in dev only.

## Terminal (under Sessions)

`/sessions/terminal` runs Claude Code on **thor** from any browser, phone
included. The Sessions tab is the way in. In a browser, "new session" opens a
launch target in the page (personal and work: the entries thor flags
`"phone": true` in `C:\Thor\var\session-board\launch-targets.json`) and "open"
on a board row resumes that conversation in the page. In the desktop app both
still open a Windows Terminal tab on thor's screen.

The page is only a screen and a keyboard. The session itself is a tmux session
on the `valkyrie` socket on odin, owned by `valkyrie-term.service`
(`scripts/valkyrie-term.service`, config `scripts/valkyrie-tmux.conf`), whose
pane is an SSH client into thor running
`C:\Thor\tools\session-board\Remote-Session.ps1`. That script turns a target
key or a session id (via `Resume.ps1`) into a directory on thor, so no path
ever crosses the wire. It runs elevated, because Windows OpenSSH hands an
administrator the full token, which is also why it never touches wt.exe or the
pwsh Store alias.

That split is deliberate. Locking the phone, closing the tab, or restarting the
API all just detach; reopening reattaches to the same running session, and the
SSH connection to thor is never touched by any of it. The tmux server has to be
started by its own unit, because systemd kills a service's whole cgroup and a
server started by the API would die with every deploy.

`remain-on-exit failed` in the conf keeps a pane on screen when ssh itself
fails (thor asleep, a refused login), and a clean exit still closes the
session. It cannot catch a failure on thor's side: with a pty allocated,
Windows OpenSSH runs the command under a ConPTY and always reports exit 0 to
the client, so a bad target or a failed resume would otherwise vanish a second
after opening. `Remote-Session.ps1` holds its own pane open on failure instead,
printing the reason and closing itself after ten minutes.

Install once, on odin:

```bash
mkdir -p ~/.config/valkyrie
cp scripts/valkyrie-tmux.conf ~/.config/valkyrie/tmux.conf
cp scripts/valkyrie-term.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now valkyrie-term
```

and put odin's `~/.ssh/id_ed25519.pub` in thor's
`C:\ProgramData\ssh\administrators_authorized_keys`. `THOR_SSH_HOST`,
`THOR_SSH_USER` and `THOR_REMOTE_SCRIPT` override the defaults
(`THOR_LAUNCHER_HOST`, `brendon`, the script path above).

The routes and the `/ws/terminal` socket are behind `requireStrongAuth`, not the
app-wide `requireAuth`, so the short-lived media token that opens a poster can
never open a shell. A client only ever sends a session name, a launch-target
key, or a session id, never a path.

## VR workspace (Steam Frame)

`/vr` is a flat multi-screen desk for the headset's own browser: Claude sessions
on thor and Valkyrie pages side by side in one window, with a key strip for
what the SteamOS keyboard lacks. Nothing is streamed from a PC. Each terminal
screen is the same tmux-over-SSH bridge as the phone terminal, so a session
opened in the headset shows on the board and survives taking the headset off.
The `vr` device profile in Settings opens the app there. For the headset itself
the app is the Android build: every release from v0.3.91 carries a signed
`Valkyrie_<version>_arm64.apk` to sideload (the Frame runs Android apps natively
and Valve supports sideloading). `scripts/android-toolchain.sh` sets a machine up
to build it and `scripts/android-build.sh` builds it. Design notes, the install
route, and what to check once the hardware arrives are in `docs/vr-mode.md`.

## Dev

```bash
# Backend
cd backend
cp .env.example .env
npm install
npm run dev   # http://localhost:3001

# Frontend
cd frontend
npm install
npm run dev   # http://localhost:5173 (proxies /api → :3001)
```

## Deploy

- Frontend: push to GitHub → Cloudflare Pages auto-builds `frontend/`
- Backend: runs as a service on the home server, fronted by `cloudflared`
