#!/usr/bin/env bash
# Android build toolchain for the Valkyrie APK, installed entirely under $HOME
# so it needs no root and lives beside the rest of the release tooling on odin.
#
#   scripts/android-toolchain.sh          # install or update everything
#   . scripts/android-env.sh              # then, in any shell that builds
#
# What it puts where:
#   ~/.local/jdk-21           Temurin JDK 21 (Gradle and the Android plugin want 17+)
#   ~/Android/Sdk             command-line tools, platform-tools, one NDK
#   rustup                    the aarch64-linux-android target (the Frame and
#                             every phone made this decade; x86_64 only for an
#                             emulator, add it by hand if ever needed)
#
# The SDK platform and build-tools are NOT installed here: the Android Gradle
# plugin downloads the exact versions the generated project asks for, as long
# as the licenses are accepted, which this does.
set -euo pipefail

JDK_DIR="$HOME/.local/jdk-21"
SDK_DIR="$HOME/Android/Sdk"
# A specific NDK rather than "latest" so two machines build the same bytes.
NDK_VERSION="28.2.13676358"
# Command-line tools package from https://developer.android.com/studio#command-line-tools-only
CMDLINE_URL="https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"

log() { printf '\n== %s\n' "$*"; }

log "JDK"
if [[ ! -x "$JDK_DIR/bin/java" ]]; then
  mkdir -p "$JDK_DIR"
  curl -fsSL -o /tmp/temurin21.tar.gz \
    "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
  tar -xzf /tmp/temurin21.tar.gz -C "$JDK_DIR" --strip-components=1
  rm -f /tmp/temurin21.tar.gz
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"
java -version 2>&1 | head -1

log "SDK command-line tools"
if [[ ! -x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]]; then
  mkdir -p "$SDK_DIR/cmdline-tools"
  curl -fsSL -o /tmp/cmdline-tools.zip "$CMDLINE_URL"
  rm -rf /tmp/cmdline-tools && mkdir -p /tmp/cmdline-tools
  unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools
  # The zip unpacks to cmdline-tools/, and sdkmanager insists on living in
  # cmdline-tools/<version>/ under the SDK root.
  rm -rf "$SDK_DIR/cmdline-tools/latest"
  mv /tmp/cmdline-tools/cmdline-tools "$SDK_DIR/cmdline-tools/latest"
  rm -rf /tmp/cmdline-tools /tmp/cmdline-tools.zip
fi
export ANDROID_HOME="$SDK_DIR"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
SDKM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"

log "licenses"
yes | "$SDKM" --licenses > /dev/null 2>&1 || true

log "platform-tools and NDK $NDK_VERSION"
"$SDKM" --install "platform-tools" "ndk;$NDK_VERSION" > /dev/null
export NDK_HOME="$ANDROID_HOME/ndk/$NDK_VERSION"
[[ -d "$NDK_HOME" ]] || { echo "NDK did not land at $NDK_HOME" >&2; exit 1; }

log "rust target"
rustup target add aarch64-linux-android

log "done"
echo "JAVA_HOME=$JAVA_HOME"
echo "ANDROID_HOME=$ANDROID_HOME"
echo "NDK_HOME=$NDK_HOME"
du -sh "$JDK_DIR" "$SDK_DIR" 2>/dev/null
