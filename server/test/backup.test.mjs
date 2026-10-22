// The server's backups (src/backup.mjs): a copy that opens and says what the original says, whatever the server writes while it is made; a copy that was changed, cut short or never finished is
// not taken for a good one; only its own old copies are removed; and what a restore replaces is kept, and put back if the restore fails.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { backup, backupsIn, DATABASE, FORMAT, main, prune, restore, serverRunning, verify } from "../src/backup.mjs";
import { openDatabase } from "../src/db.mjs";

const cli = fileURLToPath(new URL("../src/backup.mjs", import.meta.url));
const folders = [];
const children = [];
after(() => {
  children.forEach((child) => child.kill("SIGKILL"));
  folders.forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});
const scratch = () => {
  const folder = mkdtempSync(join(tmpdir(), "zim-backup-test-"));
  folders.push(folder);
  return folder;
};
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A data folder as the server leaves one: a database with something in it, the key, what it was told. */
function dataFolder({ accounts = 3, files = 4 } = {}) {
  const dataDir = scratch();
  const db = openDatabase(join(dataDir, DATABASE));
  for (let id = 1; id <= accounts; id++) {
    db.prepare("insert into users (id, email, created_at, quota_bytes) values (?, ?, 1, 1048576)").run(id, `user${id}@example.org`);
    db.prepare("insert into notebooks (user_id, id, title, revision, updated_at) values (?, 'zsl-notebook', 'Encrypted notebook', 1, 1)").run(id);
    for (let n = 0; n < files; n++) db.prepare("insert into notebook_files (user_id, notebook_id, path, bytes) values (?, 'zsl-notebook', ?, ?)").run(id, `file-${n}.zseal`, Buffer.from(`sealed bytes ${id}/${n} `.repeat(50)));
  }
  db.close();
  writeFileSync(join(dataDir, "secret.key"), "c2VjcmV0LWtleS1vZi10aGlzLXNlcnZlcg==\n", { mode: 0o600 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ baseUrl: "https://notes.example.org" }));
  return dataDir;
}

const counts = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(["users", "notebooks", "notebook_files"].map((table) => [table, db.prepare(`select count(*) as n from ${table}`).get().n]));
  } finally {
    db.close();
  }
};

