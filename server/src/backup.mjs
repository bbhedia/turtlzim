// Copies of what the server keeps, and the way back. What the server keeps is one SQLite file (the accounts, the notebooks that are kept on it, the sealed things), a key that the sealed things
// and the codes are made with, and what it was told (`config.json`, `oauth.json`). A backup is a folder with a copy of each, and a `manifest.json` that lists them with their sizes and SHA-256 and
// what the tables hold, so that a copy can be checked later (`verify`), and so that a copy that was changed, cut short or never finished is not taken for a good one.
//
//   node src/backup.mjs backup [--to DIR] [--keep N] [--data DIR]     a copy now, checked, and the oldest ones beyond N (14) removed
//   node src/backup.mjs verify DIR                                    is this copy whole?
//   node src/backup.mjs restore DIR [--data DIR]                      put it back (the server must be stopped); what it replaces is kept in `replaced-<date>/`
//   node src/backup.mjs list [--to DIR] [--data DIR]                  the copies there are
//
// The database is copied while the server runs: `VACUUM INTO` reads it in one transaction (a snapshot that no write can half change), and a copy that was made that way is checked before it counts.
// A backup holds the server's key and what it was told, so it is as secret as the data folder is: its folders are made for their owner only.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dataDirOf } from "./config.mjs";
import { openDatabase, renewEpoch } from "./db.mjs";

/** What a manifest says it is: a backup of this server's files. */
export const FORMAT = 1;
export const DATABASE = "zim.sqlite";
/** The small files beside the database that the server needs to be what it was: the key its sealed things are made with, and what it was told. */
export const SETTINGS = ["secret.key", "config.json", "oauth.json"];
/** What a backup's folder is called: `zim-backup-` and the time, in UTC, so that the names sort by date. */
const NAME = /^zim-backup-\d{8}T\d{6}Z$/;
const KEEP = 14;

/** `20261022T093015Z`. */
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** The SHA-256 of a file, read in pieces (a database can be larger than is worth holding in memory). */
function sumOf(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1 << 20);
  const file = openSync(path, "r");
  try {
    for (let read = readSync(file, buffer, 0, buffer.length, null); read > 0; read = readSync(file, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(file);
  }
  return hash.digest("hex");
}

/** What each table holds, counted, and the version of the database's tables: what a copy has to say the same as. */
function describe(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const counts = {};
    for (const { name } of db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all()) {
      counts[name] = db.prepare(`select count(*) as n from "${name.replaceAll('"', '""')}"`).get().n;
    }
    return { schema: db.prepare("pragma user_version").get().user_version, counts };
  } finally {
    db.close();
  }
}

/** Whether a database file is whole: SQLite's own check, no row that points at nothing, and a version that this server knows. */
function wholeDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const said = db.prepare("pragma integrity_check").all().map((row) => Object.values(row)[0]);
    if (said.length !== 1 || said[0] !== "ok") return `its check says: ${said.slice(0, 3).join("; ")}`;
    const dangling = db.prepare("pragma foreign_key_check").all();
    if (dangling.length > 0) return `${dangling.length} row(s) point at a row that is not there`;
    return null;
  } catch (error) {
    return `it can't be opened: ${error.message}`;
  } finally {
    try {
      db.close();
    } catch {
      // (a file that never opened has nothing to close)
    }
  }
}

/**
 * Give the data of a restored database a new generation (db.mjs, `epoch`): it went back to an older state, and the devices that were in step with what it held before have to be able to tell, for
 * their pages are not to be taken from it as if it had moved on. It is opened with the server's own code, which also brings the tables of an older backup up to date (and makes the generation of
 * one that had none), and closed again. Gives the new generation.
 */
function renewedEpoch(path) {
  const db = openDatabase(path);
  try {
    return renewEpoch(db);
  } finally {
    db.close();
  }
}

