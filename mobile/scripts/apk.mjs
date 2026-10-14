// Build the debug APK: `npm run apk` from this folder (after `npm run build` in ../web). The tools are looked for where
// docs/zim-mobile-shell.md puts them (~/android: a JDK and the Android SDK, installed without root); JAVA_HOME and ANDROID_HOME win.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
env.JAVA_HOME ??= join(homedir(), "android/jdk-21");
env.ANDROID_HOME ??= join(homedir(), "android/sdk");
env.ANDROID_SDK_ROOT ??= env.ANDROID_HOME;
env.PATH = `${join(env.JAVA_HOME, "bin")}:${env.PATH}`;
for (const [what, path] of [["a JDK (JAVA_HOME)", env.JAVA_HOME], ["the Android SDK (ANDROID_HOME)", env.ANDROID_HOME]]) {
  if (!existsSync(path)) {
    console.error(`${what} is not at ${path}: see docs/zim-mobile-shell.md.`);
    process.exit(1);
  }
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(process.execPath, [join(root, "scripts/prepare.mjs")], root);
run(join(root, "node_modules/.bin/cap"), ["sync", "android"], root);
run(join(root, "android/gradlew"), ["assembleDebug"], join(root, "android"));

const built = join(root, "android/app/build/outputs/apk/debug/app-debug.apk");
mkdirSync(join(root, "out"), { recursive: true });
const kept = join(root, "out/zim-notebook-debug.apk");
copyFileSync(built, kept);
console.log(`${kept} (${(statSync(kept).size / 1048576).toFixed(1)} MB)`);
