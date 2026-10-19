import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { ANDROID_REDIRECT, Apps, CLIENT_LABELS, clientOf, CODE_SECONDS } from "../src/apps.mjs";
import { createApi } from "../src/api.mjs";
import { OAuth } from "../src/oauth.mjs";
import { confirmed, lastCode, make, PASSWORD, refused } from "./helpers.mjs";

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(16).toString("base64url") };
};
const LOOPBACK = "http://127.0.0.1:49152/callback";
const request = (redirect_uri, p) => ({ redirect_uri, code_challenge: p.challenge, code_challenge_method: "S256", state: p.state });
const codeOf = (redirect) => new URL(redirect).searchParams.get("code");

describe("the return addresses of the apps", () => {
  it("are the program's own port on the computer's own address, and the Android app's own scheme: nothing else", () => {
    assert.equal(clientOf(LOOPBACK), "desktop");
    assert.equal(clientOf("http://127.0.0.1:1024/callback"), "desktop");
    assert.equal(clientOf("http://127.0.0.1:65535/callback"), "desktop");
    assert.equal(clientOf(ANDROID_REDIRECT), "android");
    for (const bad of [
      "http://127.0.0.1:80/callback",
      "http://127.0.0.1:1023/callback",
      "http://127.0.0.1:65536/callback",
      "http://127.0.0.1:99999/callback",
      "http://127.0.0.1:01234/callback",
      "http://127.0.0.1/callback",
      "http://localhost:49152/callback",
      "http://[::1]:49152/callback",
      "http://127.0.0.2:49152/callback",
      "https://127.0.0.1:49152/callback",
      "http://127.0.0.1:49152/callback?x=1",
      "http://127.0.0.1:49152/callback#x",
      "http://127.0.0.1:49152/callback/",
      "http://127.0.0.1:49152/other",
      "http://127.0.0.1:49152@evil.example/callback",
      "http://127.0.0.1.evil.example:49152/callback",
      "http://evil.example:49152/callback",
      "https://evil.example/callback",
      "org.zimnotebook.app:/callback?x=1",
      "org.zimnotebook.app://callback",
      "org.zimnotebook.app:/other",
      "org.zimnotebook.other:/callback",
      "javascript:alert(1)",
      "",
      undefined,
      null,
      42,
      { toString: () => LOOPBACK },
      `${LOOPBACK}${"a".repeat(80)}`,
    ]) {
      assert.equal(clientOf(bad), null, String(bad));
    }
  });
});

