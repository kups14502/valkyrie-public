# Valkyrie

Personal server control dashboard. Single pane for server health, AI usage, active sessions, projects, plus dedicated tabs for the gig log (game-style task tracker), email intake, Home Assistant lights, Vaultwarden, and the trade bot.

## Architecture

- **Frontend** — React + Vite + Tailwind v4 (`/frontend`). Deployed to Cloudflare Pages.
- **Backend** — Express + TypeScript (`/backend`). Runs locally on `127.0.0.1:3001`, exposed to Cloudflare via Cloudflare Tunnel.
- **Auth** — Cloudflare Access (Zero Trust) on the public hostname. Backend verifies the `Cf-Access-Jwt-Assertion` JWT for defense in depth. Local requests (127.0.0.1) bypass auth in dev only.

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
