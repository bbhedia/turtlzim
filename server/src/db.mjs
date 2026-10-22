// The server's database: one SQLite file (the one that comes with Node), with its tables made by numbered steps, so that a newer server opens an older file.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const STEPS = [
  `
  create table users (
    id integer primary key,
    email text not null unique,
    password_hash text,
    created_at integer not null,
    verified_at integer,
    quota_bytes integer not null,
    disabled integer not null default 0
  );
  create table codes (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    purpose text not null,
    hash text not null,
    expires_at integer not null,
    attempts integer not null default 0,
    created_at integer not null
  );
  create index codes_by_user on codes (user_id, purpose);
  create table sessions (
    id text primary key,
    user_id integer not null references users(id) on delete cascade,
    created_at integer not null,
    expires_at integer not null,
    last_used integer not null
  );
  create index sessions_by_user on sessions (user_id);
  create table identities (
    provider text not null,
    subject text not null,
    user_id integer not null references users(id) on delete cascade,
    email text,
    created_at integer not null,
    primary key (provider, subject)
  );
  create index identities_by_user on identities (user_id);
  create table limits (
    key text primary key,
    window_start integer not null,
    count integer not null
  );
  create table oauth_states (
    state text primary key,
    provider text not null,
    verifier text not null,
    nonce_hash text not null,
    created_at integer not null
  );
  `,
  `
  create table notebooks (
    user_id integer not null references users(id) on delete cascade,
    id text not null,
    title text not null,
    revision integer not null,
    updated_at integer not null,
    primary key (user_id, id)
  );
  create table notebook_files (
    user_id integer not null,
    notebook_id text not null,
    path text not null,
    bytes blob not null,
    primary key (user_id, notebook_id, path),
    foreign key (user_id, notebook_id) references notebooks (user_id, id) on delete cascade
  );
  `,
  `
  create table connectors (
    id integer primary key,
    user_id integer not null references users(id) on delete cascade,
    kind text not null,
    label text not null,
    config blob not null,
    created_at integer not null
  );
  create index connectors_by_user on connectors (user_id);
  `,
  `
  alter table oauth_states add column user_id integer;
  `,
  `
  create table cloud_keys (
    user_id integer primary key references users(id) on delete cascade,
    wrapped blob not null,
    check_value text not null,
    updated_at integer not null
  );
  `,
  `
  alter table sessions add column kind text not null default 'browser';
  alter table sessions add column label text;
  alter table sessions add column public_id text;
  create unique index sessions_by_public_id on sessions (public_id) where public_id is not null;
  create table app_codes (
    hash text primary key,
    user_id integer not null references users(id) on delete cascade,
    challenge text not null,
    redirect_uri text not null,
    client text not null,
    created_at integer not null,
    expires_at integer not null
  );
  create index app_codes_by_user on app_codes (user_id);
  `,
  // the generation of the data (see epochOf): made once, and made again whenever the data is put back to an older state
  `
  create table meta (key text primary key, value text not null);
  insert into meta (key, value) values ('epoch', lower(hex(randomblob(16))));
  `,
];

/** The database holds everyone's accounts and the notebooks kept on the server: its file, and the journal files beside it, are for its owner only (SQLite would make them readable by everyone: 644). */
function keepPrivate(path) {
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
}

/** Open (and make or bring up to date) the database at `path` (`:memory:` for a test). */
export function openDatabase(path) {
  if (path !== ":memory:") keepPrivate(path); // (SQLite gives the journal files that it makes the mode of the database's own file)
  const db = new DatabaseSync(path);
  db.exec("pragma foreign_keys = on");
  if (path !== ":memory:") db.exec("pragma journal_mode = wal");
  const version = db.prepare("pragma user_version").get().user_version;
  if (version > STEPS.length) throw new Error(`the database was made by a newer server (version ${version})`);
  for (let step = version; step < STEPS.length; step++) {
    db.exec("begin");
    try {
      db.exec(STEPS[step]);
      db.exec(`pragma user_version = ${step + 1}`);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
  return db;
}

/**
 * The generation of the data in this database. A device that keeps a notebook here remembers it, and a server whose data was put back to an older state (restored from a backup) has a new one
 * (`renewEpoch`): the device can then tell that what it finds here is not what moved on from what it left, whatever the revisions of the notebooks say (they went back too, or are the same by chance).
 */
export function epochOf(db) {
  return db.prepare("select value from meta where key = 'epoch'").get().value;
}

/** Start a new generation of the data, and say it. A restore does, whatever the backup held. */
export function renewEpoch(db) {
  const epoch = randomBytes(16).toString("hex");
  db.prepare("update meta set value = ? where key = 'epoch'").run(epoch);
  return epoch;
}

/** Run `work` as one transaction. */
export function transaction(db, work) {
  db.exec("begin immediate");
  try {
    const result = work();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
