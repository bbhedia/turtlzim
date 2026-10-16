// Google Drive (API v3), as far as the connector uses it, in memory: the authorisation window and token endpoints (code with PKCE, refresh, revoke), a tree of folders and files that
// have ids and no unique names, listing by a query in Drive's language in pages of two, multipart and media uploads, download and delete.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const FOLDER = "application/vnd.google-apps.folder";
const md5 = (b) => createHash("md5").update(b).digest("hex");

function multipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let at = body.indexOf(delim);
  for (;;) {
    const next = body.indexOf(delim, at + delim.length);
    if (next < 0) return parts;
    const chunk = body.subarray(at + delim.length + 2, next - 2);
    const sep = chunk.indexOf("\r\n\r\n");
    parts.push({ headers: chunk.subarray(0, sep).toString(), body: chunk.subarray(sep + 4) });
    at = next;
  }
}

export function fakeDrive({ clientId = "drv-id", clientSecret = "drv-secret" } = {}) {
  const items = new Map(); // id -> { id, name, mimeType, parents, bytes, created }
  const codes = new Map();
  const refresh = new Set();
  const access = new Map();
  const requests = [];
  const state = { revoked: [], tokenCalls: 0, beforeUpload: null };
  let counter = 0;
  const make = (name, mimeType, parents, bytes) => {
    const id = `id${++counter}`;
    items.set(id, { id, name, mimeType, parents, bytes, created: counter });
    return id;
  };
  const view = (it) => ({ id: it.id, name: it.name, mimeType: it.mimeType, ...(it.bytes ? { size: String(it.bytes.length), md5Checksum: md5(it.bytes) } : {}) });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    requests.push(`${req.method} ${url.pathname}`);
    const json = (status, value) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
    if (url.pathname === "/authorize") {
      const code = `code-${randomBytes(6).toString("hex")}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri"), offline: url.searchParams.get("access_type") === "offline" });
      res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
      return res.end();
    }
    if (url.pathname === "/token") {
      state.tokenCalls++;
      const form = Object.fromEntries(new URLSearchParams(body.toString()));
      if (form.client_id !== clientId || form.client_secret !== clientSecret) return json(401, { error: "invalid_client" });
      if (form.grant_type === "authorization_code") {
        const c = codes.get(form.code);
        codes.delete(form.code);
        if (!c || c.redirect !== form.redirect_uri || !form.code_verifier || createHash("sha256").update(form.code_verifier).digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant" });
        const a = `at-${++counter}`;
        let r;
        if (c.offline) (r = `refresh-${++counter}`, refresh.add(r));
        access.set(a, r);
        return json(200, { access_token: a, refresh_token: r, expires_in: 3599, token_type: "Bearer" });
      }
      if (form.grant_type === "refresh_token") {
        if (!refresh.has(form.refresh_token)) return json(400, { error: "invalid_grant" });
        const a = `at-${++counter}`;
        access.set(a, form.refresh_token);
        return json(200, { access_token: a, expires_in: 3599, token_type: "Bearer" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke") {
      refresh.delete(url.searchParams.get("token"));
      state.revoked.push(url.searchParams.get("token"));
      return json(200, {});
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer || !access.has(bearer) || !refresh.has(access.get(bearer))) return json(401, { error: { message: "Invalid Credentials" } });
    let n;
    if (url.pathname === "/drive/v3/files" && req.method === "GET") {
      const conds = decodeURIComponent(url.searchParams.get("q")).split(" and ").map((c) => c.trim());
      const unq = (v) => v.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      let list = [...items.values()];
      for (const c of conds) {
        let m;
        // (a value is in quotes, and a quote inside it has to be escaped, as in Drive's own language)
        if ((m = /^('(?:[^'\\]|\\.)*') in parents$/.exec(c))) list = list.filter((it) => it.parents.includes(unq(m[1])));
        else if ((m = /^name=('(?:[^'\\]|\\.)*')$/.exec(c))) list = list.filter((it) => it.name === unq(m[1]));
        else if ((m = /^mimeType=('(?:[^'\\]|\\.)*')$/.exec(c))) list = list.filter((it) => it.mimeType === unq(m[1]));
        else if (c === "trashed=false") list = list.filter((it) => !it.trashed);
        else return json(400, { error: { message: `bad query ${c}` } });
      }
      list.sort((a, b) => a.created - b.created);
      const from = Number(url.searchParams.get("pageToken") ?? 0);
      return json(200, { files: list.slice(from, from + 2).map(view), ...(list.length > from + 2 ? { nextPageToken: String(from + 2) } : {}) });
    }
    if (url.pathname === "/drive/v3/files" && req.method === "POST") {
      const meta = JSON.parse(body.toString());
      return json(200, { id: make(meta.name, meta.mimeType, meta.parents ?? ["root"]) });
    }
    if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
      const parts = multipart(body, req.headers["content-type"]);
      const meta = JSON.parse(parts[0].body.toString());
      state.beforeUpload?.(meta);
      return json(200, { id: make(meta.name, "application/octet-stream", meta.parents, Buffer.from(parts[1].body)) });
    }
    if ((n = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)) && req.method === "PATCH") {
      const it = items.get(decodeURIComponent(n[1]));
      if (!it) return json(404, {});
      it.bytes = Buffer.from(body);
      return json(200, { id: it.id });
    }
    if ((n = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname))) {
      const it = items.get(decodeURIComponent(n[1]));
      if (!it) return json(404, { error: { message: "File not found" } });
      if (req.method === "DELETE") return (items.delete(it.id), res.writeHead(204), res.end());
      if (req.method === "GET" && url.searchParams.get("alt") === "media") return (res.writeHead(200, { "content-type": "application/octet-stream" }), res.end(it.bytes));
    }
    return json(404, { error: { message: "unhandled " + url.pathname } });
  });
  /** The path of an item, from the root, by names. */
  const pathOf = (it) => (it.parents[0] === "root" ? it.name : `${pathOf(items.get(it.parents[0]))}/${it.name}`);
  return {
    server,
    items,
    requests,
    state,
    refresh,
    expireAccessTokens: () => access.clear(),
    /** The files (not folders) as { path: Buffer }. */
    files: () => Object.fromEntries([...items.values()].filter((it) => it.mimeType !== FOLDER).map((it) => [pathOf(it), it.bytes])),
    /** A file written from outside, in a folder path that is made if needed. */
    put(path, text) {
      const names = path.split("/");
      let parent = "root";
      for (const name of names.slice(0, -1)) parent = [...items.values()].find((it) => it.name === name && it.mimeType === FOLDER && it.parents[0] === parent)?.id ?? make(name, FOLDER, [parent]);
      const existing = [...items.values()].find((it) => it.name === names.at(-1) && it.parents[0] === parent && it.mimeType !== FOLDER);
      if (existing) existing.bytes = Buffer.from(text);
      else make(names.at(-1), "application/octet-stream", [parent], Buffer.from(text));
    },
    make,
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
