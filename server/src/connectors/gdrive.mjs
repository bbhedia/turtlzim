// Google Drive, with the narrowest scope Google has for it (`drive.file`: the app sees only files and folders that *it* made, never the rest of the person's Drive). Everything lives in a
// folder called "Zim Notebooks" that the app makes; a notebook is a folder in it, and its sub-folders are real Drive folders, so the files can be seen and opened in Drive.
// Drive has no commit across files and gives names no uniqueness (two files may share one name in a folder: the first is the one that is used), so a send is a series of calls,
// and the version check before it is what keeps two devices from overwriting each other (not airtight: it shortens the window to one sync).
import { accessToken, forgetAccessToken } from "./oauth-token.mjs";
import { ConnectorError, safeRequest } from "./safe-fetch.mjs";

const API = "https://www.googleapis.com";
const FOLDER = "application/vnd.google-apps.folder";
export const ROOT_NAME = "Zim Notebooks";

/** A value in Drive's query language: in quotes, with the quote and the backslash escaped. */
const q = (text) => `'${String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export const gdrive = {
  kind: "gdrive",
  label: "Google Drive",
  oauth: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.file",
    extra: { access_type: "offline", prompt: "consent" },
  },

  describe() {
    return "Google Drive";
  },

  validate(input) {
    const refreshToken = String(input?.refreshToken ?? "");
    if (!refreshToken || refreshToken.length > 2000) throw new ConnectorError("Google did not give a token.", 400, "bad-settings");
    return { refreshToken };
  },

  async token(config, options) {
    return accessToken({ tokenUrl: options.endpoints?.gdrive?.token ?? this.oauth.token, app: options.apps?.gdrive, refreshToken: config.refreshToken, options, name: "Google" });
  },

  async request(config, options, url, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await safeRequest({ url, ...init, headers: { ...init.headers, authorization: `Bearer ${await this.token(config, options)}` }, timeoutMs: options.timeoutMs, allowPrivate: options.allowPrivate, allowInsecure: options.allowInsecure, lookup: options.lookup });
      if (response.status === 401 && attempt === 0) {
        forgetAccessToken(config.refreshToken);
        continue;
      }
      return response;
    }
  },

  api(options) {
    return options.driveApi ?? API;
  },

  json(response, what) {
    if (response.status === 403 || response.status === 429) throw new ConnectorError(`Google refused ${what} (its limit may be reached, or the connection no longer allows it).`, 502, "rate-limit");
    if (response.status < 200 || response.status >= 300) throw new ConnectorError(`Google answered ${response.status} for ${what}.`);
    const text = response.body.toString("utf8");
    return text ? JSON.parse(text) : {};
  },

  /** The files and folders directly in a folder. */
  async children(config, options, folderId) {
    const out = [];
    let pageToken = "";
    for (let i = 0; i < 40; i++) {
      const url = `${this.api(options)}/drive/v3/files?q=${encodeURIComponent(`${q(folderId)} in parents and trashed=false`)}&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType,size,md5Checksum)")}&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const page = this.json(await this.request(config, options, url), "the list of files");
      out.push(...page.files);
      if (!page.nextPageToken) return out;
      pageToken = page.nextPageToken;
    }
    throw new ConnectorError("There are too many files in that folder.", 502, "too-many");
  },

  /** The id of the folder called `name` in `parentId`, made if `create`; else null. (Where there are several, the one made first.) */
  async folder(config, options, parentId, name, create) {
    const url = `${this.api(options)}/drive/v3/files?q=${encodeURIComponent(`${q(parentId)} in parents and name=${q(name)} and mimeType=${q(FOLDER)} and trashed=false`)}&fields=${encodeURIComponent("files(id,createdTime)")}&orderBy=createdTime&pageSize=10`;
    const found = this.json(await this.request(config, options, url), `the folder ${name}`).files;
    if (found.length) return found[0].id;
    if (!create) return null;
    const made = this.json(await this.request(config, options, `${this.api(options)}/drive/v3/files?fields=id`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }) }), `making the folder ${name}`);
    return made.id;
  },

  async chain(config, options, names, create) {
    let id = "root";
    for (const name of names) {
      id = await this.folder(config, options, id, name, create);
      if (id === null) return null;
    }
    return id;
  },

  async test(config, options) {
    await this.chain(config, options, [ROOT_NAME], true);
  },

  async revoke(config, options) {
    await safeRequest({ url: `${options.endpoints?.gdrive?.revoke ?? "https://oauth2.googleapis.com/revoke"}?token=${encodeURIComponent(config.refreshToken)}`, method: "POST", timeoutMs: options.timeoutMs, allowPrivate: options.allowPrivate, allowInsecure: options.allowInsecure, lookup: options.lookup });
  },

  /** The files under a notebook's folder, recursively: `[{ path, size, mark, id }]` (the mark is Drive's own checksum). */
  async list(config, options, dir) {
    const top = await this.chain(config, options, [ROOT_NAME, ...dir.split("/")], false);
    if (top === null) return [];
    const files = [];
    const walk = async (folderId, prefix, depth) => {
      if (depth > 12) throw new ConnectorError("The folders go too deep.", 502, "too-deep");
      const seen = new Set();
      for (const e of await this.children(config, options, folderId)) {
        const path = prefix + e.name;
        if (seen.has(e.name)) continue; // (a second file of the same name in a folder is not used)
        seen.add(e.name);
        if (e.mimeType === FOLDER) await walk(e.id, `${path}/`, depth + 1);
        else files.push({ path, size: Number(e.size ?? 0), mark: e.md5Checksum ?? `${e.size ?? 0}`, id: e.id });
        if (files.length > 3000) throw new ConnectorError("There are too many files in that folder.", 502, "too-many");
      }
    };
    await walk(top, "", 0);
    return files.sort((a, b) => (a.path < b.path ? -1 : 1));
  },

  async folders(config, options) {
    const root = await this.chain(config, options, [ROOT_NAME], false);
    if (root === null) return [];
    return (await this.children(config, options, root)).filter((e) => e.mimeType === FOLDER && !e.name.startsWith(".")).map((e) => e.name).sort();
  },

  async read(config, options, dir, path, entry) {
    const id = entry?.id ?? (await this.list(config, options, dir)).find((f) => f.path === path)?.id;
    if (!id) throw new ConnectorError(`${path} is not on Google Drive.`, 404, "not-found");
    const response = await this.request(config, options, `${this.api(options)}/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    if (response.status !== 200) throw new ConnectorError(`Google answered ${response.status} when reading ${path}.`);
    return response.body;
  },

  async write(config, options, dir, { put, remove }) {
    const there = new Map((await this.list(config, options, dir)).map((f) => [f.path, f]));
    const folders = new Map();
    const parentOf = async (path) => {
      const names = [ROOT_NAME, ...dir.split("/"), ...path.split("/").slice(0, -1)];
      const key = names.join("/");
      if (!folders.has(key)) folders.set(key, await this.chain(config, options, names, true));
      return folders.get(key);
    };
    for (const file of put) {
      const known = there.get(file.path);
      if (known) {
        const response = await this.request(config, options, `${this.api(options)}/upload/drive/v3/files/${encodeURIComponent(known.id)}?uploadType=media`, { method: "PATCH", headers: { "content-type": "application/octet-stream" }, body: file.bytes });
        this.json(response, `writing ${file.path}`);
        continue;
      }
      const boundary = `zim${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const meta = JSON.stringify({ name: file.path.split("/").pop(), parents: [await parentOf(file.path)] });
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${boundary}--`)]);
      const response = await this.request(config, options, `${this.api(options)}/upload/drive/v3/files?uploadType=multipart&fields=id`, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
      this.json(response, `writing ${file.path}`);
    }
    for (const path of remove) {
      const known = there.get(path);
      if (!known) continue;
      const response = await this.request(config, options, `${this.api(options)}/drive/v3/files/${encodeURIComponent(known.id)}`, { method: "DELETE", headers: {} });
      if (response.status !== 204 && response.status !== 404) this.json(response, `deleting ${path}`);
    }
  },
};
