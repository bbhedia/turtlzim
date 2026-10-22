// The database file (src/db.mjs): it holds everyone's accounts and the notebooks kept on the server, so it is for its owner only, with the journal files beside it, whether the server made it or found it
// as an older server left it (SQLite gives a file it makes the mode 644: readable by every other user of the computer).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { epochOf, openDatabase, renewEpoch } from "../src/db.mjs";

const folders = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));
const scratch = () => {
  const folder = mkdtempSync(join(tmpdir(), "zim-db-test-"));
  folders.push(folder);
  return folder;
};
const mode = (path) => statSync(path).mode & 0o777;

describe("the database file", () => {
  it("is made for its owner only, and so are its journal files while it is open", () => {
    const path = join(scratch(), "zim.sqlite");
    const db = openDatabase(path);
    db.prepare("insert into users (id, email, created_at, quota_bytes) values (1, 'ada@example.org', 1, 1)").run();
    assert.equal(mode(path), 0o600);
    assert.ok(existsSync(`${path}-wal`) && existsSync(`${path}-shm`), "the journal files are there while it is open");
    assert.equal(mode(`${path}-wal`), 0o600);
    assert.equal(mode(`${path}-shm`), 0o600);
    db.close();
  });

  it("is made private when it was found readable by others, with the journal files of a server that was killed (they hold what it had not yet written into the file), and keeps what they hold", async () => {
    const path = join(scratch(), "zim.sqlite");
    // a server that is killed in the middle of its work leaves a journal with rows in it that are not in the file yet
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { openDatabase } from ${JSON.stringify(new URL("../src/db.mjs", import.meta.url).href)};
         const db = openDatabase(${JSON.stringify(path)});
         db.prepare("insert into users (id, email, created_at, quota_bytes) values (1, 'ada@example.org', 1, 1)").run();
         console.log("written");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise((resolve) => child.stdout.once("data", resolve));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    assert.ok(statSync(`${path}-wal`).size > 0, "the journal holds what was written");
    // as an older server left it: 644 (the file and the journal files)
    for (const file of [path, `${path}-wal`, `${path}-shm`]) chmodSync(file, 0o644);
    const db = openDatabase(path);
    assert.equal(db.prepare("select email from users").get().email, "ada@example.org", "what the journal held is there");
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      assert.ok(existsSync(file), file);
      assert.equal(mode(file), 0o600, file);
    }
    db.close();
  });

  it("has a generation for its data (what a device remembers to tell that the data went back in time): made with the database, kept by every opening of it, new when it is renewed", () => {
    const path = join(scratch(), "zim.sqlite");
    const first = openDatabase(path);
    const made = epochOf(first);
    assert.match(made, /^[0-9a-f]{32}$/);
    first.close();
    const second = openDatabase(path);
    assert.equal(epochOf(second), made, "the same one when it is opened again");
    const renewed = renewEpoch(second);
    assert.match(renewed, /^[0-9a-f]{32}$/);
    assert.notEqual(renewed, made);
    assert.equal(epochOf(second), renewed);
    second.close();
    const third = openDatabase(path);
    assert.equal(epochOf(third), renewed, "and the new one is kept");
    // every renewal is a generation of its own (a restore after a restore is another, so that a device that synced after the first one is not taken for one that did not need to)
    const seen = new Set([made, renewed]);
    for (let n = 0; n < 5; n++) seen.add(renewEpoch(third));
    assert.equal(seen.size, 7, "seven generations, all different");
    third.close();
    // two databases are two generations
    const other = openDatabase(join(scratch(), "zim.sqlite"));
    assert.notEqual(epochOf(other), renewed);
    other.close();
  });

  it("gets a generation when it is brought up to date from a version that had none, once, and keeps it after that", () => {
    const path = join(scratch(), "zim.sqlite");
    const db = openDatabase(path);
    db.exec("drop table meta");
    const version = db.prepare("pragma user_version").get().user_version;
    db.exec(`pragma user_version = ${version - 1}`);
    db.close();
    const upgraded = openDatabase(path);
    const epoch = epochOf(upgraded);
    assert.match(epoch, /^[0-9a-f]{32}$/);
    assert.equal(upgraded.prepare("pragma user_version").get().user_version, version);
    upgraded.close();
    const again = openDatabase(path);
    assert.equal(epochOf(again), epoch);
    again.close();
  });

  it("needs no file for a database that is in memory", () => {
    const db = openDatabase(":memory:");
    assert.equal(db.prepare("pragma user_version").get().user_version > 0, true);
    db.close();
  });
});
