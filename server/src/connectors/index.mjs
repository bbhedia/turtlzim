// The services that a person has connected (their Nextcloud, ...): which, under what name, and the settings that let the server act for them. Those settings are secrets of
// another service (a password): they are kept sealed (AES-256-GCM, a key derived from the server's own secret key), never sent back to the page, and gone with the account.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { AccountError } from "../accounts.mjs";
import { ConnectorError } from "./safe-fetch.mjs";
import { github } from "./github.mjs";
import { versionOf, webdav } from "./webdav.mjs";

export const DRIVERS = { webdav, github };
const MAX_CONNECTORS = 10;
const SEGMENT = /^[^\u0000-\u001f\\/]{1,120}$/;

/** A folder of a notebook on the service: one to four plain names. */
export function validDir(dir) {
  return typeof dir === "string" && dir.length <= 400 && dir.split("/").length <= 4 && dir.split("/").every((part) => SEGMENT.test(part) && part !== "." && part !== ".." && !part.startsWith("."));
}

export class Connectors {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, config: { secret: Buffer, connectorOptions?: object }, now?: () => number }} parts
   * `config.connectorOptions` is for tests and for an operator who runs the server inside a private network (`allowPrivate`, `allowInsecure`).
   */
  constructor({ db, config, now = () => Math.floor(Date.now() / 1000) }) {
    this.db = db;
    this.config = config;
    this.now = now;
    this.key = Buffer.from(hkdfSync("sha256", config.secret, Buffer.alloc(0), "zim connectors v1", 32));
  }

  get options() {
    return this.config.connectorOptions ?? {};
  }

  seal(settings) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(settings), "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
  }

  unseal(blob) {
    const bytes = Buffer.from(blob);
    if (bytes[0] !== 1) throw new Error("unknown format of connector settings");
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(1, 13));
    decipher.setAuthTag(bytes.subarray(13, 29));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8"));
  }

  list(userId) {
    return this.db
      .prepare("select id, kind, label, created_at as createdAt from connectors where user_id = ? order by id")
      .all(userId)
      .map((row) => ({ ...row, service: DRIVERS[row.kind]?.label ?? row.kind }));
  }

  /** Connect a service: the settings are checked against the service itself before anything is kept. */
  async add(userId, kind, labelInput, input) {
    const driver = DRIVERS[kind];
    if (!driver) throw new AccountError("That kind of service is not supported.", 400, { code: "bad-kind" });
    if (this.db.prepare("select count(*) as n from connectors where user_id = ?").get(userId).n >= MAX_CONNECTORS) throw new AccountError(`At most ${MAX_CONNECTORS} services can be connected.`, 400, { code: "too-many" });
    const settings = await this.guard(() => driver.validate(input));
    await this.guard(() => driver.test(settings, this.options));
    const label = String(labelInput ?? "").trim().slice(0, 80) || driver.describe(settings);
    const id = Number(this.db.prepare("insert into connectors (user_id, kind, label, config, created_at) values (?, ?, ?, ?, ?)").run(userId, kind, label, this.seal(settings), this.now()).lastInsertRowid);
    return { id, kind, label, service: driver.label };
  }

  remove(userId, id) {
    if (!this.db.prepare("delete from connectors where user_id = ? and id = ?").run(userId, id).changes) throw new AccountError("No such connection.", 404, { code: "not-found" });
    return { ok: true };
  }

  /** The driver and the settings of one of the person's connections. */
  open(userId, id) {
    const row = this.db.prepare("select kind, config from connectors where user_id = ? and id = ?").get(userId, id);
    if (!row || !DRIVERS[row.kind]) throw new AccountError("No such connection.", 404, { code: "not-found" });
    return { driver: DRIVERS[row.kind], settings: this.unseal(row.config) };
  }

  /** Run something that may fail with a connector's error and say it as an account error (a status and a sentence for the person). */
  async guard(work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ConnectorError) throw new AccountError(error.message, [409, 413, 502, 504].includes(error.status) ? error.status : 400, { code: error.code });
      throw error;
    }
  }

  async folders(userId, id) {
    const { driver, settings } = this.open(userId, id);
    return { folders: (await this.guard(() => driver.folders(settings, this.options))).filter((name) => validDir(name)) };
  }

  async files(userId, id, dir) {
    const { driver, settings } = this.open(userId, id);
    const files = await this.guard(() => driver.list(settings, this.options, dir));
    return { version: files.length ? versionOf(files) : "", files: files.map((f) => ({ path: f.path, size: f.size })) };
  }

  async read(userId, id, dir) {
    const { driver, settings } = this.open(userId, id);
    return this.guard(async () => {
      const files = await driver.list(settings, this.options, dir);
      const total = files.reduce((sum, f) => sum + f.size, 0);
      if (total > 8 * 1024 * 1024) throw new ConnectorError("That notebook is bigger than 8 MB, which is more than can be fetched here.", 413, "too-big");
      const out = [];
      for (const file of files) out.push({ path: file.path, base64: (await driver.read(settings, this.options, dir, file.path)).toString("base64") });
      return { version: files.length ? versionOf(files) : "", files: out };
    });
  }

  /** Change a notebook's folder: refused if it is not as the person last saw it (`baseVersion`). Not atomic against another writer in the same instant. */
  async write(userId, id, dir, baseVersion, { put, remove }) {
    const { driver, settings } = this.open(userId, id);
    return this.guard(async () => {
      const before = await driver.list(settings, this.options, dir);
      const current = before.length ? versionOf(before) : "";
      if (current !== baseVersion) throw new AccountError("The notebook changed on that service since this copy was made.", 409, { code: "conflict", version: current });
      await driver.write(settings, this.options, dir, { put: put.map((f) => ({ path: f.path, bytes: Buffer.from(f.base64, "base64") })), remove });
      const after = await driver.list(settings, this.options, dir);
      return { version: after.length ? versionOf(after) : "" };
    });
  }
}
