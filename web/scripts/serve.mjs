#!/usr/bin/env node
// Serves the built Zim editor (web/dist) over HTTP, and nothing else. It is meant to be safe to put
// on a network: no dependencies, no directory listings, no dotfiles, no way out of the directory
// (path tricks and symlinks included), GET and HEAD only, and it listens on 127.0.0.1 unless told
// otherwise.
//
//   npm run build
//   node scripts/serve.mjs                              # http://127.0.0.1:8080, this machine only
//   node scripts/serve.mjs --host 0.0.0.0 --port 8080   # every IPv4 address ("::" adds IPv6)
//   ZIM_WEB_AUTH=name:password node scripts/serve.mjs --host 0.0.0.0
//   node scripts/serve.mjs --host 0.0.0.0 --tls         # https, with a certificate it makes itself
//
// Options: --host, --port, --dir (default: ../dist), --auth user:password (or ZIM_WEB_AUTH, which
// keeps the password out of the process list), --tls (or --cert FILE --key FILE), --pid-file path,
// --help.
//
// Encrypted notebooks need a **secure page**: https, or localhost. From another machine that means
// https (`--tls`: a self-signed certificate, so the browser warns once, and Advanced > Proceed makes
// the page a secure one) or an SSH tunnel to localhost (below).
//
// The editor is a static web app: everything it does happens in the visitor's browser, a page they
// open from their own disk never reaches this server, and nothing is stored here. Exposing this
// exposes the editor's files and nothing else. Basic authentication, when enabled, is sent in clear
// over plain HTTP, so it keeps casual visitors out but is no secret on an untrusted network: use an
// SSH tunnel (ssh -L 8080:127.0.0.1:8080 you@server) or put TLS in front for that.
import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir, networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  // Browsers compile wasm while it downloads only if it is served with this exact type.
  ".wasm": "application/wasm",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".txt", ".svg", ".wasm"]);

// What the editor needs and no more. 'wasm-unsafe-eval' lets the page compile its own WebAssembly;
// CodeMirror adds <style> elements and style attributes at run time, hence 'unsafe-inline' for
// styles (scripts stay strict: no inline script, no eval).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
};

const digest = (text) => createHash("sha256").update(text).digest();

/**
 * Find the file for a URL path inside `root`, or null. The path is decoded once, and any segment
 * that is `..` or starts with a dot is refused outright; what remains is resolved with symlinks
 * followed, and refused unless it is still inside the directory. A directory means its index.html.
 */
function locate(rootReal, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((part) => part.startsWith("."))) return null;
  try {
    let candidate = realpathSync(join(rootReal, ...parts));
    if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) return null;
    let stat = statSync(candidate);
    if (stat.isDirectory()) {
      candidate = join(candidate, "index.html");
      stat = statSync(candidate);
    }
    return stat.isFile() ? { file: candidate, stat } : null;
  } catch {
    return null;
  }
}

/**
 * The static server for `dir`.
 *
 * @param {object} options
 * @param {string} options.dir the directory to serve (and nothing outside it)
 * @param {string} [options.auth] "user:password": require HTTP Basic authentication
 * @param {(line: string) => void} [options.log] gets one line per request
 * @param {{ key: Buffer | string, cert: Buffer | string }} [options.tls] serve over https with this key and certificate
 * @returns {import("node:http").Server}
 */
