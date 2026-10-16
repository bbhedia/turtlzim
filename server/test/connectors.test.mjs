import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { Connectors } from "../src/connectors/index.mjs";
import { isPrivateAddress, safeRequest } from "../src/connectors/safe-fetch.mjs";
import { OAuth } from "../src/oauth.mjs";
import { fakeWebdav } from "./fake-webdav.mjs";
import { lastCode, make, PASSWORD } from "./helpers.mjs";

const HEADERS = { "content-type": "application/json", "x-requested-with": "zim" };
const b64 = (text) => Buffer.from(text).toString("base64");

describe("addresses the server must not call", () => {
  it("knows this machine, private networks, link-local and reserved ranges, in both IP versions and mapped", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "ff02::1", "nonsense"]) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "172.15.0.1", "100.63.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(ip), false, ip);
  });
});

describe("requests to an address that a person gave", () => {
  let server, origin, hits;
  before(async () => {
    hits = 0;
    server = http.createServer((req, res) => {
      hits++;
      if (req.url === "/redirect") (res.writeHead(302, { location: "http://127.0.0.1:1/" }), res.end());
      else if (req.url === "/big") res.end(Buffer.alloc(5000));
      else if (req.url === "/slow") setTimeout(() => res.end("late"), 2000);
      else res.end("hello");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => (server.closeAllConnections?.(), server.close()));

  const refused = async (options, pattern) => assert.rejects(() => safeRequest(options), (error) => (assert.match(error.message, pattern), true));

  it("refuses http, a private address, an address with a password in it and what is not an address, without calling it", async () => {
    await refused({ url: `${origin}/x` }, /https/);
    await refused({ url: `${origin}/x`, allowInsecure: true }, /private network/);
    await refused({ url: "https://user:pw@example.org/" }, /own fields/);
    await refused({ url: "not an address" }, /not a web address/);
    await refused({ url: "ftp://example.org/" }, /https/);
    assert.equal(hits, 0, "nothing reached the machine");
  });

  it("checks the address a name resolves to when it connects, not only what the name looks like", async () => {
    const rebinding = (host, options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]);
    await refused({ url: "http://looks-public.example/x", allowInsecure: true, lookup: rebinding }, /private network/);
    assert.equal(hits, 0);
  });

  it("calls an address that the operator allowed, does not follow a redirect, and caps the time and the size of the answer", async () => {
    const allowed = { allowInsecure: true, allowPrivate: true };
    assert.equal((await safeRequest({ url: `${origin}/x`, ...allowed })).body.toString(), "hello");
    const redirect = await safeRequest({ url: `${origin}/redirect`, ...allowed });
    assert.equal(redirect.status, 302, "the redirect is returned, not followed");
    await refused({ url: `${origin}/big`, maxBytes: 1000, ...allowed }, /too big/);
    await refused({ url: `${origin}/slow`, timeoutMs: 200, ...allowed }, /did not answer in time/);
    await refused({ url: "http://127.0.0.1:1/", ...allowed }, /can't be reached/);
  });
});

describe("connected services, through the API", () => {
  let server, base, parts, dav, davUrl;
  const jars = {};
  before(async () => {
    dav = fakeWebdav();
    davUrl = await dav.start();
    parts = make({ baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {}, connectorOptions: { allowInsecure: true, allowPrivate: true } });
    const api = createApi({ accounts: parts.accounts, oauth: new OAuth({ db: parts.db, accounts: parts.accounts, config: parts.config }), config: parts.config });
    server = http.createServer(async (req, res) => ((await api(req, res)) ? undefined : (res.writeHead(404), res.end())));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    parts.config.baseUrl = base;
    for (const who of ["ada", "bob"]) {
      const email = `${who}@example.org`;
      await call(who, "/api/register", { email, password: PASSWORD });
      await call(who, "/api/verify", { email, code: lastCode(parts.mailer, email) });
    }
  });
  after(() => (server.close(), dav.stop()));

  async function call(who, path, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(base + path, { method, headers: { ...(method === "GET" ? {} : HEADERS), ...(jars[who] ? { cookie: jars[who] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers.get("set-cookie");
    if (set) jars[who] = set.split(";")[0];
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, text };
  }
  const settings = (extra = {}) => ({ kind: "webdav", label: "My Nextcloud", settings: { url: davUrl, username: "ada", password: "app-password", ...extra } });
  let id;

  it("needs a session and the site's header", async () => {
    assert.equal((await call("nobody", "/api/connectors")).status, 401);
    const noHeader = await fetch(`${base}/api/connectors`, { method: "POST", headers: { "content-type": "application/json", cookie: jars.ada }, body: "{}" });
    assert.equal(noHeader.status, 403);
  });

  it("checks the settings against the service before keeping them, and says what is wrong", async () => {
    const wrong = await call("ada", "/api/connectors", settings({ password: "nope" }));
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /refused that user name and password/);
    assert.equal((await call("ada", "/api/connectors", settings({ url: davUrl + "missing/" }))).json.code, "not-found");
    assert.equal((await call("ada", "/api/connectors", { kind: "webdav", settings: { url: davUrl } })).json.code, "bad-settings");
    assert.equal((await call("ada", "/api/connectors", { kind: "carrier-pigeon", settings: {} })).json.code, "bad-kind");
    assert.equal((await call("ada", "/api/connectors")).json.connectors.length, 0, "nothing was kept");
    const ok = await call("ada", "/api/connectors", settings());
    assert.equal(ok.status, 200);
    id = ok.json.id;
    assert.equal(ok.json.label, "My Nextcloud");
  });

  it("never gives the password back, and keeps it sealed", async () => {
    const listed = await call("ada", "/api/connectors");
    assert.equal(listed.json.connectors.length, 1);
    assert.equal(listed.text.includes("app-password"), false);
    const raw = Buffer.from(parts.db.prepare("select config from connectors").get().config);
    assert.equal(raw.includes("app-password"), false, "the database holds it sealed");
    assert.equal(raw.includes(davUrl), false);
    const other = new Connectors({ db: parts.db, config: { ...parts.config, secret: Buffer.alloc(32, 7) } });
    assert.throws(() => other.unseal(raw), "another server key does not open it");
  });

  it("writes a notebook's files, lists them, reads them back byte for byte, and its version moves with them", async () => {
    const dir = "Garden-abc123";
    const empty = await call("ada", `/api/connectors/${id}/list`, { dir });
    assert.deepEqual(empty.json, { version: "", files: [] });
    const bytes = Buffer.from([0, 255, 10, 13, 128]);
    const wrote = await call("ada", `/api/connectors/${id}/write`, { dir, baseVersion: "", put: [{ path: "Home.txt", base64: b64("Hello é\n") }, { path: "Help/Editor page.txt", base64: b64("deep") }, { path: "Home/pic.bin", base64: bytes.toString("base64") }], remove: [] });
    assert.equal(wrote.status, 200, wrote.text);
    assert.match(wrote.json.version, /^[0-9a-f]{32}$/);
    const listed = await call("ada", `/api/connectors/${id}/list`, { dir });
    assert.deepEqual(listed.json.files.map((f) => f.path), ["Help/Editor page.txt", "Home.txt", "Home/pic.bin"]);
    assert.equal(listed.json.version, wrote.json.version);
    const read = await call("ada", `/api/connectors/${id}/read`, { dir });
    const byPath = Object.fromEntries(read.json.files.map((f) => [f.path, Buffer.from(f.base64, "base64")]));
    assert.equal(byPath["Home.txt"].toString(), "Hello é\n");
    assert.deepEqual(byPath["Home/pic.bin"], bytes);
    assert.equal(dav.files.get("Garden-abc123/Help/Editor page.txt").bytes.toString(), "deep", "the service has it where a person would look");
  });

  it("gives each file's mark in a listing, and reads only the files that are asked for", async () => {
    const dir = "Garden-abc123";
    const listed = await call("ada", `/api/connectors/${id}/list`, { dir });
    assert.ok(listed.json.files.every((f) => typeof f.mark === "string" && f.mark.length > 0), "every file has a mark");
    const some = await call("ada", `/api/connectors/${id}/read`, { dir, paths: ["Home.txt", "Nope.txt"] });
    assert.deepEqual(some.json.files.map((f) => f.path), ["Home.txt"]);
    assert.equal(some.json.version, listed.json.version, "the version is the folder's, not the subset's");
    assert.equal((await call("ada", `/api/connectors/${id}/read`, { dir, paths: ["../x"] })).status, 400);
    assert.equal((await call("ada", `/api/connectors/${id}/read`, { dir, paths: "Home.txt" })).status, 400);
  });

  it("lists the folders at the root of the service, which are the notebooks there", async () => {
    dav.folders.add("Other book-1");
    dav.folders.add(".hidden");
    const got = await call("ada", `/api/connectors/${id}/folders`, {});
    assert.deepEqual(got.json.folders, ["Garden-abc123", "Other book-1"]);
  });

  it("refuses a change made from a version that is not the service's, and changes nothing", async () => {
    const dir = "Garden-abc123";
    const current = (await call("ada", `/api/connectors/${id}/list`, { dir })).json.version;
    const stale = await call("ada", `/api/connectors/${id}/write`, { dir, baseVersion: "0".repeat(32), put: [{ path: "Home.txt", base64: b64("overwritten") }], remove: [] });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "conflict");
    assert.equal(stale.json.version, current);
    assert.equal(dav.files.get("Garden-abc123/Home.txt").bytes.toString(), "Hello é\n");
    const next = await call("ada", `/api/connectors/${id}/write`, { dir, baseVersion: current, put: [{ path: "Home.txt", base64: b64("second") }], remove: ["Help/Editor page.txt"] });
    assert.equal(next.status, 200);
    assert.notEqual(next.json.version, current, "the version moved");
    assert.equal(dav.files.has("Garden-abc123/Help/Editor page.txt"), false, "a removed file is gone");
    assert.equal(dav.files.get("Garden-abc123/Home.txt").bytes.toString(), "second");
  });

  it("refuses folders and paths that are not safe, before any call to the service", async () => {
    const calls = dav.log.length;
    for (const dir of ["..", "../x", "a/../b", ".hidden", "", "a/b/c/d/e", "a\\b", "/abs"]) assert.equal((await call("ada", `/api/connectors/${id}/list`, { dir })).status, 400, `dir ${dir}`);
    for (const path of ["../x.txt", "/abs.txt", ".hidden", "a//b", "a\\b", ""]) {
      assert.equal((await call("ada", `/api/connectors/${id}/write`, { dir: "Garden-abc123", baseVersion: "", put: [{ path, base64: "" }], remove: [] })).status, 400, `path ${path}`);
      assert.equal((await call("ada", `/api/connectors/${id}/write`, { dir: "Garden-abc123", baseVersion: "", put: [], remove: [path] })).status, 400, `remove ${path}`);
    }
    assert.equal(dav.log.length, calls, "the service was not called");
  });

  it("keeps connections to their owner, and takes them with the account", async () => {
    assert.equal((await call("bob", `/api/connectors/${id}/list`, { dir: "Garden-abc123" })).status, 404);
    assert.equal((await call("bob", `/api/connectors/${id}`, undefined, "DELETE")).status, 404);
    assert.equal((await call("bob", "/api/connectors")).json.connectors.length, 0);
    assert.equal((await call("ada", `/api/connectors/${id}`, undefined, "DELETE")).status, 200);
    assert.equal((await call("ada", `/api/connectors/${id}/list`, { dir: "x" })).status, 404);
    await call("ada", "/api/connectors", settings());
    assert.equal((await call("ada", "/api/account/delete", { password: PASSWORD })).status, 200);
    assert.equal(parts.db.prepare("select count(*) as n from connectors").get().n, 0);
  });

  it("does not call a private address when the operator has not allowed it", async () => {
    const strict = make({ baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {} });
    const connectors = new Connectors({ db: strict.db, config: strict.config });
    const user = strict.db.prepare("insert into users (email, password_hash, created_at, verified_at, quota_bytes) values ('x@example.org', null, 1, 1, 1)").run().lastInsertRowid;
    await assert.rejects(() => connectors.add(Number(user), "webdav", "x", { url: davUrl, username: "ada", password: "app-password" }), /https/);
    await assert.rejects(() => connectors.add(Number(user), "webdav", "x", { url: davUrl.replace("http:", "https:"), username: "ada", password: "app-password" }), /private network|can't be reached/);
  });
});
