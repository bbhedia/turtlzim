import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword, normalizeEmail, passwordProblem, verifyPassword } from "../src/passwords.mjs";
import { openDatabase } from "../src/db.mjs";
import { hit } from "../src/limits.mjs";
import { PASSWORD, confirmed, lastCode, make, refused } from "./helpers.mjs";

describe("passwords and addresses", () => {
  it("keeps a password so that it can be checked and not read, with a salt for each", async () => {
    const a = await hashPassword("a long enough password");
    const b = await hashPassword("a long enough password");
    assert.match(a, /^scrypt\$32768\$8\$1\$/);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("a long enough password", a), true);
    assert.equal(await verifyPassword("a long enough passwore", a), false);
    assert.equal(await verifyPassword("anything", "garbage"), false);
    assert.equal(await verifyPassword("anything", null), false);
    assert.equal(await verifyPassword("é".normalize("NFD") + "xxxxxxxxxx", await hashPassword("é".normalize("NFC") + "xxxxxxxxxx")), true, "the same text in another form is the same password");
  });

  it("accepts addresses that are addresses and compares them without regard to case", () => {
    assert.equal(normalizeEmail("  Ada.Lovelace+zim@Example.ORG "), "ada.lovelace+zim@example.org");
    for (const bad of ["", "ada", "ada@", "@example.org", "ada@example", "a b@example.org", "ada@@example.org", "ada@example..org", "ada@.example.org", "a,b@example.org", "<ada@example.org>", "x".repeat(70) + "@example.org", null, 42]) assert.equal(normalizeEmail(bad), null, String(bad));
  });

  it("asks for length and nothing else, and refuses what everybody tries", () => {
    assert.equal(passwordProblem("short"), "The password needs at least 10 characters.");
    assert.equal(passwordProblem("x".repeat(201)), "The password can have at most 200 characters.");
    assert.match(passwordProblem("password123") ?? "", /too common/);
    assert.match(passwordProblem("aaaaaaaaaaaa") ?? "", /too common/);
    assert.match(passwordProblem("ada.lovelace is me", "ada.lovelace@example.org") ?? "", /e-mail address/);
    assert.equal(passwordProblem("correct horse battery"), null);
    assert.equal(passwordProblem("mot de passe très long"), null);
    assert.match(passwordProblem(undefined) ?? "", /Choose/);
  });

  it("counts tries in a window and says when the window is over", () => {
    const db = openDatabase(":memory:");
    assert.deepEqual([1, 2, 3].map((t) => hit(db, "k", 3, 100, 1000 + t).ok), [true, true, true]);
    const fourth = hit(db, "k", 3, 100, 1010);
    assert.equal(fourth.ok, false);
    assert.equal(fourth.retryAfter, 1001 + 100 - 1010, "the window began at the first try");
    assert.equal(hit(db, "other", 3, 100, 1010).ok, true);
    assert.equal(hit(db, "k", 3, 100, 1101).ok, true, "a new window");
  });
});