describe("signing an app in", () => {
  it("gives a token for a code, the secret that its challenge was made from and the same return address, and keeps only hashes", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const apps = new Apps({ accounts: parts.accounts });
    const p = pkce();
    const asked = apps.authorize(user.id, request(LOOPBACK, p));
    assert.equal(asked.client, "desktop");
    assert.equal(asked.label, CLIENT_LABELS.desktop);
    const back = new URL(asked.redirect);
    assert.equal(`${back.origin}${back.pathname}`, LOOPBACK);
    assert.equal(back.searchParams.get("state"), p.state, "the app's own state comes back with the code");
    const code = codeOf(asked.redirect);
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(parts.db.prepare("select count(*) as n from app_codes where hash = ?").get(code).n, 0, "the code itself is not kept");
    assert.equal(parts.db.prepare("select count(*) as n from app_codes where hash = ?").get(createHash("sha256").update(code).digest("hex")).n, 1, "its hash is");

    const given = apps.redeem({ code, code_verifier: p.verifier, redirect_uri: LOOPBACK });
    assert.equal(given.user.email, "ada@example.org");
    assert.equal(given.label, CLIENT_LABELS.desktop);
    const session = parts.accounts.session(given.token);
    assert.equal(session?.kind, "app");
    assert.equal(session?.label, CLIENT_LABELS.desktop);
    assert.equal(session?.user.email, "ada@example.org");
    const row = parts.db.prepare("select id, kind, public_id from sessions where kind = 'app'").get();
    assert.notEqual(row.id, given.token);
    assert.equal(row.id.length, 64, "only the token's hash is kept");
    assert.match(row.public_id, /^[0-9a-f]{16}$/);
    assert.notEqual(row.public_id, row.id.slice(0, 16), "and the id that can be shown says nothing of it");
    assert.equal(parts.db.prepare("select count(*) as n from app_codes").get().n, 0, "the code is used up");
  });

  it("asks for the Android app's address the same way", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const apps = new Apps({ accounts: parts.accounts });
    const p = pkce();
    const asked = apps.authorize(user.id, request(ANDROID_REDIRECT, p));
    assert.equal(asked.client, "android");
    assert.ok(asked.redirect.startsWith(`${ANDROID_REDIRECT}?code=`));
    const given = apps.redeem({ code: codeOf(asked.redirect), code_verifier: p.verifier, redirect_uri: ANDROID_REDIRECT });
    assert.equal(parts.accounts.session(given.token)?.label, CLIENT_LABELS.android);
  });

  it("refuses a request that is not valid, before a code is made", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const apps = new Apps({ accounts: parts.accounts });
    const p = pkce();
    const ok = request(LOOPBACK, p);
    const codes = () => parts.db.prepare("select count(*) as n from app_codes").get().n;
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, redirect_uri: "https://evil.example/callback" }))).code, "bad-redirect");
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, redirect_uri: undefined }))).code, "bad-redirect");
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, code_challenge_method: "plain" }))).code, "bad-request", "the challenge has to be a hash");
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, code_challenge_method: undefined }))).code, "bad-request");
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, code_challenge: p.verifier + "x" }))).code, "bad-request");
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, code_challenge: "short" }))).code, "bad-request");
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, code_challenge: undefined }))).code, "bad-request");
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, state: "short" }))).code, "bad-request");
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, state: "a".repeat(16) + "&code=evil" }))).code, "bad-request", "what is put in the address is not free text");
    assert.equal((await refused(() => apps.authorize(user.id, { ...ok, state: undefined }))).code, "bad-request");
    assert.equal((await refused(() => apps.authorize(user.id, undefined))).code, "bad-redirect");
    assert.equal(codes(), 0);
  });

  it("uses a code up with the first try, whoever makes it, and refuses all that does not go together", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const apps = new Apps({ accounts: parts.accounts });
    const sessions = () => parts.db.prepare("select count(*) as n from sessions where kind = 'app'").get().n;
    const fresh = () => {
      const p = pkce();
      return { p, code: codeOf(apps.authorize(user.id, request(LOOPBACK, p)).redirect) };
    };
    // a wrong secret: refused, and the code is gone, so the right one cannot be tried after it (a code can't be guessed at)
    let { p, code } = fresh();
    assert.equal((await refused(() => apps.redeem({ code, code_verifier: pkce().verifier, redirect_uri: LOOPBACK }))).code, "bad-grant");
    assert.equal((await refused(() => apps.redeem({ code, code_verifier: p.verifier, redirect_uri: LOOPBACK }))).code, "bad-grant");
    // another return address than the one it was made for
    ({ p, code } = fresh());
    assert.equal((await refused(() => apps.redeem({ code, code_verifier: p.verifier, redirect_uri: "http://127.0.0.1:49153/callback" }))).code, "bad-grant");
    assert.equal((await refused(() => apps.redeem({ code, code_verifier: p.verifier, redirect_uri: LOOPBACK }))).code, "bad-grant", "used up");
    // too late
    ({ p, code } = fresh());
    parts.clock.t += CODE_SECONDS + 1;
    assert.equal((await refused(() => apps.redeem({ code, code_verifier: p.verifier, redirect_uri: LOOPBACK }))).code, "bad-grant");
    // not a code, not a secret
    ({ p, code } = fresh());
    for (const body of [
      { code: "x".repeat(43), code_verifier: p.verifier, redirect_uri: LOOPBACK },
      { code: undefined, code_verifier: p.verifier, redirect_uri: LOOPBACK },
      { code, code_verifier: "short", redirect_uri: LOOPBACK },
      { code, code_verifier: undefined, redirect_uri: LOOPBACK },
      { code, code_verifier: p.verifier, redirect_uri: undefined },
      { code: [code], code_verifier: p.verifier, redirect_uri: LOOPBACK },
      undefined,
    ]) {
      assert.equal((await refused(() => apps.redeem(body))).code, "bad-grant", JSON.stringify(body));
    }
    assert.equal(sessions(), 0, "no token was given for any of it");
    // and a code that is tried twice, the second time right, gives one token only to the one that was first
    const twice = fresh();
    const first = apps.redeem({ code: twice.code, code_verifier: twice.p.verifier, redirect_uri: LOOPBACK });
    assert.ok(first.token);
    assert.equal((await refused(() => apps.redeem({ code: twice.code, code_verifier: twice.p.verifier, redirect_uri: LOOPBACK }))).code, "bad-grant");
    assert.equal(sessions(), 1);
  });

  it("does not give a token to an account that was disabled or deleted in the meantime", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const apps = new Apps({ accounts: parts.accounts });
    let p = pkce();
    let code = codeOf(apps.authorize(user.id, request(LOOPBACK, p)).redirect);
    parts.db.prepare("update users set disabled = 1 where id = ?").run(user.id);
    assert.equal((await refused(() => apps.redeem({ code, code_verifier: p.verifier, redirect_uri: LOOPBACK }))).code, "bad-grant");
    parts.db.prepare("update users set disabled = 0 where id = ?").run(user.id);
    p = pkce();
    code = codeOf(apps.authorize(user.id, request(LOOPBACK, p)).redirect);
    parts.db.prepare("delete from users where id = ?").run(user.id);
    assert.equal(parts.db.prepare("select count(*) as n from app_codes").get().n, 0, "the codes of a deleted account go with it");
    assert.equal((await refused(() => apps.redeem({ code, code_verifier: p.verifier, redirect_uri: LOOPBACK }))).code, "bad-grant");
  });

  it("limits what a program that keeps trying can do, and what one account can ask", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const apps = new Apps({ accounts: parts.accounts });
    let last;
    for (let i = 0; i < 31; i++) last = await refused(() => apps.redeem({ code: "x".repeat(43), code_verifier: "y".repeat(43), redirect_uri: LOOPBACK }, { ip: "9.9.9.9" }));
    assert.equal(last.status, 429);
    assert.ok(last.retryAfter > 0);
    assert.equal((await refused(() => apps.redeem({}, { ip: "9.9.9.9" }))).status, 429, "from that address");
    assert.equal((await refused(() => apps.redeem({}, { ip: "9.9.9.8" }))).code, "bad-grant", "and not from another");
    for (let i = 0; i < 20; i++) apps.authorize(user.id, request(LOOPBACK, pkce()));
    assert.equal((await refused(() => apps.authorize(user.id, request(LOOPBACK, pkce())))).status, 429);
  });

  it("makes an app's session last six months without use, and a browser's thirty days, and clears away the codes that are over", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const apps = new Apps({ accounts: parts.accounts });
    const p = pkce();
    const { token } = apps.redeem({ code: codeOf(apps.authorize(user.id, request(LOOPBACK, p)).redirect), code_verifier: p.verifier, redirect_uri: LOOPBACK });
    const browser = parts.accounts.createSession(user.id);
    parts.clock.t += 100 * 86400;
    assert.ok(parts.accounts.session(token), "a hundred days without being used: still there");
    assert.equal(parts.accounts.session(browser), null, "a browser's session is over after thirty");
    for (let i = 0; i < 6; i++) {
      parts.clock.t += 29 * 86400;
      assert.ok(parts.accounts.session(token), `still there after ${100 + (i + 1) * 29} days of being used now and then`);
    }
    parts.clock.t += 181 * 86400;
    assert.equal(parts.accounts.session(token), null, "not used for 181 days");
    apps.authorize(user.id, request(LOOPBACK, pkce()));
    parts.clock.t += CODE_SECONDS + 1;
    apps.authorize(user.id, request(LOOPBACK, pkce()));
    assert.equal(parts.db.prepare("select count(*) as n from app_codes").get().n, 1, "asking again clears the account's codes that are over");
    parts.clock.t += CODE_SECONDS + 1;
    assert.equal(parts.accounts.purge().appCodes, 1);
    assert.equal(parts.db.prepare("select count(*) as n from app_codes").get().n, 0);
  });

  it("lists what is connected, ends one app and no one else's, and ends them all with a new password", async () => {
    const parts = make();
    const ada = await confirmed(parts);
    const bob = await confirmed(parts, "bob@example.org");
    const apps = new Apps({ accounts: parts.accounts });
    const connect = (user, redirect) => {
      const p = pkce();
      return apps.redeem({ code: codeOf(apps.authorize(user.id, request(redirect, p)).redirect), code_verifier: p.verifier, redirect_uri: redirect }).token;
    };
    const laptop = connect(ada, LOOPBACK);
    parts.clock.t += 60;
    const phone = connect(ada, ANDROID_REDIRECT);
    const bobs = connect(bob, LOOPBACK);
    parts.accounts.createSession(ada.id);
    const listed = apps.list(ada.id);
    assert.deepEqual(listed.map((a) => a.label), [CLIENT_LABELS.android, CLIENT_LABELS.desktop], "the apps, newest first, and not the browser");
    assert.deepEqual(Object.keys(listed[0]).sort(), ["connectedAt", "id", "label", "lastUsed"]);
    assert.equal(JSON.stringify(listed).includes(phone), false);
    assert.equal((await refused(() => apps.revoke(bob.id, listed[0].id))).status, 404, "another account's app can't be ended");
    assert.ok(parts.accounts.session(phone));
    assert.equal((await refused(() => apps.revoke(ada.id, "not an id"))).code, "no-such-app");
    assert.deepEqual(apps.revoke(ada.id, listed[0].id), { ok: true });
    assert.equal(parts.accounts.session(phone), null, "ended");
    assert.ok(parts.accounts.session(laptop));
    assert.equal((await refused(() => apps.revoke(ada.id, listed[0].id))).status, 404, "and only once");
    // a new password ends the other sessions, the apps with them
    await parts.accounts.changePassword(ada.id, PASSWORD, "another long password", undefined);
    assert.equal(parts.accounts.session(laptop), null);
    assert.ok(parts.accounts.session(bobs));
  });
});

