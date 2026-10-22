// scripts/run.sh as a person uses it, on a server of its own (its state in a folder of the test's): it starts and says where it is, `check` says whether it answers, a backup is made while it runs and is
// listed and checked, a restore stops it, puts the copy back and starts it again (and a copy that is not whole is refused before anything is stopped), and the log is moved aside when it has grown.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const script = fileURLToPath(new URL("../scripts/run.sh", import.meta.url));
const dist = fileURLToPath(new URL("../../web/dist/index.html", import.meta.url));
const state = mkdtempSync(join(tmpdir(), "zim-run-test-"));
const data = join(state, "zim-server");
const env = { ...process.env, XDG_STATE_HOME: state, ZIM_BASE_URL: "http://127.0.0.1", ZIM_LOG_MAX_BYTES: "100000", PATH: process.env.PATH };
delete env.ZIM_SERVER_DATA;
// (a state folder that was there before, with the mode that a umask of 002 gives: the script makes it private)
mkdirSync(data, { recursive: true });
chmodSync(data, 0o775);
const run = (...args) => {
  const done = spawnSync("bash", [script, ...args], { env, encoding: "utf8", timeout: 60_000 });
  return { status: done.status, out: done.stdout + done.stderr };
};
after(() => {
  run("stop");
  rmSync(state, { recursive: true, force: true });
});

const users = () => {
  const db = new DatabaseSync(join(data, "zim.sqlite"), { readOnly: true });
  try {
    return db.prepare("select email from users order by id").all().map((row) => row.email);
  } finally {
    db.close();
  }
};
const addUser = (id, email) => {
  const db = new DatabaseSync(join(data, "zim.sqlite"));
  db.exec("pragma busy_timeout = 5000");
  db.prepare("insert into users (id, email, created_at, quota_bytes) values (?, ?, 1, 1048576)").run(id, email);
  db.close();
};

