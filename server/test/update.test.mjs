// A machine that updates itself by pull (scripts/deploy/turtlzim-update.mjs, docs/zim-delivery.md), tried against everything that can be wrong with what it finds: a version that is published and fine, one that is not
// ours, one that is cut or changed, one that will not start on a copy of the real data, one that starts and then does not answer, and one whose migrations the old version cannot take back. GitHub is a stand-in
// that serves the files through a redirect, as the real one does; `systemctl` is a stand-in that starts and stops the REAL server of the version that `current` points at; the releases are the real ones that
// scripts/deploy/make-release.mjs makes from this checkout, signed and checked by the real `ssh-keygen`; the backups and the restores are the server's own.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeRelease } from "../../scripts/deploy/make-release.mjs";
import { settingsFrom, update } from "../../scripts/deploy/turtlzim-update.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const fake = fileURLToPath(new URL("./fake-systemctl.mjs", import.meta.url));
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const short = (commit) => commit.slice(0, 12);
const machines = [];
const folders = [];
after(async () => {
  for (const m of machines) await m.close();
  folders.forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** GitHub as a stand-in: every file of `folder` is served at /download/NAME through a redirect to /objects/NAME, as release assets are. */
async function fakeGithub(folder) {
  const requests = [];
  // (the files whose connection is cut half way through, when it is asked to be)
  const cut = new Set();
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    requests.push(path);
    if (path.startsWith("/download/")) {
      res.writeHead(302, { location: `/objects/${path.slice("/download/".length)}` });
      return res.end();
    }
    const name = path.slice("/objects/".length);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !existsSync(join(folder, name))) {
      res.writeHead(404);
      return res.end("not found");
    }
    const body = readFileSync(join(folder, name));
    res.writeHead(200, { "content-length": body.length });
    if (cut.has(name)) return res.write(body.subarray(0, Math.floor(body.length / 2)), () => res.destroy());
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, cut, url: `http://127.0.0.1:${server.address().port}/download`, close: () => (server.close(), server.closeAllConnections()) };
}

let epoch = 1793800000;

/** A machine: the folders, the key that signs for it, GitHub, a `systemctl`, and what the program needs to be told. */
async function machine({ keep = 2, seconds = 10 } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "zim-update-"));
  folders.push(folder);
  const dirs = { root: join(folder, "root"), data: join(folder, "data"), etc: join(folder, "etc"), published: join(folder, "published"), supervisor: join(folder, "supervisor") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const key = join(folder, "signer");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "signer", "-f", key]);
  writeFileSync(join(dirs.etc, "allowed_signers"), `turtlzim-beta ${readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ")}\n`);
  const httpsPort = await freePort();
  const redirectPort = await freePort();
  const args = ["--host", "127.0.0.1", "--port", String(httpsPort), "--tls", "--name", "127.0.0.1", "--redirect-port", String(redirectPort), "--dir", "../web/dist", "--pid-file", join(dirs.data, "serve.pid")];
  const control = join(folder, "fake-systemd.json");
  const m = { ...dirs, folder, key, httpsPort, redirectPort, args, control, log: [], github: await fakeGithub(dirs.published) };
  m.config = { dir: dirs.supervisor, root: dirs.root, data: dirs.data, args, bad: [], needRestore: false };
  m.tell = (patch) => {
    Object.assign(m.config, patch);
    writeFileSync(control, JSON.stringify(m.config));
    process.env.FAKE_SYSTEMD = control;
  };
  m.tell({});
  m.settings = settingsFrom({
    TURTLZIM_RELEASE_URL: m.github.url,
    TURTLZIM_ROOT: dirs.root,
    ZIM_SERVER_DATA: dirs.data,
    TURTLZIM_ETC: dirs.etc,
    TURTLZIM_ARGS: args.join(" "),
    TURTLZIM_SYSTEMCTL: `${process.execPath} ${fake}`,
    TURTLZIM_HEALTH_SECONDS: String(seconds),
    TURTLZIM_POLL_MS: "200",
    TURTLZIM_KEEP: String(keep),
  });
  m.run = () => {
    process.env.FAKE_SYSTEMD = control;
    return update(m.settings, (line) => m.log.push(line));
  };
  m.publish = (commit, extra = {}) => makeRelease({ out: dirs.published, commit, signKey: key, install: "copy", epoch: ++epoch, ...extra });
  /** The manifest, changed and signed again with the key of this machine. */
  m.resign = (change) => {
    const file = join(dirs.published, "turtlzim-beta.json");
    writeFileSync(file, `${JSON.stringify(change(JSON.parse(readFileSync(file, "utf8"))), null, 2)}\n`);
    rmSync(`${file}.sig`, { force: true });
    execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-f", key, "-n", "turtlzim-beta", file], { stdio: ["ignore", "ignore", "pipe"] });
  };
  m.linked = (name) => {
    try {
      return basename(readlinkSync(join(dirs.root, name)));
    } catch {
      return null;
    }
  };
  m.versions = () => readdirSync(join(dirs.root, "releases")).filter((name) => !name.startsWith(".")).sort();
  m.calls = (verb) => (existsSync(join(dirs.supervisor, "calls.log")) ? readFileSync(join(dirs.supervisor, "calls.log"), "utf8").split("\n").filter((line) => line.startsWith(`${verb} `)).length : 0);
  m.status = () => JSON.parse(readFileSync(join(dirs.root, "status.json"), "utf8"));
  m.answers = () =>
    new Promise((resolve) => {
      https
        .get(`https://127.0.0.1:${httpsPort}/api/health`, { rejectUnauthorized: false, timeout: 3000 }, (res) => (res.resume(), resolve(res.statusCode === 200)))
        .on("error", () => resolve(false));
    });
  m.close = async () => {
    spawnSync(process.execPath, [fake, "stop", "turtlzim.service"], { env: { ...process.env, FAKE_SYSTEMD: control } });
    m.github.close();
  };
  machines.push(m);
  return m;
}