describe("signing up", () => {
  it("makes an account only when the code that was mailed is given, and then signs the person in", async () => {
    const parts = make();
    const { accounts, mailer } = parts;
    assert.deepEqual(await accounts.register("Ada@Example.org", PASSWORD), { ok: true });
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, "ada@example.org");
    assert.match(mailer.sent[0].text, /\b\d{6}\b/);
    // not confirmed: it can't be used yet
    assert.equal((await refused(accounts.login("ada@example.org", PASSWORD))).code, "unconfirmed");
    const user = accounts.verify("ada@example.org", lastCode(mailer, "ada@example.org"));
    assert.deepEqual({ email: user.email, quotaBytes: user.quotaBytes, hasPassword: user.hasPassword }, { email: "ada@example.org", quotaBytes: 1048576, hasPassword: true });
    assert.equal((await accounts.login("ADA@example.org", PASSWORD)).email, "ada@example.org");
  });

  it("refuses an address that is not one and a password that is too weak, before anything is sent", async () => {
    const { accounts, mailer } = make();
    assert.equal((await refused(accounts.register("not an address", PASSWORD))).code, "bad-email");
    assert.equal((await refused(accounts.register("ada@example.org", "short"))).code, "bad-password");
    assert.equal(mailer.sent.length, 0);
  });

  it("keeps the code for ten minutes, for five tries, and for one use", async () => {
    const { accounts, mailer, clock } = make();
    await accounts.register("ada@example.org", PASSWORD);
    const code = lastCode(mailer, "ada@example.org");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) assert.equal((await refused(() => accounts.verify("ada@example.org", wrong))).code, "wrong-code");
    // the fifth wrong try uses the code up, and the right one is refused too
    assert.equal((await refused(() => accounts.verify("ada@example.org", wrong))).code, "wrong-code");
    assert.equal((await refused(() => accounts.verify("ada@example.org", code))).code, "wrong-code", "a code that was guessed at five times is dead");
    // a new code, which expires
    clock.t += 120;
    await accounts.resend("ada@example.org");
    const second = lastCode(mailer, "ada@example.org");
    clock.t += 601;
    assert.equal((await refused(() => accounts.verify("ada@example.org", second))).code, "wrong-code", "after ten minutes");
    // and a code that is right works once
    clock.t += 120;
    await accounts.resend("ada@example.org");
    const third = lastCode(mailer, "ada@example.org");
    assert.equal(accounts.verify("ada@example.org", ` ${third.slice(0, 3)} ${third.slice(3)} `).email, "ada@example.org", "spaces in it do not matter");
    assert.equal((await refused(() => accounts.verify("ada@example.org", third))).code, "wrong-code");
  });

  it("does not send a second code within a minute, and sends one after", async () => {
    const { accounts, mailer, clock } = make();
    await accounts.register("ada@example.org", PASSWORD);
    await accounts.register("ada@example.org", PASSWORD);
    await accounts.resend("ada@example.org");
    assert.equal(mailer.sent.length, 1);
    clock.t += 61;
    await accounts.resend("ada@example.org");
    assert.equal(mailer.sent.length, 2);
    assert.notEqual(mailer.sent[0].text, mailer.sent[1].text);
  });

  it("answers the same for an address that has an account, and tells its owner by mail instead", async () => {
    const parts = make();
    await confirmed(parts);
    const before = parts.mailer.sent.length;
    assert.deepEqual(await parts.accounts.register("ada@example.org", "another good password"), { ok: true });
    assert.equal(parts.mailer.sent.length, before + 1);
    assert.match(parts.mailer.sent.at(-1).subject, /already have an account/);
    assert.doesNotMatch(parts.mailer.sent.at(-1).text, /\b\d{6}\b/, "no code, so no way in");
    // the password of the account is the one it had
    assert.equal((await parts.accounts.login("ada@example.org", PASSWORD)).email, "ada@example.org");
    assert.equal((await refused(parts.accounts.login("ada@example.org", "another good password"))).code, "bad-login");
    // and asking again at once does not mail again
    await parts.accounts.register("ada@example.org", "another good password");
    assert.equal(parts.mailer.sent.length, before + 1);
  });

  it("lets a second try at an unconfirmed address replace the password of the first", async () => {
    const parts = make();
    await parts.accounts.register("ada@example.org", "the first password!!");
    parts.clock.t += 61;
    await parts.accounts.register("ada@example.org", "the second password!");
    const code = lastCode(parts.mailer, "ada@example.org");
    parts.accounts.verify("ada@example.org", code);
    assert.equal((await refused(parts.accounts.login("ada@example.org", "the first password!!"))).code, "bad-login");
    assert.equal((await parts.accounts.login("ada@example.org", "the second password!")).email, "ada@example.org");
  });

  it("slows down someone who asks for many accounts or many codes", async () => {
    const { accounts } = make();
    for (let i = 0; i < 10; i++) await accounts.register(`user${i}@example.org`, PASSWORD, { ip: "1.2.3.4" });
    const refusal = await refused(accounts.register("user11@example.org", PASSWORD, { ip: "1.2.3.4" }));
    assert.equal(refusal.status, 429);
    assert.ok(refusal.retryAfter > 0);
    await accounts.register("user11@example.org", PASSWORD, { ip: "5.6.7.8" }); // another address is not held up
    for (let i = 0; i < 5; i++) await accounts.register("same@example.org", PASSWORD, { ip: `9.9.9.${i}` });
    assert.equal((await refused(accounts.register("same@example.org", PASSWORD, { ip: "9.9.9.9" }))).status, 429, "nor is the address that is being asked for");
  });
});