describe("scripts/run.sh", { skip: !existsSync(dist) && "web/dist is not built" }, () => {
  it("says what it does when it is asked wrong, and that it is not running when it is not", () => {
    const help = run("nonsense");
    assert.equal(help.status, 2);
    assert.match(help.out, /scripts\/run\.sh backup/);
    assert.match(help.out, /scripts\/run\.sh restore BACKUP/);
    const check = run("check");
    assert.equal(check.status, 3);
    assert.match(check.out, /not running/);
    assert.equal(run("restore").status, 2, "a restore says which copy it wants");
    assert.equal(statSync(data).mode & 0o777, 0o700, "its state folder (the log has the addresses that people come from) is for its owner only");
  });

  it("starts, answers a check, and is backed up while it runs", () => {
    const started = run("start", "--host", "127.0.0.1", "--port", "0");
    assert.equal(started.status, 0, started.out);
    assert.match(started.out, /started \(pid \d+\)/);
    assert.match(started.out, /http:\/\/127\.0\.0\.1:\d+\//);
    const check = run("check");
    assert.equal(check.status, 0, check.out);
    assert.match(check.out, /^ok: http:\/\/127\.0\.0\.1:\d+\/ answers, and so does its database \(pid \d+\)/);
    assert.equal(run("status").status, 0);
    addUser(1, "ada@example.org");
    const made = run("backup", "--keep", "3");
    assert.equal(made.status, 0, made.out);
    const folder = /backed up to (\S+)/.exec(made.out)?.[1];
    assert.ok(folder && folder.startsWith(join(data, "backups")), made.out);
    assert.match(made.out, /1 users/);
    const listed = run("backups");
    assert.match(listed.out, /zim-backup-\d{8}T\d{6}Z .*whole/);
    assert.equal(run("verify", folder).status, 0);
    // a check still answers after all that: the backup did not trouble the server
    assert.equal(run("check").status, 0);
  });

  it("is restored: stopped, the copy put back, started again; what it replaced is kept, and a copy that is not whole is refused before anything is stopped", () => {
    const folder = readdirSync(join(data, "backups")).sort().at(-1);
    const backupFolder = join(data, "backups", folder);
    // later than the copy: another account, and a change of the key
    addUser(2, "grace@example.org");
    assert.deepEqual(users(), ["ada@example.org", "grace@example.org"]);
    // a copy that was changed is refused, and the server keeps running (it was not stopped for nothing)
    const bad = join(data, "backups", "zim-backup-20200101T000000Z");
    run("verify", backupFolder);
    spawnSync("cp", ["-r", backupFolder, bad]);
    writeFileSync(join(bad, "secret.key"), "changed");
    const refused = run("restore", bad);
    assert.equal(refused.status, 1, refused.out);
    assert.match(refused.out, /NOT whole/);
    assert.equal(run("check").status, 0, "the server is still up");
    assert.deepEqual(users(), ["ada@example.org", "grace@example.org"], "and nothing was changed");
    rmSync(bad, { recursive: true, force: true });
    // the copy that is whole
    const restored = run("restore", backupFolder);
    assert.equal(restored.status, 0, restored.out);
    assert.match(restored.out, /stopped \(was pid \d+\)/);
    assert.match(restored.out, /restored .*zim\.sqlite/);
    assert.match(restored.out, /started \(pid \d+\)/);
    assert.equal(run("check").status, 0, "it is up again");
    assert.deepEqual(users(), ["ada@example.org"], "with what the copy had");
    const aside = readdirSync(data).filter((name) => name.startsWith("replaced-"));
    assert.equal(aside.length, 1);
    const kept = new DatabaseSync(join(data, aside[0], "zim.sqlite"), { readOnly: true });
    assert.equal(kept.prepare("select count(*) as n from users where email = 'grace@example.org'").get().n, 1, "what it replaced is kept");
    kept.close();
  });

  it("keeps its backups where the server keeps its data: ZIM_SERVER_DATA, when it is set", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "zim-run-data-"));
    try {
      const done = spawnSync("bash", [script, "backups"], { env: { ...env, ZIM_SERVER_DATA: elsewhere }, encoding: "utf8", timeout: 60_000 });
      assert.equal(done.status, 0, done.stderr);
      assert.ok(done.stdout.includes(`no backup in ${join(elsewhere, "backups")}`), done.stdout);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("stops, and says so", () => {
    assert.match(run("stop").out, /stopped \(was pid \d+\)/);
    assert.equal(run("check").status, 3);
    assert.match(run("stop").out, /not running/);
  });

  it("is restored when it is not running: the copy is put back, and it is not started", () => {
    const folder = join(data, "backups", readdirSync(join(data, "backups")).sort().at(-1));
    const restored = run("restore", folder);
    assert.equal(restored.status, 0, restored.out);
    assert.match(restored.out, /restored; start the server with/);
    assert.equal(run("status").status, 3);
  });

  it("moves its log aside when it has grown, keeps three, and leaves a small one alone", () => {
    const log = join(state, "zim-server", "serve.log");
    writeFileSync(log, "first log\n".repeat(20_000));
    assert.equal(run("start", "--host", "127.0.0.1", "--port", "0").status, 0);
    assert.ok(readFileSync(`${log}.1`, "utf8").startsWith("first log"), "what was there is in serve.log.1");
    assert.ok(!readFileSync(log, "utf8").includes("first log"), "and the new log is a new one");
    const small = readFileSync(log, "utf8").length;
    assert.ok(small < 100_000);
    run("stop");
    // a log that is not large is kept going
    assert.equal(run("start", "--host", "127.0.0.1", "--port", "0").status, 0);
    assert.ok(!existsSync(`${log}.2`), "a small log is not moved aside");
    run("stop");
    for (const round of ["second", "third", "fourth", "fifth"]) {
      writeFileSync(log, `${round} log\n`.repeat(20_000));
      assert.equal(run("start", "--host", "127.0.0.1", "--port", "0").status, 0);
      run("stop");
    }
    assert.ok(readFileSync(`${log}.1`, "utf8").startsWith("fifth"));
    assert.ok(readFileSync(`${log}.2`, "utf8").startsWith("fourth"));
    assert.ok(readFileSync(`${log}.3`, "utf8").startsWith("third"));
    assert.ok(!existsSync(`${log}.4`), "three old logs, no more");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// ensure: what cron runs every minute to keep the server up (on a state folder of its own, and a command that is given what has to be told, which writes it down)

describe("scripts/run.sh ensure", { skip: !existsSync(dist) && "web/dist is not built" }, () => {
  const folder = mkdtempSync(join(tmpdir(), "zim-ensure-test-"));
  const mine = join(folder, "zim-server");
  const alertsFile = join(folder, "alerts.txt");
  const settings = { ...env, XDG_STATE_HOME: folder, ZIM_CHECK_TIMEOUT: "2", ZIM_LOCK_WAIT: "8", ZIM_ALERT_FILE: alertsFile, ZIM_ALERT_COMMAND: 'printf "%s\\n" "$1" >>"$ZIM_ALERT_FILE"' };
  const runWith = (given, ...args) => {
    const done = spawnSync("bash", [script, ...args], { env: given, encoding: "utf8", timeout: 120_000 });
    return { status: done.status, out: done.stdout + done.stderr, said: done.stdout };
  };
  const ensure = (...args) => runWith(settings, ...args);
  const watchLog = () => (existsSync(join(mine, "watch.log")) ? readFileSync(join(mine, "watch.log"), "utf8") : "");
  const alerts = () => (existsSync(alertsFile) ? readFileSync(alertsFile, "utf8").trim().split("\n") : []);
  const pidOf = () => Number(readFileSync(join(mine, "serve.pid"), "utf8"));
  const gone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  const waitFor = async (condition, what) => {
    for (let waited = 0; !condition(); waited += 100) {
      assert.ok(waited < 15_000, `never: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const killAndWait = async (pid) => {
    process.kill(pid, "SIGKILL");
    await waitFor(() => gone(pid), "the process ended");
  };
  after(() => {
    ensure("stop");
    rmSync(folder, { recursive: true, force: true });
  });

  it("does nothing, and says nothing, while the server answers", () => {
    assert.equal(ensure("start", "--host", "127.0.0.1", "--port", "0").status, 0);
    const done = ensure("ensure");
    assert.equal(done.status, 0, done.out);
    assert.equal(done.out, "");
    assert.equal(watchLog(), "", "nothing is written down for a server that is well");
    assert.deepEqual(alerts(), []);
  });

  it("starts the server again when it is not running, says so (output, log, and the command that was given), and then it answers", async () => {
    const before = pidOf();
    await killAndWait(before);
    const done = ensure("ensure");
    assert.equal(done.status, 0, done.out);
    assert.match(done.said, /^the server was not running: it was started again \(pid \d+\)\n$/);
    assert.notEqual(pidOf(), before);
    assert.equal(ensure("check").status, 0, "it answers");
    assert.match(watchLog(), /Z the server was not running: it was started again \(pid \d+\)/);
    assert.equal(alerts().length, 1);
    assert.match(alerts()[0], /the server was not running: it was started again/);
    assert.equal(ensure("ensure").out, "", "and the next one has nothing to say");
  });

  it("leaves alone a server that was stopped on purpose, and watches again once it is started by hand", () => {
    assert.match(ensure("stop").out, /stopped \(was pid \d+\)/);
    assert.equal(existsSync(join(mine, "stopped")), true);
    const done = ensure("ensure");
    assert.equal(done.out, "");
    assert.equal(ensure("status").status, 3, "it was not started");
    assert.equal(alerts().length, 1, "and nothing was told");
    assert.equal(ensure("start", "--host", "127.0.0.1", "--port", "0").status, 0);
    assert.equal(existsSync(join(mine, "stopped")), false);
    assert.equal(ensure("ensure").out, "");
  });

  it("restarts a server that does not answer, but only the second time in a row (once may be a moment of load), and a good answer between starts the count again", async () => {
    const stuck = pidOf();
    process.kill(stuck, "SIGSTOP");
    const asked = Date.now();
    const first = ensure("ensure");
    assert.ok(Date.now() - asked < 8000, `it waits ZIM_CHECK_TIMEOUT (2 s) for an answer, not longer (${Date.now() - asked} ms)`);
    assert.equal(first.out, "", "once is not enough");
    assert.equal(pidOf(), stuck);
    assert.match(watchLog(), /did not answer: once/);
    assert.equal(existsSync(join(mine, "watch.failures")), true);
    // it answers again: the count is gone
    process.kill(stuck, "SIGCONT");
    await waitFor(() => ensure("check").status === 0, "the server answered again");
    assert.equal(ensure("ensure").out, "");
    assert.equal(existsSync(join(mine, "watch.failures")), false, "a good answer clears the count");
    // once more, and once again: that is twice in a row only if nothing good came between
    process.kill(stuck, "SIGSTOP");
    assert.equal(ensure("ensure").out, "", "once, again");
    assert.equal(pidOf(), stuck);
    const second = ensure("ensure");
    assert.match(second.said, /^the server \(pid \d+\) did not answer twice in a row: it was started again \(pid \d+\)\n$/);
    assert.notEqual(pidOf(), stuck);
    assert.equal(ensure("check").status, 0, "the new one answers");
    await waitFor(() => gone(stuck), "the one that did not answer is gone");
    assert.equal(alerts().length, 2);
    assert.match(alerts()[1], /did not answer twice in a row/);
  });

  it("gives up after three restarts in ten minutes (not counting older ones), says so once, does nothing more, and tries again after a start by hand", async () => {
    // a server that can't start: a node that ends at once, first on the path
    const fake = mkdtempSync(join(tmpdir(), "zim-fake-node-"));
    writeFileSync(join(fake, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const broken = { ...settings, PATH: `${fake}:${process.env.PATH}` };
    await killAndWait(pidOf());
    // restarts that were made long ago are not counted
    const longAgo = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(join(mine, "watch.restarts"), `${longAgo}\n${longAgo}\n${longAgo}\n`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const done = runWith(broken, "ensure");
      assert.match(done.said, /the server was not running, and it could not be started again/, `attempt ${attempt}`);
    }
    const gave = runWith(broken, "ensure");
    assert.match(gave.said, /the server was not running, and it has been restarted 3 times in the last 10 minutes: giving up/);
    assert.equal(existsSync(join(mine, "watch.gaveup")), true);
    assert.equal(runWith(broken, "ensure").out, "", "and nothing more is said");
    assert.equal(alerts().filter((line) => /giving up/.test(line)).length, 1, "the person was told once");
    assert.equal(ensure("ensure").out, "", "(not even with a node that works: it gave up)");
    assert.equal(ensure("status").status, 3);
    // started by hand, with the node that works: the watch begins again, and the count with it
    assert.equal(ensure("start", "--host", "127.0.0.1", "--port", "0").status, 0);
    assert.equal(existsSync(join(mine, "watch.gaveup")), false);
    assert.equal(existsSync(join(mine, "watch.restarts")), false);
    await killAndWait(pidOf());
    assert.match(ensure("ensure").said, /it was started again/);
    rmSync(fake, { recursive: true, force: true });
  });

  it("does nothing while the server is being changed by another command (they hold a lock), and the commands that change it wait for it", async () => {
    await killAndWait(pidOf());
    const hold = (seconds) => spawn("flock", ["-w", "10", join(mine, "watch.lock"), "sleep", String(seconds)], { stdio: "ignore" });
    let holder = hold(4);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(ensure("ensure").out, "", "ensure left the server as it was");
    assert.equal(ensure("status").status, 3, "and did not start it");
    // (a restart of a server that is not running starts it: it waits for the lock first)
    const began = Date.now();
    const restarted = ensure("restart", "--host", "127.0.0.1", "--port", "0");
    assert.equal(restarted.status, 0, restarted.out);
    assert.ok(Date.now() - began >= 2500, `restart waited for the lock (${Date.now() - began} ms)`);
    // a stop waits too, and so does a restore (which looks at its copy first, and then waits)
    holder.kill();
    await new Promise((resolve) => holder.once("close", resolve));
    const made = ensure("backup");
    const copy = /backed up to (\S+)/.exec(made.out)?.[1];
    assert.ok(copy, made.out);
    holder = hold(4);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stopStart = Date.now();
    assert.equal(ensure("stop").status, 0);
    assert.ok(Date.now() - stopStart >= 2500, `stop waited for the lock (${Date.now() - stopStart} ms)`);
    holder.kill();
    await new Promise((resolve) => holder.once("close", resolve));
    holder = hold(4);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const restoreStart = Date.now();
    assert.equal(ensure("restore", copy).status, 0);
    assert.ok(Date.now() - restoreStart >= 2500, `restore waited for the lock (${Date.now() - restoreStart} ms)`);
    holder.kill();
    // what was stopped on purpose is still stopped after a restore of a stopped server, and ensure does not start it in the middle of anything
    assert.equal(ensure("ensure").out, "");
    assert.equal(ensure("status").status, 3);
  });
});
