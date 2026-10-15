// A WebDAV server in memory, as far as the connector uses one: folders and files under /dav/, basic authentication, PROPFIND (depth 0 and 1), MKCOL, GET, PUT, DELETE.
import http from "node:http";

export function fakeWebdav({ user = "ada", password = "app-password" } = {}) {
  const files = new Map(); // "a/b.txt" -> { bytes, etag }
  const folders = new Set([""]);
  const log = [];
  let counter = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      log.push(`${req.method} ${req.url}`);
      const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
        return res.end();
      }
      const url = new URL(req.url, "http://x");
      if (!url.pathname.startsWith("/dav/")) {
        res.writeHead(404);
        return res.end();
      }
      const path = decodeURIComponent(url.pathname.slice(5)).replace(/\/+$/, "");
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const send = (status, headers = {}, body = "") => (res.writeHead(status, headers), res.end(body));
      if (req.method === "PROPFIND") {
        if (!folders.has(path) && !files.has(path)) return send(404);
        const entry = (href, folder, file) =>
          `<d:response><d:href>${href.replace(/&/g, "&amp;")}</d:href><d:propstat><d:prop>${folder ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getcontentlength>${file.bytes.length}</d:getcontentlength><d:getetag>"${file.etag}"</d:getetag><d:getlastmodified>Tue, 15 Oct 2026 10:00:00 GMT</d:getlastmodified>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        const enc = (p) => "/dav/" + p.split("/").map(encodeURIComponent).join("/");
        let xml = "";
        if (files.has(path)) xml += entry(enc(path), false, files.get(path));
        else {
          xml += entry(enc(path) + (path ? "/" : ""), true);
          if (req.headers.depth !== "0") {
            for (const f of folders) if (f && f !== path && (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "") === path) xml += entry(enc(f) + "/", true);
            for (const [name, file] of files) if ((name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "") === path) xml += entry(enc(name), false, file);
          }
        }
        return send(207, { "content-type": "application/xml" }, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`);
      }
      if (req.method === "MKCOL") {
        if (folders.has(path)) return send(405);
        if (!folders.has(parent)) return send(409);
        folders.add(path);
        return send(201);
      }
      if (req.method === "PUT") {
        if (!folders.has(parent)) return send(409);
        const existed = files.has(path);
        files.set(path, { bytes: Buffer.concat(chunks), etag: `e${++counter}` });
        return send(existed ? 204 : 201);
      }
      if (req.method === "GET") return files.has(path) ? send(200, {}, files.get(path).bytes) : send(404);
      if (req.method === "DELETE") {
        if (files.delete(path)) return send(204);
        if (folders.has(path)) {
          for (const name of [...files.keys()]) if (name.startsWith(path + "/")) files.delete(name);
          for (const f of [...folders]) if (f === path || f.startsWith(path + "/")) folders.delete(f);
          return send(204);
        }
        return send(404);
      }
      return send(405);
    });
  });
  return {
    server,
    files,
    folders,
    log,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}/dav/`;
    },
    stop() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
