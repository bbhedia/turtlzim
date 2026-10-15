// The part of GitHub's REST API that the connector uses, in memory, with the real model underneath: blobs by content hash, trees (flat here), commits with parents, a branch that
// moves only forward. `beforeRefUpdate` lets a test make another device push at the worst moment.
import { createHash } from "node:crypto";
import http from "node:http";

const sha1 = (...parts) => createHash("sha1").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest("hex");

export function fakeGithub({ repo = "ada/notebooks", token = "ghp_valid", readOnlyToken = "ghp_readonly" } = {}) {
  const blobs = new Map();
  const trees = new Map(); // sha -> Map(path -> blob sha)
  const commits = new Map(); // sha -> { tree, parents, message }
  const branches = new Map();
  const requests = [];
  const state = { beforeRefUpdate: null };

  const putBlob = (bytes) => {
    const sha = sha1("blob ", String(bytes.length), "\0", bytes);
    blobs.set(sha, Buffer.from(bytes));
    return sha;
  };
  const putTree = (map) => {
    const sha = sha1("tree ", JSON.stringify([...map].sort()));
    trees.set(sha, new Map(map));
    return sha;
  };
  const putCommit = (tree, parents, message) => {
    const sha = sha1("commit ", tree, parents.join(","), message, String(commits.size));
    commits.set(sha, { tree, parents, message });
    return sha;
  };
  /** A commit made by "someone else": files is { path: string | null }. */
  const push = (files, branch = "main", message = "someone else") => {
    const head = branches.get(branch);
    const base = new Map(head ? trees.get(commits.get(head).tree) : []);
    for (const [path, content] of Object.entries(files)) content === null ? base.delete(path) : base.set(path, putBlob(Buffer.from(content)));
    const sha = putCommit(putTree(base), head ? [head] : [], message);
    branches.set(branch, sha);
    return sha;
  };
  push({ "README.md": "# notebooks\n" });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      requests.push(`${req.method} ${url.pathname}`);
      const send = (status, body) => (res.writeHead(status, { "content-type": "application/json" }), res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)));
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}` && auth !== `Bearer ${readOnlyToken}`) return send(401, { message: "Bad credentials" });
      const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
      if (!m || m[1] !== repo) return send(404, { message: "Not Found" });
      const rest = decodeURIComponent(m[2] ?? "");
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      } catch {
        return send(400, {});
      }
      if (rest === "") return send(200, { full_name: repo, permissions: { push: auth === `Bearer ${token}` } });
      if (auth === `Bearer ${readOnlyToken}` && req.method !== "GET") return send(403, { message: "read only" });
      let n;
      if ((n = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) return branches.has(n[1]) ? send(200, { object: { sha: branches.get(n[1]) } }) : send(404, { message: "Not Found" });
      if ((n = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) return commits.has(n[1]) ? send(200, { sha: n[1], tree: { sha: commits.get(n[1]).tree } }) : send(404, {});
      if ((n = /^\/git\/trees\/(.+)$/.exec(rest)) && req.method === "GET") {
        const head = branches.get(n[1]);
        if (!head) return send(404, {});
        return send(200, { truncated: false, tree: [...trees.get(commits.get(head).tree)].map(([path, sha]) => ({ path, type: "blob", sha, size: blobs.get(sha).length })) });
      }
      if ((n = /^\/contents\/(.+)$/.exec(rest))) {
        const head = branches.get(url.searchParams.get("ref"));
        const sha = head && trees.get(commits.get(head).tree).get(n[1]);
        return sha ? (res.writeHead(200, { "content-type": "application/octet-stream" }), res.end(blobs.get(sha))) : send(404, {});
      }
      if (rest === "/git/blobs" && req.method === "POST") return send(201, { sha: putBlob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8")) });
      if (rest === "/git/trees" && req.method === "POST") {
        const base = new Map(trees.get(body.base_tree));
        for (const e of body.tree) {
          if (e.sha === null) {
            if (!base.delete(e.path)) return send(422, { message: "path does not exist" });
          } else base.set(e.path, e.sha);
        }
        return send(201, { sha: putTree(base) });
      }
      if (rest === "/git/commits" && req.method === "POST") return send(201, { sha: putCommit(body.tree, body.parents, body.message) });
      if ((n = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && req.method === "PATCH") {
        state.beforeRefUpdate?.();
        if (body.force !== true && commits.get(body.sha).parents[0] !== branches.get(n[1])) return send(422, { message: "Update is not a fast forward" });
        branches.set(n[1], body.sha);
        return send(200, { object: { sha: body.sha } });
      }
      return send(404, { message: "unhandled " + rest });
    });
  });
  return {
    server,
    requests,
    state,
    push,
    branches,
    commits,
    /** The files of a branch as { path: string }. */
    files: (branch = "main") => Object.fromEntries([...trees.get(commits.get(branches.get(branch)).tree)].map(([p, s]) => [p, blobs.get(s)])),
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