describe("signing in", () => {
  it("answers a wrong password and an unknown address in the same words", async () => {
    const parts = make();
    await confirmed(parts);
    const wrong = await refused(parts.accounts.login("ada@example.org", "not the password"));
    const unknown = await refused(parts.accounts.login("nobody@example.org", "not the password"));
    assert.deepEqual(wrong, unknown);
    assert.equal(wrong.status, 401);
    assert.equal((await refused(parts.accounts.login("", ""))).status, 401);
  });

  it("stops after ten wrong tries for an address, and after twenty from an address of the network", async () => {
    const parts = make();
    await confirmed(parts);
    for (let i = 0; i < 10; i++) await refused(parts.accounts.login("ada@example.org", "wrong wrong wrong", { ip: `10.0.0.${i}` }));
    assert.equal((await refused(parts.accounts.login("ada@example.org", PASSWORD, { ip: "10.0.1.1" }))).status, 429, "even the right password waits");
    parts.clock.t += 601;
    assert.equal((await parts.accounts.login("ada@example.org", PASSWORD, { ip: "10.0.1.1" })).email, "ada@example.org");
    for (let i = 0; i < 20; i++) await refused(parts.accounts.login(`n${i}@example.org`, "wrong wrong wrong", { ip: "7.7.7.7" }));
    assert.equal((await refused(parts.accounts.login("ada@example.org", PASSWORD, { ip: "7.7.7.7" }))).status, 429);
  });

  it("has sessions that are a token of which only a hash is kept, that last thirty days, and that can be ended", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const token = parts.accounts.createSession(user.id);
    assert.equal(parts.accounts.session(token)?.user.email, "ada@example.org");
    const stored = parts.db.prepare("select id from sessions").all();
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].id, token);
    assert.equal(stored[0].id.length, 64);
    assert.equal(parts.accounts.session("x".repeat(43)), null);
    assert.equal(parts.accounts.session(undefined), null);
    parts.clock.t += 29 * 86400;
    assert.ok(parts.accounts.session(token), "in use, it is made to last");
    parts.clock.t += 29 * 86400;
    assert.ok(parts.accounts.session(token));
    parts.clock.t += 31 * 86400;
    assert.equal(parts.accounts.session(token), null, "not used for thirty days");
    const another = parts.accounts.createSession(user.id);
    parts.accounts.destroySession(another);
    assert.equal(parts.accounts.session(another), null);
  });
});

describe("a forgotten password", () => {
  it("is changed with a code that was mailed, which ends every session", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const token = parts.accounts.createSession(user.id);
    parts.clock.t += 61;
    assert.deepEqual(await parts.accounts.requestReset("ada@example.org"), { ok: true });
    const code = lastCode(parts.mailer, "ada@example.org");
    assert.match(parts.mailer.sent.at(-1).subject, /password reset/);
    assert.equal((await refused(parts.accounts.reset("ada@example.org", code, "short"))).code, "bad-password");
    assert.deepEqual(await parts.accounts.reset("ada@example.org", code, "a brand new password"), { ok: true });
    assert.equal(parts.accounts.session(token), null);
    assert.equal((await refused(parts.accounts.login("ada@example.org", PASSWORD))).code, "bad-login");
    assert.equal((await parts.accounts.login("ada@example.org", "a brand new password")).email, "ada@example.org");
    assert.equal((await refused(parts.accounts.reset("ada@example.org", code, "yet another password"))).code, "wrong-code", "the code was used");
  });

  it("says nothing about whether an address has an account, and sends nothing to one that has not", async () => {
    const parts = make();
    assert.deepEqual(await parts.accounts.requestReset("nobody@example.org"), { ok: true });
    assert.equal(parts.mailer.sent.length, 0);
    await parts.accounts.register("pending@example.org", PASSWORD);
    const before = parts.mailer.sent.length;
    parts.clock.t += 61;
    await parts.accounts.requestReset("pending@example.org");
    assert.equal(parts.mailer.sent.length, before, "an account that was never confirmed has nothing to reset");
  });

  it("is changed from inside by someone who knows it, and the other sessions end", async () => {
    const parts = make();
    const user = await confirmed(parts);
    const mine = parts.accounts.createSession(user.id);
    const other = parts.accounts.createSession(user.id);
    assert.equal((await refused(parts.accounts.changePassword(user.id, "wrong wrong wrong", "a brand new password", mine))).code, "bad-login");
    await parts.accounts.changePassword(user.id, PASSWORD, "a brand new password", mine);
    assert.ok(parts.accounts.session(mine));
    assert.equal(parts.accounts.session(other), null);
    assert.equal((await parts.accounts.login("ada@example.org", "a brand new password")).email, "ada@example.org");
  });
});

