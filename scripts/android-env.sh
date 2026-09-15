# Source this before `tauri android ...` or the APK step of a release.
# Matches what scripts/android-toolchain.sh installs; nothing here is a choice.
export JAVA_HOME="$HOME/.local/jdk-21"
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 "$ANDROID_HOME/ndk" 2>/dev/null | sort -V | tail -1)"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