export function createStaticServer({ dir, auth, log = () => {}, tls }) {
  const rootReal = realpathSync(resolve(dir));
  const expected = auth ? digest(`Basic ${Buffer.from(auth).toString("base64")}`) : null;
  const compressed = new Map(); // "file:mtime:size" -> gzip bytes; the app is a few files, so this stays small

  const handler = (req, res) => {
    const remote = req.socket.remoteAddress ?? "-";
    const reply = (status, headers = {}, body = "") => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
      res.end(req.method === "HEAD" ? undefined : body);
      log(`${remote} ${req.method} ${req.url} ${status}`);
    };

    if (expected && !timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) {
      return reply(401, { "www-authenticate": 'Basic realm="Zim editor", charset="UTF-8"', "content-type": "text/plain" }, "Authentication required\n");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return reply(405, { allow: "GET, HEAD", "content-type": "text/plain" }, "Method not allowed\n");
    }
    // The request target is taken as written: a path starting with "/", up to any "?" or "#". (Not
    // via `new URL`, which would read "//x" as a host and tidy ".." away instead of refusing it.)
    const target = req.url ?? "";
    if (!target.startsWith("/")) return reply(400, { "content-type": "text/plain" }, "Bad request\n");
    const found = locate(rootReal, target.split(/[?#]/, 1)[0]);
    if (!found) return reply(404, { "content-type": "text/plain" }, "Not found\n");

    const { file, stat } = found;
    const extension = extname(file);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    // Build output names its files by content hash, so those never change; the page itself must be rechecked.
    const hashed = file.startsWith(join(rootReal, "assets") + sep);
    const headers = {
      "content-type": TYPES[extension] ?? "application/octet-stream",
      etag,
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      vary: "Accept-Encoding",
    };
    if (req.headers["if-none-match"] === etag) return reply(304, headers);

    let body = readFileSync(file);
    if (COMPRESSIBLE.has(extension) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
      const key = `${file}:${stat.mtimeMs}:${stat.size}`;
      if (!compressed.has(key)) compressed.set(key, gzipSync(body, { level: 9 }));
      body = compressed.get(key);
      headers["content-encoding"] = "gzip";
    }
    headers["content-length"] = body.length;
    return reply(200, headers, body);
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

  // A server on a network gets slow and half-open connections; do not let them pile up.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 256;
  return server;
}

/** The addresses a visitor could use for a server listening on `host`. */
export function urlsFor(host, port, scheme = "http") {
  const wildcard = host === "0.0.0.0" || host === "::";
  if (!wildcard) return [`${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}/`];
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.internal) continue;
      if (a.family === "IPv4") urls.push(`${scheme}://${a.address}:${port}/`);
      else if (host === "::" && !a.address.startsWith("fe80:")) urls.push(`${scheme}://[${a.address}]:${port}/`);
    }
  }
  return urls;
}

/** Where a self-signed certificate is kept. */
const defaultCertificateDirectory = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "zim-web", "tls");

/**
 * A self-signed certificate for this machine, made with `openssl` and kept in `directory` (private to
 * the user), made again when the machine's addresses have changed or it is nearly a year old. It
 * names localhost and every address the machine has, so the browser's only complaint is that nobody it
 * trusts signed it. Returns `{ key, cert }` for `createStaticServer`.
 */
export function selfSignedCertificate(directory = defaultCertificateDirectory()) {
  const keyFile = join(directory, "key.pem");
  const certFile = join(directory, "cert.pem");
  const namesFile = join(directory, "names.txt");
  const names = ["DNS:localhost", "IP:127.0.0.1", "IP:::1"];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) if (!a.internal && !a.address.startsWith("fe80:")) names.push(`IP:${a.address}`);
  }
  const wanted = [...new Set(names)].sort().join(",");
  const current =
    existsSync(certFile) && existsSync(keyFile) && existsSync(namesFile) && readFileSync(namesFile, "utf8") === wanted && Date.now() - statSync(certFile).mtimeMs < 300 * 24 * 3600 * 1000;
  if (!current) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      execFileSync(
        "openssl",
        ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "365", "-subj", "/CN=zim-web (self-signed)", "-addext", `subjectAltName=${wanted}`],
        { stdio: "pipe" },
      );
    } catch (error) {
      throw new Error(`couldn't make a certificate (is openssl installed?): ${error.message.split("\n")[0]}`);
    }
    chmodSync(keyFile, 0o600);
    writeFileSync(namesFile, wanted);
  }
  return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
}

