// The HTTP side: `/api/...`, JSON in and out, the session in a cookie. It does nothing of its own that the account logic does not: it reads the request, checks that it comes
// from this site's own page, calls `Accounts` or `OAuth`, and writes the answer.
//
// What it guards against, besides what `Accounts` does: another site making the browser send a request (every request that changes something must carry a header that only this
// site's own scripts can add, and an `Origin` that is this site's); a cookie that a script can read (it is HttpOnly); one that is sent along to other sites (SameSite) or over plain
// http (Secure, and the `__Host-` name that a browser only accepts with Secure, Path=/ and no Domain); a body that is huge; and answers that are kept by a cache.
import { AccountError } from "./accounts.mjs";
import { Connectors, DRIVERS, validDir } from "./connectors/index.mjs";
import { Sync, validPath } from "./sync.mjs";

const MAX_BODY = 16 * 1024;
/** A notebook is sent whole, as base64: the quota (1 MB) and a third more. */
const MAX_SYNC_BODY = 2 * 1024 * 1024;
/** What is sent to a connected service in one request (base64: a third more than the files). */
const MAX_CONNECTOR_BODY = 12 * 1024 * 1024;
const NONCE_SECONDS = 600;

export function createApi({ accounts, oauth, config, log = () => {}, sync = new Sync({ db: accounts.db }), connectors = new Connectors({ db: accounts.db, config }) }) {
  const prefix = config.secure ? "__Host-" : "";
  const SESSION = `${prefix}zim`;
  const NONCE = `${prefix}zim-oauth`;

  const cookieOf = (req) => {
    const jar = {};
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const at = part.indexOf("=");
      if (at > 0) jar[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
    return jar;
  };
  const setCookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secure ? "; Secure" : ""}`;

  const clientIp = (req) => {
    if (config.trustProxy) {
      const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    return String(req.socket.remoteAddress ?? "-").replace(/^::ffff:/, "");
  };

  function send(res, status, body, headers = {}) {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers, ...(text ? { "content-length": Buffer.byteLength(text) } : {}) });
    res.end(text);
  }

  function redirect(res, to, cookies = []) {
    res.writeHead(302, { location: to, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
    res.end();
  }

  /** The body as JSON, or an error that says what is wrong with it. */
  function readJson(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return reject(new AccountError("Send JSON.", 415));
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new AccountError("That request is too big.", 413));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
          resolve(value);
        } catch {
          reject(new AccountError("That is not JSON that this server can read.", 400));
        }
      });
      req.on("error", reject);
    });
  }

  /** Only this site's own page may make a request that changes something. */
  function checkSameSite(req) {
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") throw new AccountError("That request does not come from this site.", 403, { code: "cross-site" });
    const origin = new URL(config.baseUrl).origin;
    const from = req.headers.origin;
    if (from && from !== origin && from !== `${config.secure ? "https" : "http"}://${req.headers.host}`) throw new AccountError("That request does not come from this site.", 403, { code: "cross-site" });
    if (req.headers["x-requested-with"] !== "zim") throw new AccountError("That request does not come from this site.", 403, { code: "cross-site" });
  }

  const sessionOf = (req) => {
    const token = cookieOf(req)[SESSION];
    const found = accounts.session(token);
    return found ? { ...found, token } : null;
  };

  const signedIn = (res, user, previous) => {
    if (previous) accounts.destroySession(previous);
    const token = accounts.createSession(user.id);
    return { token, cookie: setCookie(SESSION, token, config.sessionDays * 86400) };
  };

  const publicMe = (found) => ({ user: { email: found.user.email, quotaBytes: found.user.quotaBytes, usedBytes: sync.used(found.user.id), hasPassword: found.user.hasPassword }, signIns: accounts.identities(found.user.id).map((i) => i.provider) });

  /** Handle the request if it is for `/api/`; says whether it was. */
  return async function handle(req, res) {
    const handled = await answer(req, res);
    return handled === false ? false : true;
  };

  async function answer(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path !== "/api" && !path.startsWith("/api/")) return false;
    try {
      const method = req.method ?? "GET";
      const ip = clientIp(req);
      const route = path.replace(/\/+$/, "");
      const get = method === "GET" || method === "HEAD";

      // ------------------------------------------------------------------ what can be asked with a GET
      if (route === "/api/health" && get) return void send(res, 200, { ok: true });
      if (route === "/api/providers" && get) return void send(res, 200, { providers: oauth.providers(), email: true });
      if (route === "/api/me" && get) {
        const found = sessionOf(req);
        // (not a 401: a page that asks who is here, signed out, is not an error, and a browser would log it as one)
        return void send(res, 200, found ? publicMe(found) : { user: null, signIns: [] });
      }
      if (route === "/api/account/export" && get) {
        const found = sessionOf(req);
        if (!found) throw new AccountError("Not signed in.", 401, { code: "signed-out" });
        return void send(res, 200, accounts.exportData(found.user.id), { "content-disposition": 'attachment; filename="zim-notebook-account.json"' });
      }
      const notebookRoute = /^\/api\/sync\/notebooks(?:\/([^/]+))?$/.exec(route);
      if (notebookRoute) {
        const found = sessionOf(req);
        if (!found) throw new AccountError("Not signed in.", 401, { code: "signed-out" });
        const id = notebookRoute[1] && decodeURIComponent(notebookRoute[1]);
        if (get && !id) return void send(res, 200, { notebooks: sync.list(found.user.id), usedBytes: sync.used(found.user.id), quotaBytes: found.user.quotaBytes });
        if (get) return void send(res, 200, sync.get(found.user.id, id));
        if (id && (method === "PUT" || method === "DELETE")) {
          checkSameSite(req);
          if (method === "DELETE") return void send(res, 200, sync.remove(found.user.id, id));
          const body = await readJson(req, MAX_SYNC_BODY);
          return void send(res, 200, sync.put(found.user.id, found.user.quotaBytes, id, body));
        }
        return void send(res, 405, { error: "Not that way." }, { allow: "GET, PUT, DELETE" });
      }
      const connectorRoute = /^\/api\/connectors(?:\/(\d{1,9})(?:\/(list|read|write))?)?$/.exec(route);
      if (connectorRoute) {
        const found = sessionOf(req);
        if (!found) throw new AccountError("Not signed in.", 401, { code: "signed-out" });
        const userId = found.user.id;
        const id = connectorRoute[1] ? Number(connectorRoute[1]) : null;
        const action = connectorRoute[2];
        if (get && id === null) return void send(res, 200, { connectors: connectors.list(userId), services: Object.values(DRIVERS).map((d) => ({ kind: d.kind, label: d.label })) });
        if (get) return void send(res, 405, { error: "Not that way." }, { allow: "POST, DELETE" });
        checkSameSite(req);
        if (id === null && method === "POST") {
          accounts.limit(`connector:add:${userId}`, 10, 3600);
          const body = await readJson(req);
          return void send(res, 200, await connectors.add(userId, body.kind, body.label, body.settings));
        }
        if (id !== null && !action && method === "DELETE") return void send(res, 200, connectors.remove(userId, id));
        if (id !== null && action && method === "POST") {
          accounts.limit(`connector:io:${userId}`, 600, 600);
          const body = await readJson(req, MAX_CONNECTOR_BODY);
          if (!validDir(body.dir)) throw new AccountError("That is not a folder name that can be used.", 400, { code: "bad-dir" });
          if (action === "list") return void send(res, 200, await connectors.files(userId, id, body.dir));
          if (action === "read") return void send(res, 200, await connectors.read(userId, id, body.dir));
          const put = Array.isArray(body.put) ? body.put : [];
          const remove = Array.isArray(body.remove) ? body.remove : [];
          if (put.length > 2000 || remove.length > 2000 || typeof body.baseVersion !== "string") throw new AccountError("That change is not valid.", 400, { code: "bad-files" });
          for (const file of put) if (!file || !validPath(file.path) || typeof file.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new AccountError("A file of the notebook is not valid.", 400, { code: "bad-files" });
          for (const path of remove) if (!validPath(path)) throw new AccountError("A file of the notebook is not valid.", 400, { code: "bad-files" });
          return void send(res, 200, await connectors.write(userId, id, body.dir, body.baseVersion, { put, remove }));
        }
        return void send(res, 405, { error: "Not that way." }, { allow: "GET, POST, DELETE" });
      }
      const oauthRoute = /^\/api\/oauth\/([a-z]+)\/(start|callback)$/.exec(route);
      if (oauthRoute && get) {
        const [, provider, step] = oauthRoute;
        if (step === "start") {
          let started;
          try {
            started = oauth.start(provider);
          } catch (error) {
            if (error instanceof AccountError) return void redirect(res, `/?account_error=${error.extra.code ?? "failed"}`);
            throw error;
          }
          return void redirect(res, started.url, [setCookie(NONCE, started.nonce, NONCE_SECONDS)]);
        }
        const clearNonce = setCookie(NONCE, "", 0);
        try {
          const user = await oauth.finish(provider, Object.fromEntries(url.searchParams), cookieOf(req)[NONCE], { ip });
          const session = signedIn(res, user, cookieOf(req)[SESSION]);
          return void redirect(res, "/?signed_in=1", [session.cookie, clearNonce]);
        } catch (error) {
          if (!(error instanceof AccountError)) throw error;
          return void redirect(res, `/?account_error=${encodeURIComponent(error.extra.code ?? "failed")}`, [clearNonce]);
        }
      }

      // ------------------------------------------------------------------ what changes something
      if (get) return void send(res, 404, { error: "There is nothing here." });
      if (method !== "POST") return void send(res, 405, { error: "Use POST." }, { allow: "GET, POST" });
      checkSameSite(req);
      const body = await readJson(req);

      switch (route) {
        case "/api/register":
          return void send(res, 200, await accounts.register(body.email, body.password, { ip }));
        case "/api/resend":
          return void send(res, 200, await accounts.resend(body.email, { ip }));
        case "/api/verify": {
          const user = accounts.verify(body.email, body.code, { ip });
          const session = signedIn(res, user, cookieOf(req)[SESSION]);
          return void send(res, 200, { user: { email: user.email, quotaBytes: user.quotaBytes, usedBytes: 0, hasPassword: user.hasPassword }, signIns: [] }, { "set-cookie": session.cookie });
        }
        case "/api/login": {
          const user = await accounts.login(body.email, body.password, { ip });
          const session = signedIn(res, user, cookieOf(req)[SESSION]);
          return void send(res, 200, { user: { email: user.email, quotaBytes: user.quotaBytes, usedBytes: 0, hasPassword: user.hasPassword }, signIns: accounts.identities(user.id).map((i) => i.provider) }, { "set-cookie": session.cookie });
        }
        case "/api/logout":
          accounts.destroySession(cookieOf(req)[SESSION]);
          return void send(res, 200, { ok: true }, { "set-cookie": setCookie(SESSION, "", 0) });
        case "/api/password/forgot":
          return void send(res, 200, await accounts.requestReset(body.email, { ip }));
        case "/api/password/reset":
          return void send(res, 200, await accounts.reset(body.email, body.code, body.password, { ip }));
        case "/api/password/change": {
          const found = sessionOf(req);
          if (!found) throw new AccountError("Not signed in.", 401, { code: "signed-out" });
          return void send(res, 200, await accounts.changePassword(found.user.id, body.current, body.next, found.token));
        }
        case "/api/account/delete": {
          const found = sessionOf(req);
          if (!found) throw new AccountError("Not signed in.", 401, { code: "signed-out" });
          await accounts.deleteAccount(found.user.id, body.password, found.createdAt);
          return void send(res, 200, { ok: true }, { "set-cookie": setCookie(SESSION, "", 0) });
        }
        default:
          return void send(res, 404, { error: "There is nothing here." });
      }
    } catch (error) {
      if (error instanceof AccountError) {
        return void send(res, error.status, { error: error.message, ...(error.extra.code ? { code: error.extra.code } : {}), ...(error.extra.retryAfter ? { retryAfter: error.extra.retryAfter } : {}), ...(error.extra.revision !== undefined ? { revision: error.extra.revision } : {}), ...(error.extra.version !== undefined ? { version: error.extra.version } : {}), ...(error.extra.quotaBytes ? { usedBytes: error.extra.usedBytes, quotaBytes: error.extra.quotaBytes } : {}) }, error.extra.retryAfter ? { "retry-after": String(error.extra.retryAfter) } : {});
      }
      log(`error: ${error instanceof Error ? error.stack : String(error)}`);
      return void send(res, 500, { error: "Something went wrong on the server." });
    }
  }
}