describe("sessions", () => {
  it("say when they began (not when the account did), and of what kind they are", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const accountBegan = parts.clock.t;
    parts.clock.t += 5000;
    const token = parts.accounts.createSession(user.id);
    const found = parts.accounts.session(token);
    assert.equal(found?.createdAt, parts.clock.t, "the session's date");
    assert.notEqual(found?.createdAt, accountBegan);
    assert.equal(found?.kind, "browser");
    assert.equal(found?.label, null);
    assert.equal(found?.publicId, null);
    assert.equal(found?.user.createdAt, accountBegan, "the account's stays the account's");
  });

  it("let someone who signed in with a service delete the account soon after, however old the account is", async () => {
    const parts = make();
    const social = parts.accounts.signInWithIdentity("github", "42", "grace@example.org", true);
    parts.clock.t += 30 * 86400;
    const token = parts.accounts.createSession(social.id);
    const found = parts.accounts.session(token);
    assert.deepEqual(await parts.accounts.deleteAccount(social.id, "", found.createdAt), { ok: true });
  });
});

describe("an app's token over HTTP", () => {
  let server, base, parts;
  before(async () => {
    parts = make({ baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {} });
    const oauth = new OAuth({ db: parts.db, accounts: parts.accounts, config: parts.config, now: () => parts.clock.t });
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

  const SITE = { "content-type": "application/json", "x-requested-with": "zim" };
  const call = async (path, { method = "POST", body, headers = SITE, cookie, bearer } = {}) => {
    const response = await fetch(base + path, { method, redirect: "manual", headers: { ...headers, ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await response.text();
    const set = response.headers.get("set-cookie");
    return { status: response.status, headers: response.headers, set, cookie: set ? set.split(";")[0] : undefined, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  };
  const signIn = async (email) => {
    await call("/api/register", { body: { email, password: PASSWORD } });
    return (await call("/api/verify", { body: { email, code: lastCode(parts.mailer, email) } })).cookie;
  };
  const connect = async (cookie, redirect = LOOPBACK) => {
    const p = pkce();
    const asked = await call("/api/app/authorize", { cookie, body: request(redirect, p) });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    const given = await call("/api/app/token", { body: { code: codeOf(asked.json.redirect), code_verifier: p.verifier, redirect_uri: redirect } });
    assert.equal(given.status, 200, JSON.stringify(given.json));
    return { token: given.json.token, given, asked };
  };

  it("is made in a browser that is signed in, carried back to the app, and traded for a token that works without a cookie", async () => {
    const cookie = await signIn("ada@example.org");
    const { token, asked, given } = await connect(cookie);
    assert.equal(asked.json.client, "desktop");
    assert.equal(asked.headers.get("cache-control"), "no-store");
    assert.equal(given.headers.get("cache-control"), "no-store");
    assert.equal(given.set, null, "no cookie is set for an app");
    assert.equal(given.json.user.email, "ada@example.org");
    const me = await call("/api/me", { method: "GET", bearer: token, headers: {} });
    assert.equal(me.json.user.email, "ada@example.org");
    assert.equal(JSON.stringify(me.json).includes("hash"), false);
    // what an app does with it: keep notebooks, with the same header that the site's own page sends
    const put = await call("/api/sync/notebooks/notebook-1", { method: "PUT", bearer: token, body: { title: "From the app", baseRevision: 0, files: [{ path: "Home.txt", base64: Buffer.from("Hello").toString("base64") }] } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const listed = await call("/api/sync/notebooks", { method: "GET", bearer: token, headers: {} });
    assert.deepEqual(listed.json.notebooks.map((n) => n.title), ["From the app"]);
    // and the browser sees the same notebooks: it is the same account
    const fromBrowser = await call("/api/sync/notebooks", { method: "GET", cookie, headers: {} });
    assert.deepEqual(fromBrowser.json.notebooks.map((n) => n.title), ["From the app"]);
  });

  it("needs the site's header for a change, like a browser, and an origin that is the site's if there is one", async () => {
    const cookie = await signIn("ben@example.org");
    const { token } = await connect(cookie);
    const body = { title: "x", baseRevision: 0, files: [] };
    assert.equal((await call("/api/sync/notebooks/notebook-2", { method: "PUT", bearer: token, body, headers: { "content-type": "application/json" } })).status, 403);
    assert.equal((await call("/api/sync/notebooks/notebook-2", { method: "PUT", bearer: token, body, headers: { ...SITE, origin: "https://evil.example" } })).status, 403);
    assert.equal((await call("/api/sync/notebooks/notebook-2", { method: "PUT", bearer: token, body, headers: { ...SITE, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await call("/api/sync/notebooks/notebook-2", { method: "PUT", bearer: token, body })).status, 200);
  });

  it("is no one's when it is not a token of the kind that the way it came is for", async () => {
    const cookie = await signIn("cat@example.org");
    const { token } = await connect(cookie);
    const browserToken = cookie.split("=")[1];
    // an app's token as a cookie, and a browser's session as a bearer token
    assert.equal((await call("/api/me", { method: "GET", headers: {}, cookie: `zim=${token}` })).json.user, null);
    assert.equal((await call("/api/me", { method: "GET", headers: {}, bearer: browserToken })).json.user, null);
    // a bearer token decides alone: a wrong one is no one, whatever cookie comes with it
    assert.equal((await call("/api/me", { method: "GET", headers: {}, cookie, bearer: "x".repeat(43) })).json.user, null);
    assert.equal((await call("/api/me", { method: "GET", headers: {}, cookie, bearer: token })).json.user.email, "cat@example.org");
    // another kind of authorization is not ours (a proxy may ask for its own on every request): the cookie is used as before
    assert.equal((await call("/api/me", { method: "GET", headers: { authorization: "Basic dXNlcjpwYXNz" }, cookie })).json.user.email, "cat@example.org");
    assert.equal((await call("/api/me", { method: "GET", headers: { authorization: "Bearer" }, cookie })).json.user.email, "cat@example.org", "an empty one is not a token");
    assert.equal((await call("/api/me", { method: "GET", headers: { authorization: `bearer ${token}` } })).json.user.email, "cat@example.org", "the scheme's name is not case sensitive");
  });

  it("can't make another token, change the password, delete the account or take the data away: that is for a browser", async () => {
    const cookie = await signIn("dan@example.org");
    const { token } = await connect(cookie);
    const p = pkce();
    const attempts = [
      ["/api/app/authorize", "POST", request(LOOPBACK, p)],
      ["/api/app/revoke", "POST", { id: "0123456789abcdef" }],
      ["/api/app/sessions", "GET"],
      ["/api/account/export", "GET"],
      ["/api/password/change", "POST", { current: PASSWORD, next: "another long password" }],
      ["/api/account/delete", "POST", { password: PASSWORD }],
    ];
    for (const [path, method, body] of attempts) {
      const answer = await call(path, { method, bearer: token, body, ...(method === "GET" ? { headers: {} } : {}) });
      assert.equal(answer.status, 403, path);
      assert.equal(answer.json.code, "browser-only", path);
    }
    // nothing was done: the password is the old one, the account is there, and no second token was made
    assert.equal((await call("/api/login", { body: { email: "dan@example.org", password: PASSWORD } })).status, 200);
    assert.equal(parts.db.prepare("select count(*) as n from sessions where kind = 'app' and user_id = (select id from users where email = 'dan@example.org')").get().n, 1);
    // signed out, the same routes say so
    for (const [path, method, body] of attempts) assert.equal((await call(path, { method, body, ...(method === "GET" ? { headers: {} } : {}) })).status, 401, path);
  });

  it("is listed in the browser, and ended from there", async () => {
    const cookie = await signIn("eve@example.org");
    const first = await connect(cookie);
    const second = await connect(cookie, ANDROID_REDIRECT);
    const listed = await call("/api/app/sessions", { method: "GET", headers: {}, cookie });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.apps.map((a) => a.label).sort(), [CLIENT_LABELS.android, CLIENT_LABELS.desktop]);
    assert.equal(JSON.stringify(listed.json).includes(first.token) || JSON.stringify(listed.json).includes(second.token), false);
    const target = listed.json.apps.find((a) => a.label === CLIENT_LABELS.desktop);
    assert.equal((await call("/api/app/revoke", { cookie, body: { id: target.id } })).status, 200);
    assert.equal((await call("/api/me", { method: "GET", headers: {}, bearer: first.token })).json.user, null, "signed out, the next time it asks (and told the way a browser is: 200, nobody)");
    assert.equal((await call("/api/me", { method: "GET", headers: {}, bearer: second.token })).json.user.email, "eve@example.org");
    assert.equal((await call("/api/app/revoke", { cookie, body: { id: target.id } })).status, 404);
    assert.equal((await call("/api/app/revoke", { cookie, body: {}, headers: { "content-type": "application/json" } })).status, 403, "and it is a change: it has to come from the site's page");
    assert.equal((await call("/api/sync/notebooks", { method: "GET", headers: {}, bearer: first.token })).status, 401, "what it did before is refused now");
  });

  it("ends itself when the app signs out, and does not touch the browser's session", async () => {
    const cookie = await signIn("fay@example.org");
    const { token } = await connect(cookie);
    const out = await call("/api/logout", { bearer: token });
    assert.equal(out.status, 200);
    assert.equal(out.set, null, "no cookie to clear");
    assert.equal((await call("/api/me", { method: "GET", headers: {}, bearer: token })).json.user, null);
    assert.equal((await call("/api/me", { method: "GET", headers: {}, cookie })).json.user.email, "fay@example.org", "the browser is still signed in");
    // a bearer token that is no one's ends nothing, and a browser's session sent as one is not ended by it
    const browserToken = cookie.split("=")[1];
    assert.equal((await call("/api/logout", { bearer: browserToken })).status, 200);
    assert.equal((await call("/api/me", { method: "GET", headers: {}, cookie })).json.user.email, "fay@example.org");
  });

  it("is ended by a new password, from the browser that changed it", async () => {
    const cookie = await signIn("gus@example.org");
    const { token } = await connect(cookie);
    assert.equal((await call("/api/password/change", { cookie, body: { current: PASSWORD, next: "another long password" } })).status, 200);
    assert.equal((await call("/api/me", { method: "GET", headers: {}, bearer: token })).json.user, null);
    assert.equal((await call("/api/me", { method: "GET", headers: {}, cookie })).json.user.email, "gus@example.org");
  });

  it("is refused for what is not valid, with words that are written for a person", async () => {
    const cookie = await signIn("hal@example.org");
    const p = pkce();
    const bad = await call("/api/app/authorize", { cookie, body: request("https://evil.example/callback", p) });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, "bad-redirect");
    assert.match(bad.json.error, /return address/);
    assert.equal((await call("/api/app/authorize", { cookie, body: request(LOOPBACK, p), headers: { "content-type": "application/json" } })).status, 403, "from the site's page only");
    assert.equal((await call("/api/app/authorize", { cookie, body: request(LOOPBACK, p), headers: { ...SITE, origin: "https://evil.example" } })).status, 403);
    const wrong = await call("/api/app/token", { body: { code: "x".repeat(43), code_verifier: p.verifier, redirect_uri: LOOPBACK } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.code, "bad-grant");
    assert.equal((await call("/api/app/token", { body: {}, headers: { "content-type": "application/json" } })).status, 403, "the token request carries the site's header too");
    assert.equal((await call("/api/app/token", { method: "GET", headers: {} })).status, 404);
  });

  it("counts the tries to trade a code for each address that they come from", async () => {
    parts.config.trustProxy = true;
    try {
      const bad = (ip) => call("/api/app/token", { body: {}, headers: { ...SITE, "x-forwarded-for": ip } });
      let last;
      for (let i = 0; i < 31; i++) last = await bad("10.1.1.1");
      assert.equal(last.status, 429);
      assert.ok(Number(last.headers.get("retry-after")) > 0);
      assert.equal((await bad("10.1.1.2")).status, 400, "another address is not held back by it");
    } finally {
      parts.config.trustProxy = false;
    }
  });
});