describe("a backup", () => {
  it("is a folder of its own with a copy of the database that says what the original says, the key and the settings, and a manifest that lists them with their sizes and SHA-256; for its owner only", () => {
    const dataDir = dataFolder();
    const before = sha(join(dataDir, DATABASE));
    const made = backup({ dataDir, now: new Date("2026-10-22T09:30:15Z") });
    assert.equal(made.folder, join(dataDir, "backups", "zim-backup-20261022T093015Z"));
    assert.deepEqual(readdirSync(made.folder).sort(), ["config.json", "manifest.json", "secret.key", DATABASE]);
    assert.deepEqual(counts(join(made.folder, DATABASE)), { users: 3, notebooks: 3, notebook_files: 12 });
    const manifest = JSON.parse(readFileSync(join(made.folder, "manifest.json"), "utf8"));
    assert.equal(manifest.format, FORMAT);
    assert.equal(manifest.created, "2026-10-22T09:30:15.000Z");
    assert.equal(manifest.schema, 6);
    assert.equal(manifest.counts.users, 3);
    for (const name of ["zim.sqlite", "secret.key", "config.json"]) {
      assert.equal(manifest.files[name].bytes, statSync(join(made.folder, name)).size, name);
      assert.equal(manifest.files[name].sha256, sha(join(made.folder, name)), name);
    }
    assert.equal(manifest.files["oauth.json"], undefined, "a file that was not there is not listed");
    assert.equal(readFileSync(join(made.folder, "secret.key"), "utf8"), readFileSync(join(dataDir, "secret.key"), "utf8"));
    // for its owner only: the backups' folder, the backup's, and every file in it
    assert.equal(statSync(join(dataDir, "backups")).mode & 0o777, 0o700);
    assert.equal(statSync(made.folder).mode & 0o777, 0o700);
    for (const name of readdirSync(made.folder)) assert.equal(statSync(join(made.folder, name)).mode & 0o777, 0o600, name);
    assert.ok(verify(made.folder).ok);
    assert.equal(sha(join(dataDir, DATABASE)), before, "what was copied was not changed");
    assert.equal(existsSync(join(made.folder, `${DATABASE}.part`)), false, "nothing is left half made");
  });

  it("makes its folders private even when they were there before with a mode that others can read, and so does a restore for the data folder (it holds the key that the copy brings back)", () => {
    const dataDir = dataFolder({ accounts: 1, files: 1 });
    const to = join(dataDir, "backups");
    mkdirSync(to);
    chmodSync(to, 0o755);
    const made = backup({ dataDir, to, now: new Date("2026-10-22T09:30:15Z") });
    assert.equal(statSync(to).mode & 0o777, 0o700, "the folder of backups");
    assert.equal(statSync(made.folder).mode & 0o777, 0o700, "the backup's");
    chmodSync(dataDir, 0o755);
    const done = restore({ dataDir, from: made.folder, now: new Date("2026-10-22T10:00:00Z") });
    assert.equal(statSync(dataDir).mode & 0o777, 0o700, "the data folder");
    assert.equal(statSync(done.replaced).mode & 0o777, 0o700, "and what a restore keeps aside");
  });

  it("is a whole copy when the server writes while it is made: every table is of the same moment", async () => {
    const dataDir = dataFolder({ accounts: 1, files: 1 });
    // another process writes as the server does: an account, its notebook and its file in one transaction, as fast as it can
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `const { openDatabase } = await import(${JSON.stringify(new URL("../src/db.mjs", import.meta.url).href)});
         const db = openDatabase(${JSON.stringify(join(dataDir, DATABASE))});
         db.exec("pragma busy_timeout = 5000");
         console.log("writing");
         for (let id = 100; ; id++) {
           db.exec("begin immediate");
           db.prepare("insert into users (id, email, created_at, quota_bytes) values (?, ?, 1, 1)").run(id, "w" + id + "@example.org");
           db.prepare("insert into notebooks (user_id, id, title, revision, updated_at) values (?, 'n', 't', 1, 1)").run(id);
           db.prepare("insert into notebook_files (user_id, notebook_id, path, bytes) values (?, 'n', 'f', ?)").run(id, Buffer.alloc(2000, id % 251));
           db.exec("commit");
         }`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    children.push(writer);
    await new Promise((resolve) => writer.stdout.once("data", resolve));
    let last = 0;
    try {
      for (let round = 0; round < 8; round++) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        const made = backup({ dataDir, to: join(dataDir, "backups"), keep: 20, now: new Date(Date.UTC(2026, 9, 22, 9, 0, round)) });
        const held = counts(join(made.folder, DATABASE));
        // every transaction of the writer is in the copy whole or not at all
        assert.equal(held.users, held.notebooks, `round ${round}`);
        assert.equal(held.users, held.notebook_files, `round ${round}`);
        assert.ok(verify(made.folder).ok, `round ${round}`);
        assert.ok(held.users >= last, "a later copy has what an earlier one had");
        last = held.users;
      }
    } finally {
      writer.kill("SIGKILL");
    }
    assert.ok(last > 5, `the writer was writing while the copies were made (${last} accounts in the last one)`);
  });

  it("is refused for a folder that has no database, and keeps none of what it began", () => {
    const empty = scratch();
    assert.throws(() => backup({ dataDir: empty }), /there is no database in/);
    assert.equal(existsSync(join(empty, "backups")), false, "nothing was made");
    const dataDir = dataFolder();
    assert.throws(() => backup({ dataDir, keep: 0 }), /at least one backup/);
    // a database that is not one: the copy fails and no folder of a backup is left behind
    const broken = scratch();
    writeFileSync(join(broken, DATABASE), "this is not a database file at all, only text that is long enough to be mistaken for one by a person");
    assert.throws(() => backup({ dataDir: broken }));
    assert.deepEqual(backupsIn(join(broken, "backups")), []);
    assert.deepEqual(readdirSync(join(broken, "backups")), [], "the half made folder is gone");
  });

  it("is refused when what is copied is not whole (a row that points at nothing), and does not push out the copies that are", () => {
    const dataDir = dataFolder({ accounts: 2, files: 1 });
    const to = join(dataDir, "backups");
    backup({ dataDir, to, keep: 1, now: new Date("2026-10-01T03:00:00Z") });
    const db = new DatabaseSync(join(dataDir, DATABASE));
    db.exec("pragma foreign_keys = off");
    db.exec("delete from notebooks where user_id = 1");
    db.close();
    assert.throws(() => backup({ dataDir, to, keep: 1, now: new Date("2026-10-02T03:00:00Z") }), /the copy is not whole: .*point at a row that is not there/);
    assert.deepEqual(backupsIn(to), ["zim-backup-20261001T030000Z"], "the good copy is still the only one, and nothing half made is beside it");
  });

  it("is a second later when the second is taken, so that two backups of one moment are two", () => {
    const dataDir = dataFolder({ accounts: 1, files: 1 });
    const at = new Date("2026-10-22T09:30:15.400Z");
    const first = backup({ dataDir, now: at });
    const second = backup({ dataDir, now: at });
    assert.notEqual(first.folder, second.folder);
    assert.match(second.folder, /zim-backup-20261022T093016Z$/);
  });
});

