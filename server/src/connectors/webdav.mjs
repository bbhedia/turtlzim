// Nextcloud, ownCloud and any WebDAV server: a notebook is a folder of files. The person gives the address of the folder that holds their notebooks (for Nextcloud:
// https://host/remote.php/dav/files/USER/), a user name and an app password; a notebook lives in a sub-folder named for it.
import { createHash } from "node:crypto";
import { ConnectorError, safeRequest } from "./safe-fetch.mjs";

const decode = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

export const webdav = {
  kind: "webdav",
  label: "Nextcloud / ownCloud / WebDAV",

  /** The settings as they are kept (and nothing else of what was sent), or an error that says what is wrong. */
  validate(input) {
    const url = String(input?.url ?? "").trim();
    const username = String(input?.username ?? "");
    const password = String(input?.password ?? "");
    if (!url) throw new ConnectorError("Give the address of the folder.", 400, "bad-settings");
    if (!username || !password) throw new ConnectorError("Give the user name and the password (for Nextcloud, an app password).", 400, "bad-settings");
    if (url.length > 500 || username.length > 200 || password.length > 500) throw new ConnectorError("One of the settings is too long.", 400, "bad-settings");
    return { url: url.replace(/\/*$/, "/"), username, password };
  },

  describe(config) {
    return new URL(config.url).host;
  },

  request(config, options, method, path, extra = {}) {
    return safeRequest({
      url: config.url + (path ? encodePath(path) : ""),
      method,
      headers: { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`, ...extra.headers },
      body: extra.body,
      ...options,
    });
  },

  /** Say whether the settings work, and what is wrong if not. */
  async test(config, options) {
    const response = await this.request(config, options, "PROPFIND", "", { headers: { depth: "0", "content-type": "application/xml" } });
    if (response.status === 401 || response.status === 403) throw new ConnectorError("The server refused that user name and password.", 400, "bad-credentials");
    if (response.status === 404) throw new ConnectorError("The folder was not found at that address.", 400, "not-found");
    if (response.status !== 207) throw new ConnectorError(`That does not look like a WebDAV folder (the server answered ${response.status}).`, 400, "not-webdav");
  },

  /** The files under `dir` (recursively), each with a mark that changes when it does: `[{ path, size, mark }]`; empty if the folder does not exist. */
  async list(config, options, dir) {
    const files = [];
    const walk = async (folder, depth) => {
      if (depth > 12) throw new ConnectorError("The folders go too deep.", 502, "too-deep");
      const response = await this.request(config, options, "PROPFIND", folder, { headers: { depth: "1", "content-type": "application/xml" } });
      if (response.status === 404) return;
      if (response.status !== 207) throw new ConnectorError(`The server answered ${response.status} when listing ${folder || "the folder"}.`);
      const base = new URL(config.url).pathname;
      for (const block of response.body.toString("utf8").split(/<(?:\w+:)?response[\s>]/i).slice(1)) {
        const href = /<(?:\w+:)?href[^>]*>([^<]*)</i.exec(block)?.[1];
        if (!href) continue;
        let path;
        try {
          path = new URL(decode(href), config.url).pathname;
          if (!path.startsWith(base)) continue;
          path = decodeURIComponent(path.slice(base.length)).replace(/\/+$/, "");
        } catch {
          continue;
        }
        if (path === folder.replace(/\/+$/, "")) continue;
        const isFolder = /<(?:\w+:)?collection\s*\/?>/i.test(block);
        if (isFolder) {
          await walk(path, depth + 1);
          continue;
        }
        const size = Number(/<(?:\w+:)?getcontentlength[^>]*>(\d+)</i.exec(block)?.[1] ?? 0);
        const etag = /<(?:\w+:)?getetag[^>]*>([^<]*)</i.exec(block)?.[1] ?? "";
        const modified = /<(?:\w+:)?getlastmodified[^>]*>([^<]*)</i.exec(block)?.[1] ?? "";
        files.push({ path, size, mark: decode(etag) || `${size}@${modified}` });
        if (files.length > 3000) throw new ConnectorError("There are too many files in that folder.", 502, "too-many");
      }
    };
    await walk(dir, 0);
    return files.map((f) => ({ ...f, path: f.path.slice(dir.length + 1) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  },

  /** The folders at the root of the connected folder: each one may be a notebook. */
  async folders(config, options) {
    const response = await this.request(config, options, "PROPFIND", "", { headers: { depth: "1", "content-type": "application/xml" } });
    if (response.status !== 207) throw new ConnectorError(`The server answered ${response.status} when listing the folder.`);
    const base = new URL(config.url).pathname;
    const names = [];
    for (const block of response.body.toString("utf8").split(/<(?:\w+:)?response[\s>]/i).slice(1)) {
      const href = /<(?:\w+:)?href[^>]*>([^<]*)</i.exec(block)?.[1];
      if (!href || !/<(?:\w+:)?collection\s*\/?>/i.test(block)) continue;
      try {
        const path = new URL(decode(href), config.url).pathname;
        if (!path.startsWith(base)) continue;
        const name = decodeURIComponent(path.slice(base.length)).replace(/\/+$/, "");
        if (name && !name.includes("/") && !name.startsWith(".")) names.push(name);
      } catch {
        // not an address of this folder
      }
    }
    return names.sort();
  },

  async read(config, options, dir, path) {
    const response = await this.request(config, options, "GET", `${dir}/${path}`);
    if (response.status !== 200) throw new ConnectorError(`The server answered ${response.status} when reading ${path}.`);
    return response.body;
  },

  /** Make every folder on the way to `dir`, as far as it is not there. */
  async ensureFolder(config, options, folder) {
    let here = "";
    for (const part of folder.split("/")) {
      here = here ? `${here}/${part}` : part;
      const response = await this.request(config, options, "MKCOL", here);
      // (405: it is there already; 201: made)
      if (![201, 405, 301].includes(response.status)) throw new ConnectorError(`The server answered ${response.status} when making the folder ${here}.`);
    }
  },

  async write(config, options, dir, { put, remove }) {
    await this.ensureFolder(config, options, dir);
    const made = new Set([dir]);
    for (const file of put) {
      const parent = `${dir}/${file.path}`.split("/").slice(0, -1).join("/");
      if (!made.has(parent)) {
        await this.ensureFolder(config, options, parent);
        made.add(parent);
      }
      const response = await this.request(config, options, "PUT", `${dir}/${file.path}`, { body: file.bytes, headers: { "content-type": "application/octet-stream" } });
      if (![200, 201, 204].includes(response.status)) throw new ConnectorError(`The server answered ${response.status} when writing ${file.path}.`);
    }
    for (const path of remove) {
      const response = await this.request(config, options, "DELETE", `${dir}/${path}`);
      if (![200, 204, 404].includes(response.status)) throw new ConnectorError(`The server answered ${response.status} when deleting ${path}.`);
    }
  },
};

/** One value for the state of a remote folder: it changes when any file does. */
export function versionOf(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) hash.update(`${file.path}\0${file.mark}\0${file.size}\n`);
  return hash.digest("hex").slice(0, 32);
}
