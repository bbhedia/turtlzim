// Dropbox, as far as the connector uses it, in memory: the authorisation window, the token endpoint (code with PKCE, and refresh), listing in pages of two, upload with `add` / `update` modes that
// refuse a conflict, download, delete, and revoking. Access tokens can be expired by a test to see that the connector asks for a new one.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export function fakeDropbox({ clientId = "dbx-id", clientSecret = "dbx-secret" } = {}) {
  const files = new Map(); // lower path -> { display, bytes, rev }
  const codes = new Map(); // code -> { challenge }
  const refresh = new Set();
  const access = new Map(); // access token -> refresh token
  const requests = [];
  const state = { revoked: [], uploads: 0, tokenCalls: 0, beforeUpload: null };
  let counter = 0;
  let lastRedirect = "";

  const readBody = (req) => new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); });
  const entry = (f) => ({ ".tag": "file", name: f.display.split("/").pop(), path_display: f.display, path_lower: f.display.toLowerCase(), size: f.bytes.length, content_hash: sha256(f.bytes), rev: f.rev });
  const under = (path, recursive) => {
    const prefix = path === "" ? "/" : `${path.toLowerCase()}/`;
    const out = [];
    const folders = new Set();
    const folder = (display) => {
      if (folders.has(display.toLowerCase())) return;
      folders.add(display.toLowerCase());
      out.push({ ".tag": "folder", name: display.split("/").pop(), path_display: display, path_lower: display.toLowerCase() });
    };
    for (const [lower, f] of files) {
      if (!lower.startsWith(prefix)) continue;
      const rel = f.display.slice(prefix.length);
      const first = rel.indexOf("/");
      if (first >= 0 && !recursive) {
        folder(f.display.slice(0, prefix.length + first));
        continue;
      }
      if (recursive) for (let at = first; at > 0; at = rel.indexOf("/", at + 1)) folder(f.display.slice(0, prefix.length + at));
      out.push(entry(f));
    }
    return out;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const body = await readBody(req);
    requests.push(`${req.method} ${url.pathname}`);
    const json = (status, value, headers = {}) => (res.writeHead(status, { "content-type": "application/json", ...headers }), res.end(JSON.stringify(value)));
    if (url.pathname === "/oauth2/authorize") {
      const code = `code-${randomBytes(6).toString("hex")}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri"), offline: url.searchParams.get("token_access_type") });
      lastRedirect = url.searchParams.get("redirect_uri");
      res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
      return res.end();
    }
    if (url.pathname === "/oauth2/token") {
      state.tokenCalls++;
      const form = Object.fromEntries(new URLSearchParams(body.toString()));
      if (form.client_id !== clientId || form.client_secret !== clientSecret) return json(401, { error: "invalid_client" });
      if (form.grant_type === "authorization_code") {
        const c = codes.get(form.code);
        codes.delete(form.code);
        if (!c || c.redirect !== form.redirect_uri || !form.code_verifier || Buffer.from(createHash("sha256").update(form.code_verifier).digest()).toString("base64url") !== c.challenge) return json(400, { error: "invalid_grant" });
        const r = `refresh-${++counter}`;
        const a = `at-${++counter}`;
        refresh.add(r);
        access.set(a, r);
        return json(200, { access_token: a, refresh_token: c.offline === "offline" ? r : undefined, expires_in: 14400, token_type: "bearer" });
      }
      if (form.grant_type === "refresh_token") {
        if (!refresh.has(form.refresh_token)) return json(400, { error: "invalid_grant" });
        const a = `at-${++counter}`;
        access.set(a, form.refresh_token);
        return json(200, { access_token: a, expires_in: 14400, token_type: "bearer" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer || !access.has(bearer) || !refresh.has(access.get(bearer))) return json(401, { error_summary: "expired_access_token/" });
    const arg = req.headers["dropbox-api-arg"] ? JSON.parse(req.headers["dropbox-api-arg"]) : null;
    const notFound = () => json(409, { error_summary: "path/not_found/..", error: { ".tag": "path" } });
    const rpc = body.length && String(req.headers["content-type"]).includes("json") ? JSON.parse(body.toString()) : {};
    if (url.pathname === "/2/auth/token/revoke") {
      refresh.delete(access.get(bearer));
      state.revoked.push(bearer);
      return json(200, {});
    }
    if (url.pathname === "/2/files/list_folder") {
      const all = under(rpc.path, rpc.recursive);
      if (rpc.path !== "" && all.length === 0) return notFound();
      return json(200, { entries: all.slice(0, 2), has_more: all.length > 2, cursor: `${rpc.recursive ? "r" : "f"}:2:${rpc.path}` });
    }
    if (url.pathname === "/2/files/list_folder/continue") {
      const [mode, offset, ...path] = rpc.cursor.split(":");
      const all = under(path.join(":"), mode === "r");
      const from = Number(offset);
      return json(200, { entries: all.slice(from, from + 2), has_more: all.length > from + 2, cursor: `${mode}:${from + 2}:${path.join(":")}` });
    }
    if (url.pathname === "/2/files/download") {
      const f = files.get(arg.path.toLowerCase());
      return f ? (res.writeHead(200, { "content-type": "application/octet-stream" }), res.end(f.bytes)) : notFound();
    }
    if (url.pathname === "/2/files/upload") {
      state.beforeUpload?.(arg);
      const lower = arg.path.toLowerCase();
      const existing = files.get(lower);
      if (arg.mode === "add" && existing) return json(409, { error_summary: "path/conflict/file/.." });
      if (arg.mode?.[".tag"] === "update" && (!existing || existing.rev !== arg.mode.update)) return json(409, { error_summary: "path/conflict/file/.." });
      state.uploads++;
      files.set(lower, { display: arg.path, bytes: Buffer.from(body), rev: `rev${++counter}` });
      return json(200, entry(files.get(lower)));
    }
    if (url.pathname === "/2/files/delete_v2") {
      return files.delete(rpc.path.toLowerCase()) ? json(200, { metadata: {} }) : notFound();
    }
    return json(404, { error: "unhandled " + url.pathname });
  });
  return {
    server,
    files,
    requests,
    state,
    refresh,
    access,
    expireAccessTokens: () => access.clear(),
    /** A file changed from outside, as a person would from another device. */
    put: (path, text) => files.set(path.toLowerCase(), { display: path, bytes: Buffer.from(text), rev: `rev${++counter}` }),
    get lastRedirect() { return lastRedirect; },
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
