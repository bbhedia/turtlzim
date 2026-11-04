// What CI makes for a machine that updates itself by pull (scripts/deploy/make-release.mjs, docs/zim-delivery.md): an archive that is enough to run the server, a manifest that says what it is, and a signature
// that only the one key that signs can make. Built from this very checkout (its web/dist is built, as the CI's server job has it) and tried with the real `ssh-keygen` and the real server.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FORMAT, assetsOf, makeRelease, namespaceOf, signatureHolds } from "../../scripts/deploy/make-release.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const EPOCH = 1793800000;
const folders = [];
const children = [];
after(() => {
  children.forEach((child) => child.kill("SIGKILL"));
  folders.forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});
const temp = (name) => {
  const folder = mkdtempSync(join(tmpdir(), `zim-${name}-`));
  folders.push(folder);
  return folder;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A key to sign with, and the `allowed_signers` file of a machine that trusts it (for the namespace of this channel). */
function newKey(folder, name, channel = "beta") {
  const key = join(folder, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
  const signers = `${key}.signers`;
  writeFileSync(signers, `${namespaceOf(channel)} ${readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ")}\n`);
  return { key, signers };
}

describe("the release that CI makes", () => {
  let work, made, key;
  before(() => {
    work = temp("release");
    key = newKey(work, "signer");
    made = makeRelease({ out: join(work, "out"), commit: COMMIT, signKey: key.key, install: "copy", epoch: EPOCH });
  });

  it("is three files of fixed names: the archive, a manifest that says what it is, and its signature", () => {
    assert.deepEqual(assetsOf("beta"), { archive: "turtlzim-beta.tar.gz", manifest: "turtlzim-beta.json", signature: "turtlzim-beta.json.sig" });
    assert.equal(namespaceOf("beta"), "turtlzim-beta", "the name that the machine checks the signature for (scripts/deploy/turtlzim-update.mjs)");
    assert.equal(namespaceOf("production"), "turtlzim-production");
    for (const file of [made.archive, made.manifest, made.signature]) assert.ok(existsSync(file), file);
    const archive = readFileSync(made.archive);
    const manifest = JSON.parse(readFileSync(made.manifest, "utf8"));
    assert.equal(manifest.format, FORMAT);
    assert.equal(manifest.channel, "beta");
    assert.equal(manifest.commit, COMMIT);
    assert.equal(manifest.built, new Date(EPOCH * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
    assert.equal(manifest.node.major, 24, "the Node that the server's package.json asks for");
    assert.deepEqual(manifest.archive, { name: "turtlzim-beta.tar.gz", sha256: sha256(archive), size: archive.length });
    assert.equal(manifest.web.sw, sha256(readFileSync(join(repo, "web/dist/sw.js"))), "the service worker's own SHA-256: what a machine that serves this build has to serve");
    assert.deepEqual(manifest, made.data);
  });

  it("holds the server with its production dependencies, the one file of web/scripts that it imports, and the web app as it was built, and nothing of the tests or of the machine that made it", () => {
    const names = execFileSync("tar", ["-tzf", made.archive], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean);
    for (const need of ["./RELEASE.json", "./server/src/main.mjs", "./server/src/redirect.mjs", "./server/package.json", "./server/node_modules/nodemailer/package.json", "./web/scripts/serve.mjs", "./web/dist/index.html", "./web/dist/sw.js"]) {
      assert.ok(names.includes(need), `${need} is in the archive`);
    }
    for (const name of names) {
      assert.ok(!/^\.\/(server\/(test|scripts)|web\/(src|test|node_modules)|\.git|docs|core|desktop|mobile)(\/|$)/.test(name), `${name} has no place in what a machine runs`);
    }
    // (no name and no number of whoever made it: every entry is root's, so that the same files make the same bytes wherever they are made)
    const verbose = execFileSync("tar", ["-tvzf", made.archive], { encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, TZ: "UTC" } }).split("\n").filter(Boolean);
    assert.ok(verbose.every((line) => /^\S+\s+0\/0\s/.test(line)), `every entry is owned by 0/0: ${verbose.find((line) => !/^\S+\s+0\/0\s/.test(line))}`);
    // (and every entry has the time that was given, not the time of the making: two builds a second apart are the same bytes)
    const stamp = new Date(EPOCH * 1000).toISOString().slice(0, 16).replace("T", " ");
    assert.ok(verbose.every((line) => line.includes(stamp)), `every entry is dated ${stamp}: ${verbose.find((line) => !line.includes(stamp))}`);
    const inside = JSON.parse(execFileSync("tar", ["-xzOf", made.archive, "./RELEASE.json"], { encoding: "utf8" }));
    assert.deepEqual(inside, { format: FORMAT, channel: "beta", commit: COMMIT, built: made.data.built }, "the archive says by itself which commit it is");
  });

  it("is the same archive for the same files and the same time, and not for another time", () => {
    const again = makeRelease({ out: join(work, "again"), commit: COMMIT, install: "copy", epoch: EPOCH });
    assert.equal(sha256(readFileSync(again.archive)), made.data.archive.sha256);
    const later = makeRelease({ out: join(work, "later"), commit: COMMIT, install: "copy", epoch: EPOCH + 60 });
    assert.notEqual(later.data.archive.sha256, made.data.archive.sha256);
  });

  it("has a signature that holds for the manifest, the namespace and the key that signed, and for nothing else", () => {
    const good = { manifest: made.manifest, signature: made.signature, signers: key.signers, namespace: namespaceOf("beta") };
    assert.equal(signatureHolds(good), true);
    // a manifest that was changed by one byte
    const changed = join(work, "changed.json");
    writeFileSync(changed, readFileSync(made.manifest, "utf8").replace(COMMIT, "f".repeat(40)));
    assert.equal(signatureHolds({ ...good, manifest: changed }), false);
    // the same signature offered for another use
    assert.equal(signatureHolds({ ...good, namespace: "turtlzim-production" }), false);
    // a machine that trusts another key
    assert.equal(signatureHolds({ ...good, signers: newKey(work, "other").signers }), false);
    // no signature at all
    assert.equal(signatureHolds({ ...good, signature: join(work, "nothing.sig") }), false);
  });

  it("is signed only if a key was given, and a key that is not one stops it", () => {
    const unsigned = makeRelease({ out: join(work, "unsigned"), commit: COMMIT, install: "copy", epoch: EPOCH });
    assert.equal(unsigned.signature, null);
    assert.ok(!existsSync(join(work, "unsigned", "turtlzim-beta.json.sig")));
    const notAKey = join(work, "not-a-key");
    writeFileSync(notAKey, "this is not a key\n", { mode: 0o600 });
    assert.throws(() => makeRelease({ out: join(work, "bad"), commit: COMMIT, signKey: notAKey, install: "copy", epoch: EPOCH }));
  });

  it("is refused for a commit that is not one, a channel that is not a name, an install that is not known, or a checkout that is not built", () => {
    const out = join(work, "refused");
    assert.throws(() => makeRelease({ out, commit: "HEAD", install: "copy" }), /40 hexadecimal/);
    assert.throws(() => makeRelease({ out, commit: COMMIT.toUpperCase(), install: "copy" }), /40 hexadecimal/);
    assert.throws(() => makeRelease({ out, commit: COMMIT, channel: "../x", install: "copy" }), /lower-case name/);
    assert.throws(() => makeRelease({ out, commit: COMMIT, install: "yarn" }), /npm or copy/);
    const empty = temp("empty");
    assert.throws(() => makeRelease({ repoRoot: empty, out, commit: COMMIT, install: "copy" }), /is missing/);
    mkdirSync(join(empty, "server/src"), { recursive: true });
    for (const file of ["server/src/main.mjs", "server/package.json", "server/package-lock.json"]) writeFileSync(join(empty, file), "x");
    assert.throws(() => makeRelease({ repoRoot: empty, out, commit: COMMIT, install: "copy" }), /web\/dist\/index\.html is missing.*build the web app first/);
  });

  it("is enough to run the server by itself: unpacked on its own, it starts over https, answers, and redirects from its http port", async () => {
    const root = temp("unpacked");
    execFileSync("tar", ["-xzf", made.archive, "-C", root]);
    const state = temp("state");
    const child = spawn(process.execPath, [join(root, "server/src/main.mjs"), "--host", "127.0.0.1", "--port", "0", "--tls", "--name", "127.0.0.1", "--redirect-port", "0", "--dir", join(root, "web/dist")], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: join(root, "server"),
      env: { ...process.env, ZIM_SERVER_DATA: join(state, "data"), XDG_STATE_HOME: join(state, "state"), ZIM_BASE_URL: "https://127.0.0.1" },
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`it did not start: ${output}`)), 20_000);
      const look = () => output.includes("Data: ") && (clearTimeout(timer), resolve());
      child.stdout.on("data", look);
      child.on("exit", () => reject(new Error(`it ended: ${output}`)));
    });
    const [, httpsPort] = /https:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
    const [, redirectPort] = /Plain http, on port (\d+)/.exec(output);
    const health = await new Promise((resolve, reject) => {
      https.get(`https://127.0.0.1:${httpsPort}/api/health`, { rejectUnauthorized: false }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject);
    });
    assert.equal(health.status, 200);
    assert.match(health.body, /"ok":\s*true/);
    const redirect = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: redirectPort, path: "/" }, (res) => (res.resume(), resolve({ status: res.statusCode, location: res.headers.location }))).on("error", reject);
    });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.location, `https://127.0.0.1:${httpsPort}/`);
    // and what it serves is the build that the manifest names: the service worker, byte for byte
    const sw = await new Promise((resolve, reject) => {
      https.get(`https://127.0.0.1:${httpsPort}/sw.js`, { rejectUnauthorized: false }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }).on("error", reject);
    });
    assert.equal(sha256(sw), made.data.web.sw);
  });
});
