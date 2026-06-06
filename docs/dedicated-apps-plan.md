# Dedicated Desktop + Mobile Apps — Plan

> Status: **NEXT TASK** (Code Deck AskUserQuestion fix is done as of commit d1a56df).
> This file is the durable home for this plan — an earlier copy lived in a
> reused `~/.claude/plans/` file and was overwritten. Do not let it evaporate again.

## Goal (user's words)

> "I am tired of using Master Control in PWA apps and Safari on my phone; and I'm
> tired of logging in with the Cloudflare email code, why not just use an OTP on
> my phone. It's time to make dedicated desktop and mobile apps."

## What it does

- Wrap the existing React UI in a **Tauri 2** app — one codebase → desktop and iOS/Android.
- Replace Cloudflare Access email codes with self-hosted **password + TOTP** (authenticator app),
  plus **biometric unlock** on reopen.
- Keep the Cloudflare Tunnel; retire the Access policy.

## Why this is a real auth build, not a swap

1. The app has **no login UI today** — auth happens at Cloudflare's edge before React loads.
2. **Code Deck WebSockets are unauthenticated at the app layer** — only Cloudflare Access guards
   them. New auth must cover WS via a `?token=` param, and the **JWT-bypass branch in the
   middleware must be removed** (`backend/src/middleware/auth.ts`).

## Four locked decisions (defaults — NOT yet confirmed by the user)

| Fork        | Default                                   | Alternatives                          |
|-------------|-------------------------------------------|---------------------------------------|
| App shell   | Tauri 2 (one codebase, desktop+mobile)    | Electron+Capacitor; desktop-only first|
| Auth        | TOTP + biometric unlock                   | TOTP every login; Passkeys/WebAuthn   |
| Transport   | Keep tunnel, drop Access policy           | Tailscale; expose directly            |
| iOS signing | Free signing (7-day re-sign)              | Paid Apple Developer ($99/yr)         |

## Four parts (build order)

1. **Backend auth + WS token** — login endpoint (password + TOTP verify), issue app token,
   authenticate WebSocket via `?token=`, remove the JWT-bypass branch. *(start here — everything
   depends on it)*
2. **Frontend login/token/secure-storage** — login screen, token storage, biometric unlock.
3. **Tauri 2 shell** — wrap the React UI; desktop + mobile targets.
4. **Cloudflare cutover** — drop the Access policy, keep the tunnel.

## Verification (per part)

- Part 1: log in with password+TOTP, hit an authed API + open a Code Deck WS with the token; the
  JWT-bypass path is gone and unauthenticated requests are rejected.
- Parts 2–4: filled in as each part is scoped.
