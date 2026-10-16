// Dropbox, with an *app folder* (the app can only see its own folder, /Apps/<the app's name>): a notebook is a folder of it. The person authorises once (OAuth, in a window of Dropbox's own);
// the server keeps the refresh token sealed. Dropbox has no commit that spans several files, so a send is a series of uploads; each upload of a file that exists names the revision it
// replaces (`update`), and a new file is added only if none is there (`add`): a file that changed meanwhile is refused (a conflict) instead of overwritten, but files sent before it stay sent.
import { accessToken, forgetAccessToken } from "./oauth-token.mjs";
import { ConnectorError, safeRequest } from "./safe-fetch.mjs";

const API = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";

/** A header can only hold ASCII: what is not is written as \u escapes, as Dropbox asks. */
const arg = (value) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export const dropbox = {
  kind: "dropbox",
  label: "Dropbox",
  oauth: {
    authorize: "https://www.dropbox.com/oauth2/authorize",
    token: "https://api.dropboxapi.com/oauth2/token",
    scope: "files.metadata.read files.content.read files.content.write",
    extra: { token_access_type: "offline" },
  },

  describe() {
    return "Dropbox";
  },

  /** Settings come from the authorisation, never from a form: a refresh token and nothing else. */
  validate(input) {
    const refreshToken = String(input?.refreshToken ?? "");
    if (!refreshToken || refreshToken.length > 2000) throw new ConnectorError("Dropbox did not give a token.", 400, "bad-settings");
    return { refreshToken };
  },

  async token(config, options) {
    return accessToken({ tokenUrl: options.endpoints?.dropbox?.token ?? this.oauth.token, app: options.apps?.dropbox, refreshToken: config.refreshToken, options, name: "Dropbox" });
  },

  /** A call that is made with a fresh access token; one that Dropbox says is no good is made again with a new one. */
  async request(config, options, url, init) {
    for (let attempt = 0; ; attempt++) {
      const response = await safeRequest({ url, ...init, headers: { ...init.headers, authorization: `Bearer ${await this.token(config, options)}` }, timeoutMs: options.timeoutMs, allowPrivate: options.allowPrivate, allowInsecure: options.allowInsecure, lookup: options.lookup });
      if (response.status === 401 && attempt === 0) {
        forgetAccessToken(config.refreshToken);
        continue;
      }
      return response;
    }
  },

  async rpc(config, options, path, body) {
    const response = await this.request(config, options, `${options.dropboxApi ?? API}/2/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? null) });
    return this.answer(response, path);
  },

  /** The JSON of an answer, or a ConnectorError that says what Dropbox said. A `not_found` is returned as null. */
  answer(response, what) {
    const text = response.body.toString("utf8");
    if (response.status === 409) {
      if (/not_found/.test(text)) return null;
      if (/conflict/.test(text)) throw new ConnectorError("A file changed on Dropbox while this was being sent.", 409, "conflict");
      throw new ConnectorError(`Dropbox refused ${what} (${text.slice(0, 120)}).`);
    }
    if (response.status === 429) throw new ConnectorError("Dropbox says to slow down: try again in a moment.", 502, "rate-limit");
    if (response.status < 200 || response.status >= 300) throw new ConnectorError(`Dropbox answered ${response.status} for ${what}.`);
    return text ? JSON.parse(text) : {};
  },

  async test(config, options) {
    await this.rpc(config, options, "files/list_folder", { path: "", limit: 1 });
  },

  async revoke(config, options) {
    await this.request(config, options, `${options.dropboxApi ?? API}/2/auth/token/revoke`, { method: "POST", headers: {} });
  },

  /** Every file under a folder: `[{ path, size, mark, rev }]`, the mark being Dropbox's own content hash. */
  async entries(config, options, folder, recursive) {
    let page = await this.rpc(config, options, "files/list_folder", { path: folder, recursive, limit: 2000 });
    if (page === null) return null;
    const all = [...page.entries];
    for (let i = 0; page.has_more; i++) {
      if (i > 20 || all.length > 6000) throw new ConnectorError("There are too many files in that folder.", 502, "too-many");
      page = await this.rpc(config, options, "files/list_folder/continue", { cursor: page.cursor });
      all.push(...page.entries);
    }
    return all;
  },

  async list(config, options, dir) {
    const base = `/${dir}`;
    const all = await this.entries(config, options, base, true);
    if (all === null) return [];
    const files = all
      .filter((e) => e[".tag"] === "file")
      .map((e) => ({ path: e.path_display.slice(base.length + 1), size: e.size ?? 0, mark: e.content_hash, rev: e.rev }));
    if (files.length > 3000) throw new ConnectorError("There are too many files in that folder.", 502, "too-many");
    return files.sort((a, b) => (a.path < b.path ? -1 : 1));
  },

  async folders(config, options) {
    const all = (await this.entries(config, options, "", false)) ?? [];
    return all.filter((e) => e[".tag"] === "folder" && !e.name.startsWith(".")).map((e) => e.name).sort();
  },

  async read(config, options, dir, path) {
    const response = await this.request(config, options, `${options.dropboxContent ?? CONTENT}/2/files/download`, { method: "POST", headers: { "dropbox-api-arg": arg({ path: `/${dir}/${path}` }) } });
    if (response.status !== 200) throw new ConnectorError(`Dropbox answered ${response.status} when reading ${path}.`);
    return response.body;
  },

  async write(config, options, dir, { put, remove }) {
    const there = new Map((await this.list(config, options, dir)).map((f) => [f.path, f]));
    for (const file of put) {
      const known = there.get(file.path);
      const response = await this.request(config, options, `${options.dropboxContent ?? CONTENT}/2/files/upload`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "dropbox-api-arg": arg({ path: `/${dir}/${file.path}`, mode: known ? { ".tag": "update", update: known.rev } : "add", autorename: false, mute: true }) },
        body: file.bytes,
      });
      this.answer(response, `writing ${file.path}`);
    }
    for (const path of remove) if (there.has(path)) await this.rpc(config, options, "files/delete_v2", { path: `/${dir}/${path}` });
  },
};
