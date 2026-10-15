import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { OAuth } from "../src/oauth.mjs";
import { validPath } from "../src/sync.mjs";
import { lastCode, make, PASSWORD } from "./helpers.mjs";

const HEADERS = { "content-type": "application/json", "x-requested-with": "zim" };
const b64 = (text) => Buffer.from(text).toString("base64");
const ID = "notebook-0001";

describe("notebooks kept on the server", () => {
  let server, base, parts;
  const jars = {};
  before(async () => {
    parts = make({ baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {}, quotaBytes: 1000 });
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
  after(() => server.close());

  async function call(who, path, body, method = body === undefined ? "GET" : "POST", headers = HEADERS) {
    const response = await fetch(base + path, { method, headers: { ...(method === "GET" ? {} : headers), ...(jars[who] ? { cookie: jars[who] } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers.get("set-cookie");
    if (set) jars[who] = set.split(";")[0];
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  it("needs a session, and a write needs the site's own header", async () => {
    assert.equal((await call("nobody", "/api/sync/notebooks")).status, 401);
    assert.equal((await call("nobody", `/api/sync/notebooks/${ID}`, { title: "x", baseRevision: 0, files: [] }, "PUT")).status, 401);
    assert.equal((await call("ada", `/api/sync/notebooks/${ID}`, { title: "x", baseRevision: 0, files: [] }, "PUT", { "content-type": "application/json" })).status, 403);
  });

  it("stores a notebook, lists it, gives it back byte for byte", async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 128]).toString("base64");
    const put = await call("ada", `/api/sync/notebooks/${ID}`, { title: "Garden", baseRevision: 0, files: [{ path: "Home.txt", base64: b64("Content-Type: text/x-zim-wiki\n\nHello é\n") }, { path: "Home/pic.bin", base64: bytes }] }, "PUT");
    assert.equal(put.status, 200);
    assert.equal(put.json.revision, 1);
    const list = await call("ada", "/api/sync/notebooks");
    assert.equal(list.json.notebooks.length, 1);
    assert.equal(list.json.notebooks[0].title, "Garden");
    const got = await call("ada", `/api/sync/notebooks/${ID}`);
    assert.deepEqual(got.json.files, [{ path: "Home.txt", base64: b64("Content-Type: text/x-zim-wiki\n\nHello é\n") }, { path: "Home/pic.bin", base64: bytes }]);
    assert.equal((await call("ada", "/api/me")).json.user.usedBytes, put.json.usedBytes);
  });

  it("keeps each person's notebooks to themselves", async () => {
    assert.equal((await call("bob", "/api/sync/notebooks")).json.notebooks.length, 0);
    assert.equal((await call("bob", `/api/sync/notebooks/${ID}`)).status, 404);
    assert.equal((await call("bob", `/api/sync/notebooks/${ID}`, undefined, "DELETE")).status, 404);
    // the same id for someone else is another notebook
    assert.equal((await call("bob", `/api/sync/notebooks/${ID}`, { title: "Bob's", baseRevision: 0, files: [{ path: "A.txt", base64: b64("b") }] }, "PUT")).status, 200);
    assert.equal((await call("ada", `/api/sync/notebooks/${ID}`)).json.title, "Garden");
  });

  it("refuses a write made from an old revision, and changes nothing", async () => {
    const stale = await call("ada", `/api/sync/notebooks/${ID}`, { title: "Garden", baseRevision: 0, files: [] }, "PUT");
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "conflict");
    assert.equal(stale.json.revision, 1);
    assert.equal((await call("ada", `/api/sync/notebooks/${ID}`)).json.files.length, 2);
    const next = await call("ada", `/api/sync/notebooks/${ID}`, { title: "Garden", baseRevision: 1, files: [{ path: "Home.txt", base64: b64("v2") }] }, "PUT");
    assert.equal(next.json.revision, 2);
    assert.equal((await call("ada", `/api/sync/notebooks/${ID}`)).json.files.length, 1, "files that are gone from the notebook are gone");
  });

  it("holds the account to its quota, counting what a notebook already has only once", async () => {
    const big = (n) => b64("x".repeat(n));
    const over = await call("ada", `/api/sync/notebooks/${ID}`, { title: "Garden", baseRevision: 2, files: [{ path: "Big.txt", base64: big(1001) }] }, "PUT");
    assert.equal(over.status, 413);
    assert.equal(over.json.code, "quota");
    assert.equal((await call("ada", `/api/sync/notebooks/${ID}`)).json.revision, 2, "nothing changed");
    assert.equal((await call("ada", `/api/sync/notebooks/${ID}`, { title: "Garden", baseRevision: 2, files: [{ path: "Big.txt", base64: big(1000) }] }, "PUT")).status, 200, "rewriting the notebook itself may use the whole quota");
    const second = await call("ada", "/api/sync/notebooks/second-book", { title: "Two", baseRevision: 0, files: [{ path: "A.txt", base64: big(1) }] }, "PUT");
    assert.equal(second.status, 413);
  });

  it("refuses ids, names and paths that are not safe", async () => {
    const put = (id, body) => call("bob", `/api/sync/notebooks/${id}`, { title: "T", baseRevision: 0, files: [], ...body }, "PUT");
    assert.equal((await put("bad%20id%21%21", {})).status, 400);
    assert.equal((await put("short", {})).status, 400);
    assert.equal((await put("good-id-001", { title: "  " })).status, 400);
    for (const path of ["../x.txt", "/abs.txt", ".hidden", "a//b.txt", "a/./b", "a\\b", ""]) assert.equal((await put("good-id-001", { files: [{ path, base64: "" }] })).status, 400, path);
    assert.equal((await put("good-id-001", { files: [{ path: "A.txt", base64: "" }, { path: "a.TXT", base64: "" }] })).status, 400, "two names that differ only by case");
    assert.equal((await put("good-id-001", { files: [{ path: "A.txt", base64: "not base64!" }] })).status, 400);
    assert.equal((await put("good-id-001", { baseRevision: -1 })).status, 400);
    assert.equal(validPath("Home/Sub page.txt"), true);
  });

  it("deletes a notebook, and the account's notebooks go with the account", async () => {
    assert.equal((await call("bob", `/api/sync/notebooks/${ID}`, undefined, "DELETE")).status, 200);
    assert.equal((await call("bob", "/api/sync/notebooks")).json.notebooks.length, 0);
    assert.equal((await call("ada", "/api/account/delete", { password: PASSWORD })).status, 200);
    assert.equal(parts.db.prepare("select count(*) as n from notebook_files").get().n, 0);
    assert.equal(parts.db.prepare("select count(*) as n from notebooks").get().n, 0);
  });
});