/** A checkout whose server cannot start (`main.mjs` ends at once), or, with `without`, one that lacks a file. */
function brokenCheckout(without) {
  const folder = mkdtempSync(join(tmpdir(), "zim-broken-"));
  folders.push(folder);
  for (const path of ["server/src", "server/package.json", "server/package-lock.json", "server/node_modules", "web/scripts/serve.mjs", "web/dist"]) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    cpSync(join(repo, path), join(folder, path), { recursive: true });
  }
  if (without) rmSync(join(folder, without));
  else writeFileSync(join(folder, "server/src/main.mjs"), 'console.error("this version cannot start"); process.exit(1);\n');
  return folder;
}

describe("the settings", () => {
  it("are the ones of the staging machine unless they are told, and the ports that are asked are the server's own", () => {
    const s = settingsFrom({});
    assert.equal(s.releaseUrl, "https://github.com/bbhedia/turtlzim/releases/download/beta");
    assert.equal(s.root, "/opt/turtlzim");
    assert.equal(s.data, "/var/lib/turtlzim");
    assert.equal(s.etc, "/etc/turtlzim");
    assert.equal(s.keep, 3);
    assert.deepEqual(s.systemctl, ["systemctl", "--user"]);
    assert.equal(s.httpsPort, 8244);
    assert.equal(s.redirectPort, undefined);
    const told = settingsFrom({ TURTLZIM_ARGS: "--host :: --port 8444 --tls --redirect-port 8481", TURTLZIM_REPO: "me/app", TURTLZIM_CHANNEL: "production", TURTLZIM_KEEP: "5" });
    assert.equal(told.httpsPort, 8444);
    assert.equal(told.redirectPort, 8481);
    assert.equal(told.releaseUrl, "https://github.com/me/app/releases/download/production");
    assert.equal(told.keep, 5);
  });

  it("are refused when they are not what they have to be, and say which", () => {
    assert.throws(() => settingsFrom({ TURTLZIM_REPO: "not a repo" }), /TURTLZIM_REPO is owner\/name/);
    assert.throws(() => settingsFrom({ TURTLZIM_CHANNEL: "../x" }), /TURTLZIM_CHANNEL is a lower-case name/);
    assert.throws(() => settingsFrom({ TURTLZIM_KEEP: "0" }), /TURTLZIM_KEEP must be a whole number of at least 1/);
  });
});

