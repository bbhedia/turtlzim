// A GitHub repository: a notebook is a folder of it. The person gives `owner/name`, a branch, a folder of the repository to keep notebooks in and a personal access token (best: a fine-grained
// one that can only touch that repository, with "Contents: read and write"). A change is **one commit** made through the Git Data API (blobs, a tree, a commit, then the branch moved
// without force): if the branch moved meanwhile, GitHub refuses the move, so two devices can't overwrite each other here, unlike on a plain WebDAV folder.
import { ConnectorError, safeRequest } from "./safe-fetch.mjs";
import { versionOf } from "./webdav.mjs";

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const ROOT_PART = /^[A-Za-z0-9 _.-]{1,80}$/;
const DEFAULT_API = "https://api.github.com";

const enc = (path) => path.split("/").map(encodeURIComponent).join("/");

export const github = {
  kind: "github",
  label: "GitHub repository",

  validate(input) {
    const repo = String(input?.repo ?? "").trim();
    const branch = String(input?.branch ?? "").trim() || "main";
    const root = String(input?.root ?? "").trim().replace(/^\/+|\/+$/g, "");
    const token = String(input?.token ?? "").trim();
    if (!REPO.test(repo)) throw new ConnectorError("Give the repository as owner/name, for example ada/notebooks.", 400, "bad-settings");
    if (!BRANCH.test(branch)) throw new ConnectorError("That is not a branch name.", 400, "bad-settings");
    if (root && (root.split("/").length > 3 || !root.split("/").every((p) => ROOT_PART.test(p) && p !== "." && p !== ".." && !p.startsWith(".")))) throw new ConnectorError("That is not a folder name that can be used (up to three levels of plain names).", 400, "bad-settings");
    if (!token || token.length > 300 || /\s/.test(token)) throw new ConnectorError("Give the access token.", 400, "bad-settings");
    return { repo, branch, root, token };
  },

  describe(config) {
    return `github.com/${config.repo}`;
  },

  prefix(config, dir) {
    return [config.root, dir].filter(Boolean).join("/");
  },

  async api(config, options, method, path, body, accept = "application/vnd.github+json") {
    const response = await safeRequest({
      url: `${options.githubApi ?? DEFAULT_API}${path}`,
      method,
      headers: { authorization: `Bearer ${config.token}`, accept, "x-github-api-version": "2022-11-28", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: options.timeoutMs,
      allowPrivate: options.allowPrivate,
      allowInsecure: options.allowInsecure,
      lookup: options.lookup,
    });
    if (response.status === 401) throw new ConnectorError("GitHub refused that token.", 400, "bad-credentials");
    return response;
  },

  json(response, what) {
    if (response.status === 403 || response.status === 429) throw new ConnectorError(`GitHub refused ${what} (the token may not allow it, or its limit is reached).`, 400, "forbidden");
    if (response.status === 404) throw new ConnectorError(`GitHub did not find ${what}. Check the repository, the branch and that the token can see the repository.`, 400, "not-found");
    if (response.status < 200 || response.status >= 300) throw new ConnectorError(`GitHub answered ${response.status} for ${what}.`);
    try {
      return JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new ConnectorError("GitHub's answer could not be read.");
    }
  },

  async test(config, options) {
    const repo = this.json(await this.api(config, options, "GET", `/repos/${config.repo}`), "the repository");
    if (repo.permissions && repo.permissions.push === false) throw new ConnectorError("The token can read that repository but not write to it.", 400, "read-only");
    const ref = await this.api(config, options, "GET", `/repos/${config.repo}/git/ref/heads/${enc(config.branch)}`);
    if (ref.status === 404 || ref.status === 409) throw new ConnectorError(`The branch ${config.branch} does not exist, or the repository is empty: make a first commit (a README) on it first.`, 400, "no-branch");
    this.json(ref, "the branch");
  },

  /** Every file of the repository's branch, as the tree says: `[{ path, size, mark }]` (the mark is the file's content hash). */
  async tree(config, options) {
    const tree = this.json(await this.api(config, options, "GET", `/repos/${config.repo}/git/trees/${enc(config.branch)}?recursive=1`), "the branch");
    if (tree.truncated) throw new ConnectorError("The repository is too big to be listed.", 502, "too-big");
    return (tree.tree ?? []).filter((e) => e.type === "blob").map((e) => ({ path: e.path, size: e.size ?? 0, mark: e.sha }));
  },

  async list(config, options, dir) {
    const prefix = `${this.prefix(config, dir)}/`;
    const files = (await this.tree(config, options)).filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
    if (files.length > 3000) throw new ConnectorError("There are too many files in that folder.", 502, "too-many");
    return files.sort((a, b) => (a.path < b.path ? -1 : 1));
  },

  async folders(config, options) {
    const prefix = config.root ? `${config.root}/` : "";
    const names = new Set();
    for (const f of await this.tree(config, options)) if (f.path.startsWith(prefix) && f.path.slice(prefix.length).includes("/")) names.add(f.path.slice(prefix.length).split("/")[0]);
    return [...names].filter((n) => !n.startsWith(".")).sort();
  },

  async read(config, options, dir, path) {
    const response = await this.api(config, options, "GET", `/repos/${config.repo}/contents/${enc(`${this.prefix(config, dir)}/${path}`)}?ref=${encodeURIComponent(config.branch)}`, undefined, "application/vnd.github.raw+json");
    if (response.status !== 200) throw new ConnectorError(`GitHub answered ${response.status} when reading ${path}.`);
    return response.body;
  },

  async write(config, options, dir, { put, remove }) {
    if (put.length === 0 && remove.length === 0) return;
    const head = this.json(await this.api(config, options, "GET", `/repos/${config.repo}/git/ref/heads/${enc(config.branch)}`), "the branch");
    const commit = this.json(await this.api(config, options, "GET", `/repos/${config.repo}/git/commits/${head.object.sha}`), "the last commit");
    const entries = [];
    for (const file of put) {
      const blob = this.json(await this.api(config, options, "POST", `/repos/${config.repo}/git/blobs`, { content: file.bytes.toString("base64"), encoding: "base64" }), `a file (${file.path})`);
      entries.push({ path: `${this.prefix(config, dir)}/${file.path}`, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const path of remove) entries.push({ path: `${this.prefix(config, dir)}/${path}`, mode: "100644", type: "blob", sha: null });
    const tree = this.json(await this.api(config, options, "POST", `/repos/${config.repo}/git/trees`, { base_tree: commit.tree.sha, tree: entries }), "the new tree");
    const message = `Zim Notebook: ${dir} (${put.length} written${remove.length ? `, ${remove.length} deleted` : ""})`;
    const made = this.json(await this.api(config, options, "POST", `/repos/${config.repo}/git/commits`, { message, tree: tree.sha, parents: [head.object.sha] }), "the new commit");
    const moved = await this.api(config, options, "PATCH", `/repos/${config.repo}/git/refs/heads/${enc(config.branch)}`, { sha: made.sha, force: false });
    if (moved.status === 422 || moved.status === 409) throw new ConnectorError("The branch changed on GitHub while this was being sent.", 409, "conflict");
    this.json(moved, "the branch");
  },
};

export { versionOf };
