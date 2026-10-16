import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { OAuth } from "../src/oauth.mjs";
import { fakeDrive } from "./fake-drive.mjs";
import { lastCode, make, PASSWORD } from "./helpers.mjs";

const HEADERS = { "content-type": "application/json", "x-requested-with": "zim" };
const b64 = (text) => Buffer.from(text).toString("base64");

describe("Google Drive as a connected service", () => {
  let server, base, parts, drv, drvUrl, cookie, id;
  before(async () => {
    drv = fakeDrive();
    drvUrl = await drv.start();
    parts = make({
      baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {},
      connectorApps: { gdrive: { clientId: "drv-id", clientSecret: "drv-secret" } },
      connectorOptions: { allowInsecure: true, allowPrivate: true, driveApi: drvUrl, endpoints: { gdrive: { authorize: `${drvUrl}/authorize`, token: `${drvUrl}/token`, revoke: `${drvUrl}/revoke` } } },
    });
    const api = createApi({ accounts: parts.accounts, oauth: new OAuth({ db: parts.db, accounts: parts.accounts, config: parts.config }), config: parts.config });
    server = http.createServer(async (req, res) => ((await api(req, res)) ? undefined : (res.writeHead(404), res.end())));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    parts.config.baseUrl = base;
    await call("/api/register", { email: "ada@example.org", password: PASSWORD });
    await call("/api/verify", { email: "ada@example.org", code: lastCode(parts.mailer, "ada@example.org") });
  });
  after(() => (server.close(), drv.stop()));

  async function call(path, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(base + path, { method, redirect: "manual", headers: { ...(method === "GET" ? {} : HEADERS), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers.get("set-cookie");
    if (set && set.startsWith("zim=")) cookie = set.split(";")[0];
    const text = await response.text();
    return { status: response.status, headers: response.headers, set, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null, text };
  }
  async function connect() {
    const start = await call("/api/connectors/oauth/gdrive/start");
    const nonce = /zim-connect=([^;]+)/.exec(start.set)[1];
    const back = new URL((await fetch(start.headers.get("location"), { redirect: "manual" })).headers.get("location"));
    const done = await fetch(base + back.pathname + back.search, { redirect: "manual", headers: { cookie: `${cookie}; zim-connect=${nonce}` } });
    return { start, location: done.headers.get("location") };
  }
  const dir = "Garden-abc123";
  const ROOT = "Zim Notebooks";

  it("asks Google for the narrowest access (the files this app makes), offline, and keeps a sealed refresh token", async () => {
    const start = await call("/api/connectors/oauth/gdrive/start");
    const url = new URL(start.headers.get("location"));
    assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const done = await connect();
    assert.equal(done.location, "/?connected=1");
    const listed = await call("/api/connectors");
    id = listed.json.connectors[0].id;
    assert.equal(listed.json.connectors[0].label, "Google Drive");
    assert.equal(Buffer.from(parts.db.prepare("select config from connectors").get().config).includes([...drv.refresh][0]), false);
    assert.equal(listed.text.includes([...drv.refresh][0]), false);
    assert.ok([...drv.items.values()].some((it) => it.name === ROOT && it.mimeType === "application/vnd.google-apps.folder"), "the app's folder was made by the test");
  });

  it("says when Google does not give a lasting access", async () => {
    // (a window that does not ask for offline access: the fake then gives no refresh token)
    const start = await call("/api/connectors/oauth/gdrive/start");
    const nonce = /zim-connect=([^;]+)/.exec(start.set)[1];
    const authorize = new URL(start.headers.get("location"));
    authorize.searchParams.delete("access_type");
    const back = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location"));
    const done = await fetch(base + back.pathname + back.search, { redirect: "manual", headers: { cookie: `${cookie}; zim-connect=${nonce}` } });
    assert.match(done.headers.get("location"), /connect_error=no-refresh/);
    assert.equal((await call("/api/connectors")).json.connectors.length, 1, "nothing was kept");
  });

  it("writes a notebook as real Drive folders and files, lists them over pages of two, reads them back byte for byte", async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 128]);
    const put = [{ path: "Home.txt", base64: b64("Hello é\n") }, { path: "Help/Editor page.txt", base64: b64("deep") }, { path: "Home/pic.bin", base64: bytes.toString("base64") }, { path: "A.txt", base64: b64("a") }];
    assert.deepEqual((await call(`/api/connectors/${id}/list`, { dir })).json, { version: "", files: [] });
    const wrote = await call(`/api/connectors/${id}/write`, { dir, baseVersion: "", put, remove: [] });
    assert.equal(wrote.status, 200, wrote.text);
    assert.deepEqual(Object.keys(drv.files()).sort(), [`${ROOT}/${dir}/A.txt`, `${ROOT}/${dir}/Help/Editor page.txt`, `${ROOT}/${dir}/Home.txt`, `${ROOT}/${dir}/Home/pic.bin`], "folders of Drive, where a person would look");
    assert.deepEqual(drv.files()[`${ROOT}/${dir}/Home/pic.bin`], bytes);
    const listed = await call(`/api/connectors/${id}/list`, { dir });
    assert.deepEqual(listed.json.files.map((f) => f.path), ["A.txt", "Help/Editor page.txt", "Home.txt", "Home/pic.bin"]);
    assert.equal(listed.json.version, wrote.json.version);
    const read = await call(`/api/connectors/${id}/read`, { dir });
    const byPath = Object.fromEntries(read.json.files.map((f) => [f.path, Buffer.from(f.base64, "base64")]));
    assert.equal(byPath["Home.txt"].toString(), "Hello é\n");
    assert.deepEqual(byPath["Home/pic.bin"], bytes);
  });

  it("makes each folder once, even for names with quotes, and does not make a second notebook folder", async () => {
    const quoted = "It's a \"quoted\" notebook-1";
    await call(`/api/connectors/${id}/write`, { dir: quoted, baseVersion: "", put: [{ path: "Home.txt", base64: b64("q") }, { path: "Sub/One.txt", base64: b64("1") }, { path: "Sub/Two.txt", base64: b64("2") }], remove: [] });
    assert.equal([...drv.items.values()].filter((it) => it.name === ROOT).length, 1, "one app folder");
    assert.equal([...drv.items.values()].filter((it) => it.name === "Sub").length, 1, "one Sub folder for two files");
    assert.deepEqual((await call(`/api/connectors/${id}/list`, { dir: quoted })).json.files.map((f) => f.path), ["Home.txt", "Sub/One.txt", "Sub/Two.txt"]);
    assert.deepEqual((await call(`/api/connectors/${id}/folders`, {})).json.folders, [dir, quoted].sort());
  });

  it("replaces a file in place (its id stays), adds, deletes, and the version moves", async () => {
    const before = (await call(`/api/connectors/${id}/list`, { dir })).json.version;
    const homeId = [...drv.items.values()].find((it) => it.name === "Home.txt" && it.parents[0] !== "root").id;
    const next = await call(`/api/connectors/${id}/write`, { dir, baseVersion: before, put: [{ path: "Home.txt", base64: b64("second") }, { path: "New.txt", base64: b64("n") }], remove: ["Help/Editor page.txt", "Ghost.txt"] });
    assert.equal(next.status, 200, next.text);
    assert.notEqual(next.json.version, before);
    assert.equal(drv.items.get(homeId).bytes.toString(), "second", "the same file, new content");
    const files = drv.files();
    assert.equal(files[`${ROOT}/${dir}/New.txt`].toString(), "n");
    assert.equal(`${ROOT}/${dir}/Help/Editor page.txt` in files, false);
  });

  it("uses the first of two files that share a name, and refuses a stale version", async () => {
    const folder = [...drv.items.values()].find((it) => it.name === dir).id;
    drv.make("Home.txt", "application/octet-stream", [folder], Buffer.from("a twin made elsewhere"));
    const listed = await call(`/api/connectors/${id}/list`, { dir });
    assert.equal(listed.json.files.filter((f) => f.path === "Home.txt").length, 1);
    const read = await call(`/api/connectors/${id}/read`, { dir });
    assert.equal(Buffer.from(read.json.files.find((f) => f.path === "Home.txt").base64, "base64").toString(), "second", "the first one");
    const stale = await call(`/api/connectors/${id}/write`, { dir, baseVersion: "0".repeat(32), put: [{ path: "Home.txt", base64: b64("lost") }], remove: [] });
    assert.equal(stale.status, 409);
  });

  it("asks for a new access token when one ends, says to connect again when access was withdrawn, and tells Google when the connection is removed", async () => {
    const calls = drv.state.tokenCalls;
    drv.expireAccessTokens();
    assert.equal((await call(`/api/connectors/${id}/list`, { dir })).status, 200);
    assert.ok(drv.state.tokenCalls > calls);
    const second = (await connect(), (await call("/api/connectors")).json.connectors.at(-1).id);
    const revoked = drv.state.revoked.length;
    assert.equal((await call(`/api/connectors/${second}`, undefined, "DELETE")).status, 200);
    assert.equal(drv.state.revoked.length, revoked + 1, "Google was told");
    drv.refresh.clear();
    drv.expireAccessTokens();
    const gone = await call(`/api/connectors/${id}/list`, { dir });
    assert.notEqual(gone.status, 200);
    assert.match(gone.json.error, /connect it again/);
  });
});