/** Make a folder for its owner only. */
function privateFolder(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Write a file beside its place and put it there: a copy that is cut short never has the name of a whole one. */
function placeFile(from, to) {
  const part = `${to}.part`;
  rmSync(part, { force: true });
  copyFileSync(from, part);
  chmodSync(part, 0o600);
  renameSync(part, to);
}

/**
 * Is this folder a whole backup? Its manifest is read, every file that it lists is there with the size and the SHA-256 that it says, nothing else than the server's own files is listed
 * (a manifest does not get to name a file anywhere), and the database is whole and holds what the manifest counted.
 * @returns {{ ok: boolean, problems: string[], manifest?: any }}
 */
export function verify(folder) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  } catch (error) {
    return { ok: false, problems: [`manifest.json can't be read: ${error.message}`] };
  }
  const problems = [];
  if (manifest?.format !== FORMAT) problems.push(`it is not a backup of this kind (format ${JSON.stringify(manifest?.format)}, not ${FORMAT})`);
  const files = manifest?.files && typeof manifest.files === "object" ? manifest.files : {};
  if (!(DATABASE in files)) problems.push("the manifest lists no database");
  for (const [name, said] of Object.entries(files)) {
    if (name !== DATABASE && !SETTINGS.includes(name)) {
      problems.push(`the manifest lists a file that is not one of the server's: ${JSON.stringify(name)}`);
      continue;
    }
    const path = join(folder, name);
    let size;
    try {
      size = statSync(path).size;
    } catch {
      problems.push(`${name} is not there`);
      continue;
    }
    if (size !== said?.bytes) problems.push(`${name} is ${size} bytes, the manifest says ${said?.bytes}`);
    else if (sumOf(path) !== said?.sha256) problems.push(`${name} is not the file that was copied (its SHA-256 differs)`);
  }
  if (problems.length === 0) {
    const broken = wholeDatabase(join(folder, DATABASE));
    if (broken) problems.push(`${DATABASE} is not whole: ${broken}`);
    else {
      const holds = describe(join(folder, DATABASE));
      if (holds.schema !== manifest.schema) problems.push(`${DATABASE} is at version ${holds.schema}, the manifest says ${manifest.schema}`);
      if (JSON.stringify(holds.counts) !== JSON.stringify(manifest.counts)) problems.push(`${DATABASE} does not hold what the manifest counted`);
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

/** The folders of backups that are in `to`, newest first: named as a backup is, and with a manifest (a folder that only looks like one is not ours to remove). */
export function backupsIn(to) {
  if (!existsSync(to)) return [];
  return readdirSync(to, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && NAME.test(entry.name) && existsSync(join(to, entry.name, "manifest.json")))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/** Remove the oldest backups of `to`, keeping the `keep` newest. Says which. */
export function prune(to, keep = KEEP) {
  const old = backupsIn(to).slice(Math.max(0, keep));
  for (const name of old) rmSync(join(to, name), { recursive: true, force: true });
  return old;
}

/**
 * Make a backup: a folder `zim-backup-<time>` in `to` (by default `backups` in the data folder) with the database as it is now, the key and the settings, and the manifest. It is checked before it counts
 * (a copy that does not pass is removed, and this throws), and only then are the oldest ones beyond `keep` removed.
 * @returns {{ folder: string, bytes: number, counts: Record<string, number>, pruned: string[] }}
 */
export function backup({ dataDir, to = join(dataDir, "backups"), keep = KEEP, now = new Date() }) {
  const source = join(dataDir, DATABASE);
  if (!existsSync(source)) throw new Error(`there is no database in ${dataDir}`);
  if (!Number.isInteger(keep) || keep < 1) throw new Error("at least one backup has to be kept");
  privateFolder(to);
  // (two backups in the same second: the second one is a second later)
  let when = new Date(Math.floor(now.getTime() / 1000) * 1000);
  while (existsSync(join(to, `zim-backup-${stamp(when)}`))) when = new Date(when.getTime() + 1000);
  const folder = join(to, `zim-backup-${stamp(when)}`);
  privateFolder(folder);
  try {
    // the database: read in one transaction, whatever the server writes meanwhile
    const reading = new DatabaseSync(source, { readOnly: true });
    try {
      reading.prepare("vacuum into ?").run(join(folder, `${DATABASE}.part`));
    } finally {
      reading.close();
    }
    renameSync(join(folder, `${DATABASE}.part`), join(folder, DATABASE));
    chmodSync(join(folder, DATABASE), 0o600);
    for (const name of SETTINGS) if (existsSync(join(dataDir, name))) placeFile(join(dataDir, name), join(folder, name));
    const files = {};
    for (const name of [DATABASE, ...SETTINGS]) {
      const path = join(folder, name);
      if (existsSync(path)) files[name] = { bytes: statSync(path).size, sha256: sumOf(path) };
    }
    const { schema, counts } = describe(join(folder, DATABASE));
    writeFileSync(join(folder, "manifest.json"), `${JSON.stringify({ format: FORMAT, created: when.toISOString(), server: "zim-server", schema, counts, files }, null, 2)}\n`, { mode: 0o600 });
    const checked = verify(folder);
    if (!checked.ok) throw new Error(`the copy is not whole: ${checked.problems.join("; ")}`);
    const pruned = prune(to, keep);
    return { folder, bytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0), counts, pruned };
  } catch (error) {
    // (a backup that was not finished is not left where it could be taken for one)
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

/** Whether a server started by `scripts/run.sh` is running on this data folder (its pid file names a process that is this server). */
export function serverRunning(dataDir) {
  try {
    const pid = readFileSync(join(dataDir, "serve.pid"), "utf8").trim();
    return /^\d+$/.test(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").includes("src/main.mjs");
  } catch {
    return false;
  }
}

/**
 * Put a backup back. It is checked first (a copy that is not whole is refused, and nothing is touched), the server must not be running, and what is in the data folder now is not deleted: it is moved to
 * `replaced-<time>` there. The restored data gets a new generation (`renewedEpoch`). If anything goes wrong after that, what was moved is put back and this throws. `placed` is called when the files
 * are in place and before they are checked (a seam for a test).
 * @returns {{ replaced: string, restored: string[], was: string[], epoch: string }}
 */
export function restore({ dataDir, from, now = new Date(), placed = () => {} }) {
  const checked = verify(from);
  if (!checked.ok) throw new Error(`that backup can't be used: ${checked.problems.join("; ")}`);
  if (serverRunning(dataDir)) throw new Error("the server is running: stop it first (scripts/run.sh restore does)");
  privateFolder(dataDir);
  let when = new Date(Math.floor(now.getTime() / 1000) * 1000);
  while (existsSync(join(dataDir, `replaced-${stamp(when)}`))) when = new Date(when.getTime() + 1000);
  const replaced = join(dataDir, `replaced-${stamp(when)}`);
  privateFolder(replaced);
  const was = [];
  for (const name of [DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`, ...SETTINGS]) {
    if (existsSync(join(dataDir, name))) {
      renameSync(join(dataDir, name), join(replaced, name));
      was.push(name);
    }
  }
  // (a folder that had nothing in it, as when a copy is tried out in a new one, has nothing that was replaced: no folder is left for it)
  if (was.length === 0) rmSync(replaced, { recursive: true, force: true });
  const restored = Object.keys(checked.manifest.files);
  let epoch;
  try {
    for (const name of restored) placeFile(join(from, name), join(dataDir, name));
    placed();
    const broken = wholeDatabase(join(dataDir, DATABASE));
    if (broken) throw new Error(`the restored ${DATABASE} is not whole: ${broken}`);
    // (last: it opens the database for writing, which puts it in WAL mode, and closing it leaves no journal files, as a read-only look at a WAL database would)
    epoch = renewedEpoch(join(dataDir, DATABASE));
  } catch (error) {
    for (const name of [...restored, `${DATABASE}-wal`, `${DATABASE}-shm`]) rmSync(join(dataDir, name), { force: true });
    for (const name of was) renameSync(join(replaced, name), join(dataDir, name));
    rmSync(replaced, { recursive: true, force: true });
    throw new Error(`the restore failed, and what was there is back: ${error.message}`);
  }
  return { replaced, restored, was, epoch };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// the command line

const USAGE = `Usage: node src/backup.mjs backup [--to DIR] [--keep N] [--data DIR]
       node src/backup.mjs verify DIR
       node src/backup.mjs restore DIR [--data DIR]
       node src/backup.mjs list [--to DIR] [--data DIR]
The data folder is ZIM_SERVER_DATA, else ~/.local/state/zim-server; backups go to its \`backups\` folder unless --to says where.`;

function parse(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--to" || flag === "--data" || flag === "--keep") {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = argv[++i];
    } else if (flag.startsWith("--")) throw new Error(`unknown option ${flag}`);
    else options.positional.push(flag);
  }
  return options;
}

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(bytes < 1048576 ? 2 : 1)} MiB`;

export function main(argv = process.argv.slice(2), out = console.log, env = process.env) {
  let options;
  try {
    options = parse(argv.slice(1));
  } catch (error) {
    out(`backup: ${error.message}`);
    return 2;
  }
  const dataDir = resolve(options.data ?? dataDirOf(env));
  const to = resolve(options.to ?? join(dataDir, "backups"));
  try {
    switch (argv[0]) {
      case "backup": {
        const keep = options.keep === undefined ? KEEP : Number(options.keep);
        const made = backup({ dataDir, to, keep });
        out(`backed up to ${made.folder} (${megabytes(made.bytes)}: ${Object.entries(made.counts).filter(([, n]) => n > 0).map(([table, n]) => `${n} ${table}`).join(", ") || "nothing in it yet"})`);
        if (made.pruned.length) out(`removed the oldest: ${made.pruned.join(", ")}`);
        return 0;
      }
      case "verify": {
        if (options.positional.length !== 1) throw new Error("verify takes the folder of a backup");
        const checked = verify(resolve(options.positional[0]));
        out(checked.ok ? `whole: ${options.positional[0]} (${checked.manifest.created})` : `NOT whole: ${checked.problems.join("; ")}`);
        return checked.ok ? 0 : 1;
      }
      case "restore": {
        if (options.positional.length !== 1) throw new Error("restore takes the folder of a backup");
        const done = restore({ dataDir, from: resolve(options.positional[0]) });
        out(`restored ${done.restored.join(", ")} into ${dataDir}`);
        out("its data has a new generation: the devices that were in step with what it held before will compare their pages with it, not take it as the newer copy");
        if (done.was.length) out(`what was there is kept in ${done.replaced} (${done.was.join(", ")})`);
        return 0;
      }
      case "list": {
        const names = backupsIn(to);
        if (names.length === 0) out(`no backup in ${to}`);
        for (const name of names) {
          const checked = verify(join(to, name));
          out(`${name}  ${checked.ok ? `${megabytes(Object.values(checked.manifest.files).reduce((sum, file) => sum + file.bytes, 0))}, whole` : `NOT whole: ${checked.problems[0]}`}`);
        }
        return 0;
      }
      default:
        out(USAGE);
        return 2;
    }
  } catch (error) {
    out(`backup: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
