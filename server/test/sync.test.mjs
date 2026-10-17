import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

  describe("page by page", () => {
    const NB = "patched-0001";
    before(async () => {
      await call("cara", "/api/register", { email: "cara@example.org", password: PASSWORD });
      await call("cara", "/api/verify", { email: "cara@example.org", code: lastCode(parts.mailer, "cara@example.org") });
    });
    const sha = async (text) => Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(text))).toString("hex");
    const manifest = (who = "cara", id = NB) => call(who, `/api/sync/notebooks/${id}/manifest`);

    it("says what a notebook holds without its bytes, with a mark that is the SHA-256 of each file", async () => {
      const put = await call("cara", `/api/sync/notebooks/${NB}`, { title: "Pages", baseRevision: 0, files: [{ path: "A.txt", base64: b64("alpha") }, { path: "Sub/B.txt", base64: b64("beta") }] }, "PUT");
      assert.equal(put.status, 200);
      const m = await manifest();
      assert.equal(m.status, 200);
      assert.equal(m.json.revision, 1);
      assert.deepEqual(m.json.files, [{ path: "A.txt", size: 5, mark: await sha("alpha") }, { path: "Sub/B.txt", size: 4, mark: await sha("beta") }]);
      assert.equal(JSON.stringify(m.json).includes(b64("alpha")), false, "no bytes in it");
      assert.equal((await manifest("bob")).status, 404, "another account has none");
      assert.equal((await call("nobody", `/api/sync/notebooks/${NB}/manifest`)).status, 401);
    });

    it("gives some of the files, and leaves out a path that is not there", async () => {
      const got = await call("cara", `/api/sync/notebooks/${NB}/read`, { paths: ["Sub/B.txt", "Nope.txt"] }, "POST");
      assert.equal(got.status, 200);
      assert.deepEqual(got.json.files, [{ path: "Sub/B.txt", base64: b64("beta") }]);
      assert.equal(got.json.revision, 1);
      assert.equal((await call("cara", `/api/sync/notebooks/${NB}/read`, { paths: ["../x"] }, "POST")).status, 400);
      assert.equal((await call("bob", `/api/sync/notebooks/${NB}/read`, { paths: ["A.txt"] }, "POST")).status, 404);
      assert.equal((await call("cara", `/api/sync/notebooks/${NB}/read`, { paths: ["A.txt"] }, "POST", { "content-type": "application/json" })).status, 403, "the site's header is needed");
    });

    it("changes only the files it is told to, and the revision moves once", async () => {
      const patch = (body) => call("cara", `/api/sync/notebooks/${NB}`, { title: "Pages", ...body }, "PATCH");
      const done = await patch({ baseRevision: 1, put: [{ path: "A.txt", base64: b64("alpha two") }, { path: "New.txt", base64: b64("n") }], remove: ["Sub/B.txt"] });
      assert.equal(done.status, 200, done.text);
      assert.equal(done.json.revision, 2);
      const m = (await manifest()).json;
      assert.deepEqual(m.files.map((f) => f.path), ["A.txt", "New.txt"]);
      assert.equal(m.files[0].mark, await sha("alpha two"));
      assert.equal(done.json.usedBytes, 9 + 1, "what is used is what is kept");
      // nothing to change: no new revision
      const same = await patch({ baseRevision: 2, put: [], remove: [] });
      assert.equal(same.json.revision, 2);
      // the title alone is a change
      assert.equal((await patch({ title: "Renamed", baseRevision: 2, put: [], remove: [] })).json.revision, 3);
    });

    it("refuses an old revision, a file written and deleted at once, bad paths, and a notebook that is not there", async () => {
      const patch = (body, id = NB, who = "cara") => call(who, `/api/sync/notebooks/${id}`, { title: "Pages", ...body }, "PATCH");
      const stale = await patch({ baseRevision: 1, put: [{ path: "A.txt", base64: b64("lost") }], remove: [] });
      assert.equal(stale.status, 409);
      assert.equal(stale.json.revision, 3);
      assert.equal((await patch({ baseRevision: 3, put: [{ path: "A.txt", base64: "" }], remove: ["a.TXT"] })).status, 400);
      assert.equal((await patch({ baseRevision: 3, put: [{ path: "../x", base64: "" }], remove: [] })).status, 400);
      assert.equal((await patch({ baseRevision: 3, put: [], remove: [".hidden"] })).status, 400);
      assert.equal((await patch({ baseRevision: 0, put: [], remove: [] })).status, 400);
      assert.equal((await patch({ baseRevision: 1, put: [], remove: [] }, "missing-book")).status, 404);
      assert.equal((await patch({ baseRevision: 3, put: [], remove: [] }, NB, "bob")).status, 404, "another account's");
      assert.equal(JSON.parse(JSON.stringify((await manifest()).json)).files.length, 2, "nothing was changed by the refusals");
    });

    it("counts the quota by what is kept after the change (a replaced file is counted once)", async () => {
      const patch = (put, remove = []) => call("cara", `/api/sync/notebooks/${NB}`, { title: "Renamed", baseRevision: (JSON.parse("{}"), 3), put, remove }, "PATCH");
      const rev = async () => (await manifest()).json.revision;
      const r = await rev();
      const big = (n) => b64("x".repeat(n));
      const tooBig = await call("cara", `/api/sync/notebooks/${NB}`, { title: "Renamed", baseRevision: r, put: [{ path: "A.txt", base64: big(1001) }], remove: [] }, "PATCH");
      assert.equal(tooBig.status, 413);
      assert.equal(tooBig.json.code, "quota");
      assert.equal(await rev(), r, "nothing changed");
      const exact = await call("cara", `/api/sync/notebooks/${NB}`, { title: "Renamed", baseRevision: r, put: [{ path: "A.txt", base64: big(999) }], remove: [] }, "PATCH");
      assert.equal(exact.status, 200, "999 + the 1 byte of New.txt is the whole 1000");
      const over = await call("cara", `/api/sync/notebooks/${NB}`, { title: "Renamed", baseRevision: exact.json.revision, put: [{ path: "More.txt", base64: big(1) }], remove: [] }, "PATCH");
      assert.equal(over.status, 413);
      const swap = await call("cara", `/api/sync/notebooks/${NB}`, { title: "Renamed", baseRevision: exact.json.revision, put: [{ path: "More.txt", base64: big(1) }], remove: ["New.txt"] }, "PATCH");
      assert.equal(swap.status, 200, "deleting a file makes room for another in the same change");
      void patch;
    });

    it("treats names that differ only by case as one file", async () => {
      const r = (await manifest()).json.revision;
      const done = await call("cara", `/api/sync/notebooks/${NB}`, { title: "Renamed", baseRevision: r, put: [{ path: "a.txt", base64: b64("lower") }], remove: [] }, "PATCH");
      assert.equal(done.status, 200, done.text);
      const files = (await manifest()).json.files.map((f) => f.path);
      assert.equal(files.filter((p) => p.toLowerCase() === "a.txt").length, 1, `one file for A.txt and a.txt (${files.join(", ")})`);
    });
  });

  describe("the key for sealed copies", () => {
    const wrappedOf = (fill) => Buffer.concat([Buffer.from("ZSW1"), Buffer.alloc(100, fill)]);
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const CHECK = "0123456789abcdef0123456789abcdef";
    const put = (who, body, headers) => call(who, "/api/sync/keychain", body, "PUT", headers);
    before(async () => {
      await call("dora", "/api/register", { email: "dora@example.org", password: PASSWORD });
      await call("dora", "/api/verify", { email: "dora@example.org", code: lastCode(parts.mailer, "dora@example.org") });
    });

    it("is there for the account that signed in, and for nobody else", async () => {
      assert.equal((await call("nobody", "/api/sync/keychain")).status, 401);
      assert.equal((await put("nobody", { wrapped: wrappedOf(1).toString("base64"), check: CHECK, expect: "none" })).status, 401);
      assert.deepEqual((await call("dora", "/api/sync/keychain")).json, { wrapped: null });
      assert.equal((await put("dora", { wrapped: wrappedOf(1).toString("base64"), check: CHECK, expect: "none" }, { "content-type": "application/json" })).status, 403, "the site's header is needed");
    });

    it("keeps the first key, and refuses a second that is made without having seen it", async () => {
      const first = wrappedOf(1);
      assert.equal((await put("dora", { wrapped: first.toString("base64"), check: CHECK, expect: "none" })).status, 200);
      const got = (await call("dora", "/api/sync/keychain")).json;
      assert.equal(got.wrapped, first.toString("base64"));
      assert.equal(got.check, CHECK);
      const raced = await put("dora", { wrapped: wrappedOf(2).toString("base64"), check: "f".repeat(32), expect: "none" });
      assert.equal(raced.status, 409);
      assert.equal(raced.json.code, "conflict");
      assert.equal(raced.json.wrapped, first.toString("base64"), "it says which key is there, so that the other device can take it");
      assert.equal((await call("dora", "/api/sync/keychain")).json.wrapped, first.toString("base64"), "and nothing was replaced");
    });

    it("replaces a key only for a device that saw it", async () => {
      const first = wrappedOf(1);
      const second = wrappedOf(2);
      const wrong = await put("dora", { wrapped: second.toString("base64"), check: CHECK, expect: sha(wrappedOf(9)) });
      assert.equal(wrong.status, 409);
      const done = await put("dora", { wrapped: second.toString("base64"), check: CHECK, expect: sha(first) });
      assert.equal(done.status, 200);
      assert.equal((await call("dora", "/api/sync/keychain")).json.wrapped, second.toString("base64"));
      assert.equal((await put("dora", { wrapped: first.toString("base64"), check: CHECK, expect: sha(first) })).status, 409, "the old one is not what is there now");
    });

    it("refuses what is not a wrapped key, whatever the rest says", async () => {
      const there = sha(wrappedOf(2));
      for (const [why, body] of [
        ["too short", { wrapped: Buffer.concat([Buffer.from("ZSW1"), Buffer.alloc(99, 1)]).toString("base64"), check: CHECK, expect: there }],
        ["too long", { wrapped: Buffer.concat([Buffer.from("ZSW1"), Buffer.alloc(101, 1)]).toString("base64"), check: CHECK, expect: there }],
        ["not the magic", { wrapped: Buffer.concat([Buffer.from("XXXX"), Buffer.alloc(100)]).toString("base64"), check: CHECK, expect: there }],
        ["not base64", { wrapped: "!!!", check: CHECK, expect: there }],
        ["a number", { wrapped: 5, check: CHECK, expect: there }],
        ["no check value", { wrapped: wrappedOf(3).toString("base64"), expect: there }],
        ["a check value that is not hex", { wrapped: wrappedOf(3).toString("base64"), check: "zz", expect: there }],
        ["no expectation", { wrapped: wrappedOf(3).toString("base64"), check: CHECK }],
        ["an expectation that is not a sum", { wrapped: wrappedOf(3).toString("base64"), check: CHECK, expect: "yes" }],
      ]) assert.equal((await put("dora", body)).status, 400, why);
      assert.equal((await call("dora", "/api/sync/keychain")).json.wrapped, wrappedOf(2).toString("base64"), "nothing was changed by the refusals");
    });

    it("is one account's own, is in the export, and goes with the account", async () => {
      assert.deepEqual((await call("bob", "/api/sync/keychain")).json, { wrapped: null });
      assert.equal((await call("dora", "/api/account/export")).json.sealedKey, true);
      assert.equal((await call("bob", "/api/account/export")).json.sealedKey, false);
      // another account's first key is its own first, whatever is kept for others, and a replacement is compared with its own key only
      const bobs = wrappedOf(7);
      assert.equal((await put("bob", { wrapped: bobs.toString("base64"), check: CHECK, expect: "none" })).status, 200);
      assert.equal((await call("dora", "/api/sync/keychain")).json.wrapped, wrappedOf(2).toString("base64"), "which does not touch the other account's");
      assert.equal((await put("bob", { wrapped: wrappedOf(8).toString("base64"), check: CHECK, expect: sha(bobs) })).status, 200);
      assert.equal((await call("bob", "/api/account/export")).json.sealedKey, true);
      assert.equal((await call("dora", "/api/account/delete", { password: PASSWORD })).status, 200);
      assert.equal(parts.db.prepare("select count(*) as n from cloud_keys").get().n, 1, "what is left is the other account's");
    });
  });

  describe("starting the sealed copies over", () => {
    const wrappedOf = (fill) => Buffer.concat([Buffer.from("ZSW1"), Buffer.alloc(100, fill)]);
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const CHECK = "0123456789abcdef0123456789abcdef";
    const SEALED = "zsl-aaaaaaaaaaaaaaaa";
    const put = (who, body, headers) => call(who, "/api/sync/keychain", body, "PUT", headers);
    const reset = (who, body, headers) => call(who, "/api/sync/keychain/reset", body, "POST", headers);
    const keepNotebook = (who, id, title) => call(who, `/api/sync/notebooks/${id}`, { title, baseRevision: 0, files: [{ path: "index.zseal", base64: b64("sealed") }] }, "PUT");
    before(async () => {
      for (const who of ["erin", "finn"]) {
        await call(who, "/api/register", { email: `${who}@example.org`, password: PASSWORD });
        await call(who, "/api/verify", { email: `${who}@example.org`, code: lastCode(parts.mailer, `${who}@example.org`) });
      }
    });

    it("is for the account that signed in, and needs the site's header", async () => {
      assert.equal((await reset("nobody", { expect: sha(wrappedOf(1)) })).status, 401);
      assert.equal((await reset("erin", { expect: sha(wrappedOf(1)) }, { "content-type": "application/json" })).status, 403);
    });

    it("has nothing to delete where there is no key, and must be told which key it deletes", async () => {
      assert.equal((await reset("erin", { expect: sha(wrappedOf(1)) })).status, 404);
      assert.equal((await put("erin", { wrapped: wrappedOf(1).toString("base64"), check: CHECK, expect: "none" })).status, 200);
      for (const [why, body] of [["nothing", undefined], ["no sum", {}], ["none", { expect: "none" }], ["a sum that is not one", { expect: "yes" }], ["a short sum", { expect: "ab12" }], ["a number", { expect: 5 }]]) {
        assert.equal((await reset("erin", body ?? {})).status, 400, why);
      }
      assert.equal((await call("erin", "/api/sync/keychain")).json.wrapped, wrappedOf(1).toString("base64"), "nothing was deleted by the refusals");
    });

    it("refuses a key that is not the one that was seen, and says which one is there", async () => {
      const stale = await reset("erin", { expect: sha(wrappedOf(9)) });
      assert.equal(stale.status, 409);
      assert.equal(stale.json.wrapped, wrappedOf(1).toString("base64"));
      assert.equal(stale.json.check, CHECK);
      assert.equal((await call("erin", "/api/sync/keychain")).json.wrapped, wrappedOf(1).toString("base64"), "and nothing was deleted");
    });

    it("deletes the key and the sealed notebooks of the account's own space, and nothing else: its other notebooks, and every other account's, stay", async () => {
      assert.equal((await keepNotebook("erin", SEALED, "Encrypted notebook")).status, 200);
      assert.equal((await keepNotebook("erin", "zsl-bbbbbbbbbbbbbbbb", "Encrypted notebook")).status, 200);
      assert.equal((await keepNotebook("erin", "garden-in-clear-1", "Garden")).status, 200);
      assert.equal((await keepNotebook("erin", "zslx-not-a-sealed-one", "Looks like one")).status, 200);
      assert.equal((await put("finn", { wrapped: wrappedOf(7).toString("base64"), check: CHECK, expect: "none" })).status, 200);
      assert.equal((await keepNotebook("finn", SEALED, "Encrypted notebook")).status, 200);
      const done = await reset("erin", { expect: sha(wrappedOf(1)) });
      assert.equal(done.status, 200);
      assert.deepEqual({ ok: done.json.ok, removed: done.json.removed }, { ok: true, removed: 2 });
      assert.deepEqual((await call("erin", "/api/sync/keychain")).json, { wrapped: null }, "the key is gone");
      assert.deepEqual((await call("erin", "/api/sync/notebooks")).json.notebooks.map((n) => n.id).sort(), ["garden-in-clear-1", "zslx-not-a-sealed-one"], "the sealed notebooks are gone, the others are not");
      assert.equal(parts.db.prepare("select count(*) as n from notebook_files where user_id = (select id from users where email = 'erin@example.org') and notebook_id like 'zsl-%'").get().n, 0, "with their files");
      assert.equal((await call("finn", "/api/sync/keychain")).json.wrapped, wrappedOf(7).toString("base64"), "another account's key stays");
      assert.deepEqual((await call("finn", "/api/sync/notebooks")).json.notebooks.map((n) => n.id), [SEALED], "and so does its sealed notebook");
      assert.equal((await reset("erin", { expect: sha(wrappedOf(1)) })).status, 404, "there is nothing to delete a second time");
    });

    it("lets a first key be made again afterwards", async () => {
      assert.equal((await put("erin", { wrapped: wrappedOf(3).toString("base64"), check: "f".repeat(32), expect: "none" })).status, 200);
      assert.equal((await call("erin", "/api/sync/keychain")).json.check, "f".repeat(32));
      assert.equal((await keepNotebook("erin", SEALED, "Encrypted notebook")).status, 200, "and the id is free again");
    });

    after(async () => {
      for (const who of ["erin", "finn"]) await call(who, "/api/account/delete", { password: PASSWORD });
    });
  });

  it("deletes a notebook, and the account's notebooks go with the account", async () => {
    assert.equal((await call("bob", `/api/sync/notebooks/${ID}`, undefined, "DELETE")).status, 200);
    assert.equal((await call("bob", "/api/sync/notebooks")).json.notebooks.length, 0);
    assert.equal((await call("ada", "/api/account/delete", { password: PASSWORD })).status, 200);
    assert.equal((await call("cara", "/api/account/delete", { password: PASSWORD })).status, 200);
    assert.equal(parts.db.prepare("select count(*) as n from notebook_files").get().n, 0);
    assert.equal(parts.db.prepare("select count(*) as n from notebooks").get().n, 0);
  });
});
