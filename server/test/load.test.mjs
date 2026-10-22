// scripts/load.mjs is a tool, and a tool that is not run goes stale: it is run small, and what it reports is what it measured (nobody failed, every kind of request was made, a storm was answered).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/load.mjs", import.meta.url));

describe("scripts/load.mjs", { skip: !existsSync(fileURLToPath(new URL("../../web/dist/index.html", import.meta.url))) && "web/dist is not built" }, () => {
  it("signs people up, keeps their notebooks in step, and says what it measured, with and without a storm of strangers", () => {
    const done = spawnSync(process.execPath, [script, "--users", "3", "--files", "6", "--bytes", "300", "--seconds", "2", "--think", "10", "--storm", "8", "--json"], { encoding: "utf8", timeout: 120_000 });
    assert.equal(done.status, 0, done.stdout + done.stderr);
    const result = JSON.parse(done.stdout);
    assert.equal(result.users, 3);
    assert.equal(result.signedIn, 3);
    assert.ok(result.rounds > 10, `${result.rounds} rounds`);
    const names = result.rows.map((row) => row.name);
    for (const name of ["sign up", "confirm", "sign in", "send a notebook", "who am I", "list notebooks", "manifest", "send changed files", "read files", "stranger signs in"]) assert.ok(names.includes(name), name);
    for (const row of result.rows.filter((row) => row.name !== "stranger signs in")) assert.equal(row.errors, 0, `${row.name} had errors`);
    // the strangers have no account: they are told so (401), or that the server is busy (503), never anything else
    assert.deepEqual(Object.keys(result.storm.answers).filter((status) => !["401", "503"].includes(status)), []);
    assert.equal(Object.values(result.storm.answers).reduce((sum, n) => sum + n, 0), 8);
    assert.ok(result.storm.before.count > 0 && result.storm.during.count > 0);
    assert.ok(result.serverCpuSeconds > 0 && result.serverPeakMiB > 10);
  });

  it("lets people in a few at a time (--ramp), so that a server that hashes one password at a time with two waiting is not turned into a refusal by the tool's own start", () => {
    // capacity of the limiter: one place and two waiting = three; the ramp is two. (Without a ramp, eight at once would be five refusals: "no code was mailed".)
    const done = spawnSync(process.execPath, [script, "--users", "8", "--files", "3", "--bytes", "200", "--seconds", "1", "--think", "10", "--ramp", "2", "--json"], { encoding: "utf8", timeout: 120_000, env: { ...process.env, ZIM_HASH_SLOTS: "1", ZIM_HASH_QUEUE: "2" } });
    assert.equal(done.status, 0, done.stdout + done.stderr);
    const result = JSON.parse(done.stdout);
    assert.equal(result.signedIn, 8);
    for (const row of result.rows) assert.equal(row.errors, 0, `${row.name} had errors`);
  });

  it("says how it is asked wrong", () => {
    const done = spawnSync(process.execPath, [script, "--users", "none"], { encoding: "utf8" });
    assert.equal(done.status, 2);
    assert.match(done.stderr, /--users needs a number/);
    assert.equal(spawnSync(process.execPath, [script, "--surprise"], { encoding: "utf8" }).status, 2);
    const ramp = spawnSync(process.execPath, [script, "--ramp", "0"], { encoding: "utf8" });
    assert.equal(ramp.status, 2);
    assert.match(ramp.stderr, /--ramp needs at least one at a time/);
  });
});
