import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createApi } from "../src/api.mjs";
import { OAuth } from "../src/oauth.mjs";
import { lastCode, make, PASSWORD } from "./helpers.mjs";

const HEADERS = { "content-type": "application/json", "x-requested-with": "zim" };

describe("the HTTP API", () => {
  let server, base, parts, oauth;
  before(async () => {
    parts = make({ baseUrl: "http://localhost", secure: false, trustProxy: false, providers: { github: { clientId: "id", clientSecret: "s" } } });
    oauth = new OAuth({ db: parts.db, accounts: parts.accounts, config: parts.config, now: () => parts.clock.t });
    const api = createApi({ accounts: parts.accounts, oauth, config: parts.config });
    server = http.createServer(async (req, res) => {
      if (!(await api(req, res))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    parts.config.baseUrl = base;
  });
  after(() => server.close());

  let cookie = "";
  const call = async (path, { method = "POST", body, headers = HEADERS, useCookie = true } = {}) => {
    const response = await fetch(base + path, { method, redirect: "manual", headers: { ...headers, ...(useCookie && cookie ? { cookie } : {}) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const text = await response.text();
    return { status: response.status, headers: response.headers, set, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  };

  it("leaves what is not /api/ alone, and says what is set up", async () => {
    assert.equal((await call("/other", { method: "GET" })).status, 404);
    const { json } = await call("/api/providers", { method: "GET" });
    assert.deepEqual(json, { providers: ["github"], email: true });
  });

  it("says that it is up only while its database answers (what a check from outside asks)", async () => {
    const up = await call("/api/health", { method: "GET" });
    assert.equal(up.status, 200);
    assert.deepEqual(up.json, { ok: true });
    // a server whose database does not answer (here, one that was closed) is not up, and says so with a status that a monitor reads
    const dead = make({ baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {} });
    const deadApi = createApi({ accounts: dead.accounts, oauth: new OAuth({ db: dead.db, accounts: dead.accounts, config: dead.config, now: () => dead.clock.t }), config: dead.config });
    const other = http.createServer(async (req, res) => {
      if (!(await deadApi(req, res))) res.writeHead(404).end();
    });
    await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${other.address().port}/api/health`;
      assert.equal((await fetch(url)).status, 200);
      dead.db.close();
      const down = await fetch(url);
      assert.equal(down.status, 503);
      assert.deepEqual(await down.json(), { ok: false });
    } finally {
      other.close();
    }
  });

  it("registers, confirms with the code mailed, and signs in with an HttpOnly cookie", async () => {
    assert.deepEqual((await call("/api/me", { method: "GET" })).json, { user: null, signIns: [] });
    const registered = await call("/api/register", { body: { email: "Ada@Example.org", password: PASSWORD } });
    assert.equal(registered.status, 200);
    assert.equal(registered.headers.get("cache-control"), "no-store");
    const wrong = await call("/api/verify", { body: { email: "ada@example.org", code: "000000" } });
    assert.equal(wrong.status, 400);
    const verified = await call("/api/verify", { body: { email: "ada@example.org", code: lastCode(parts.mailer, "ada@example.org") } });
    assert.equal(verified.status, 200);
    assert.match(verified.set, /^zim=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    const me = await call("/api/me", { method: "GET" });
    assert.equal(me.json.user.email, "ada@example.org");
    assert.equal(JSON.stringify(me.json).includes("hash"), false);
  });

  it("signs out, and the old cookie is then worth nothing", async () => {
    const old = cookie;
    assert.equal((await call("/api/logout")).status, 200);
    assert.equal(cookie, "");
    assert.equal((await call("/api/me", { method: "GET", headers: { cookie: old } })).json.user, null);
    assert.equal((await call("/api/login", { body: { email: "ada@example.org", password: "wrong wrong wrong" } })).status, 401);
    assert.equal((await call("/api/login", { body: { email: "ada@example.org", password: PASSWORD } })).status, 200);
    assert.equal((await call("/api/me", { method: "GET" })).status, 200);
  });

  it("refuses a request that does not come from the site's own page", async () => {
    const body = { email: "x@example.org", password: PASSWORD };
    const noHeader = await call("/api/register", { body, headers: { "content-type": "application/json" } });
    assert.equal(noHeader.status, 403);
    const foreign = await call("/api/register", { body, headers: { ...HEADERS, origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    const crossSite = await call("/api/register", { body, headers: { ...HEADERS, "sec-fetch-site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    const own = await call("/api/resend", { body: { email: "x@example.org" }, headers: { ...HEADERS, origin: base } });
    assert.equal(own.status, 200);
  });

  it("refuses bodies that are not JSON, not an object, or too big", async () => {
    assert.equal((await call("/api/login", { body: "a=b", headers: { ...HEADERS, "content-type": "text/plain" } })).status, 415);
    assert.equal((await call("/api/login", { body: "[1]" })).status, 400);
    assert.equal((await call("/api/login", { body: "{oops" })).status, 400);
    const big = await call("/api/login", { body: JSON.stringify({ email: "a".repeat(20_000) }) }).catch((error) => ({ status: 413, error }));
    assert.equal(big.status, 413);
  });

  it("limits sign-in attempts and says when to come back", async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await call("/api/login", { body: { email: "limit@example.org", password: "nothing at all" }, useCookie: false });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get("retry-after")) > 0);
  });

  it("deletes the account only with the password", async () => {
    assert.equal((await call("/api/account/delete", { body: { password: "wrong wrong wrong" } })).status, 403);
    const exported = await call("/api/account/export", { method: "GET" });
    assert.equal(exported.json.email, "ada@example.org");
    assert.match(exported.headers.get("content-disposition"), /attachment/);
    assert.equal((await call("/api/account/delete", { body: { password: PASSWORD } })).status, 200);
    assert.equal((await call("/api/me", { method: "GET", useCookie: false })).json.user, null);
  });

  it("replaces the session that was held when signing in again, and does not delete an account for someone who is signed out", async () => {
    await call("/api/logout");
    await call("/api/register", { body: { email: "rot@example.org", password: PASSWORD }, useCookie: false });
    await call("/api/verify", { body: { email: "rot@example.org", code: lastCode(parts.mailer, "rot@example.org") }, useCookie: false });
    const first = cookie;
    assert.ok(first);
    await call("/api/login", { body: { email: "rot@example.org", password: PASSWORD } });
    assert.notEqual(cookie, first, "a new session");
    assert.equal((await call("/api/me", { method: "GET", headers: { cookie: first }, useCookie: false })).json.user, null, "the one that was held no longer works");
    const signedOut = await call("/api/account/delete", { body: { password: PASSWORD }, useCookie: false });
    assert.equal(signedOut.status, 401);
  });

  it("sends the person to the service and back, with a cookie that binds the browser", async () => {
    const start = await call("/api/oauth/github/start", { method: "GET", useCookie: false });
    assert.equal(start.status, 302);
    assert.match(start.headers.get("location"), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    assert.match(start.set, /^zim-oauth=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
    assert.equal((await call("/api/oauth/nowhere/start", { method: "GET" })).headers.get("location"), "/?account_error=no-provider");
    // (the state is right but the browser is not the one that started it: refused before anything is asked of the service)
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const other = await call(`/api/oauth/github/callback?code=x&state=${state}`, { method: "GET", useCookie: false });
    assert.match(other.headers.get("location"), /^\/\?account_error=/);
    assert.equal(other.set?.includes("zim="), false, "no session");
    const back = await call("/api/oauth/github/callback?code=x&state=bad", { method: "GET", useCookie: false });
    assert.equal(back.status, 302);
    assert.match(back.headers.get("location"), /^\/\?account_error=[a-z-]+$/);
  });
});
