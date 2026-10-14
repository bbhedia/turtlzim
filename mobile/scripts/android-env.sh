# Source this: `. scripts/android-env.sh`. The JDK and the Android SDK that docs/zim-mobile-shell.md installs under ~/android (no root).
export JAVA_HOME="${JAVA_HOME:-$HOME/android/jdk-21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
