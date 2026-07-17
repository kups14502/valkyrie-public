# Huginn — the Valkyrie assistant (Jarvis mode)

Voice + touch natural-language control of odin, Echo-Show style: an ambient
clock/HUD on the laptop's touchscreen that wakes into a chat when tapped,
listens, answers out loud, and shows rich cards (portfolio, media, gigs,
system) alongside the conversation. Also reachable from the phone or thor
through the normal authed web app at `/jarvis`.

## What it can do

- **Gigs**: everything the gig agent does (same tools, shared code) — add,
  complete, modify, link. Work gigs still mirror Autotask.
- **Media**: "add the movie Heat", "get the new season of Severance" —
  searches Radarr/Sonarr, adds with default profile/root folder, downloads
  flow through the existing stack into Plex. "Is it done yet" reads the queue.
- **Trading**: "how are the trades" — reads `/api/trading` (trade-bot data).
  Read-only by design; it cannot place trades.
- **Server ops**: system vitals, per-service health, restart a container or
  user service (asks for confirmation; ssh/tailscale/docker refused), lights.
- **Self-update**: "update valkyrie" — `check` reports pending commits;
  `backend` pulls + rebuilds + restarts valkyrie-api (assistant goes quiet
  ~1 min); `apps` kicks `scripts/ship.sh` in the background.

## Architecture

```
touchscreen kiosk (firefox --kiosk, profile "valkyrie-kiosk")
   → http://127.0.0.1:3001/kiosk/jarvis      (backend-served kiosk build,
                                              loopback = no auth, mic OK)
phone / thor → https://valkyrie.brendonkupsch.com/jarvis  (login required)

frontend/src/pages/Jarvis.tsx     idle HUD + chat bubbles + mic (VAD) + TTS
frontend/src/lib/assistant.ts     SSE client, /stt, /tts
frontend/src/lib/useVoice.ts      MediaRecorder + silence auto-stop

backend/src/assistant/index.ts    POST /api/assistant/chat  (SSE agent)
                                  POST /api/assistant/stt   (audio → text)
                                  POST /api/assistant/tts   (text → wav)
                                  GET  /api/assistant/config
backend/src/assistant/media.ts    Radarr/Sonarr tools
backend/src/assistant/ops.ts      trading/system/services/lights/update tools
(gig tools imported from routes/gigChat.ts — one implementation, two agents)

whisper-stt.service   whisper.cpp server, 127.0.0.1:8378 (small.en-q5_1)
valkyrie-tts.service  voice/kokoro_server.py, 127.0.0.1:8379 (kokoro int8)
```

Agent runtime: `@anthropic-ai/claude-agent-sdk` on the service user's
`~/.claude` CLI auth, model `VALKYRIE_ASSISTANT_MODEL` (default
`claude-sonnet-5`). Tools are in-process MCP wrappers; the agent has no Bash,
no file access. Card data is streamed to the UI straight from tool results,
so the model narrates while the UI shows the numbers.

## Setup

1. Voice services: see `voice/README.md` (one-time build + units).
2. `backend/.env`: add the assistant block from `.env.example` — Radarr and
   Sonarr keys come from `/home/brendon/docker/media-stack/<app>/config.xml`.
3. Build: `cd backend && npm run build`; `cd frontend && npm install &&
   npm run build:kiosk`; restart `valkyrie-api.service`.
4. Kiosk autostart on odin: `~/.config/autostart/valkyrie-kiosk.desktop`
   launches `firefox --kiosk -P valkyrie-kiosk http://127.0.0.1:3001/kiosk/jarvis`.
   The profile pre-grants mic (`permissions.default.microphone=1`) and enables
   autoplay (`media.autoplay.default=0`).

## Interaction model

- Idle: clock + equity/CPU/gigs/services tiles. Tap anywhere → starts
  listening immediately.
- Speech ends on ~1.4 s silence (or tap the mic again). After the spoken
  reply finishes, the mic re-arms once for a follow-up; staying quiet lets it
  lapse. 90 s of inactivity returns to the clock; the conversation survives
  (sessionId in sessionStorage) until ↺ resets it.
- Tap the mic while it's speaking to interrupt (barge-in).
- Keyboard icon → typed input; speaker icon → mute TTS.

## Troubleshooting

- Mic button greyed / "voice offline": `systemctl --user status
  whisper-stt valkyrie-tts`; `GET /api/assistant/config` shows per-service
  health.
- Chat errors mid-update: expected for `update_valkyrie backend` — the
  service restarts under the conversation. Check `/tmp/valkyrie-assistant-update.log`.
- Media add fails with 401: Radarr/Sonarr key missing/stale in `backend/.env`.
