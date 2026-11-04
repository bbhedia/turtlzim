// A stand-in for `systemctl --user` in the tests of scripts/deploy/turtlzim-update.mjs: it starts and stops the real server of the version that `current` points at, as the unit does, and says what it was asked in
// `calls.log`. What it is told (where the versions are, the server's arguments, which versions "do not come up", whether the old version needs the backup back) is in the JSON file that FAKE_SYSTEMD names, read at each call.
//
//   node fake-systemctl.mjs restart|start|stop UNIT
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const config = JSON.parse(readFileSync(process.env.FAKE_SYSTEMD, "utf8"));
const [verb, unit] = process.argv.slice(2);
appendFileSync(join(config.dir, "calls.log"), `${verb} ${unit}\n`);
const pidFile = join(config.dir, "server.pid");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stop() {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  rmSync(pidFile, { force: true });
  if (!alive(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

function start() {
  let release;
  try {
    release = resolve(config.root, readlinkSync(join(config.root, "current")));
  } catch {
    return; // (the unit's condition: nothing to start without a version)
  }
  let restored = false;
  try {
    restored = readdirSync(config.data).some((name) => name.startsWith("replaced-"));
  } catch {
    // (no data folder yet)
  }
  // a version that does not come up (nothing listens), and an old version that cannot take the data that the new one changed until the backup is back
  if (config.bad.includes(basename(release)) || (config.needRestore && !restored)) return;
  const log = openSync(join(config.dir, "server.log"), "a");
  const child = spawn(process.execPath, [join(release, "server/src/main.mjs"), ...config.args], {
    cwd: join(release, "server"),
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, ZIM_SERVER_DATA: config.data, XDG_STATE_HOME: join(config.dir, "state"), ZIM_BASE_URL: "https://127.0.0.1" },
  });
  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`);
}

if (verb === "restart") {
  await stop();
  start();
} else if (verb === "stop") {
  await stop();
} else if (verb === "start") {
  start();
} else {
  console.error(`fake systemctl: what is ${verb}?`);
  process.exit(2);
}
