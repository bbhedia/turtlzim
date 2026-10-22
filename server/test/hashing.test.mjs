// How many passwords are hashed at the same time (src/passwords.mjs): at most the number of places, the next ones wait their turn in order, and one that would wait behind too many is turned away at
// once with a time to come back in. (scripts/load.mjs --storm is what showed why: a crowd of strangers signing in made every request that costs nothing four times slower.)
import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import { AccountError } from "../src/errors.mjs";
import { createApi } from "../src/api.mjs";
import { OAuth } from "../src/oauth.mjs";
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { hashingLimits, hashPassword, limitHashing, verifyPassword } from "../src/passwords.mjs";
import { make, PASSWORD, confirmed } from "./helpers.mjs";

afterEach(() => limitHashing());

/** What does the hashing, made by the test: it says how many are at it at once, and gives each the time that the test says. */
function slow() {
  const state = { now: 0, most: 0, started: [], finished: [], release: new Map() };
  const run = (password) =>
    new Promise((resolve, reject) => {
      state.now++;
      state.most = Math.max(state.most, state.now);
      state.started.push(password);
      state.release.set(password, (failure) => {
        state.now--;
        state.finished.push(password);
        if (failure) reject(failure);
        else resolve(Buffer.alloc(32, 7));
      });
    });
  return { state, run };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
// (a limiter that is wrong can leave a test waiting for a hashing that nobody lets go: it fails after a while instead)
const patiently = { timeout: 20_000 };

describe("hashing a password", () => {
  it("is done by at most the places that there are, and the others wait in order", patiently, async () => {
    const { state, run } = slow();
    limitHashing({ slots: 2, waiting: 10, run });
    const all = ["a", "b", "c", "d", "e"].map((p) => hashPassword(p));
    await turn();
    assert.deepEqual(state.started, ["a", "b"], "two at it, three waiting");
    state.release.get("a")();
    await turn();
    assert.deepEqual(state.started, ["a", "b", "c"], "a place that is let go goes to the one that has waited longest");
    all.push(hashPassword("f"));
    await turn();
    assert.deepEqual(state.started, ["a", "b", "c"], "and one who comes now waits behind them: the place that was handed over is not a free one");
    state.release.get("b")();
    state.release.get("c")();
    await turn();
    assert.deepEqual(state.started, ["a", "b", "c", "d", "e"]);
    state.release.get("d")();
    await turn();
    assert.deepEqual(state.started, ["a", "b", "c", "d", "e", "f"]);
    state.release.get("e")();
    state.release.get("f")();
    await Promise.all(all);
    assert.equal(state.most, 2, "never more than two at once");
    assert.equal(state.now, 0);
  });

  it("turns away at once what would wait behind too many, with a time to come back in, and takes no place", patiently, async () => {
    const { state, run } = slow();
    limitHashing({ slots: 1, waiting: 2, run });
    const first = hashPassword("one");
    const second = hashPassword("two");
    const third = hashPassword("three");
    await turn();
    assert.deepEqual(state.started, ["one"]);
    const refused = await hashPassword("four").then(
      () => null,
      (error) => error,
    );
    assert.ok(refused instanceof AccountError, String(refused));
    assert.equal(refused.status, 503);
    assert.deepEqual(refused.extra, { code: "busy", retryAfter: 5 });
    assert.match(refused.message, /busy/);
    // the one that was turned away did not take a place from the ones that wait, and they are done in turn
    state.release.get("one")();
    await turn();
    state.release.get("two")();
    await turn();
    state.release.get("three")();
    await Promise.all([first, second, third]);
    assert.deepEqual(state.started, ["one", "two", "three"]);
    // and when they are done there is room again
    const again = hashPassword("five");
    await turn();
    state.release.get("five")();
    await again;
    assert.deepEqual(state.started.at(-1), "five");
  });

  it("lets go of its place when the hashing fails, so that the next one is not left waiting for ever", patiently, async () => {
    const { state, run } = slow();
    limitHashing({ slots: 1, waiting: 5, run });
    const failing = hashPassword("fails");
    const next = hashPassword("next");
    await turn();
    state.release.get("fails")(new Error("out of memory"));
    await assert.rejects(failing, /out of memory/);
    await turn();
    assert.deepEqual(state.started, ["fails", "next"]);
    state.release.get("next")();
    await next;
    assert.equal(state.now, 0);
  });

  it("takes a place for a check of a password that cannot be right too (a stored hash that is not one costs what a real one does), and lets it go", patiently, async () => {
    const { state, run } = slow();
    limitHashing({ slots: 1, waiting: 5, run });
    const check = verifyPassword("anything at all", "not a stored hash");
    const next = hashPassword("next");
    await turn();
    assert.deepEqual(state.started, ["anything at all"], "it is hashing, and so takes the place: the next waits");
    state.release.get("anything at all")();
    assert.equal(await check, false);
    await turn();
    assert.deepEqual(state.started, ["anything at all", "next"], "and the place it let go is the next one's");
    state.release.get("next")();
    await next;
  });

  it("is given half of the processors by default, and one at least: what is left is for the rest of what the server does; sixty-four may wait", () => {
    const half = Math.max(1, Math.floor(availableParallelism() / 2));
    limitHashing();
    assert.deepEqual(hashingLimits(), { slots: half, waiting: 64 });
    limitHashing({ slots: 3 });
    assert.deepEqual(hashingLimits(), { slots: 3, waiting: 64 });
    limitHashing({ waiting: 5 });
    assert.deepEqual(hashingLimits(), { slots: half, waiting: 5 });
  });

  it("is limited as soon as the module is loaded, which is all that a server does (it never calls limitHashing): a process of its own, nothing set", () => {
    const url = new URL("../src/passwords.mjs", import.meta.url).href;
    const done = spawnSync(process.execPath, ["--input-type=module", "-e", `import { hashingLimits } from ${JSON.stringify(url)}; console.log(JSON.stringify(hashingLimits()));`], { encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout), { slots: Math.max(1, Math.floor(availableParallelism() / 2)), waiting: 64 });
  });

  it("is the same for checking a password as for making one, and a password that is not the one is not told from one that is by waiting less", patiently, async () => {
    // (a real hash, and a real check: the places are given to both, and what is answered is what it was)
    limitHashing({ slots: 1, waiting: 8 });
    const [one, two] = await Promise.all([hashPassword("a long enough password"), hashPassword("another long password")]);
    const checks = await Promise.all([verifyPassword("a long enough password", one), verifyPassword("a long enough passwore", one), verifyPassword("another long password", two), verifyPassword("anything at all", "not a stored hash")]);
    assert.deepEqual(checks, [true, false, true, false]);
  });
});

describe("a sign-in when the server is busy hashing", () => {
  it("is answered 503 with a time to come back in, by the API, and the person who is already signed in is answered as always", patiently, async () => {
    const parts = make({ baseUrl: "http://localhost", secure: false, trustProxy: false, providers: {} });
    await confirmed(parts);
    const oauth = new OAuth({ db: parts.db, accounts: parts.accounts, config: parts.config, now: () => parts.clock.t });
    const api = createApi({ accounts: parts.accounts, oauth, config: parts.config });
    const server = http.createServer(async (req, res) => {
      if (!(await api(req, res))) res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    parts.config.baseUrl = base;
    const signal = () => AbortSignal.timeout(8000);
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "zim" }, body: JSON.stringify(body), signal: signal() });
    try {
      const signedIn = await post("/api/login", { email: "ada@example.org", password: PASSWORD });
      assert.equal(signedIn.status, 200);
      const cookie = signedIn.headers.get("set-cookie").split(";")[0];
      // every place is taken and nobody may wait: the next sign-in is turned away
      const { state, run } = slow();
      limitHashing({ slots: 1, waiting: 0, run });
      const taking = hashPassword("takes the only place");
      await turn();
      const busy = await post("/api/login", { email: "ada@example.org", password: PASSWORD });
      assert.equal(busy.status, 503);
      assert.equal(busy.headers.get("retry-after"), "5");
      assert.deepEqual(await busy.json(), { error: "The server is busy: try again in a moment.", code: "busy", retryAfter: 5 });
      // a person who is signed in does not need a password: they are answered as always
      const me = await fetch(`${base}/api/me`, { headers: { cookie }, signal: signal() });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).user.email, "ada@example.org");
      state.release.get("takes the only place")();
      await taking;
    } finally {
      limitHashing();
      server.closeAllConnections();
      server.close();
    }
  });
});