describe("a machine that has nothing yet, and then a newer version, and then another", () => {
  it("installs what is published as its first version: the checks pass, the server is started and answers, and there was nothing to back up", async () => {
    const m = await machine();
    m.publish(A);
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["installed", 0]);
    assert.equal(m.linked("current"), short(A));
    assert.equal(m.linked("previous"), null);
    assert.equal(await m.answers(), true);
    assert.equal(m.calls("restart"), 1);
    assert.ok(!existsSync(join(m.data, "backups")), "no database before it: nothing to back up");
    assert.equal(m.status().outcome, "installed");
    assert.equal(m.status().commit, A);
    assert.ok(m.log.some((line) => /first version on this machine: nothing to back up/.test(line)), m.log.join("\n"));
  });

  it("does nothing, and does not restart the server, when what is published is what is here", async () => {
    const m = await machine();
    m.publish(A);
    await m.run();
    const again = await m.run();
    assert.deepEqual([again.outcome, again.code], ["up-to-date", 0]);
    assert.equal(m.calls("restart"), 1);
    assert.equal(m.status().outcome, "up-to-date");
  });

  it("goes from one version to the next: a backup first, the new version tried on a copy of it, then the switch, and the old one is kept to go back to", async () => {
    const m = await machine();
    m.publish(A);
    await m.run();
    m.publish(B);
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["installed", 0], m.log.join("\n"));
    assert.equal(m.linked("current"), short(B));
    assert.equal(m.linked("previous"), short(A));
    assert.equal(await m.answers(), true);
    assert.equal(m.calls("restart"), 2);
    const backups = readdirSync(join(m.data, "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^zim-backup-\d{8}T\d{6}Z$/);
    assert.ok(existsSync(join(m.data, "backups", backups[0], "manifest.json")));
    assert.ok(m.log.some((line) => /came up on a copy of the data and answered/.test(line)), m.log.join("\n"));
    assert.deepEqual(m.versions(), [short(A), short(B)].sort());
  });

  it("keeps only the newest versions, and never the one that runs or the one before it", async () => {
    const m = await machine({ keep: 2 });
    for (const commit of [A, B, C]) {
      m.publish(commit);
      const result = await m.run();
      assert.equal(result.outcome, "installed", m.log.join("\n"));
    }
    assert.deepEqual(m.versions(), [short(B), short(C)].sort(), "the oldest is gone");
    assert.equal(m.linked("current"), short(C));
    assert.equal(m.linked("previous"), short(B));
  });

  it("never takes away the version that runs or the one before it, even when only one is to be kept", async () => {
    const m = await machine({ keep: 1 });
    m.publish(A);
    await m.run();
    m.publish(B);
    await m.run();
    assert.deepEqual(m.versions(), [short(A), short(B)].sort(), "A is the one before: it is kept");
    m.publish(C);
    await m.run();
    assert.deepEqual(m.versions(), [short(B), short(C)].sort(), "now B is the one before, and A can go");
  });

  it("never asks an address that is plain http and not on this computer", async () => {
    const m = await machine();
    m.settings.releaseUrl = "http://example.org/download";
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["unreachable", 0]);
    assert.match(result.detail, /is not an address that this program asks \(https, or http on this computer\)/);
  });

  it("does not look at all while the pause file is there, and goes on when it is taken away", async () => {
    const m = await machine();
    m.publish(A);
    writeFileSync(join(m.etc, "pause"), "");
    const paused = await m.run();
    assert.deepEqual([paused.outcome, paused.code], ["paused", 0]);
    assert.equal(m.github.requests.length, 0, "nothing was even asked for");
    assert.equal(m.linked("current"), null);
    rmSync(join(m.etc, "pause"));
    assert.equal((await m.run()).outcome, "installed");
  });

  it("takes a connection that is cut in the middle of the archive for a look to do again, leaves no file behind, and goes on when it holds", async () => {
    const m = await machine();
    m.publish(A);
    m.github.cut.add("turtlzim-beta.tar.gz");
    const cutOff = await m.run();
    assert.deepEqual([cutOff.outcome, cutOff.code], ["unreachable", 0], m.log.join("\n"));
    assert.match(cutOff.detail, /the archive could not be read now/);
    assert.deepEqual(readdirSync(m.root).filter((name) => name.endsWith(".tar.gz")), [], "the half of an archive is not left");
    assert.equal(m.linked("current"), null);
    m.github.cut.clear();
    assert.equal((await m.run()).outcome, "installed");
  });

  it("is not stopped by a release that is not there yet, nor by a GitHub that cannot be reached: it looks again later", async () => {
    const m = await machine();
    const nothing = await m.run();
    assert.deepEqual([nothing.outcome, nothing.code], ["nothing-published", 0]);
    m.publish(A);
    m.github.close();
    const down = await m.run();
    assert.deepEqual([down.outcome, down.code], ["unreachable", 0]);
    assert.equal(m.linked("current"), null);
    assert.deepEqual(m.versions(), []);
  });
});