describe("a copy that is checked", () => {
  const made = () => {
    const dataDir = dataFolder();
    return { dataDir, folder: backup({ dataDir, now: new Date("2026-10-22T09:30:15Z") }).folder };
  };
  const rewriteManifest = (folder, change) => {
    const path = join(folder, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    change(manifest);
    writeFileSync(path, JSON.stringify(manifest));
  };

  it("is whole when nothing was changed", () => {
    const { folder } = made();
    const checked = verify(folder);
    assert.deepEqual(checked.problems, []);
    assert.ok(checked.ok);
  });

  it("is not whole when a byte of it was changed, when it was cut short, when a file is gone or when the manifest is not what it was", () => {
    // a byte of the database
    let { folder } = made();
    const bytes = readFileSync(join(folder, DATABASE));
    bytes[bytes.length - 100] ^= 0xff;
    writeFileSync(join(folder, DATABASE), bytes);
    assert.match(verify(folder).problems.join(), /zim\.sqlite is not the file that was copied/);
    // cut short
    ({ folder } = made());
    truncateSync(join(folder, DATABASE), statSync(join(folder, DATABASE)).size - 1);
    assert.match(verify(folder).problems.join(), /bytes, the manifest says/);
    // the key was changed (a byte of it: the same size)
    ({ folder } = made());
    writeFileSync(join(folder, "secret.key"), "X".repeat(statSync(join(folder, "secret.key")).size));
    assert.match(verify(folder).problems.join(), /secret\.key is not the file that was copied/);
    // a file that is gone
    ({ folder } = made());
    rmSync(join(folder, "config.json"));
    assert.match(verify(folder).problems.join(), /config\.json is not there/);
    // no manifest, a manifest that is not JSON, another format
    ({ folder } = made());
    rmSync(join(folder, "manifest.json"));
    assert.match(verify(folder).problems.join(), /manifest\.json can't be read/);
    ({ folder } = made());
    writeFileSync(join(folder, "manifest.json"), "{ not json");
    assert.match(verify(folder).problems.join(), /manifest\.json can't be read/);
    ({ folder } = made());
    rewriteManifest(folder, (m) => (m.format = 2));
    assert.match(verify(folder).problems.join(), /not a backup of this kind/);
    // a folder that is not a backup
    assert.equal(verify(scratch()).ok, false);
  });

  it("is not whole when the manifest says other things of the database than it holds: its version, what the tables hold", () => {
    let { folder } = made();
    rewriteManifest(folder, (m) => (m.schema = 5));
    assert.match(verify(folder).problems.join(), /is at version 6, the manifest says 5/);
    ({ folder } = made());
    rewriteManifest(folder, (m) => (m.counts.users = 99));
    assert.match(verify(folder).problems.join(), /does not hold what the manifest counted/);
  });

  it("is not whole when the database itself is not, even if the manifest was made to agree with it", () => {
    // a database file that was damaged inside, with the manifest's size and SHA-256 made to say what the damaged file is
    const { folder } = made();
    const path = join(folder, DATABASE);
    const bytes = readFileSync(path);
    // (the pages after the first hold the tables: wiping some of them breaks the file)
    bytes.fill(0xaa, 8192, 8192 + 4096);
    writeFileSync(path, bytes);
    rewriteManifest(folder, (m) => (m.files[DATABASE] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
    const checked = verify(folder);
    assert.equal(checked.ok, false);
    assert.match(checked.problems.join(), /zim\.sqlite is not whole/);
  });

  it("is not whole when SQLite's own check finds what nothing else does: a table and its index that no longer agree (the file opens, every table reads, no row points at nothing)", () => {
    const { folder } = made();
    const path = join(folder, DATABASE);
    const bytes = readFileSync(path);
    // an address as the table holds it, one letter changed: the index of addresses (they are UNIQUE) still has the old one
    const at = bytes.indexOf("user2@example.org");
    assert.ok(at > 0, "the address is in the file");
    bytes[at] ^= 0x20;
    writeFileSync(path, bytes);
    rewriteManifest(folder, (m) => (m.files[DATABASE] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
    assert.equal(counts(path).users, 3, "what is wrong with it is not that it can't be read");
    const checked = verify(folder);
    assert.equal(checked.ok, false);
    assert.match(checked.problems.join(), /zim\.sqlite is not whole: its check says: .*index/i);
  });

  it("is not whole when the manifest lists no database, or is not what a manifest is, and none of them makes the check throw", () => {
    let { folder } = made();
    rewriteManifest(folder, (m) => delete m.files[DATABASE]);
    assert.match(verify(folder).problems.join(), /the manifest lists no database/);
    for (const text of ["null", "[]", "7", '"text"', '{"format":1,"files":5}', '{"format":1,"files":{"zim.sqlite":null}}']) {
      ({ folder } = made());
      writeFileSync(join(folder, "manifest.json"), text);
      assert.equal(verify(folder).ok, false, text);
    }
  });

  it("is not whole when a row points at a row that is not there", () => {
    const { folder } = made();
    const path = join(folder, DATABASE);
    const db = new DatabaseSync(path);
    db.exec("pragma foreign_keys = off");
    db.exec("delete from notebooks where user_id = 1");
    db.close();
    rewriteManifest(folder, (m) => (m.files[DATABASE] = { bytes: statSync(path).size, sha256: sha(path) }));
    assert.match(verify(folder).problems.join(), /point at a row that is not there/);
  });

  it("does not let a manifest name a file that is not the server's: nothing outside the folder, nothing else", () => {
    for (const name of ["../escape", "/etc/passwd", "outbox.jsonl", "serve.log", "backups/inner"]) {
      const { folder } = made();
      rewriteManifest(folder, (m) => (m.files[name] = { bytes: 0, sha256: createHash("sha256").update("").digest("hex") }));
      assert.match(verify(folder).problems.join(), /not one of the server's/, name);
    }
  });
});

describe("the old backups", () => {
  it("are removed beyond the newest ones that are kept, and nothing that only looks like one", () => {
    const dataDir = dataFolder({ accounts: 1, files: 1 });
    const to = join(dataDir, "backups");
    for (let day = 1; day <= 5; day++) backup({ dataDir, to, keep: 99, now: new Date(Date.UTC(2026, 9, day, 3, 0, 0)) });
    // things in the folder that are not ours: a folder named as a backup is but with no manifest, one named otherwise, a file
    mkdirSync(join(to, "zim-backup-20200101T000000Z"));
    writeFileSync(join(to, "zim-backup-20200101T000000Z", "notes.txt"), "mine");
    mkdirSync(join(to, "zim-backup-notes"));
    writeFileSync(join(to, "zim-backup-notes", "manifest.json"), "{}");
    writeFileSync(join(to, "zim-backup-20190101T000000Z"), "a file");
    assert.deepEqual(backupsIn(to), ["zim-backup-20261005T030000Z", "zim-backup-20261004T030000Z", "zim-backup-20261003T030000Z", "zim-backup-20261002T030000Z", "zim-backup-20261001T030000Z"]);
    assert.deepEqual(prune(to, 2), ["zim-backup-20261003T030000Z", "zim-backup-20261002T030000Z", "zim-backup-20261001T030000Z"]);
    assert.deepEqual(backupsIn(to), ["zim-backup-20261005T030000Z", "zim-backup-20261004T030000Z"]);
    assert.ok(existsSync(join(to, "zim-backup-20200101T000000Z", "notes.txt")) && existsSync(join(to, "zim-backup-notes")) && existsSync(join(to, "zim-backup-20190101T000000Z")), "what is not ours is where it was");
    // a new backup removes the oldest beyond what is kept, after the new one was checked
    const made = backup({ dataDir, to, keep: 2, now: new Date(Date.UTC(2026, 9, 6, 3, 0, 0)) });
    assert.deepEqual(made.pruned, ["zim-backup-20261004T030000Z"]);
    assert.deepEqual(backupsIn(to), ["zim-backup-20261006T030000Z", "zim-backup-20261005T030000Z"]);
  });

  it("are all kept when the new one is not whole: a bad copy does not push out a good one", () => {
    const dataDir = dataFolder({ accounts: 1, files: 1 });
    const to = join(dataDir, "backups");
    backup({ dataDir, to, keep: 1, now: new Date("2026-10-01T03:00:00Z") });
    const broken = scratch();
    writeFileSync(join(broken, DATABASE), "not a database, but long enough that someone could take it for a small one, which it is not at all");
    assert.throws(() => backup({ dataDir: broken, to, keep: 1, now: new Date("2026-10-02T03:00:00Z") }));
    assert.deepEqual(backupsIn(to), ["zim-backup-20261001T030000Z"]);
  });
});

describe("a restore", () => {
  /** A data folder in the state A, a backup of it, and then the state B. */
  function twoStates() {
    const dataDir = dataFolder({ accounts: 2, files: 2 });
    const { folder } = backup({ dataDir, now: new Date("2026-10-22T09:30:15Z") });
    const db = openDatabase(join(dataDir, DATABASE));
    db.prepare("insert into users (id, email, created_at, quota_bytes) values (50, 'later@example.org', 2, 1)").run();
    db.prepare("delete from users where id = 1").run();
    db.close();
    writeFileSync(join(dataDir, "secret.key"), "bGF0ZXIta2V5\n", { mode: 0o600 });
    return { dataDir, folder };
  }

  it("puts back the database, the key and the settings, and keeps what it replaces", () => {
    const { dataDir, folder } = twoStates();
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
    const done = restore({ dataDir, from: folder, now: new Date("2026-10-22T10:00:00Z") });
    assert.deepEqual(done.restored.sort(), ["config.json", "secret.key", DATABASE]);
    assert.equal(sha(join(dataDir, "secret.key")), manifest.files["secret.key"].sha256);
    assert.equal(sha(join(dataDir, DATABASE)), manifest.files[DATABASE].sha256);
    assert.deepEqual(counts(join(dataDir, DATABASE)), { users: 2, notebooks: 2, notebook_files: 4 });
    // what was there is not deleted: it is in a folder beside, with the key of state B
    assert.equal(done.replaced, join(dataDir, "replaced-20261022T100000Z"));
    assert.equal(readFileSync(join(done.replaced, "secret.key"), "utf8"), "bGF0ZXIta2V5\n");
    assert.equal(new DatabaseSync(join(done.replaced, DATABASE), { readOnly: true }).prepare("select count(*) as n from users where id = 50").get().n, 1);
    // the files are for their owner only, and nothing is left half placed
    for (const name of done.restored) assert.equal(statSync(join(dataDir, name)).mode & 0o777, 0o600, name);
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.endsWith(".part")), []);
    // the database opens with the server's own code, at the version of the backup
    const db = openDatabase(join(dataDir, DATABASE));
    assert.equal(db.prepare("select email from users order by id").all().map((row) => row.email).join(), "user1@example.org,user2@example.org");
    db.close();
  });

  it("takes away the files that the backup does not have (a state in which the settings were not there) and keeps them aside", () => {
    const dataDir = dataFolder({ accounts: 1, files: 1 });
    rmSync(join(dataDir, "config.json"));
    const { folder } = backup({ dataDir, now: new Date("2026-10-22T09:30:15Z") });
    writeFileSync(join(dataDir, "config.json"), '{"baseUrl":"https://later.example.org"}');
    writeFileSync(join(dataDir, "oauth.json"), '{"github":{}}');
    // the journal files of a database that was not closed: a log of the old database is not to be applied to the restored one
    writeFileSync(join(dataDir, `${DATABASE}-wal`), "a log of the old database");
    writeFileSync(join(dataDir, `${DATABASE}-shm`), "its index");
    const done = restore({ dataDir, from: folder, now: new Date("2026-10-22T10:00:00Z") });
    assert.equal(existsSync(join(dataDir, "config.json")), false);
    assert.equal(existsSync(join(dataDir, "oauth.json")), false);
    const aside = readdirSync(done.replaced).sort();
    for (const name of ["config.json", "oauth.json", "secret.key", DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`]) assert.ok(aside.includes(name), name);
    assert.deepEqual(aside.filter((name) => !["config.json", "oauth.json", "secret.key", DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`].includes(name)), []);
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.startsWith(`${DATABASE}-`)), [], "no journal of the old database is beside the restored one");
  });

  it("keeps what each restore replaces: two restores in the same second do not write over each other's", () => {
    const { dataDir, folder } = twoStates();
    const now = new Date("2026-10-22T10:00:00Z");
    const first = restore({ dataDir, from: folder, now });
    writeFileSync(join(dataDir, "secret.key"), "c3RhdGUtYw==\n", { mode: 0o600 });
    const second = restore({ dataDir, from: folder, now });
    assert.notEqual(first.replaced, second.replaced);
    assert.equal(first.replaced, join(dataDir, "replaced-20261022T100000Z"));
    assert.match(second.replaced, /replaced-20261022T100001Z$/);
    assert.equal(readFileSync(join(first.replaced, "secret.key"), "utf8"), "bGF0ZXIta2V5\n", "the key that the first restore replaced");
    assert.equal(readFileSync(join(second.replaced, "secret.key"), "utf8"), "c3RhdGUtYw==\n", "the key that the second one replaced");
  });

  it("refuses a backup that is not whole, and touches nothing", () => {
    const { dataDir, folder } = twoStates();
    const bytes = readFileSync(join(folder, DATABASE));
    bytes[bytes.length - 50] ^= 0xff;
    writeFileSync(join(folder, DATABASE), bytes);
    const before = Object.fromEntries(readdirSync(dataDir).filter((name) => statSync(join(dataDir, name)).isFile()).map((name) => [name, sha(join(dataDir, name))]));
    assert.throws(() => restore({ dataDir, from: folder }), /that backup can't be used/);
    const after = Object.fromEntries(readdirSync(dataDir).filter((name) => statSync(join(dataDir, name)).isFile()).map((name) => [name, sha(join(dataDir, name))]));
    assert.deepEqual(after, before);
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.startsWith("replaced-")), []);
  });

  it("refuses while the server is running, and says so", async () => {
    const { dataDir, folder } = twoStates();
    // a process whose command line says that it is the server, and a pid file that names it, as scripts/run.sh leaves one
    const fake = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "src/main.mjs"], { stdio: "ignore" });
    children.push(fake);
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(join(dataDir, "serve.pid"), `${fake.pid}\n`);
    assert.equal(serverRunning(dataDir), true);
    assert.throws(() => restore({ dataDir, from: folder }), /the server is running/);
    assert.deepEqual(counts(join(dataDir, DATABASE)).users, 2, "nothing was changed");
    // a pid file that names a process that is something else, or nothing, is no server
    writeFileSync(join(dataDir, "serve.pid"), `${process.pid}\n`);
    assert.equal(serverRunning(dataDir), false);
    writeFileSync(join(dataDir, "serve.pid"), "99999999\n");
    assert.equal(serverRunning(dataDir), false);
    writeFileSync(join(dataDir, "serve.pid"), "not a pid\n");
    assert.equal(serverRunning(dataDir), false);
    rmSync(join(dataDir, "serve.pid"));
    assert.equal(serverRunning(dataDir), false);
    fake.kill("SIGKILL");
  });

  it("puts back what it moved aside when it fails after that, and leaves nothing of what it began", () => {
    const { dataDir, folder } = twoStates();
    // (a file that the copy has and the data folder has not: the restore places it, and when it fails it is not left there)
    rmSync(join(dataDir, "config.json"));
    const before = Object.fromEntries(readdirSync(dataDir).filter((name) => statSync(join(dataDir, name)).isFile()).map((name) => [name, sha(join(dataDir, name))]));
    assert.throws(
      () =>
        restore({
          dataDir,
          from: folder,
          placed: () => {
            throw new Error("the disk went away");
          },
        }),
      /the restore failed, and what was there is back: the disk went away/,
    );
    const after = Object.fromEntries(readdirSync(dataDir).filter((name) => statSync(join(dataDir, name)).isFile()).map((name) => [name, sha(join(dataDir, name))]));
    assert.deepEqual(after, before, "every file is as it was");
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.startsWith("replaced-") || name.endsWith(".part")), []);
    // and a restore that fails because the restored database is not whole (a copy whose manifest was made to agree with damage that its check reads as sound)
    // is undone the same way
    const second = backup({ dataDir, now: new Date("2026-10-22T11:00:00Z") });
    assert.ok(verify(second.folder).ok);
    assert.throws(
      () =>
        restore({
          dataDir,
          from: second.folder,
          placed: () => writeFileSync(join(dataDir, DATABASE), "damaged after it was placed, long enough to be taken for a file that was there"),
        }),
      /the restored zim\.sqlite is not whole/,
    );
    assert.deepEqual(counts(join(dataDir, DATABASE)).users, 2, "the database that was there is back");
  });

  it("is what a person is told by the command line: a backup, a list, a check, a restore, and what to do when it is asked wrong", () => {
    const dataDir = dataFolder({ accounts: 2, files: 1 });
    const run = (...args) => {
      const lines = [];
      const status = main(args, (line) => lines.push(line), { ZIM_SERVER_DATA: dataDir });
      return { status, text: lines.join("\n") };
    };
    assert.equal(run("nothing").status, 2);
    assert.match(run("nothing").text, /Usage/);
    assert.equal(run("backup", "--surprise").status, 2);
    assert.equal(run("backup", "--to").status, 2);
    const made = run("backup", "--keep", "3");
    assert.equal(made.status, 0, made.text);
    assert.match(made.text, /backed up to .*zim-backup-\d{8}T\d{6}Z \(\d+\.\d+ MiB: /);
    for (const held of ["2 users", "2 notebooks", "2 notebook_files"]) assert.ok(made.text.includes(held), held);
    const folder = /backed up to (\S+)/.exec(made.text)[1];
    // a number of backups to keep that is not a number, or is less than one, is refused before anything is removed (NaN would keep none)
    for (const keep of ["abc", "1.5", "0", "-1", ""]) {
      const refused = run("backup", "--keep", keep);
      assert.equal(refused.status, 1, JSON.stringify(keep));
      assert.match(refused.text, /at least one backup/);
    }
    assert.deepEqual(backupsIn(join(dataDir, "backups")), [basename(folder)], "and the backup there is still the only one");
    assert.match(run("list").text, /zim-backup-\d{8}T\d{6}Z  \d+\.\d+ MiB, whole/);
    assert.match(run("verify", folder).text, /^whole: /);
    assert.equal(run("verify").status, 1);
    assert.equal(run("restore").status, 1);
    writeFileSync(join(folder, "secret.key"), "changed");
    const bad = run("verify", folder);
    assert.equal(bad.status, 1);
    assert.match(bad.text, /NOT whole: secret\.key/);
    assert.match(run("list").text, /NOT whole/);
    assert.equal(run("restore", folder).status, 1);
    // an empty folder: nothing to back up, and nothing made
    const empty = scratch();
    const none = main(["backup"], () => {}, { ZIM_SERVER_DATA: empty });
    assert.equal(none, 1);
    assert.equal(existsSync(join(empty, "zim.sqlite")), false, "the tool made no database of its own");
    assert.equal(existsSync(join(empty, "secret.key")), false, "and no key");
    // and as a program
    const program = spawnSync(process.execPath, [cli, "backup", "--keep", "2"], { env: { ...process.env, ZIM_SERVER_DATA: dataDir }, encoding: "utf8" });
    assert.equal(program.status, 0, program.stdout + program.stderr);
    assert.match(program.stdout, /backed up to/);
    assert.equal(spawnSync(process.execPath, [cli], { env: { ...process.env, ZIM_SERVER_DATA: dataDir }, encoding: "utf8" }).status, 2);
    chmodSync(dataDir, 0o700);
  });
});
