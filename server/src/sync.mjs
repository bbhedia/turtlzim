// Notebooks kept on the server, for a person who has an account: whole notebooks, as the files they are (clear: nothing here encrypts them yet), within the account's
// quota. A write says which revision it was made from; if another device wrote since, it is refused (409) with the current revision, and nothing is overwritten.
import { createHash } from "node:crypto";
import { transaction } from "./db.mjs";
import { AccountError } from "./accounts.mjs";

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_FILES = 2000;
const MAX_PATH = 240;
/** A wrapped key is what the core makes: 4 (magic) + 4 + 4 (cost) + 32 (salt) + 12 (nonce) + 32 (key) + 16 (tag). */
const WRAPPED_KEY_BYTES = 104;

/** A path inside a notebook: relative, no `..`, no hidden part, no control characters. */
export function validPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= MAX_PATH && !/[\u0000-\u001f\\]/.test(path) && !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."));
}

export class Sync {
  constructor({ db, now = () => Math.floor(Date.now() / 1000) }) {
    this.db = db;
    this.now = now;
  }

  used(userId) {
    return this.db.prepare("select coalesce(sum(length(f.bytes)), 0) as n from notebook_files f where f.user_id = ?").get(userId).n;
  }

  list(userId) {
    return this.db
      .prepare("select n.id, n.title, n.revision, n.updated_at as updatedAt, coalesce((select sum(length(bytes)) from notebook_files f where f.user_id = n.user_id and f.notebook_id = n.id), 0) as bytes from notebooks n where n.user_id = ? order by n.updated_at desc")
      .all(userId)
      .map((row) => ({ ...row }));
  }

  get(userId, id) {
    const notebook = this.db.prepare("select id, title, revision, updated_at as updatedAt from notebooks where user_id = ? and id = ?").get(userId, id);
    if (!notebook) throw new AccountError("No such notebook.", 404, { code: "not-found" });
    const files = this.db.prepare("select path, bytes from notebook_files where user_id = ? and notebook_id = ? order by path").all(userId, id).map((f) => ({ path: f.path, base64: Buffer.from(f.bytes).toString("base64") }));
    return { ...notebook, files };
  }

