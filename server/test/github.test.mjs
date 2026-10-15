import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { OAuth } from "../src/oauth.mjs";
import { fakeGithub } from "./fake-github.mjs";
import { lastCode, make, PASSWORD } from "./helpers.mjs";

const HEADERS = { "content-type": "application/json", "x-requested-with": "zim" };
const b64 = (text) => Buffer.from(text).toString("base64");

describe("a GitHub repository as a connected service", () => {
  let server, base, parts, gh, ghUrl, cookie, id;
  before(async () => {
    gh = fakeGithub();
    ghUrl = await gh.start();
    parts = make({ baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {}, connectorOptions: { allowInsecure: true, allowPrivate: true, githubApi: ghUrl } });
    const api = createApi({ accounts: parts.accounts, oauth: new OAuth({ db: parts.db, accounts: parts.accounts, config: parts.config }), config: parts.config });
    server = http.createServer(async (req, res) => ((await api(req, res)) ? undefined : (res.writeHead(404), res.end())));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    parts.config.baseUrl = base;
    await call("/api/register", { email: "ada@example.org", password: PASSWORD });
    await call("/api/verify", { email: "ada@example.org", code: lastCode(parts.mailer, "ada@example.org") });
  });
  after(() => (server.close(), gh.stop()));

  async function call(path, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(base + path, { method, headers: { ...(method === "GET" ? {} : HEADERS), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, text };
  }
  const add = (settings) => call("/api/connectors", { kind: "github", label: "Notes repo", settings: { repo: "ada/notebooks", branch: "main", root: "notebooks", token: "ghp_valid", ...settings } });
  const dir = "Garden-abc123";

  it("checks the repository, the branch and the token before keeping anything, and says what is wrong", async () => {
    assert.match((await add({ token: "ghp_wrong" })).json.error, /refused that token/);
    assert.equal((await add({ repo: "ada/missing" })).json.code, "not-found");
    assert.equal((await add({ token: "ghp_readonly" })).json.code, "read-only");
    assert.equal((await add({ branch: "develop" })).json.code, "no-branch");
    for (const settings of [{ repo: "nonsense" }, { repo: "a/b/c" }, { repo: "../.." }, { repo: "ada/.." }, { repo: "./x" }, { branch: "a..b" }, { root: "../x" }, { root: ".hidden" }, { root: "a/b/c/d" }, { token: "" }, { token: "has space" }]) assert.equal((await add(settings)).json.code, "bad-settings", JSON.stringify(settings));
    assert.equal((await call("/api/connectors")).json.connectors.length, 0, "nothing was kept");
    const ok = await add({});
    assert.equal(ok.status, 200, ok.text);
    id = ok.json.id;
    assert.equal(ok.json.service, "GitHub repository");
  });

  it("keeps the token sealed and never gives it back", async () => {
    assert.equal((await call("/api/connectors")).text.includes("ghp_valid"), false);
    assert.equal(Buffer.from(parts.db.prepare("select config from connectors").get().config).includes("ghp_valid"), false);
  });

  it("sends a change as one commit, and leaves the rest of the repository alone", async () => {
    const commitsBefore = gh.commits.size;
    const bytes = Buffer.from([0, 255, 10, 13, 128]);
    const put = [{ path: "Home.txt", base64: b64("Hello é\n") }, { path: "Help/Editor page.txt", base64: b64("deep") }, { path: "Home/pic.bin", base64: bytes.toString("base64") }];
    const empty = await call(`/api/connectors/${id}/list`, { dir });
    assert.deepEqual(empty.json, { version: "", files: [] });
    const wrote = await call(`/api/connectors/${id}/write`, { dir, baseVersion: "", put, remove: [] });
    assert.equal(wrote.status, 200, wrote.text);
    assert.equal(gh.commits.size, commitsBefore + 1, "one commit for three files");
    const head = gh.commits.get(gh.branches.get("main"));
    assert.match(head.message, /Zim Notebook: Garden-abc123 \(3 written\)/);
    const files = gh.files();
    assert.deepEqual(Object.keys(files).sort(), ["README.md", `notebooks/${dir}/Help/Editor page.txt`, `notebooks/${dir}/Home.txt`, `notebooks/${dir}/Home/pic.bin`], "where a person would look, and the README untouched");
    assert.deepEqual(files[`notebooks/${dir}/Home/pic.bin`], bytes);
    const listed = await call(`/api/connectors/${id}/list`, { dir });
    assert.deepEqual(listed.json.files.map((f) => f.path), ["Help/Editor page.txt", "Home.txt", "Home/pic.bin"]);
    assert.equal(listed.json.version, wrote.json.version);
    const read = await call(`/api/connectors/${id}/read`, { dir });
    const byPath = Object.fromEntries(read.json.files.map((f) => [f.path, Buffer.from(f.base64, "base64")]));
    assert.equal(byPath["Home.txt"].toString(), "Hello é\n");
    assert.deepEqual(byPath["Home/pic.bin"], bytes);
  });

  it("lists the notebooks of the repository's folder", async () => {
    gh.push({ [`notebooks/Other-1/Home.txt`]: "x", "docs/not-a-notebook/a.txt": "y" });
    assert.deepEqual((await call(`/api/connectors/${id}/folders`, {})).json.folders, ["Garden-abc123", "Other-1"]);
  });

  it("removes and replaces files in the same commit, and the version moves", async () => {
    const before = (await call(`/api/connectors/${id}/list`, { dir })).json.version;
    const next = await call(`/api/connectors/${id}/write`, { dir, baseVersion: before, put: [{ path: "Home.txt", base64: b64("second") }], remove: ["Help/Editor page.txt", "Ghost.txt"] });
    assert.equal(next.status, 200, "a file that is already gone is not an error: " + next.text);
    assert.notEqual(next.json.version, before);
    const files = gh.files();
    assert.equal(files[`notebooks/${dir}/Home.txt`].toString(), "second");
    assert.equal(`notebooks/${dir}/Help/Editor page.txt` in files, false);
    assert.equal(`notebooks/Other-1/Home.txt` in files, true, "another notebook is untouched");
  });

  it("refuses a change from a version that is not the repository's now, and writes nothing", async () => {
    const commits = gh.commits.size;
    const stale = await call(`/api/connectors/${id}/write`, { dir, baseVersion: "0".repeat(32), put: [{ path: "Home.txt", base64: b64("lost") }], remove: [] });
    assert.equal(stale.status, 409);
    assert.equal(gh.commits.size, commits, "no commit was made");
  });

  it("does not overwrite someone who pushes between reading the branch and moving it", async () => {
    const version = (await call(`/api/connectors/${id}/list`, { dir })).json.version;
    gh.state.beforeRefUpdate = () => {
      gh.state.beforeRefUpdate = null;
      gh.push({ [`notebooks/${dir}/Home.txt`]: "pushed by another device" }, "main", "another device");
    };
    const raced = await call(`/api/connectors/${id}/write`, { dir, baseVersion: version, put: [{ path: "Home.txt", base64: b64("mine") }], remove: [] });
    assert.equal(raced.status, 409, raced.text);
    assert.equal(raced.json.code, "conflict");
    assert.equal(gh.files()[`notebooks/${dir}/Home.txt`].toString(), "pushed by another device", "their work is still the branch's");
  });

  it("works for a repository's top level (no folder given), and is the owner's alone", async () => {
    const top = await add({ root: "" });
    assert.equal(top.status, 200);
    const wrote = await call(`/api/connectors/${top.json.id}/write`, { dir: "Top-1", baseVersion: "", put: [{ path: "Home.txt", base64: b64("t") }], remove: [] });
    assert.equal(wrote.status, 200, wrote.text);
    assert.equal("Top-1/Home.txt" in gh.files(), true);
    await call("/api/logout", {});
    assert.equal((await call(`/api/connectors/${top.json.id}/list`, { dir: "Top-1" })).status, 401);
  });
});