describe("what is found and is not ours", () => {
  /** Nothing was installed, nothing was left half done, and the status says what was found. */
  function nothingChanged(m, outcome, code, result) {
    assert.deepEqual([result.outcome, result.code], [outcome, code], `${result.detail}\n${m.log.join("\n")}`);
    assert.equal(m.linked("current"), null);
    assert.deepEqual(m.versions(), []);
    assert.deepEqual(readdirSync(m.root).filter((name) => name.endsWith(".tar.gz") || name.startsWith(".preflight-")), [], "no archive and no trial left behind");
    assert.equal(m.calls("restart"), 0);
  }

  it("is not installed when the manifest is signed by another key", async () => {
    const m = await machine();
    const other = join(m.folder, "other");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", other]);
    m.publish(A, { signKey: other });
    nothingChanged(m, "not-ours", 3, await m.run());
  });

  it("is not installed when the manifest was changed after it was signed, or has no signature", async () => {
    const m = await machine();
    m.publish(A);
    const file = join(m.published, "turtlzim-beta.json");
    writeFileSync(file, readFileSync(file, "utf8").replace(A, B));
    nothingChanged(m, "not-ours", 3, await m.run());
    rmSync(`${file}.sig`);
    const unsigned = await m.run();
    assert.equal(unsigned.outcome, "unreachable", "a signature that is not there is a release being put there: it is looked at again");
  });

  it("is not installed when the archive is not the one that the signed manifest describes: one byte changed, or longer", async () => {
    const m = await machine();
    m.publish(A);
    const archive = join(m.published, "turtlzim-beta.tar.gz");
    const bytes = readFileSync(archive);
    const changed = Buffer.from(bytes);
    changed[Math.floor(changed.length / 2)] ^= 0xff;
    writeFileSync(archive, changed);
    nothingChanged(m, "not-ours", 3, await m.run());
    writeFileSync(archive, Buffer.concat([bytes, Buffer.from("more")]));
    const longer = await m.run();
    nothingChanged(m, "not-ours", 3, longer);
    assert.match(longer.detail, /longer than the signed manifest says/, "it stopped reading at the size that the manifest gives: it does not take what is as long as someone wants");
  });

  it("is refused when the manifest is ours but says what this program does not know how to take: another channel, another format, no commit, no node, an archive that is not its own, a service worker that is not a hash", async () => {
    const m = await machine();
    for (const [what, change, said] of [
      ["channel", (x) => ({ ...x, channel: "production" }), /channel "production"/],
      ["format", (x) => ({ ...x, format: 2 }), /format 2/],
      ["commit", (x) => ({ ...x, commit: "main" }), /has no commit/],
      ["node", (x) => ({ ...x, node: {} }), /which Node/],
      ["archive", (x) => ({ ...x, archive: { ...x.archive, name: "../../etc/passwd" } }), /does not describe its archive/],
      ["service worker", (x) => ({ ...x, web: { sw: "short" } }), /service worker hash/],
    ]) {
      m.publish(A);
      m.resign(change);
      const result = await m.run();
      assert.deepEqual([result.outcome, result.code], ["refused", 4], `${what}: ${result.detail}`);
      assert.match(result.detail, said, what);
      assert.equal(m.linked("current"), null, what);
    }
  });

  it("is refused when the archive says that it is another version than the manifest does, or lacks a file that the server cannot do without", async () => {
    const m = await machine();
    m.publish(A);
    m.resign((x) => ({ ...x, commit: B }));
    const other = await m.run();
    assert.deepEqual([other.outcome, other.code], ["refused", 4]);
    assert.match(other.detail, /the archive says it is another version than the manifest does/);
    m.publish(C, { repoRoot: brokenCheckout("server/src/backup.mjs") });
    const lacking = await m.run();
    assert.deepEqual([lacking.outcome, lacking.code], ["refused", 4]);
    assert.match(lacking.detail, /the archive lacks server\/src\/backup\.mjs/);
    assert.equal(m.linked("current"), null);
    assert.deepEqual(m.versions(), [], "what was unpacked is taken away");
  });

  it("is refused when it asks for a Node that this machine does not have, and says so", async () => {
    const m = await machine();
    m.publish(A);
    m.resign((x) => ({ ...x, node: { major: 99 } }));
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["refused", 4]);
    assert.match(result.detail, /asks for Node 99 and this is Node \d+/);
    assert.equal(m.linked("current"), null);
  });

  it("does not run when there is no key on the machine to check anything against", async () => {
    const m = await machine();
    m.publish(A);
    rmSync(join(m.etc, "allowed_signers"));
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["refused", 4]);
    assert.match(result.detail, /allowed_signers is not there/);
    assert.equal(m.github.requests.length, 0);
  });
});