const USAGE = `Usage: node scripts/serve.mjs [options]

Serves the built editor (web/dist) and nothing else.

  --host ADDRESS     where to listen (default 127.0.0.1: this machine only;
                     0.0.0.0 = every IPv4 address, :: = IPv4 and IPv6)
  --port NUMBER      default 8080 (0 picks a free port)
  --dir DIRECTORY    what to serve (default: the dist folder next to scripts/)
  --auth USER:PASS   ask visitors for this password (or set ZIM_WEB_AUTH, which
                     keeps it out of the process list). Sent in clear over HTTP.
  --tls              serve https, with a self-signed certificate made for this machine
                     (needs openssl; kept in ~/.local/state/zim-web/tls). The browser
                     warns once: Advanced > Proceed. Encrypted notebooks need a secure
                     page, which this is (or http://localhost, through an SSH tunnel).
  --cert FILE --key FILE
                     serve https with your own certificate instead
  --pid-file PATH    write the process id here while running
  --help             this text
`;

function parseArguments(argv) {
  const options = { host: "127.0.0.1", port: 8080, dir: fileURLToPath(new URL("../dist", import.meta.url)), auth: process.env.ZIM_WEB_AUTH, pidFile: undefined, tls: false, cert: undefined, key: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === "--host") options.host = value();
    else if (flag === "--port") options.port = Number(value());
    else if (flag === "--dir") options.dir = resolve(value());
    else if (flag === "--auth") options.auth = value();
    else if (flag === "--tls") options.tls = true;
    else if (flag === "--cert") options.cert = resolve(value());
    else if (flag === "--key") options.key = resolve(value());
    else if (flag === "--pid-file") options.pidFile = resolve(value());
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`unknown option ${flag} (try --help)`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("--port must be a number from 0 to 65535");
  if (options.auth !== undefined && !/^[^:]+:.+/.test(options.auth)) throw new Error("--auth must look like user:password");
  if ((options.cert === undefined) !== (options.key === undefined)) throw new Error("--cert and --key go together");
  if (options.tls && options.cert !== undefined) throw new Error("use --tls (a certificate made here) or --cert and --key (your own), not both");
  return options;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`serve: ${error.message}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  try {
    statSync(join(options.dir, "index.html"));
  } catch {
    console.error(`serve: ${join(options.dir, "index.html")} doesn't exist: run \`npm run build\` first`);
    process.exit(1);
  }

  let tls;
  try {
    if (options.tls) tls = selfSignedCertificate();
    else if (options.cert !== undefined) tls = { cert: readFileSync(options.cert), key: readFileSync(options.key) };
  } catch (error) {
    console.error(`serve: ${error.message}`);
    process.exit(1);
  }
  const server = createStaticServer({ dir: options.dir, auth: options.auth, tls, log: (line) => console.log(`${new Date().toISOString()} ${line}`) });
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `serve: port ${options.port} is already in use on ${options.host}` : `serve: ${error.message}`);
    process.exit(1);
  });
  server.listen(options.port, options.host, () => {
    const port = server.address().port; // the real one when asked for 0
    console.log(`Serving ${options.dir}${options.auth ? " (password protected)" : ""}${tls ? " over https" : ""}`);
    for (const url of urlsFor(options.host, port, tls ? "https" : "http")) console.log(`  ${url}`);
    if (options.tls) console.log("The certificate is self-signed: the browser warns once (Advanced > Proceed), and then the page is a secure one.");
    if (options.host === "127.0.0.1" || options.host === "::1") console.log("Listening on this machine only. For other machines: --host 0.0.0.0 (and the firewall must allow the port).");
    if (options.pidFile) writeFileSync(options.pidFile, `${process.pid}\n`);
  });
  const stop = () => {
    if (options.pidFile) {
      try {
        unlinkSync(options.pidFile);
      } catch {
        // already gone
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
