// The part of GitLab's REST API (v4) that the connector uses, in memory: a project with a branch, commits that each hold the whole file set, a commits endpoint that takes a list of actions
// and refuses one made on top of a commit that is no longer the branch's head. Trees come in pages of two, so that paging is exercised.
import { createHash } from "node:crypto";
import http from "node:http";

const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

export function fakeGitlab({ project = "ada/notebooks", token = "glpat-valid", readerToken = "glpat-reader" } = {}) {
  const commits = new Map(); // id -> Map(path -> Buffer)
  const branches = new Map();
  const requests = [];
  const state = { beforeCommit: null, made: 0 };
  /** A commit by someone else: files is { path: string | null }. */
  const push = (files, branch = "main") => {
    const base = new Map(branches.has(branch) ? commits.get(branches.get(branch)) : []);
    for (const [path, content] of Object.entries(files)) content === null ? base.delete(path) : base.set(path, Buffer.from(content));
    const id = sha1(Buffer.from(`${commits.size}:${[...base.keys()].join(",")}`));
    commits.set(id, base);
    branches.set(branch, id);
    return id;
  };
  push({ "README.md": "# notebooks\n" });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      requests.push(`${req.method} ${url.pathname}`);
      const send = (status, body, headers = {}) => (res.writeHead(status, { "content-type": "application/json", ...headers }), res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body)));
      const given = req.headers["private-token"];
      if (given !== token && given !== readerToken) return send(401, { message: "401 Unauthorized" });
      const m = /^\/api\/v4\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!m || decodeURIComponent(m[1]) !== project) return send(404, { message: "404 Project Not Found" });
      const rest = m[2] ?? "";
      if (rest === "") return send(200, { id: 7, permissions: { project_access: { access_level: given === token ? 40 : 20 } } });
      let n;
      if ((n = /^\/repository\/branches\/(.+)$/.exec(rest))) {
        const name = decodeURIComponent(n[1]);
        return branches.has(name) ? send(200, { name, commit: { id: branches.get(name) } }) : send(404, { message: "404 Branch Not Found" });
      }
      if (rest === "/repository/tree") {
        const head = branches.get(url.searchParams.get("ref"));
        if (!head) return send(404, { message: "404 Tree Not Found" });
        const under = url.searchParams.get("path") ?? "";
        const all = [...commits.get(head)].filter(([p]) => !under || p.startsWith(under + "/")).sort(([a], [b]) => (a < b ? -1 : 1));
        if (under && all.length === 0) return send(404, { message: "404 Tree Not Found" });
        const page = Number(url.searchParams.get("page") ?? 1);
        const slice = all.slice((page - 1) * 2, page * 2);
        return send(200, slice.map(([path, bytes]) => ({ id: sha1(bytes), name: path.split("/").pop(), type: "blob", path })), page * 2 < all.length ? { "x-next-page": String(page + 1) } : {});
      }
      if ((n = /^\/repository\/files\/([^/]+)\/raw$/.exec(rest))) {
        const bytes = commits.get(branches.get(url.searchParams.get("ref")))?.get(decodeURIComponent(n[1]));
        return bytes ? (res.writeHead(200, { "content-type": "application/octet-stream" }), res.end(bytes)) : send(404, { message: "404 File Not Found" });
      }
      if (rest === "/repository/commits" && req.method === "POST") {
        if (given !== token) return send(403, { message: "403 Forbidden" });
        const body = JSON.parse(Buffer.concat(chunks).toString());
        state.beforeCommit?.();
        if (body.last_commit_id && body.last_commit_id !== branches.get(body.branch)) return send(400, { message: "You are attempting to update a file that has changed since you started editing it; the last commit id does not match." });
        const files = new Map(commits.get(branches.get(body.branch)));
        for (const a of body.actions) {
          if (a.action === "create" && files.has(a.file_path)) return send(400, { message: `A file with this name already exists: ${a.file_path}` });
          if ((a.action === "update" || a.action === "delete") && !files.has(a.file_path)) return send(400, { message: `A file with this name doesn't exist: ${a.file_path}` });
          if (a.action === "delete") files.delete(a.file_path);
          else files.set(a.file_path, Buffer.from(a.content, a.encoding === "base64" ? "base64" : "utf8"));
        }
        const id = sha1(Buffer.from(`${commits.size}:${body.commit_message}:${[...files.keys()].join(",")}`));
        commits.set(id, files);
        branches.set(body.branch, id);
        state.made++;
        state.lastMessage = body.commit_message;
        return send(201, { id, message: body.commit_message });
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
    messages: () => [],
    files: (branch = "main") => Object.fromEntries(commits.get(branches.get(branch))),
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}/api/v4`;
    },
    stop() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
