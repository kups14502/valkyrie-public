# Valkyrie

Personal server control dashboard. Single pane for server health, AI usage, active sessions, projects, plus dedicated tabs for Home Assistant lights, Vaultwarden, the trade bot, and a live terminal for driving Claude Code from the phone.

## Architecture

- **Frontend** — React + Vite + Tailwind v4 (`/frontend`). Deployed to Cloudflare Pages.
- **Backend** — Express + TypeScript (`/backend`). Runs locally on `127.0.0.1:3001`, exposed to Cloudflare via Cloudflare Tunnel.
- **Auth** — Cloudflare Access (Zero Trust) on the public hostname. Backend verifies the `Cf-Access-Jwt-Assertion` JWT for defense in depth. Local requests (127.0.0.1) bypass auth in dev only.

## Terminal tab

`/terminal` runs Claude Code (or a plain shell) on odin from any browser,
phone included. The page is only a screen and a keyboard: the session itself is
a tmux session on the `valkyrie` socket, owned by `valkyrie-term.service`
(`scripts/valkyrie-term.service`, config `scripts/valkyrie-tmux.conf`).

That split is deliberate. Locking the phone, closing the tab, or restarting the
API all just detach; reopening reattaches to the same running session. The tmux
server has to be started by its own unit, because systemd kills a service's
whole cgroup and a server started by the API would die with every deploy.

Install once, per machine:

```bash
mkdir -p ~/.config/valkyrie
cp scripts/valkyrie-tmux.conf ~/.config/valkyrie/tmux.conf
cp scripts/valkyrie-term.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now valkyrie-term
```

The routes and the `/ws/terminal` socket are behind `requireStrongAuth`, not the
app-wide `requireAuth`: that one still honours a legacy no-token bypass for
anything that looks like the published frontend, which is fine for a chart and
not for a shell. A client only ever sends a session name or a launch-target
key, never a path.

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
