// The plain-http port that only sends people to https (`--redirect-port`, docs/zim-server.md): a person who types `http://address:8281` is taken to `https://address:8244`, the address that the server
// really speaks. It serves no page and no API, so nothing of the app is ever on http, and the only thing that it answers is a redirect, so what there is to get wrong is where the redirect goes: always
// to a host that the server's own certificate is for (the names it was given), on the server's https port, never to whatever a `Host` header says. A request that is not a plain `GET` or `HEAD` is
// refused instead of sent on, so that nobody's password keeps travelling over http because the redirect made it work.
import http from "node:http";
import { isIP } from "node:net";

const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const HOST_NAME = new RegExp(`^${LABEL}(\\.${LABEL})*$`);

/**
 * A host name or an address in the form in which hosts are compared: lower case, an IPv6 address written the short way (0:0:0:0:0:0:0:1 and ::1 are one host), no brackets.
 * Null if it is neither a name nor an address (the same rule as the names that a certificate may be made for).
 */
export function canonicalHost(text) {
  const name = String(text).trim().toLowerCase();
  if (isIP(name) === 4) return name;
  if (isIP(name) === 6 && !name.includes("%")) return new URL(`http://[${name}]/`).hostname.slice(1, -1);
  if (name.length <= 253 && HOST_NAME.test(name) && !/^[0-9.]+$/.test(name)) return name;
  return null;
}

/** The host that a `Host` header names (`name`, `name:port`, `[address]`, `[address]:port`), written as `canonicalHost` does, or null: no header, or something that is not a host. */
export function hostOf(header) {
  if (typeof header !== "string") return null;
  const text = header.trim();
  const found = text.startsWith("[") ? /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text) : /^([^:]+)(?::(\d{1,5}))?$/.exec(text);
  return found ? canonicalHost(found[1]) : null;
}

const KEPT = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

/**
 * A request target written so that nothing in it can end a header line, leave the address that it is put after, or mean something in a page: letters, digits and the characters that an address
 * uses stay as they are (a `%` stays, so what was encoded stays encoded); every other byte becomes `%XX`. Null unless it is a path (`/…`): not `*`, not an address with a host in it.
 * A request's target is read as one byte for each character, as the server's parser gives it; a character above that (only a caller can make one) is written as its UTF-8 bytes.
 */
export function safeTarget(url) {
  if (typeof url !== "string" || !url.startsWith("/")) return null;
  let out = "";
  for (const character of url) {
    if (KEPT.test(character)) out += character;
    else if (character.codePointAt(0) <= 0xff) out += `%${character.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
    else for (const byte of Buffer.from(character, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * What to answer a request that came to the plain-http port: `{ status: 307, location }` to go on at https, `{ status: 400 }` for a target that is not a path, `{ status: 421 }` for a host that the
 * certificate is not for (`names` are what it is for, as it was told: the same address in another form is the same host). The host that the person typed is kept (the address of the local network or the
 * public one, whichever they used) and the https port is the server's own; the path and the query are as they were asked.
 */
export function redirectFor({ host, url, names, port }) {
  const target = safeTarget(url);
  if (target === null) return { status: 400 };
  const wanted = hostOf(host);
  if (wanted === null || !names.some((name) => canonicalHost(name) === wanted)) return { status: 421 };
  const authority = wanted.includes(":") ? `[${wanted}]` : wanted;
  return { status: 307, location: `https://${authority}${port === 443 ? "" : `:${port}`}${target}` };
}

/**
 * The server for that port. `names` are what the certificate is for; `httpsPort()` is the port that https listens on (asked at each request, because with port 0 it is known only once https is
 * listening). A temporary redirect that nothing may keep: the https port is the one thing in it that can change, and a browser that kept it would go on sending people to the old one.
 */
export function createRedirectServer({ names, httpsPort, log = () => {} }) {
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const remote = req.socket.remoteAddress ?? "-";
    const reply = (status, headers, text) => {
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        connection: "close",
        ...headers,
      });
      res.end(req.method === "HEAD" ? undefined : text);
      // (the path only: a query may hold what nobody else should read)
      log(`${remote} ${req.method} ${String(req.url).split("?")[0].slice(0, 200)} ${status} (plain http: only redirects)`);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return reply(405, { allow: "GET, HEAD" }, "This port only sends people to https: use the https address.\n");
    const answer = redirectFor({ host: req.headers.host, url: req.url, names, port: httpsPort() });
    if (answer.status === 307) return reply(307, { location: answer.location }, `Moved to ${answer.location}\n`);
    return reply(answer.status, {}, answer.status === 421 ? "That is not an address that this server is for.\n" : "Bad request.\n");
  });
  // A port on a network gets slow and half-open connections; do not let them pile up.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = 128;
  return server;
}