describe("a version that is ours and does not work", () => {
  it("is refused, with the running version untouched, when it does not come up on a copy of the real data, and it is not tried again", async () => {
    const m = await machine();
    m.publish(A);
    await m.run();
    m.publish(B, { repoRoot: brokenCheckout() });
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["refused", 4], m.log.join("\n"));
    assert.match(result.detail, /did not come up on a copy of the data/);
    assert.match(result.detail, /this version cannot start/, "what the version said is in the answer");
    assert.equal(m.linked("current"), short(A));
    assert.equal(m.calls("restart"), 1, "the server was not touched");
    assert.equal(await m.answers(), true);
    assert.deepEqual(m.versions(), [short(A)], "the version that did not start is not kept");
    assert.ok(existsSync(join(m.root, "failed", B)));
    assert.equal(readdirSync(join(m.data, "backups")).length, 1, "the trial was made on a copy of a backup, which was made first");
    const again = await m.run();
    assert.deepEqual([again.outcome, again.code], ["skipped", 0], "the same version is not tried every five minutes");
    assert.equal(m.calls("restart"), 1);
    m.publish(C);
    assert.equal((await m.run()).outcome, "installed", "a newer version is tried");
  });

  it("is put back, and the old one answers again, when the new one starts for real and does not answer", async () => {
    const m = await machine({ seconds: 5 });
    m.publish(A);
    await m.run();
    m.publish(B);
    m.tell({ bad: [short(B)] });
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["rolled-back", 1], m.log.join("\n"));
    assert.equal(m.linked("current"), short(A));
    assert.equal(m.linked("previous"), null);
    assert.equal(await m.answers(), true, "the old version is running again");
    assert.equal(m.calls("restart"), 3, "A, then B, then A again");
    assert.ok(existsSync(join(m.root, "failed", B)));
    assert.equal(m.status().outcome, "rolled-back");
  });

  it("is put back when the server that it starts serves another build than the one that was published", async () => {
    const m = await machine({ seconds: 5 });
    m.publish(A);
    await m.run();
    m.publish(B);
    m.resign((x) => ({ ...x, web: { sw: "0".repeat(64) } }));
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["rolled-back", 1], m.log.join("\n"));
    assert.match(result.detail, /service worker that it serves is not the one of the build that was published/);
    assert.equal(m.linked("current"), short(A));
  });

  it("is not taken for a good one when its http port does not redirect (here, a server started without it)", async () => {
    const m = await machine({ seconds: 2 });
    m.publish(A);
    await m.run();
    m.publish(B);
    m.tell({ args: m.args.filter((arg, i) => arg !== "--redirect-port" && m.args[i - 1] !== "--redirect-port") });
    const result = await m.run();
    assert.notEqual(result.outcome, "installed");
    assert.match(result.detail, /ECONNREFUSED|redirect/);
  });

  it("brings the backup back when the old version cannot take the data that the new one changed, and that answers again", async () => {
    const m = await machine({ seconds: 5 });
    m.publish(A);
    await m.run();
    m.publish(B);
    m.tell({ bad: [short(B)], needRestore: true });
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["rolled-back-and-restored", 1], m.log.join("\n"));
    assert.equal(m.linked("current"), short(A));
    assert.equal(await m.answers(), true);
    assert.ok(readdirSync(m.data).some((name) => name.startsWith("replaced-")), "what was there is kept, not deleted");
    assert.ok(m.log.some((line) => /putting the backup back/.test(line)), m.log.join("\n"));
  });

  it("says that a person is needed, and where the backup is, when neither version answers and the backup does not help", async () => {
    const m = await machine({ seconds: 2 });
    m.publish(A);
    await m.run();
    m.publish(B);
    m.tell({ bad: [short(A), short(B)] });
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["needs-a-person", 5], m.log.join("\n"));
    assert.match(result.detail, /zim-backup-/);
    assert.equal(m.status().outcome, "needs-a-person");
  });

  it("leaves nothing running, and no `current`, when the very first version does not answer", async () => {
    const m = await machine({ seconds: 2 });
    m.publish(A);
    m.tell({ bad: [short(A)] });
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["rolled-back", 1], m.log.join("\n"));
    assert.match(result.detail, /first version did not work/);
    assert.equal(m.linked("current"), null);
    assert.equal(m.calls("stop"), 1);
    assert.equal(await m.answers(), false);
  });

  it("changes nothing when no backup can be made first", async () => {
    const m = await machine();
    m.publish(A);
    await m.run();
    writeFileSync(join(m.root, "releases", short(A), "server/src/backup.mjs"), "process.exit(3);\n");
    m.publish(B);
    const result = await m.run();
    assert.deepEqual([result.outcome, result.code], ["refused", 4]);
    assert.match(result.detail, /no backup could be made, so nothing was changed/);
    assert.equal(m.linked("current"), short(A));
    assert.equal(m.calls("restart"), 1);
    assert.deepEqual(m.versions(), [short(A)], "what was unpacked is taken away");
  });
});

