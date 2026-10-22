// The database file (src/db.mjs): it holds everyone's accounts and the notebooks kept on the server, so it is for its owner only, with the journal files beside it, whether the server made it or found it
// as an older server left it (SQLite gives a file it makes the mode 644: readable by every other user of the computer).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openDatabase } from "../src/db.mjs";

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

  it("needs no file for a database that is in memory", () => {
    const db = openDatabase(":memory:");
    assert.equal(db.prepare("pragma user_version").get().user_version > 0, true);
    db.close();
  });
});
