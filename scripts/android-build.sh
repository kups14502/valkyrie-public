#!/usr/bin/env bash
# Build the signed Valkyrie APK for arm64 (the Steam Frame and any phone).
#
#   scripts/android-build.sh            # release, signed with ~/.tauri/valkyrie-android.jks
#   scripts/android-build.sh --debug    # debug, signed with the Android debug key
#
# Prints the path of the APK it produced. release.sh calls this and uploads the
# file to the GitHub release next to the desktop installers; the APK is
# sideloaded, so there is no updater manifest entry for it.
#
# The toolchain comes from scripts/android-toolchain.sh. The keystore is made
# once by hand (see docs/vr-mode.md) and never leaves ~/.tauri: the
# keystore.properties Gradle reads is written here on every build, into a path
# gen/android/.gitignore already excludes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
GEN="$FRONTEND/src-tauri/gen/android"
JKS="${VALKYRIE_ANDROID_KEYSTORE:-$HOME/.tauri/valkyrie-android.jks}"
PW_FILE="${VALKYRIE_ANDROID_KEYSTORE_PASSWORD_FILE:-$HOME/.tauri/valkyrie-android.pw}"

# shellcheck disable=SC1091
source "$ROOT/scripts/android-env.sh"
[[ -f "$HOME/.cargo/env" ]] && # shellcheck disable=SC1091
  source "$HOME/.cargo/env"

for v in JAVA_HOME ANDROID_HOME NDK_HOME; do
  [[ -d "${!v}" ]] || { echo "$v=${!v} is not a directory; run scripts/android-toolchain.sh" >&2; exit 1; }
done
[[ -d "$GEN" ]] || { echo "missing $GEN; run: cd frontend && npx tauri android init" >&2; exit 1; }

DEBUG=0
[[ "${1:-}" == "--debug" ]] && DEBUG=1

if [[ $DEBUG -eq 0 ]]; then
  [[ -f "$JKS" ]] || { echo "missing Android keystore: $JKS" >&2; exit 1; }
  [[ -f "$PW_FILE" ]] || { echo "missing keystore password file: $PW_FILE" >&2; exit 1; }
  umask 077
  cat > "$GEN/keystore.properties" <<EOF
password=$(cat "$PW_FILE")
keyAlias=valkyrie
storeFile=$JKS
EOF
fi

cd "$FRONTEND"
if [[ $DEBUG -eq 1 ]]; then
  npx tauri android build --apk --target aarch64 --debug
else
  npx tauri android build --apk --target aarch64
fi

# Tauri names the folder after the Android ABI, not the Rust target.
KIND=release
[[ $DEBUG -eq 1 ]] && KIND=debug
APK="$(find "$GEN/app/build/outputs/apk" -path "*/$KIND/*.apk" -newer "$FRONTEND/src-tauri/tauri.conf.json" 2>/dev/null | head -1 || true)"
[[ -n "$APK" ]] || APK="$(find "$GEN/app/build/outputs/apk" -path "*/$KIND/*.apk" 2>/dev/null | head -1 || true)"
[[ -f "$APK" ]] || { echo "no $KIND APK under $GEN/app/build/outputs/apk" >&2; exit 1; }
echo "$APK"