describe("Google and GitHub", () => {
  it("makes an account of an address that the service has confirmed, without a password, and finds it again by the service's name for the person", async () => {
    const parts = make();
    const user = parts.accounts.signInWithIdentity("google", "g-1", "Ada@Example.org", true);
    assert.deepEqual({ email: user.email, hasPassword: user.hasPassword }, { email: "ada@example.org", hasPassword: false });
    // the address changed at Google: it is the same person
    assert.equal(parts.accounts.signInWithIdentity("google", "g-1", "renamed@example.org", true).id, user.id);
    // no password to sign in with
    assert.equal((await refused(parts.accounts.login("ada@example.org", "anything at all"))).status, 401);
    assert.deepEqual(parts.accounts.identities(user.id).map((i) => i.provider), ["google"]);
  });

  it("joins the service to the account that has the same confirmed address, and keeps its password", async () => {
    const parts = make();
    const mine = await confirmed(parts);
    const user = parts.accounts.signInWithIdentity("github", "gh-9", "ada@example.org", true);
    assert.equal(user.id, mine.id);
    assert.equal(user.hasPassword, true);
    assert.equal((await parts.accounts.login("ada@example.org", PASSWORD)).id, mine.id);
    parts.accounts.signInWithIdentity("google", "g-1", "ada@example.org", true);
    assert.deepEqual(parts.accounts.identities(mine.id).map((i) => i.provider).sort(), ["github", "google"]);
  });

  it("refuses an address that the service did not confirm, or none", () => {
    const { accounts } = make();
    for (const [email, verified] of [["ada@example.org", false], [undefined, true], ["", true], ["garbage", true]]) {
      assert.throws(() => accounts.signInWithIdentity("github", "gh-1", email, verified), (e) => e.extra.code === "unverified-email");
    }
  });

  it("takes an account that was begun with a password and never confirmed away from whoever began it, when the owner of the address signs in with a service", async () => {
    const parts = make();
    await parts.accounts.register("victim@example.org", "the attacker's password");
    const owner = parts.accounts.signInWithIdentity("google", "g-victim", "victim@example.org", true);
    assert.equal(owner.hasPassword, false);
    assert.equal((await refused(parts.accounts.login("victim@example.org", "the attacker's password"))).code, "bad-login");
    // the code that the attacker's attempt mailed is no good either
    assert.equal((await refused(() => parts.accounts.verify("victim@example.org", lastCode(parts.mailer, "victim@example.org")))).code, "wrong-code");
  });
});

describe("the account's own data", () => {
  it("is exported, and deleted with everything that belongs to it, on the password or on a recent sign-in", async () => {
    const parts = make();
    const user = await confirmed(parts);
    parts.accounts.signInWithIdentity("github", "gh-9", "ada@example.org", true);
    const token = parts.accounts.createSession(user.id);
    const data = parts.accounts.exportData(user.id);
    assert.deepEqual({ email: data.email, hasPassword: data.hasPassword, signIns: data.signIns.map((s) => s.provider), sessions: data.sessions }, { email: "ada@example.org", hasPassword: true, signIns: ["github"], sessions: 1 });
    assert.equal((await refused(parts.accounts.deleteAccount(user.id, "wrong wrong wrong", 0))).code, "bad-login");
    assert.deepEqual(await parts.accounts.deleteAccount(user.id, PASSWORD, 0), { ok: true });
    assert.equal(parts.accounts.session(token), null);
    for (const table of ["users", "sessions", "identities", "codes"]) assert.equal(parts.db.prepare(`select count(*) as n from ${table}`).get().n, 0, table);
    // an account with no password: a sign-in of the last ten minutes
    const social = parts.accounts.signInWithIdentity("google", "g-2", "grace@example.org", true);
    assert.equal((await refused(parts.accounts.deleteAccount(social.id, "", parts.clock.t - 601))).code, "recent-login");
    assert.deepEqual(await parts.accounts.deleteAccount(social.id, "", parts.clock.t - 60), { ok: true });
  });

  it("clears away what is over, and only that", async () => {
    const parts = make();
    const user = await confirmed(parts);
    await parts.accounts.register("never@example.org", PASSWORD);
    const token = parts.accounts.createSession(user.id);
    parts.clock.t += 3 * 86400;
    const cleared = parts.accounts.purge();
    assert.equal(cleared.unconfirmed, 1);
    assert.equal(parts.accounts.session(token)?.user.email, "ada@example.org");
    assert.ok(parts.accounts.userByEmail("ada@example.org"));
    assert.equal(parts.accounts.userByEmail("never@example.org"), undefined);
    parts.clock.t += 31 * 86400;
    assert.equal(parts.accounts.purge().sessions, 1);
  });
});