  /**
   * Replace a notebook's files. `baseRevision` is the revision this copy was made from (0 for a notebook that is new here). Everything or nothing:
   * a conflict or a quota that would be passed changes nothing.
   */
  put(userId, quotaBytes, id, { title, baseRevision, files }) {
    if (!ID.test(String(id))) throw new AccountError("That is not a notebook id.", 400, { code: "bad-id" });
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new AccountError("A notebook needs a name (200 characters at most).", 400, { code: "bad-title" });
    if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new AccountError("Say which revision this was made from.", 400, { code: "bad-revision" });
    if (!Array.isArray(files) || files.length > MAX_FILES) throw new AccountError(`A notebook has at most ${MAX_FILES} files.`, 400, { code: "bad-files" });
    const seen = new Set();
    const decoded = files.map((file) => {
      if (!file || !validPath(file.path) || typeof file.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new AccountError("A file of the notebook is not valid.", 400, { code: "bad-files" });
      if (seen.has(file.path.toLowerCase())) throw new AccountError(`Two files are named ${file.path}.`, 400, { code: "bad-files" });
      seen.add(file.path.toLowerCase());
      return { path: file.path, bytes: Buffer.from(file.base64, "base64") };
    });
    const size = decoded.reduce((sum, f) => sum + f.bytes.length, 0);
    return transaction(this.db, () => {
      const current = this.db.prepare("select revision from notebooks where user_id = ? and id = ?").get(userId, id);
      const revision = current?.revision ?? 0;
      if (revision !== baseRevision) throw new AccountError("This notebook was changed somewhere else since this copy was made.", 409, { code: "conflict", revision });
      const others = this.used(userId) - (current ? this.db.prepare("select coalesce(sum(length(bytes)), 0) as n from notebook_files where user_id = ? and notebook_id = ?").get(userId, id).n : 0);
      if (others + size > quotaBytes) throw new AccountError(`That would use ${Math.ceil((others + size) / 1024)} KB of the ${Math.floor(quotaBytes / 1024)} KB that the account has.`, 413, { code: "quota", usedBytes: others, quotaBytes });
      const next = revision + 1;
      if (current) this.db.prepare("update notebooks set title = ?, revision = ?, updated_at = ? where user_id = ? and id = ?").run(title.trim(), next, this.now(), userId, id);
      else this.db.prepare("insert into notebooks (user_id, id, title, revision, updated_at) values (?, ?, ?, ?, ?)").run(userId, id, title.trim(), next, this.now());
      this.db.prepare("delete from notebook_files where user_id = ? and notebook_id = ?").run(userId, id);
      const insert = this.db.prepare("insert into notebook_files (user_id, notebook_id, path, bytes) values (?, ?, ?, ?)");
      for (const file of decoded) insert.run(userId, id, file.path, file.bytes);
      return { revision: next, usedBytes: others + size };
    });
  }

  /** What a notebook holds, without the bytes: each file's path, size and a mark that changes when its content does (the SHA-256 of the bytes, the same one the app makes of its own files). */
  manifest(userId, id) {
    const notebook = this.db.prepare("select id, title, revision, updated_at as updatedAt from notebooks where user_id = ? and id = ?").get(userId, id);
    if (!notebook) throw new AccountError("No such notebook.", 404, { code: "not-found" });
    const files = this.db.prepare("select path, bytes from notebook_files where user_id = ? and notebook_id = ? order by path").all(userId, id).map((f) => ({ path: f.path, size: f.bytes.length, mark: createHash("sha256").update(f.bytes).digest("hex") }));
    return { ...notebook, files };
  }

  /** Some of a notebook's files (the paths that it has; a path it does not have is left out). */
  readFiles(userId, id, paths) {
    if (!Array.isArray(paths) || paths.length > MAX_FILES || !paths.every(validPath)) throw new AccountError("Those are not paths of a notebook.", 400, { code: "bad-files" });
    const exists = this.db.prepare("select title, revision from notebooks where user_id = ? and id = ?").get(userId, id);
    if (!exists) throw new AccountError("No such notebook.", 404, { code: "not-found" });
    const one = this.db.prepare("select bytes from notebook_files where user_id = ? and notebook_id = ? and path = ?");
    const files = [];
    for (const path of paths) {
      const row = one.get(userId, id, path);
      if (row) files.push({ path, base64: Buffer.from(row.bytes).toString("base64") });
    }
    return { title: exists.title, revision: exists.revision, files };
  }

  /**
   * Change some of a notebook's files: write these, delete those, and leave the rest. Made from `baseRevision` like a whole write; everything or nothing; a conflict or a
   * quota that would be passed changes nothing. A path that is both written and deleted is refused.
   */
  patch(userId, quotaBytes, id, { title, baseRevision, put, remove }) {
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new AccountError("A notebook needs a name (200 characters at most).", 400, { code: "bad-title" });
    if (!Number.isInteger(baseRevision) || baseRevision < 1) throw new AccountError("Say which revision this was made from.", 400, { code: "bad-revision" });
    if (!Array.isArray(put) || !Array.isArray(remove) || put.length > MAX_FILES || remove.length > MAX_FILES) throw new AccountError("That change is not valid.", 400, { code: "bad-files" });
    const writing = new Map();
    for (const file of put) {
      if (!file || !validPath(file.path) || typeof file.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new AccountError("A file of the notebook is not valid.", 400, { code: "bad-files" });
      if (writing.has(file.path.toLowerCase())) throw new AccountError(`Two files are named ${file.path}.`, 400, { code: "bad-files" });
      writing.set(file.path.toLowerCase(), { path: file.path, bytes: Buffer.from(file.base64, "base64") });
    }
    for (const path of remove) if (!validPath(path) || writing.has(String(path).toLowerCase())) throw new AccountError("A file of the notebook is not valid.", 400, { code: "bad-files" });
    return transaction(this.db, () => {
      const current = this.db.prepare("select revision, title from notebooks where user_id = ? and id = ?").get(userId, id);
      if (!current) throw new AccountError("No such notebook.", 404, { code: "not-found" });
      if (current.revision !== baseRevision) throw new AccountError("This notebook was changed somewhere else since this copy was made.", 409, { code: "conflict", revision: current.revision });
      const size = this.db.prepare("select path, length(bytes) as n from notebook_files where user_id = ? and notebook_id = ?").all(userId, id);
      const sizeOf = new Map(size.map((f) => [f.path.toLowerCase(), f.n]));
      let notebookNow = size.reduce((sum, f) => sum + f.n, 0);
      for (const path of remove) notebookNow -= sizeOf.get(path.toLowerCase()) ?? 0;
      for (const [key, file] of writing) notebookNow += file.bytes.length - (sizeOf.has(key) && !remove.some((r) => r.toLowerCase() === key) ? sizeOf.get(key) : 0);
      const others = this.used(userId) - size.reduce((sum, f) => sum + f.n, 0);
      if (others + notebookNow > quotaBytes) throw new AccountError(`That would use ${Math.ceil((others + notebookNow) / 1024)} KB of the ${Math.floor(quotaBytes / 1024)} KB that the account has.`, 413, { code: "quota", usedBytes: others + size.reduce((sum, f) => sum + f.n, 0), quotaBytes });
      if (writing.size === 0 && remove.length === 0 && title.trim() === current.title) return { revision: current.revision, usedBytes: others + notebookNow };
      const next = current.revision + 1;
      this.db.prepare("update notebooks set title = ?, revision = ?, updated_at = ? where user_id = ? and id = ?").run(title.trim(), next, this.now(), userId, id);
      const del = this.db.prepare("delete from notebook_files where user_id = ? and notebook_id = ? and lower(path) = lower(?)");
      for (const path of remove) del.run(userId, id, path);
      const insert = this.db.prepare("insert into notebook_files (user_id, notebook_id, path, bytes) values (?, ?, ?, ?)");
      for (const file of writing.values()) {
        del.run(userId, id, file.path);
        insert.run(userId, id, file.path, file.bytes);
      }
      return { revision: next, usedBytes: others + notebookNow };
    });
  }

  /**
   * The account's key for sealed copies, **wrapped by a passphrase** that the server does not have (see core/turtl-core-rs/src/seal.rs): one opaque 104-byte value, and a check value that says
   * which key it is. The server can't open it; it keeps it so that a new device of the account can take the key with the passphrase, and compares what it is told so that a key
   * is replaced only by a device that saw the one it replaces.
   */
  keychain(userId) {
    const row = this.db.prepare("select wrapped, check_value as checkValue, updated_at as updatedAt from cloud_keys where user_id = ?").get(userId);
    return row ? { wrapped: Buffer.from(row.wrapped).toString("base64"), check: row.checkValue, updatedAt: row.updatedAt } : { wrapped: null };
  }

  /** Keep the wrapped key: as the first (`expect: "none"`), or in place of the one whose SHA-256 is `expect`. Refused (409, with what is there) if it is not what the sender thought. */
  putKeychain(userId, { wrapped, check, expect }) {
    if (typeof wrapped !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(wrapped)) throw new AccountError("That is not a wrapped key.", 400, { code: "bad-key" });
    const bytes = Buffer.from(wrapped, "base64");
    if (bytes.length !== WRAPPED_KEY_BYTES || bytes.subarray(0, 4).toString("latin1") !== "ZSW1") throw new AccountError("That is not a wrapped key.", 400, { code: "bad-key" });
    if (typeof check !== "string" || !/^[0-9a-f]{32}$/.test(check)) throw new AccountError("That key has no check value.", 400, { code: "bad-key" });
    if (expect !== "none" && !(typeof expect === "string" && /^[0-9a-f]{64}$/.test(expect))) throw new AccountError("Say which key this replaces.", 400, { code: "bad-expect" });
    return transaction(this.db, () => {
      const current = this.db.prepare("select wrapped from cloud_keys where user_id = ?").get(userId);
      const there = current ? createHash("sha256").update(current.wrapped).digest("hex") : "none";
      if (there !== expect) throw new AccountError("This account's key for sealed copies is not the one that was seen.", 409, { code: "conflict", ...this.keychain(userId) });
      this.db.prepare("insert into cloud_keys (user_id, wrapped, check_value, updated_at) values (?, ?, ?, ?) on conflict (user_id) do update set wrapped = excluded.wrapped, check_value = excluded.check_value, updated_at = excluded.updated_at").run(userId, bytes, check, this.now());
      return { ok: true, updatedAt: this.now() };
    });
  }

  /**
   * Start the account's sealed copies over: the key, and the sealed notebooks kept in this account's own space (the ids that begin `zsl-`), are deleted, if the key is the one that the sender saw
   * (`expect`: the SHA-256 of the wrapped key; a key made by another device since is a 409 that says which). What a connected service holds is not touched here: it is the person's.
   * For a passphrase that is forgotten, or a key that is not the one the person's devices have: with no key, a first one can be made again.
   */
  resetSealed(userId, { expect } = {}) {
    if (typeof expect !== "string" || !/^[0-9a-f]{64}$/.test(expect)) throw new AccountError("Say which key this deletes.", 400, { code: "bad-expect" });
    return transaction(this.db, () => {
      const current = this.db.prepare("select wrapped from cloud_keys where user_id = ?").get(userId);
      if (!current) throw new AccountError("There is no key for sealed copies to delete.", 404, { code: "not-found" });
      if (createHash("sha256").update(current.wrapped).digest("hex") !== expect) throw new AccountError("This account's key for sealed copies is not the one that was seen.", 409, { code: "conflict", ...this.keychain(userId) });
      const removed = this.db.prepare("delete from notebooks where user_id = ? and substr(id, 1, 4) = 'zsl-'").run(userId).changes;
      this.db.prepare("delete from cloud_keys where user_id = ?").run(userId);
      return { ok: true, removed: Number(removed) };
    });
  }

  remove(userId, id) {
    const done = this.db.prepare("delete from notebooks where user_id = ? and id = ?").run(userId, id).changes;
    if (!done) throw new AccountError("No such notebook.", 404, { code: "not-found" });
    return { ok: true };
  }
}
