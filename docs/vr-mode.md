# VR workspace (Steam Frame)

Started 2026-09-15, before the headset arrived. `/vr` is a flat, multi-screen desk for
Claude sessions and Valkyrie pages, meant to be opened in the headset's own browser.
Nothing is streamed from a PC and nothing is installed on the headset.

## Why a web route and not a headset app

The Steam Frame runs SteamOS. Its desktop mode has Chromium and Firefox, and a flat
window shows up in the headset as a floating screen you can move, resize and curve.
Valkyrie is already a web app, so the browser is the VR app: one window, and the
page divides it into screens. That also means the first cut could be built and
checked in a desktop browser on thor with no hardware.

The sessions themselves still run on thor. A screen is the same tmux-over-SSH bridge
the phone terminal uses (`backend/src/terminal/tmux.ts`, `Remote-Session.ps1` on
thor), so a session opened in the headset is resumable from the session board and
survives taking the headset off, exactly like the phone.

## What the page does

- Screens in a grid: 1, 2 or 3 columns by choice, or auto (1, 2, 3, 2x2, then 3 wide).
  Six screens is the cap, which is also close to the tmux session cap of twelve minus
  what the phone and the board already hold.
- A screen is either a terminal (a `vk-*` tmux session) or a Valkyrie page in an
  iframe. The iframe loads `/?go=/calendar`; `RootRedirect` in `App.tsx` routes from
  there, and an embedded copy of the app hides its header and Ctrl+K palette.
- The picker offers: sessions already running, a new Claude session in any launch
  target thor knows (phone favorites first), a plain PowerShell in the same, a
  resume from the session board, and the list of pages.
- Hide removes a screen and leaves the session running. End kills the tmux session,
  which ends Claude on thor, and needs a second press within three seconds.
- Zen hides the app header and the workspace bar (`html[data-vr-zen]` in
  `index.css`); one floating button comes back. Fullscreen uses the browser API.
- The key strip sends Esc, Tab, Ctrl (armed for the next key), Shift+Tab, ^C, arrows,
  page up and down, paste, backslash-Enter and Enter to the last-touched terminal.
  The SteamOS keyboard has none of those.
- Terminal font defaults to 18px (the phone uses 12) and is adjustable 12 to 32.
- `/vr?s=vk-...` adds that session as a screen, the same handoff the board uses for
  the terminal page.
- State is in localStorage: `valkyrie-vr-panes`, `valkyrie-vr-cols`, `valkyrie-vr-font`.
- The `vr` device profile (Settings, "this device") opens Valkyrie on `/vr` and uses
  the pad-sized controls elsewhere, because a laser pointer wants the same targets a
  finger does. It is never auto-detected: a headset browser passes every desktop media
  query.

One session, two screens: tmux sizes a window with `window-size latest`, so if the
phone and the headset are attached to the same session at once, the window follows
whichever client typed last and the other sees the unused area filled with dots.
That is tmux, not a bug here; type into the pane and it takes the size back. The
first screenshot of this page showed exactly that, because a page screen had
recursed into the workspace and attached a second, smaller client to every session.
An embedded copy now refuses to render the workspace.

Wheel scrolling is left to xterm on purpose. `valkyrie-tmux.conf` has `mouse on`, so
the thumbstick (which the browser reports as wheel events) reaches tmux as mouse
reports and tmux scrolls its own history. A page-level wheel handler would scroll it
twice. The page-up and page-down keys use the socket's scroll message instead, which
the backend tracks so the next keystroke leaves copy mode.

## Opening it on the Frame

Two ways to reach the API from the headset, pick when it arrives:

1. The public hostname through Cloudflare Access. Works from any network, the browser
   does the Access login once, and `requireStrongAuth` accepts the Access JWT for the
   terminal socket. No setup on the headset.
2. The tailnet copy at `http://100.96.237.89:8420/vr`, which needs Tailscale on the
   Frame. It installs on SteamOS the way it does on the Deck, but the immutable
   filesystem makes it fiddly and it can need redoing after a SteamOS update.

Start with the public hostname.

To make it feel like an app rather than a tab: in desktop mode, install it as a PWA
from Chromium (the manifest is already there), or add the browser to Steam as a
non-Steam app with `--app=https://<host>/vr` so it launches from the VR home without
dropping to the desktop.

## Unknowns to settle with the hardware

- Whether the Frame's game-mode (Steam client) browser is enough, or whether desktop
  mode is needed for a full Chromium. The game-mode one is CEF and should run xterm,
  but it may not offer fullscreen or the clipboard.
- How the SteamOS on-screen keyboard behaves against xterm's hidden textarea: whether
  it opens on focus, or only on Steam+X. A Bluetooth keyboard sidesteps this.
- Whether the thumbstick produces wheel events in the browser, and at what rate.
- Whether the Frame lets one browser window be pinned as a curved screen wide enough
  for three columns of terminal at 18px. If the window is narrower than expected, the
  auto layout still works, it will just choose fewer columns.

## The app (added the same day)

Brendon wants an app on the Frame, not a browser tab. The Frame runs Android apps
natively through Lepton, Valve's fork of Waydroid (an AOSP-based runtime), and
Valve supports sideloading APKs. So the headset app is the Tauri Android build of
this same frontend: `Valkyrie_<version>_arm64.apk` on every GitHub release from
v0.3.91 on. Set the device profile to `vr` in Settings and it opens on the desk.

A Tauri Android app renders in the system WebView. Waydroid images ship the AOSP
WebView, so the bet is that Lepton does too; that is the single thing that can sink
this route, and only the hardware can settle it. The fallback is a native Linux
arm64 build (Flatpak or AppImage) run from desktop mode.

How it is built, all on odin:

- `scripts/android-toolchain.sh` installs Temurin JDK 21, the SDK command-line
  tools, platform-tools and NDK 28 under `$HOME`, accepts the licenses, and adds the
  `aarch64-linux-android` Rust target. No root. About 2.8 GB.
- `scripts/android-env.sh` exports `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`.
- `frontend/src-tauri/gen/android` is the generated project, committed. Its
  `build.gradle.kts` signs release builds from `keystore.properties`, which
  `scripts/android-build.sh` writes on each run from `~/.tauri/valkyrie-android.jks`
  and `~/.tauri/valkyrie-android.pw`, both created once with `keytool` and never
  committed. Losing that keystore means the next APK cannot update over the old one;
  it is in the odin backups by virtue of living in `~/.tauri`.
- `scripts/android-build.sh [--debug]` builds the arm64 APK and prints its path.
  `release.sh` calls it when the toolchain and keystore exist and uploads the APK
  next to the installers. There is no updater manifest entry: it is sideloaded, so
  updating means installing the next release's APK over it.
- Cleartext HTTP is left on in release so `resolveApiBase()` can find odin on the
  tailnet; off the tailnet it falls back to the Cloudflare hostname and the app signs
  in with the app token like the desktop build.

Desktop-only code is gated for mobile: the window-state plugin and the hidden-window
cold-start recovery in `lib.rs`, and in the frontend the window controls, the header
padding for them, the updater, and the session board's "on screen" mode
(`isTauriMobile()` in `lib/auth.ts`).

Installing on the Frame: copy the APK to the headset (USB, or download it in the
desktop-mode browser from the GitHub release) and install it the way Valve's
sideloading flow expects; the exact UI is not public before launch. Sideloaded apps
are expected to show in the Steam library.
