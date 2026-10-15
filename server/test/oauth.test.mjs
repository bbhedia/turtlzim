import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { OAuth } from "../src/oauth.mjs";
import { make, refused } from "./helpers.mjs";

/** Google and GitHub, as far as the server asks them anything: what each is to answer is set by the test. */
function fakeServices() {
  const seen = [];
  const answers = {
    google: { token: { access_token: "google-token" }, userinfo: { sub: "g-1", email: "ada@example.org", email_verified: true } },
    github: { token: { access_token: "github-token" }, user: { id: 77 }, emails: [{ email: "ada@example.org", primary: true, verified: true }] },
    status: {},
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body: Object.fromEntries(new URLSearchParams(body)) });
      const [, service, what] = req.url.split("?")[0].split("/");
      const status = answers.status[`${service}/${what}`] ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof answers[service]?.[what] === "string" ? answers[service][what] : JSON.stringify(answers[service]?.[what] ?? {}));
    });
  });
  return { server, seen, answers };
}

describe("signing in with Google and GitHub", () => {
  const fake = fakeServices();
  let origin;
  before(async () => {
    await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${fake.server.address().port}`;
  });
  after(() => fake.server.close());

  const setup = (extra = {}) => {
    const parts = make();
    const providers = {
      google: { clientId: "google-id", clientSecret: "google-secret", endpoints: { authorize: `${origin}/google/authorize`, token: `${origin}/google/token`, userinfo: `${origin}/google/userinfo` } },
      github: { clientId: "github-id", clientSecret: "github-secret", endpoints: { authorize: `${origin}/github/authorize`, token: `${origin}/github/token`, user: `${origin}/github/user`, emails: `${origin}/github/emails` } },
    };
    const oauth = new OAuth({ db: parts.db, accounts: parts.accounts, config: { baseUrl: "https://notes.example.org", providers, ...extra }, now: () => parts.clock.t });
    fake.seen.length = 0;
    fake.answers.status = {};
    return { ...parts, oauth };
  };
  const begin = (oauth, provider) => {
    const { url, nonce } = oauth.start(provider);
    const params = new URL(url).searchParams;
    return { url, nonce, state: params.get("state"), params };
  };

  it("lists only the services that are set up", () => {
    const { oauth } = setup();
    assert.deepEqual(oauth.providers(), ["google", "github"]);
    assert.deepEqual(setup({ providers: { github: { clientId: "x", clientSecret: "y" } } }).oauth.providers(), ["github"]);
    assert.deepEqual(setup({ providers: {} }).oauth.providers(), []);
    assert.throws(() => setup({ providers: {} }).oauth.start("google"), (e) => e.status === 404);
    assert.throws(() => oauth.start("facebook"), (e) => e.status === 404);
  });

  it("sends the browser to the service with a state, a PKCE challenge, the address to come back to and the least that it asks for", () => {
    const { oauth } = setup();
    const google = begin(oauth, "google");
    assert.equal(google.url.startsWith(`${origin}/google/authorize?`), true);
    assert.equal(google.params.get("client_id"), "google-id");
    assert.equal(google.params.get("redirect_uri"), "https://notes.example.org/api/oauth/google/callback");
    assert.equal(google.params.get("response_type"), "code");
    assert.equal(google.params.get("scope"), "openid email profile");
    assert.equal(google.params.get("code_challenge_method"), "S256");
    assert.equal(google.params.get("client_secret"), null, "the secret never goes through the browser");
    assert.ok(google.state.length >= 30 && google.nonce.length >= 30);
    assert.notEqual(begin(oauth, "google").state, google.state);
    assert.equal(begin(oauth, "github").params.get("scope"), "read:user user:email");
  });

  it("signs in a person that Google vouches for: the code is traded with the secret and the verifier, only the address and the name are asked", async () => {
    const { oauth, accounts } = setup();
    const { state, nonce, params } = begin(oauth, "google");
    const user = await oauth.finish("google", { state, code: "the-code" }, nonce);
    assert.equal(user.email, "ada@example.org");
    assert.equal(accounts.identities(user.id)[0].provider, "google");
    const token = fake.seen.find((s) => s.url === "/google/token");
    assert.equal(token.method, "POST");
    assert.equal(token.type, "application/x-www-form-urlencoded");
    assert.deepEqual({ ...token.body, code_verifier: undefined }, { client_id: "google-id", client_secret: "google-secret", code: "the-code", redirect_uri: "https://notes.example.org/api/oauth/google/callback", grant_type: "authorization_code", code_verifier: undefined });
    assert.equal(createHash("sha256").update(token.body.code_verifier).digest("base64url"), params.get("code_challenge"), "the verifier is the one that the challenge was made from");
    const info = fake.seen.find((s) => s.url === "/google/userinfo");
    assert.equal(info.auth, "Bearer google-token");
    assert.equal(fake.seen.filter((s) => s.body.client_secret).length, 1, "the secret goes to the token address and nowhere else");
  });

  it("signs in a person that GitHub vouches for, with the primary address if it is confirmed, else one that is", async () => {
    const { oauth } = setup();
    fake.answers.github.emails = [{ email: "old@example.org", primary: false, verified: true }, { email: "Main@Example.org", primary: true, verified: true }, { email: "unconfirmed@example.org", primary: false, verified: false }];
    let flow = begin(oauth, "github");
    assert.equal((await oauth.finish("github", { state: flow.state, code: "c" }, flow.nonce)).email, "main@example.org");
    fake.answers.github.user = { id: 78 };
    fake.answers.github.emails = [{ email: "primary-unconfirmed@example.org", primary: true, verified: false }, { email: "second@example.org", primary: false, verified: true }];
    flow = begin(oauth, "github");
    assert.equal((await oauth.finish("github", { state: flow.state, code: "c" }, flow.nonce)).email, "second@example.org");
    fake.answers.github.user = { id: 79 };
    fake.answers.github.emails = [{ email: "nobody@example.org", primary: true, verified: false }];
    flow = begin(oauth, "github");
    assert.equal((await refused(oauth.finish("github", { state: flow.state, code: "c" }, flow.nonce))).code, "unverified-email");
    const calls = fake.seen.filter((s) => s.url === "/github/user");
    assert.ok(calls.every((c) => c.auth === "Bearer github-token"));
    fake.answers.github.user = { id: 77 };
    fake.answers.github.emails = [{ email: "ada@example.org", primary: true, verified: true }];
  });

  it("refuses an address that Google did not confirm", async () => {
    const { oauth, db } = setup();
    fake.answers.google.userinfo = { sub: "g-2", email: "liar@example.org", email_verified: false };
    const { state, nonce } = begin(oauth, "google");
    assert.equal((await refused(oauth.finish("google", { state, code: "c" }, nonce))).code, "unverified-email");
    assert.equal(db.prepare("select count(*) as n from users").get().n, 0);
    fake.answers.google.userinfo = { sub: "g-1", email: "ada@example.org", email_verified: true };
  });

  it("finishes only a sign-in that was begun here, in this browser, a short time ago, and once", async () => {
    const { oauth, clock } = setup();
    const a = begin(oauth, "google");
    assert.equal((await refused(oauth.finish("google", { state: a.state, code: "c" }, "someone else's nonce"))).code, "expired", "another browser");
    assert.equal((await refused(oauth.finish("google", { state: a.state, code: "c" }, a.nonce))).code, "expired", "and the state is used up by the try");
    const b = begin(oauth, "google");
    assert.equal((await refused(oauth.finish("google", { state: b.state, code: "c" }, undefined))).code, "expired", "no cookie");
    const c = begin(oauth, "google");
    assert.equal((await refused(oauth.finish("github", { state: c.state, code: "c" }, c.nonce))).code, "expired", "a state of the other service");
    const d = begin(oauth, "google");
    clock.t += 601;
    assert.equal((await refused(oauth.finish("google", { state: d.state, code: "c" }, d.nonce))).code, "expired", "too late");
    assert.equal((await refused(oauth.finish("google", { state: "made up", code: "c" }, "x"))).code, "expired");
    assert.equal((await refused(oauth.finish("google", {}, "x"))).code, "expired");
    const e = begin(oauth, "google");
    assert.equal((await oauth.finish("google", { state: e.state, code: "c" }, e.nonce)).email, "ada@example.org");
    assert.equal((await refused(oauth.finish("google", { state: e.state, code: "c" }, e.nonce))).code, "expired", "once");
  });

  it("says so when the person refuses, or the service does", async () => {
    const { oauth } = setup();
    let flow = begin(oauth, "github");
    assert.equal((await refused(oauth.finish("github", { state: flow.state, error: "access_denied" }, flow.nonce))).code, "cancelled");
    flow = begin(oauth, "github");
    assert.equal((await refused(oauth.finish("github", { state: flow.state }, flow.nonce))).code, "failed");
    flow = begin(oauth, "google");
    fake.answers.status["google/token"] = 400;
    assert.equal((await refused(oauth.finish("google", { state: flow.state, code: "bad" }, flow.nonce))).code, "failed");
    fake.answers.status = {};
    flow = begin(oauth, "google");
    fake.answers.google.token = { error: "invalid_grant" };
    const refusal = await refused(oauth.finish("google", { state: flow.state, code: "bad" }, flow.nonce));
    assert.equal(refusal.code, "failed");
    assert.match(refusal.message, /invalid_grant/);
    fake.answers.google.token = { access_token: "google-token" };
    flow = begin(oauth, "google");
    fake.answers.google.userinfo = "not json";
    assert.equal((await refused(oauth.finish("google", { state: flow.state, code: "c" }, flow.nonce))).code, "failed");
    fake.answers.google.userinfo = {};
    flow = begin(oauth, "google");
    assert.equal((await refused(oauth.finish("google", { state: flow.state, code: "c" }, flow.nonce))).code, "failed", "no name for the person");
    fake.answers.google.userinfo = { sub: "g-1", email: "ada@example.org", email_verified: true };
  });

  it("says so when the service can't be reached", async () => {
    const parts = setup();
    const down = new OAuth({ db: parts.db, accounts: parts.accounts, config: { baseUrl: "https://x.example", providers: { google: { clientId: "i", clientSecret: "s", endpoints: { token: "http://127.0.0.1:9/token" } } } }, now: () => parts.clock.t });
    const { url, nonce } = down.start("google");
    const refusal = await refused(down.finish("google", { state: new URL(url).searchParams.get("state"), code: "c" }, nonce));
    assert.deepEqual({ status: refusal.status, code: refusal.code }, { status: 502, code: "failed" });
  });

  it("slows down someone who tries many times", async () => {
    const { oauth } = setup();
    for (let i = 0; i < 30; i++) await refused(oauth.finish("google", { state: "x" }, "x", { ip: "6.6.6.6" }));
    assert.equal((await refused(oauth.finish("google", { state: "x" }, "x", { ip: "6.6.6.6" }))).status, 429);
  });

  it("gives an account that was begun with a password to the owner of the address who signs in with Google, and takes the password away", async () => {
    const { oauth, accounts } = setup();
    await accounts.register("ada@example.org", "the attacker's password");
    const { state, nonce } = begin(oauth, "google");
    const user = await oauth.finish("google", { state, code: "c" }, nonce);
    assert.equal(user.hasPassword, false);
    assert.equal((await refused(accounts.login("ada@example.org", "the attacker's password"))).code, "bad-login");
  });
});
