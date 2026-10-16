import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { OAuth } from "../src/oauth.mjs";
import { fakeDropbox } from "./fake-dropbox.mjs";
import { lastCode, make, PASSWORD } from "./helpers.mjs";

const HEADERS = { "content-type": "application/json", "x-requested-with": "zim" };
const b64 = (text) => Buffer.from(text).toString("base64");

describe("Dropbox as a connected service", () => {
  let server, base, parts, dbx, dbxUrl, cookie, id;
  before(async () => {
    dbx = fakeDropbox();
    dbxUrl = await dbx.start();
    parts = make({
      baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {},
      connectorApps: { dropbox: { clientId: "dbx-id", clientSecret: "dbx-secret" } },
      connectorOptions: { allowInsecure: true, allowPrivate: true, dropboxApi: dbxUrl, dropboxContent: dbxUrl, endpoints: { dropbox: { authorize: `${dbxUrl}/oauth2/authorize`, token: `${dbxUrl}/oauth2/token` } } },
    });
    const api = createApi({ accounts: parts.accounts, oauth: new OAuth({ db: parts.db, accounts: parts.accounts, config: parts.config }), config: parts.config });
    server = http.createServer(async (req, res) => ((await api(req, res)) ? undefined : (res.writeHead(404), res.end())));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    parts.config.baseUrl = base;
    await call("/api/register", { email: "ada@example.org", password: PASSWORD });
    await call("/api/verify", { email: "ada@example.org", code: lastCode(parts.mailer, "ada@example.org") });
  });
  after(() => (server.close(), dbx.stop()));

  async function call(path, body, method = body === undefined ? "GET" : "POST", extra = {}) {
    const response = await fetch(base + path, { method, redirect: "manual", headers: { ...(method === "GET" ? {} : HEADERS), ...(cookie ? { cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers.get("set-cookie");
    if (set && set.startsWith("zim=")) cookie = set.split(";")[0];
    const text = await response.text();
    return { status: response.status, headers: response.headers, set, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null, text };
  }
  /** The window: start, follow the redirect to the (fake) service, come back with what it says. Returns the final redirect of the server. */
  async function connectThroughWindow({ cookieOverride, mangleState, dropCode } = {}) {
    const start = await call("/api/connectors/oauth/dropbox/start");
    assert.equal(start.status, 302);
    const nonce = /zim-connect=([^;]+)/.exec(start.set ?? "")?.[1];
    const window_ = await fetch(start.headers.get("location"), { redirect: "manual" });
    const back = new URL(window_.headers.get("location"));
    if (mangleState) back.searchParams.set("state", "x" + back.searchParams.get("state"));
    if (dropCode) back.searchParams.delete("code");
    const done = await fetch(base + back.pathname + back.search, { redirect: "manual", headers: { cookie: `${cookie}; zim-connect=${cookieOverride ?? nonce}` } });
    return { start, location: done.headers.get("location"), nonce };
  }
  const dir = "Garden-abc123";

  it("is offered only where the server has the app's id and secret, and is not connected by a form", async () => {
    const services = (await call("/api/connectors")).json.services;
    assert.deepEqual(services.find((s) => s.kind === "dropbox"), { kind: "dropbox", label: "Dropbox", oauth: true, available: true });
    assert.equal(services.find((s) => s.kind === "webdav").oauth, false);
    assert.equal((await call("/api/connectors", { kind: "dropbox", settings: { refreshToken: "made-up" } })).json.code, "bad-kind");
  });

  it("goes through Dropbox's window and back, as the person who began it, and keeps only a sealed refresh token", async () => {
    const asked = await call("/api/connectors/oauth/dropbox/start");
    const url = new URL(asked.headers.get("location"));
    assert.equal(url.origin + url.pathname, `${dbxUrl}/oauth2/authorize`);
    assert.equal(url.searchParams.get("client_id"), "dbx-id");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("token_access_type"), "offline");
    assert.match(url.searchParams.get("scope"), /files\.content\.write/);
    assert.equal(url.searchParams.get("redirect_uri"), `${base}/api/connectors/oauth/dropbox/callback`);
    assert.match(asked.set, /^zim-connect=[\w-]+; Path=\/; HttpOnly; SameSite=Lax/);
    const done = await connectThroughWindow();
    assert.equal(done.location, "/?connected=1");
    const listed = await call("/api/connectors");
    assert.equal(listed.json.connectors.length, 1);
    id = listed.json.connectors[0].id;
    assert.equal(listed.json.connectors[0].label, "Dropbox");
    const raw = Buffer.from(parts.db.prepare("select config from connectors").get().config);
    assert.equal(raw.includes([...dbx.refresh][0]), false, "the refresh token is sealed in the database");
    assert.equal(listed.text.includes([...dbx.refresh][0]), false, "and never given to the page");
  });

  it("refuses a return that is not the one begun here, in this browser, by this person", async () => {
    const before = parts.db.prepare("select count(*) as n from connectors").get().n;
    assert.match((await connectThroughWindow({ mangleState: true })).location, /connect_error=expired/);
    assert.match((await connectThroughWindow({ cookieOverride: "someone-elses-nonce" })).location, /connect_error=expired/);
    assert.match((await connectThroughWindow({ dropCode: true })).location, /connect_error=failed/);
    const unsigned = await fetch(base + "/api/connectors/oauth/dropbox/callback?code=x&state=y", { redirect: "manual" });
    assert.equal(unsigned.headers.get("location"), "/?connect_error=signed-out");
    assert.equal((await fetch(base + "/api/connectors/oauth/dropbox/start", { redirect: "manual" })).headers.get("location"), "/?connect_error=signed-out");
    assert.equal(parts.db.prepare("select count(*) as n from connectors").get().n, before, "nothing was kept");
    const unknown = await call("/api/connectors/oauth/myspace/start");
    assert.equal(unknown.headers.get("location"), "/?connect_error=no-provider");
    // a state is used once
    const start = await call("/api/connectors/oauth/dropbox/start");
    const nonce = /zim-connect=([^;]+)/.exec(start.set)[1];
    const back = new URL((await fetch(start.headers.get("location"), { redirect: "manual" })).headers.get("location"));
    const go = () => fetch(base + back.pathname + back.search, { redirect: "manual", headers: { cookie: `${cookie}; zim-connect=${nonce}` } });
    assert.equal((await go()).headers.get("location"), "/?connected=1");
    assert.match((await go()).headers.get("location"), /connect_error=expired/);
    // a second account does not get the first one's window
    await call("/api/connectors/" + (await call("/api/connectors")).json.connectors.at(-1).id, undefined, "DELETE");
  });

  it("does not let someone else's authorisation be finished in this person's account", async () => {
    // (Bob begins a connection; Ada's browser is made to finish it. It would put Bob's Dropbox in Ada's account.)
    await call("/api/register", { email: "bob@example.org", password: PASSWORD });
    await call("/api/verify", { email: "bob@example.org", code: lastCode(parts.mailer, "bob@example.org") });
    const bobCookie = cookie;
    const adaCookie = (await (async () => {
      const login = await fetch(base + "/api/login", { method: "POST", headers: HEADERS, body: JSON.stringify({ email: "ada@example.org", password: PASSWORD }) });
      return login.headers.get("set-cookie").split(";")[0];
    })());
    const started = await fetch(base + "/api/connectors/oauth/dropbox/start", { redirect: "manual", headers: { cookie: bobCookie } });
    const nonce = /zim-connect=([^;]+)/.exec(started.headers.get("set-cookie"))[1];
    const back = new URL((await fetch(started.headers.get("location"), { redirect: "manual" })).headers.get("location"));
    const finished = await fetch(base + back.pathname + back.search, { redirect: "manual", headers: { cookie: `${adaCookie}; zim-connect=${nonce}` } });
    assert.match(finished.headers.get("location"), /connect_error=expired/);
    cookie = adaCookie;
    assert.equal((await call("/api/connectors")).json.connectors.length, 1, "Ada has only her own connection");
  });

  it("asks Dropbox for an access token once and uses it for the calls that follow", async () => {
    const calls = dbx.state.tokenCalls;
    for (let i = 0; i < 3; i++) await call(`/api/connectors/${id}/list`, { dir });
    assert.ok(dbx.state.tokenCalls - calls <= 1, `${dbx.state.tokenCalls - calls} token requests for three calls`);
  });

  it("writes a notebook's files into the app folder, lists them in pages, reads them back byte for byte", async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 128]);
    const put = [{ path: "Home.txt", base64: b64("Hello é\n") }, { path: "Help/Editor page.txt", base64: b64("deep") }, { path: "Home/pic.bin", base64: bytes.toString("base64") }, { path: "A.txt", base64: b64("a") }];
    assert.deepEqual((await call(`/api/connectors/${id}/list`, { dir })).json, { version: "", files: [] });
    const wrote = await call(`/api/connectors/${id}/write`, { dir, baseVersion: "", put, remove: [] });
    assert.equal(wrote.status, 200, wrote.text);
    assert.deepEqual([...dbx.files.keys()].sort(), ["/garden-abc123/a.txt", "/garden-abc123/help/editor page.txt", "/garden-abc123/home.txt", "/garden-abc123/home/pic.bin"]);
    assert.deepEqual(dbx.files.get("/garden-abc123/home/pic.bin").bytes, bytes);
    const listed = await call(`/api/connectors/${id}/list`, { dir });
    assert.deepEqual(listed.json.files.map((f) => f.path), ["A.txt", "Help/Editor page.txt", "Home.txt", "Home/pic.bin"], "four files over pages of two, folders not counted");
    assert.equal(listed.json.version, wrote.json.version);
    const read = await call(`/api/connectors/${id}/read`, { dir });
    const byPath = Object.fromEntries(read.json.files.map((f) => [f.path, Buffer.from(f.base64, "base64")]));
    assert.equal(byPath["Home.txt"].toString(), "Hello é\n");
    assert.deepEqual(byPath["Home/pic.bin"], bytes);
  });

  it("lists the notebooks at the root of the app folder", async () => {
    dbx.put("/Other-1/Home.txt", "x");
    assert.deepEqual((await call(`/api/connectors/${id}/folders`, {})).json.folders, ["Garden-abc123", "Other-1"]);
  });

  it("replaces a file by the revision it knows, adds a new one, deletes, and the version moves", async () => {
    const before = (await call(`/api/connectors/${id}/list`, { dir })).json.version;
    const next = await call(`/api/connectors/${id}/write`, { dir, baseVersion: before, put: [{ path: "Home.txt", base64: b64("second") }, { path: "New.txt", base64: b64("n") }], remove: ["Help/Editor page.txt", "Ghost.txt"] });
    assert.equal(next.status, 200, next.text);
    assert.notEqual(next.json.version, before);
    assert.equal(dbx.files.get("/garden-abc123/home.txt").bytes.toString(), "second");
    assert.equal(dbx.files.has("/garden-abc123/new.txt"), true);
    assert.equal(dbx.files.has("/garden-abc123/help/editor page.txt"), false);
    assert.equal(dbx.files.has("/other-1/home.txt"), true, "another notebook is untouched");
  });

  it("refuses a stale version, and a file that changed between listing and uploading, without overwriting it", async () => {
    const stale = await call(`/api/connectors/${id}/write`, { dir, baseVersion: "0".repeat(32), put: [{ path: "Home.txt", base64: b64("lost") }], remove: [] });
    assert.equal(stale.status, 409);
    const version = (await call(`/api/connectors/${id}/list`, { dir })).json.version;
    dbx.state.beforeUpload = () => {
      dbx.state.beforeUpload = null;
      dbx.put("/Garden-abc123/Home.txt", "pushed by another device");
    };
    const raced = await call(`/api/connectors/${id}/write`, { dir, baseVersion: version, put: [{ path: "Home.txt", base64: b64("mine") }], remove: [] });
    assert.equal(raced.status, 409, raced.text);
    assert.equal(raced.json.code, "conflict");
    assert.equal(dbx.files.get("/garden-abc123/home.txt").bytes.toString(), "pushed by another device");
  });

  it("asks for a new access token when one ends, and says to connect again when the access was revoked", async () => {
    const calls = dbx.state.tokenCalls;
    dbx.expireAccessTokens();
    assert.equal((await call(`/api/connectors/${id}/list`, { dir })).status, 200, "an ended access token is replaced without the person noticing");
    assert.ok(dbx.state.tokenCalls > calls);
    dbx.refresh.clear();
    dbx.expireAccessTokens();
    const gone = await call(`/api/connectors/${id}/list`, { dir });
    assert.notEqual(gone.status, 200);
    assert.match(gone.json.error, /connect it again/);
  });

  it("tells Dropbox that the access is over when the connection is removed, and takes it with the account", async () => {
    await connectThroughWindow();
    const connections = (await call("/api/connectors")).json.connectors;
    const fresh = connections.at(-1).id;
    const revoked = dbx.state.revoked.length;
    assert.equal((await call(`/api/connectors/${fresh}`, undefined, "DELETE")).status, 200);
    assert.equal(dbx.state.revoked.length, revoked + 1, "Dropbox was told");
    await connectThroughWindow();
    assert.equal((await call("/api/account/delete", { password: PASSWORD })).status, 200);
    assert.equal(parts.db.prepare("select count(*) as n from connectors").get().n, 0);
  });
});
