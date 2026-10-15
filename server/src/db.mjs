// The server's database: one SQLite file (the one that comes with Node), with its tables made by numbered steps, so that a newer server opens an older file.
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
];

/** Open (and make or bring up to date) the database at `path` (`:memory:` for a test). */
export function openDatabase(path) {
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
