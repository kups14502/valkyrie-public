# Dedicated Desktop + Mobile Apps — Plan

> Status: **IN PROGRESS.** Parts 1, 2, 3a DONE and validated end-to-end —
> the Windows app runs, signs in with self-hosted password+TOTP, and Code Deck
> works through it. Remaining: 3b (Android + biometric/secure-storage),
> Part 4 cutover (AUTH_STRICT=1 + retire Cloudflare Access), iOS (needs a Mac).
> This file is the durable home for this plan — an earlier copy lived in a
> reused `~/.claude/plans/` file and was overwritten. Do not let it evaporate again.

## Progress log
- Code Deck AskUserQuestion picker — commit d1a56df.
- Part 1 (backend auth + WS token) — commit 6e79d01.
- Part 4, auth half (2026-09-28): the migration-era no-token bypass is gone
  from the code, so the API accepts only real credentials.
- Part 2 (frontend login/setup UI + token wiring) — commit 9b94b0e.
- Part 3a (Tauri 2 desktop scaffold + GitHub Actions CI) — commit 46fae23;
  skip-hatch hidden in-app — d31a5f0. CI builds Windows/macOS/Linux installers
  on every push (Actions artifacts). Windows app installed + working.
- Part 3b, first half (Android APK) — commit 82d8373, 2026-09-15. Built on odin
  by `scripts/android-build.sh`, signed from `~/.tauri`, uploaded by release.sh
  from v0.3.91. Driven by the Steam Frame (see `docs/vr-mode.md`), which runs
  Android apps natively; it is the phone app too. Biometric unlock and secure
  token storage are still open.

## Goal (user's words)

> "I am tired of using Valkyrie in PWA apps and Safari on my phone; and I'm
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
