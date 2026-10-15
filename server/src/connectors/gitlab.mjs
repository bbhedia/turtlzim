// A GitLab project (gitlab.com or a GitLab of the person's own): a notebook is a folder of it. The person gives the project (`group/name`), a branch, a folder for the notebooks
// and a personal access token (scope `api`; best: a project access token with the Developer role). A change is **one commit** (`POST /repository/commits` with a list of actions)
// that names the commit it was made on top of (`last_commit_id`): if the branch moved meanwhile GitLab refuses it, so two devices can't overwrite each other.
import { ConnectorError, safeRequest } from "./safe-fetch.mjs";

const HOST = /^[A-Za-z0-9.-]{1,200}(:\d{1,5})?$/;
const SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.-]+`;
const PROJECT = new RegExp(`^(\\d{1,12}|${SEGMENT}(?:/${SEGMENT}){1,5})$`);
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const ROOT_PART = /^[A-Za-z0-9 _.-]{1,80}$/;
const STALE = /last.?commit|changed since|not up to date|has changed/i;

const enc = (path) => path.split("/").map(encodeURIComponent).join("/");

export const gitlab = {
  kind: "gitlab",
  label: "GitLab project",

  validate(input) {
    const host = String(input?.host ?? "").trim().toLowerCase() || "gitlab.com";
    const project = String(input?.project ?? "").trim();
    const branch = String(input?.branch ?? "").trim() || "main";
    const root = String(input?.root ?? "").trim().replace(/^\/+|\/+$/g, "");
    const token = String(input?.token ?? "").trim();
    if (!HOST.test(host)) throw new ConnectorError("That is not a GitLab address (give only the host name, like gitlab.com).", 400, "bad-settings");
    if (!PROJECT.test(project)) throw new ConnectorError("Give the project as group/name, for example ada/notebooks.", 400, "bad-settings");
    if (!BRANCH.test(branch)) throw new ConnectorError("That is not a branch name.", 400, "bad-settings");
    if (root && (root.split("/").length > 3 || !root.split("/").every((p) => ROOT_PART.test(p) && p !== "." && p !== ".." && !p.startsWith(".")))) throw new ConnectorError("That is not a folder name that can be used (up to three levels of plain names).", 400, "bad-settings");
    if (!token || token.length > 300 || /\s/.test(token)) throw new ConnectorError("Give the access token.", 400, "bad-settings");
    return { host, project, branch, root, token };
  },

  describe(config) {
    return `${config.host}/${config.project}`;
  },

  prefix(config, dir) {
    return [config.root, dir].filter(Boolean).join("/");
  },

  async api(config, options, method, path, body, raw = false) {
    const response = await safeRequest({
      url: `${options.gitlabApi ?? `https://${config.host}/api/v4`}/projects/${encodeURIComponent(config.project)}${path}`,
      method,
      headers: { "private-token": config.token, accept: raw ? "application/octet-stream" : "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      allowPrivate: options.allowPrivate,
      allowInsecure: options.allowInsecure,
      lookup: options.lookup,
    });
    if (response.status === 401) throw new ConnectorError("GitLab refused that token.", 400, "bad-credentials");
    return response;
  },

  json(response, what) {
    if (response.status === 403) throw new ConnectorError(`GitLab refused ${what} (the token may not allow it).`, 400, "forbidden");
    if (response.status === 404) throw new ConnectorError(`GitLab did not find ${what}. Check the project, the branch and that the token can see the project.`, 400, "not-found");
    if (response.status < 200 || response.status >= 300) throw new ConnectorError(`GitLab answered ${response.status} for ${what}.`);
    try {
      return JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new ConnectorError("GitLab's answer could not be read.");
    }
  },

  async head(config, options) {
    const branch = await this.api(config, options, "GET", `/repository/branches/${encodeURIComponent(config.branch)}`);
    if (branch.status === 404) throw new ConnectorError(`The branch ${config.branch} does not exist, or the project is empty: make a first commit (a README) on it first.`, 400, "no-branch");
    return this.json(branch, "the branch").commit.id;
  },

  async test(config, options) {
    const project = this.json(await this.api(config, options, "GET", ""), "the project");
    const level = Math.max(project.permissions?.project_access?.access_level ?? 0, project.permissions?.group_access?.access_level ?? 0);
    if (project.permissions && level < 30) throw new ConnectorError("The token can see that project but not write to it (it needs the Developer role or more).", 400, "read-only");
    await this.head(config, options);
  },

  /** The files under a folder of the branch, as `[{ path, size, mark }]` (a path from the project's root; the mark is the file's content hash). GitLab lists in pages. */
  async tree(config, options, path) {
    const files = [];
    for (let page = 1; page <= 60; page++) {
      const response = await this.api(config, options, "GET", `/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(config.branch)}${path ? `&path=${encodeURIComponent(path)}` : ""}`);
      if (response.status === 404 && path) return files; // (a folder that is not there yet has no files)
      for (const e of this.json(response, "the files")) if (e.type === "blob") files.push({ path: e.path, size: 0, mark: e.id });
      if (!response.headers["x-next-page"]) break;
      if (files.length > 3000) throw new ConnectorError("There are too many files in that folder.", 502, "too-many");
      if (page === 60) throw new ConnectorError("There are too many files in that folder.", 502, "too-many");
    }
    return files;
  },

  async list(config, options, dir) {
    const prefix = `${this.prefix(config, dir)}/`;
    return (await this.tree(config, options, this.prefix(config, dir)))
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => ({ ...f, path: f.path.slice(prefix.length) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  },

  async folders(config, options) {
    const prefix = config.root ? `${config.root}/` : "";
    const names = new Set();
    for (const f of await this.tree(config, options, config.root)) if (f.path.startsWith(prefix) && f.path.slice(prefix.length).includes("/")) names.add(f.path.slice(prefix.length).split("/")[0]);
    return [...names].filter((n) => !n.startsWith(".")).sort();
  },

  async read(config, options, dir, path) {
    const response = await this.api(config, options, "GET", `/repository/files/${encodeURIComponent(`${this.prefix(config, dir)}/${path}`)}/raw?ref=${encodeURIComponent(config.branch)}`, undefined, true);
    if (response.status !== 200) throw new ConnectorError(`GitLab answered ${response.status} when reading ${path}.`);
    return response.body;
  },

  async write(config, options, dir, { put, remove }) {
    if (put.length === 0 && remove.length === 0) return;
    const last = await this.head(config, options);
    const there = new Set((await this.list(config, options, dir)).map((f) => f.path));
    const actions = [];
    for (const file of put) actions.push({ action: there.has(file.path) ? "update" : "create", file_path: `${this.prefix(config, dir)}/${file.path}`, content: file.bytes.toString("base64"), encoding: "base64" });
    for (const path of remove) if (there.has(path)) actions.push({ action: "delete", file_path: `${this.prefix(config, dir)}/${path}` });
    if (actions.length === 0) return;
    const message = `Zim Notebook: ${dir} (${put.length} written${remove.length ? `, ${remove.length} deleted` : ""})`;
    const made = await this.api(config, options, "POST", "/repository/commits", { branch: config.branch, commit_message: message, actions, last_commit_id: last });
    if ((made.status === 400 || made.status === 409) && STALE.test(made.body.toString("utf8"))) throw new ConnectorError("The branch changed on GitLab while this was being sent.", 409, "conflict");
    this.json(made, "the new commit");
  },
};