describe("two looks at once", () => {
  it("does not go on while another look is going on, and takes a lock that nobody holds any more", async () => {
    const m = await machine();
    m.publish(A);
    writeFileSync(join(m.root, ".update.lock"), `${process.pid}\n`);
    const busy = await m.run();
    assert.deepEqual([busy.outcome, busy.code], ["busy", 0]);
    assert.equal(m.github.requests.length, 0);
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    writeFileSync(join(m.root, ".update.lock"), `${dead.pid}\n`);
    const taken = await m.run();
    assert.equal(taken.outcome, "installed", m.log.join("\n"));
    assert.ok(!existsSync(join(m.root, ".update.lock")), "the lock is let go");
  });

  it("takes a lock that a living process has held for more than half an hour (a look that hung), and not one that was just taken", async () => {
    const m = await machine();
    m.publish(A);
    const lock = join(m.root, ".update.lock");
    writeFileSync(lock, `${process.pid}\n`);
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(lock, old, old);
    assert.equal((await m.run()).outcome, "installed", "a look that has hung for 31 minutes does not hold the next ones for ever");
    writeFileSync(lock, `${process.pid}\n`);
    const recent = new Date(Date.now() - 29 * 60_000);
    utimesSync(lock, recent, recent);
    assert.equal((await m.run()).outcome, "busy", "one that began 29 minutes ago may still be going");
  });
});
