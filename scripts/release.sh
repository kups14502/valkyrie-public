#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: scripts/release.sh <version>}"
TAG="app-v${VERSION}"
REPO="${REPO:-kups14502/valkyrie}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
TAURI_CONF="$FRONTEND/src-tauri/tauri.conf.json"
KEY_FILE="${TAURI_SIGNING_PRIVATE_KEY_FILE:-$HOME/.tauri/valkyrie-updater.key}"
PW_FILE="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE:-$HOME/.tauri/valkyrie-updater.pw}"
NOTES="${RELEASE_NOTES:-Pop-out windows, iOS Safari fix, custom Windows updater}"
MANIFEST_NOTES="${MANIFEST_NOTES:-Pop-out windows, mobile fixes, custom updater UI}"

[[ -f "$HOME/.cargo/env" ]] && # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
export PATH="$HOME/.local/bin:$PATH"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }
need node
need npm
need npx
need gh
need jq
need cargo
need rustup
# NSIS: Tauri v2 downloads its own NSIS into the tauri cache when bundling
# on Linux, so a system makensis is not required. Just note if absent.
command -v makensis.exe >/dev/null 2>&1 || command -v makensis >/dev/null 2>&1 || echo "note: no system makensis; Tauri will download NSIS during the nsis bundle step" >&2

if [[ ! -f "$KEY_FILE" ]]; then
  echo "missing Tauri signing private key: $KEY_FILE" >&2
  exit 1
fi
if [[ ! -f "$PW_FILE" ]]; then
  echo "missing Tauri signing private key password file: $PW_FILE" >&2
  exit 1
fi

cd "$ROOT"
# Build from main, but remember and restore whatever branch was checked out:
# parallel feature-branch sessions must not find their checkout yanked away
# by a release build.
PREV_BRANCH="$(git branch --show-current || true)"
restore_branch() {
  if [[ -n "$PREV_BRANCH" && "$PREV_BRANCH" != "main" ]]; then
    git checkout "$PREV_BRANCH" >/dev/null 2>&1 || true
  fi
}
trap restore_branch EXIT
git checkout main
git pull --ff-only
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  git tag "$TAG"
  git push origin "$TAG"
fi

cd "$FRONTEND"
# --include=dev: the server runs with NODE_ENV=production, under which `npm ci`
# omits devDependencies (@tauri-apps/cli, vite, etc.) and the build can't run.
npm ci --include=dev

export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PW_FILE")"

node - "$TAURI_CONF" "$VERSION" <<'NODE'
const fs = require('fs');
const [file, version] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
c.version = version;
fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
NODE

# Linux AppImage build. APPIMAGE_EXTRACT_AND_RUN avoids FUSE dependency on headless servers.
export APPIMAGE_EXTRACT_AND_RUN=1
export NO_STRIP=1
npx tauri build --bundles appimage

# Windows NSIS cross-build
rustup target add x86_64-pc-windows-msvc
if ! command -v cargo-xwin >/dev/null 2>&1; then
  cargo install --locked cargo-xwin
fi
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis

# Select this build's artifacts by exact version name. The bundle dirs keep
# every past build, so a glob + `sort | tail -1` grabbed the wrong file once
# patches hit two digits (lexicographically "0.3.10" sorts before "0.3.9"),
# which shipped a stale installer in the manifest. Naming the exact file is
# deterministic and the existence check below fails loudly if Tauri's naming
# ever changes.
APPIMAGE="$FRONTEND/src-tauri/target/release/bundle/appimage/Valkyrie_${VERSION}_amd64.AppImage"
APPIMAGE_SIG="$APPIMAGE.sig"
SETUP_EXE="$FRONTEND/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Valkyrie_${VERSION}_x64-setup.exe"
SETUP_SIG="$SETUP_EXE.sig"
for f in "$APPIMAGE" "$APPIMAGE_SIG" "$SETUP_EXE" "$SETUP_SIG"; do
  [[ -f "$f" ]] || { echo "missing expected artifact: $f" >&2; exit 1; }
done

# Android APK (arm64), for the Steam Frame and the phone. Sideloaded, so it is
# uploaded next to the installers and left out of the updater manifest. Built
# only where the toolchain exists (scripts/android-toolchain.sh); a machine
# without it still ships the desktop release.
APK=""
if [[ -d "$HOME/Android/Sdk/ndk" && -f "$HOME/.tauri/valkyrie-android.jks" ]]; then
  APK_BUILT="$("$ROOT/scripts/android-build.sh" | tail -1)"
  [[ -f "$APK_BUILT" ]] || { echo "android build printed no APK: $APK_BUILT" >&2; exit 1; }
  APK="$FRONTEND/src-tauri/target/Valkyrie_${VERSION}_arm64.apk"
  cp -f "$APK_BUILT" "$APK"
else
  echo "note: no Android toolchain or keystore here; skipping the APK" >&2
fi

MANIFEST="$ROOT/latest.json"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
APPIMAGE_NAME="$(basename "$APPIMAGE")"
SETUP_NAME="$(basename "$SETUP_EXE")"
jq -n \
  --arg version "$VERSION" \
  --arg notes "$MANIFEST_NOTES" \
  --arg pub_date "$PUB_DATE" \
  --arg win_sig "$(cat "$SETUP_SIG")" \
  --arg win_url "https://github.com/$REPO/releases/download/$TAG/$SETUP_NAME" \
  --arg linux_sig "$(cat "$APPIMAGE_SIG")" \
  --arg linux_url "https://github.com/$REPO/releases/download/$TAG/$APPIMAGE_NAME" \
  '{version:$version, notes:$notes, pub_date:$pub_date, platforms:{"windows-x86_64":{signature:$win_sig,url:$win_url}, "linux-x86_64":{signature:$linux_sig,url:$linux_url}}}' \
  > "$MANIFEST"

ASSETS=("$SETUP_EXE" "$APPIMAGE" "$MANIFEST")
[[ -n "$APK" ]] && ASSETS+=("$APK")
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "${ASSETS[@]}" --repo "$REPO" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" \
    --title "Valkyrie v$VERSION" \
    --notes "$NOTES" \
    --repo "$REPO"
fi

# Commit the version bump here, on main, while we still hold the checkout —
# the EXIT trap restores any feature branch afterwards, so deferring this
# would land the bump on the wrong branch.
cd "$ROOT"
git add "$TAURI_CONF" "$MANIFEST"
git commit -m "release: v${VERSION}

App version bump and updater manifest from the v${VERSION} desktop build.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" || true
git push origin main

echo "release: https://github.com/$REPO/releases/tag/$TAG"
echo "manifest: $MANIFEST"
