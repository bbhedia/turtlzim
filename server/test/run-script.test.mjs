// scripts/run.sh as a person uses it, on a server of its own (its state in a folder of the test's): it starts and says where it is, `check` says whether it answers, a backup is made while it runs and is
// listed and checked, a restore stops it, puts the copy back and starts it again (and a copy that is not whole is refused before anything is stopped), and the log is moved aside when it has grown.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
