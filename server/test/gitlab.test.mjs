import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { OAuth } from "../src/oauth.mjs";
import { fakeGitlab } from "./fake-gitlab.mjs";
import { lastCode, make, PASSWORD } from "./helpers.mjs";

const HEADERS = { "content-type": "application/json", "x-requested-with": "zim" };
const b64 = (text) => Buffer.from(text).toString("base64");

describe("a GitLab project as a connected service", () => {
  let server, base, parts, gl, cookie, id;
  before(async () => {
    gl = fakeGitlab();
    const glUrl = await gl.start();
    parts = make({ baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {}, connectorOptions: { allowInsecure: true, allowPrivate: true, gitlabApi: glUrl } });
    const api = createApi({ accounts: parts.accounts, oauth: new OAuth({ db: parts.db, accounts: parts.accounts, config: parts.config }), config: parts.config });
    server = http.createServer(async (req, res) => ((await api(req, res)) ? undefined : (res.writeHead(404), res.end())));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    parts.config.baseUrl = base;
    await call("/api/register", { email: "ada@example.org", password: PASSWORD });
    await call("/api/verify", { email: "ada@example.org", code: lastCode(parts.mailer, "ada@example.org") });
  });
  after(() => (server.close(), gl.stop()));

  async function call(path, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(base + path, { method, headers: { ...(method === "GET" ? {} : HEADERS), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, text };
  }
  const add = (settings) => call("/api/connectors", { kind: "gitlab", label: "Notes project", settings: { project: "ada/notebooks", branch: "main", root: "notebooks", token: "glpat-valid", ...settings } });
  const dir = "Garden-abc123";

  it("checks the project, the branch and the token before keeping anything, and says what is wrong", async () => {
    assert.match((await add({ token: "glpat-wrong" })).json.error, /refused that token/);
    assert.equal((await add({ project: "ada/missing" })).json.code, "not-found");
    assert.equal((await add({ token: "glpat-reader" })).json.code, "read-only");
    assert.equal((await add({ branch: "develop" })).json.code, "no-branch");
    for (const settings of [{ project: "nonsense" }, { project: "a/b/../c" }, { host: "bad host!" }, { host: "gitlab.com/evil" }, { branch: "a..b" }, { root: "../x" }, { root: ".hidden" }, { token: "" }, { token: "has space" }]) assert.equal((await add(settings)).json.code, "bad-settings", JSON.stringify(settings));
    assert.equal((await call("/api/connectors")).json.connectors.length, 0, "nothing was kept");
    const ok = await add({});
    assert.equal(ok.status, 200, ok.text);
    id = ok.json.id;
    assert.equal(ok.json.service, "GitLab project");
  });

  it("keeps the token sealed and never gives it back", async () => {
    assert.equal((await call("/api/connectors")).text.includes("glpat-valid"), false);
    assert.equal(Buffer.from(parts.db.prepare("select config from connectors").get().config).includes("glpat-valid"), false);
  });

  it("sends a change as one commit (creating what is new), pages through long listings, and leaves the rest alone", async () => {
    const made0 = gl.state.made;
    const bytes = Buffer.from([0, 255, 10, 13, 128]);
    const put = [{ path: "Home.txt", base64: b64("Hello é\n") }, { path: "Help/Editor page.txt", base64: b64("deep") }, { path: "Home/pic.bin", base64: bytes.toString("base64") }, { path: "A.txt", base64: b64("a") }, { path: "B.txt", base64: b64("b") }];
    assert.deepEqual((await call(`/api/connectors/${id}/list`, { dir })).json, { version: "", files: [] });
    const wrote = await call(`/api/connectors/${id}/write`, { dir, baseVersion: "", put, remove: [] });
    assert.equal(wrote.status, 200, wrote.text);
    assert.equal(gl.state.made, made0 + 1, "one commit for five files");
    assert.deepEqual(Object.keys(gl.files()).sort(), ["README.md", ...["A.txt", "B.txt", "Help/Editor page.txt", "Home.txt", "Home/pic.bin"].map((p) => `notebooks/${dir}/${p}`)]);
    assert.deepEqual(gl.files()[`notebooks/${dir}/Home/pic.bin`], bytes);
    const listed = await call(`/api/connectors/${id}/list`, { dir });
    assert.equal(listed.json.files.length, 5, "all five pages of the listing (two to a page here) were read");
    assert.equal(listed.json.version, wrote.json.version);
    const read = await call(`/api/connectors/${id}/read`, { dir });
    const byPath = Object.fromEntries(read.json.files.map((f) => [f.path, Buffer.from(f.base64, "base64")]));
    assert.equal(byPath["Home.txt"].toString(), "Hello é\n");
    assert.deepEqual(byPath["Home/pic.bin"], bytes);
  });

  it("lists the notebooks of the project's folder", async () => {
    gl.push({ [`notebooks/${dir}/Home.txt`]: gl.files()[`notebooks/${dir}/Home.txt`].toString(), "notebooks/Other-1/Home.txt": "x", "docs/not-a-notebook/a.txt": "y" });
    assert.deepEqual((await call(`/api/connectors/${id}/folders`, {})).json.folders, ["Garden-abc123", "Other-1"]);
  });

  it("updates, creates and deletes in one commit, and the version moves", async () => {
    const before = (await call(`/api/connectors/${id}/list`, { dir })).json.version;
    const next = await call(`/api/connectors/${id}/write`, { dir, baseVersion: before, put: [{ path: "Home.txt", base64: b64("second") }, { path: "New.txt", base64: b64("n") }], remove: ["Help/Editor page.txt", "Ghost.txt"] });
    assert.equal(next.status, 200, "a file that is already gone is not an error: " + next.text);
    assert.notEqual(next.json.version, before);
    const files = gl.files();
    assert.equal(files[`notebooks/${dir}/Home.txt`].toString(), "second");
    assert.equal(files[`notebooks/${dir}/New.txt`].toString(), "n");
    assert.equal(`notebooks/${dir}/Help/Editor page.txt` in files, false);
    assert.equal(`notebooks/Other-1/Home.txt` in files, true, "another notebook is untouched");
  });

  it("refuses a change from a version that is not the project's now, and writes nothing", async () => {
    const made = gl.state.made;
    const stale = await call(`/api/connectors/${id}/write`, { dir, baseVersion: "0".repeat(32), put: [{ path: "Home.txt", base64: b64("lost") }], remove: [] });
    assert.equal(stale.status, 409);
    assert.equal(gl.state.made, made);
  });

  it("does not overwrite someone who pushes between reading the branch and committing", async () => {
    const version = (await call(`/api/connectors/${id}/list`, { dir })).json.version;
    gl.state.beforeCommit = () => {
      gl.state.beforeCommit = null;
      gl.push({ [`notebooks/${dir}/Home.txt`]: "pushed by another device" });
    };
    const raced = await call(`/api/connectors/${id}/write`, { dir, baseVersion: version, put: [{ path: "Home.txt", base64: b64("mine") }], remove: [] });
    assert.equal(raced.status, 409, raced.text);
    assert.equal(raced.json.code, "conflict");
    assert.equal(gl.files()[`notebooks/${dir}/Home.txt`].toString(), "pushed by another device");
  });

  it("works without a folder, and a folder that is not there yet is simply empty", async () => {
    const top = await add({ root: "" });
    assert.equal(top.status, 200, top.text);
    assert.deepEqual((await call(`/api/connectors/${top.json.id}/list`, { dir: "Nothing-here" })).json, { version: "", files: [] });
    const wrote = await call(`/api/connectors/${top.json.id}/write`, { dir: "Top-1", baseVersion: "", put: [{ path: "Home.txt", base64: b64("t") }], remove: [] });
    assert.equal(wrote.status, 200, wrote.text);
    assert.equal("Top-1/Home.txt" in gl.files(), true);
  });
});
