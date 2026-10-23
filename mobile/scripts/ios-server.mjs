// A real account server for the test of the iPhone app that CI runs (docs/zim-mobile-shell.md, job `ios`): the server's own code (the accounts, the API, the static server that serves web/dist)
// on the runner's own address, over https with a certificate that no system knows (the one that the app is asked to trust by its fingerprint) and over plain http (an app may ask a server on its
// own device without one), with a few doors that only this test has, on the http side, under /api/__e2e/:
//
//   GET  state                what the server was asked (its method and address, whether over https, the *names* of the headers and a few of their values that matter: never a token), and the
//                             fingerprint of the certificate that it shows now
//   POST rotate-certificate   the server shows another certificate from now on (every connection is closed: the next one is a new handshake), and says its fingerprint
//   POST browser-allows       what the person's own browser does: sign in as the test's account and allow an app with this return address (the server's own routes, asked over http), answered
//                             with what the server answered (the address to go back to)
//
// Nothing of this is in the product: the doors are made here, and the server's code is asked through its own routes. Needs Node 24 and openssl.
//
//   node scripts/ios-server.mjs OUT-FOLDER      writes OUT-FOLDER/server.json when it is ready and OUT-FOLDER/seen.jsonl as it is asked; stops on SIGTERM
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(process.argv[2] ?? "ios-server");
mkdirSync(out, { recursive: true });
const load = (path) => import(pathToFileURL(join(repo, path)).href);

const EMAIL = "ada@example.org";
const PASSWORD = "correct horse battery";

/** The certificates are made by openssl, with options that Apple's LibreSSL has not: a Homebrew one is put first if that is what `openssl` is. */
function realOpenssl() {
  const said = execFileSync("openssl", ["version"], { encoding: "utf8" }).trim();
  if (!/LibreSSL/i.test(said)) return said;
  for (const dir of ["/opt/homebrew/opt/openssl@3/bin", "/usr/local/opt/openssl@3/bin", "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!existsSync(join(dir, "openssl"))) continue;
    process.env.PATH = `${dir}:${process.env.PATH}`;
    const found = execFileSync("openssl", ["version"], { encoding: "utf8" }).trim();
    if (!/LibreSSL/i.test(found)) return found;
  }
  return `${said} (no other openssl was found)`;
}
const opensslVersion = realOpenssl();

const { Accounts } = await load("server/src/accounts.mjs");
const { createApi } = await load("server/src/api.mjs");
const { openDatabase } = await load("server/src/db.mjs");
const { OutboxMailer } = await load("server/src/mail.mjs");
const { OAuth } = await load("server/src/oauth.mjs");
const { createStaticServer, selfSignedCertificate } = await load("web/scripts/serve.mjs");

const config = { baseUrl: "http://127.0.0.1", secure: false, trustProxy: false, sessionDays: 30, quotaBytes: 1024 * 1024, secret: randomBytes(32), providers: {}, connectorApps: {} };
const db = openDatabase(":memory:");
const mailer = new OutboxMailer();
const accounts = new Accounts({ db, mailer, config });
const realApi = createApi({ accounts, oauth: new OAuth({ db, accounts, config }), config });
await accounts.register(EMAIL, PASSWORD);
accounts.verify(EMAIL, /\b(\d{6})\b/.exec(mailer.sent.at(-1).text)[1]);

// what the server was asked (the doors are not asked of the server: they are this test's)
const seen = [];
const noted = (secure, req) => {
  const entry = {
    n: seen.length + 1,
    secure,
    method: req.method,
    url: req.url,
    headers: Object.keys(req.headers).sort(),
    userAgent: req.headers["user-agent"] ?? null,
    requestedWith: req.headers["x-requested-with"] ?? null,
    origin: req.headers.origin ?? null,
    authorization: "authorization" in req.headers,
    cookie: "cookie" in req.headers,
  };
  seen.push(entry);
  appendFileSync(join(out, "seen.jsonl"), `${JSON.stringify(entry)}\n`);
};

const tlsDirectory = () => mkdtempSync(join(tmpdir(), "zim-ios-tls-"));
let certificate = selfSignedCertificate(tlsDirectory(), []);

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const bodyOf = (req) =>
  new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

/** What the person's own browser does for an app: signs in with the password, then allows the app (the server's own routes, over http, as the page of the web app asks them). */
async function browserAllows(request) {
  const headers = { "content-type": "application/json", "x-requested-with": "zim", "x-e2e-door": "1" };
  const login = await fetch(`${httpOrigin}/api/login`, { method: "POST", headers, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!login.ok) throw new Error(`the sign-in said ${login.status}`);
  const cookie = login.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
  const allowed = await fetch(`${httpOrigin}/api/app/authorize`, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify(request) });
  return { status: allowed.status, body: await allowed.json() };
}

async function door(req, res, name) {
  try {
    if (name === "state" && req.method === "GET") return send(res, 200, { seen, fingerprint: certificate.certificateFingerprint, openssl: opensslVersion });
    if (name === "rotate-certificate" && req.method === "POST") {
      certificate = selfSignedCertificate(tlsDirectory(), []);
      secureServer.setSecureContext({ key: certificate.key, cert: certificate.cert });
      secureServer.closeAllConnections?.();
      return send(res, 200, { fingerprint: certificate.certificateFingerprint });
    }
    if (name === "browser-allows" && req.method === "POST") return send(res, 200, await browserAllows(await bodyOf(req)));
    return send(res, 404, { error: "there is no such door" });
  } catch (error) {
    return send(res, 500, { error: String(error?.message ?? error) });
  }
}

const dist = join(repo, "web/dist");
const plainApi = (req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (path.startsWith("/api/__e2e/")) return door(req, res, path.slice("/api/__e2e/".length));
  if (req.headers["x-e2e-door"] !== "1") noted(false, req);
  return realApi(req, res);
};
const secureApi = (req, res) => {
  noted(true, req);
  return realApi(req, res);
};

const secureServer = createStaticServer({ dir: dist, tls: { key: certificate.key, cert: certificate.cert }, api: secureApi });
const plainServer = createStaticServer({ dir: dist, api: plainApi });
const listening = (server) => new Promise((resolveListening, reject) => (server.once("error", reject), server.listen(0, "127.0.0.1", resolveListening)));
await Promise.all([listening(secureServer), listening(plainServer)]);
const httpOrigin = `http://127.0.0.1:${plainServer.address().port}`;
const httpsOrigin = `https://127.0.0.1:${secureServer.address().port}`;
config.baseUrl = httpsOrigin;

writeFileSync(join(out, "server.json"), JSON.stringify({ https: httpsOrigin, http: httpOrigin, fingerprint: certificate.certificateFingerprint, email: EMAIL, password: PASSWORD, openssl: opensslVersion }));
console.log(`ready: ${httpsOrigin} (certificate ${certificate.certificateFingerprint}) and ${httpOrigin}, made with ${opensslVersion}`);

const stop = () => {
  secureServer.closeAllConnections?.();
  plainServer.closeAllConnections?.();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
