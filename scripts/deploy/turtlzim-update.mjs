// What a machine runs, every few minutes, to keep itself at the latest version that CI published for it (docs/zim-delivery.md). It reads a small manifest that GitHub holds and installs the version that the
// manifest names only after that version has been shown to be ours (the manifest's signature, with the public key that was put on the machine, and the archive's SHA-256), to start on a copy of the real data, and,
// after a backup, to be taken for good by the real server. Nothing comes in: the machine goes and looks (no SSH, no port opened for it). One file, with Node's own modules only, so that it can be put on a machine as it is.
//
//   node turtlzim-update.mjs        one look. Exit 0: nothing to do, or done. 1: it failed and the machine was put back as it was. 3: what was found is not ours. 4: refused (nothing was changed). 5: a person is needed.
//
// In this order, and it stops at the first thing that is not right, with nothing changed up to there:
//   the pause file, the manifest and its signature, the manifest's own contents, the Node that it asks for, "is it the version that is here already?", "did this one already fail here?", the archive and its SHA-256, the
//   archive unpacked beside the others, a backup of the real data, the new version started on a COPY of that backup (a database that its migrations cannot take, a file missing from the archive, a Node that is too old
//   stop it here, without a second of downtime), then `current` pointed at it, the unit restarted, and the server asked (health, the service worker that it serves, the http port that redirects). If the server does not
//   answer as it should, the old version is put back; if that does not answer either, the backup is put back too (what a new version's migrations changed in the database is what the old one may refuse).
//
// Settings, all from the environment (`/etc/turtlzim/env`): see `settingsFrom`.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The manifest's format that this program knows. */
const FORMAT = 1;
const MANIFEST_MAX = 64 * 1024;
const SIGNATURE_MAX = 16 * 1024;
const ARCHIVE_MAX = 300 * 1048576;
/** What a release unpacked has to hold, or it is not one. */
const NEEDED = ["RELEASE.json", "server/src/main.mjs", "server/src/backup.mjs", "server/package.json", "server/node_modules/nodemailer/package.json", "web/dist/index.html", "web/scripts/serve.mjs"];

/** An end that is not a crash: what happened, the exit status to give, and what to say. */
class Stop extends Error {
  constructor(outcome, code, message) {
    super(message);
    this.outcome = outcome;
    this.code = code;
  }
}

function whole(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of at least 1 (it is ${JSON.stringify(value)})`);
  return n;
}

/**
 * The settings, from the environment: where GitHub's release is (`TURTLZIM_REPO`, `TURTLZIM_CHANNEL`, or the whole address in `TURTLZIM_RELEASE_URL`), where the versions are put (`TURTLZIM_ROOT`), the data
 * (`ZIM_SERVER_DATA`), where the public key of the signer is (`TURTLZIM_ETC`), how many versions are kept (`TURTLZIM_KEEP`), the unit (`TURTLZIM_UNIT`, `TURTLZIM_SYSTEMCTL`) and the server's own arguments
 * (`TURTLZIM_ARGS`, of which the ports are what is asked). `TURTLZIM_HEALTH_SECONDS` and `TURTLZIM_POLL_MS` say how long and how often it waits for the server.
 */
export function settingsFrom(env = process.env) {
  const repo = env.TURTLZIM_REPO ?? "bbhedia/turtlzim";
  const channel = env.TURTLZIM_CHANNEL ?? "beta";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`TURTLZIM_REPO is owner/name (it is ${JSON.stringify(repo)})`);
  if (!/^[a-z][a-z0-9-]*$/.test(channel)) throw new Error(`TURTLZIM_CHANNEL is a lower-case name (it is ${JSON.stringify(channel)})`);
  const args = (env.TURTLZIM_ARGS ?? "").split(/\s+/).filter(Boolean);
  const after = (flag) => (args.includes(flag) ? Number(args[args.indexOf(flag) + 1]) : undefined);
  return {
    channel,
    releaseUrl: (env.TURTLZIM_RELEASE_URL ?? `https://github.com/${repo}/releases/download/${channel}`).replace(/\/+$/, ""),
    root: resolve(env.TURTLZIM_ROOT ?? "/opt/turtlzim"),
    data: resolve(env.ZIM_SERVER_DATA ?? "/var/lib/turtlzim"),
    etc: resolve(env.TURTLZIM_ETC ?? "/etc/turtlzim"),
    keep: whole(env.TURTLZIM_KEEP, 3, "TURTLZIM_KEEP"),
    unit: env.TURTLZIM_UNIT ?? "turtlzim.service",
    systemctl: (env.TURTLZIM_SYSTEMCTL ?? "systemctl --user").split(/\s+/).filter(Boolean),
    httpsPort: after("--port") ?? 8244,
    redirectPort: after("--redirect-port"),
    healthSeconds: whole(env.TURTLZIM_HEALTH_SECONDS, 90, "TURTLZIM_HEALTH_SECONDS"),
    pollMs: whole(env.TURTLZIM_POLL_MS, 1000, "TURTLZIM_POLL_MS"),
  };
}

/** An answer that is longer than it was allowed to be: told apart from a network that failed. */
const tooBig = (max) => Object.assign(new Error(`more than ${max} bytes`), { tooBig: true });
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isLoopback = (host) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// asking over the network

/**
 * A GET that follows redirects. Only https is asked (GitHub's downloads go through a redirect to its own storage); plain http only on this computer, for the machine's own checks and the tests, and a
 * certificate that nothing knows is accepted only there too: the server on this machine shows the certificate that it made for itself.
 */
function get(url, { timeoutMs = 30_000, insecure = false, redirects = 5, follow = true } = {}) {
  return new Promise((resolveGet, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error(`${url} is not an address`));
    }
    if (target.protocol === "http:" ? !isLoopback(target.hostname) : target.protocol !== "https:") {
      return reject(new Error(`${target.origin} is not an address that this program asks (https, or http on this computer)`));
    }
    const options = { timeout: timeoutMs, headers: { "user-agent": "turtlzim-update", accept: "*/*" } };
    if (target.protocol === "https:" && insecure && isLoopback(target.hostname)) options.rejectUnauthorized = false;
    const request = (target.protocol === "https:" ? https : http).get(target, options, (res) => {
      if (follow && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error("too many redirects"));
        return resolveGet(get(new URL(res.headers.location, target).href, { timeoutMs, insecure, redirects: redirects - 1, follow }));
      }
      resolveGet(res);
    });
    request.on("timeout", () => request.destroy(new Error(`no answer from ${target.host} in ${timeoutMs / 1000} s`)));
    request.on("error", reject);
  });
}

/** What an answer says, kept in memory (at most `max` bytes). */
function readBody(res, max) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) res.destroy(tooBig(max));
      else chunks.push(chunk);
    });
    res.on("end", () => resolveBody(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

/**
 * What an answer says, written to a file as it comes (at most `max` bytes), with the SHA-256 of it. Whoever asked is told only when the file is closed, whether it went well or not: nothing is left
 * going on behind a look that has ended.
 */
function saveBody(res, file, max) {
  return new Promise((resolveSave, reject) => {
    const hash = createHash("sha256");
    const out = createWriteStream(file, { mode: 0o600 });
    let size = 0;
    let failure = null;
    const fail = (error) => {
      failure ??= error;
      res.destroy();
      out.destroy();
    };
    out.on("error", fail);
    out.on("close", () => (failure ? reject(failure) : resolveSave({ size, sha256: hash.digest("hex") })));
    res.on("data", (chunk) => {
      if (failure) return;
      size += chunk.length;
      if (size > max) return fail(tooBig(max));
      hash.update(chunk);
      out.write(chunk);
    });
    res.on("end", () => !failure && out.end());
    // (a connection that is cut before the end is an error of the answer too)
    res.on("error", fail);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// what is on the machine

/** The version that `name` (`current`, `previous`) points at: `{ id, dir, commit }`, or null. */
function pointedAt(s, name) {
  try {
    const dir = resolve(s.root, readlinkSync(join(s.root, name)));
    return { id: basename(dir), dir, commit: JSON.parse(readFileSync(join(dir, "RELEASE.json"), "utf8")).commit };
  } catch {
    return null;
  }
}

/** Make `name` point at the version `id` in one step (a link made beside it and moved over it), or take it away if `id` is null. */
function point(s, name, id) {
  const link = join(s.root, name);
  if (id === null) return rmSync(link, { force: true });
  const next = join(s.root, `.${name}.new`);
  rmSync(next, { force: true });
  symlinkSync(join("releases", id), next);
  renameSync(next, link);
}

function systemctl(s, ...args) {
  return execFileSync(s.systemctl[0], [...s.systemctl.slice(1), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

/** Only one look at a time: a lock that a living process holds, for less than half an hour. */
function takeLock(s) {
  const file = join(s.root, ".update.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let alive = false;
      try {
        const pid = Number(readFileSync(file, "utf8"));
        process.kill(pid, 0);
        alive = Date.now() - statSync(file).mtimeMs < 30 * 60_000;
      } catch {
        // (nobody holds it)
      }
      if (alive) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

function writeStatus(s, result) {
  const file = join(s.root, "status.json");
  const next = `${file}.new`;
  writeFileSync(next, `${JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2)}\n`);
  renameSync(next, file);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// the checks

/** Whether `signature` is a good signature of `manifest` by a key that `signers` (an `allowed_signers` file) holds, in the namespace of the channel. */
function signedByUs(s, manifest, signature) {
  const namespace = `turtlzim-${s.channel}`;
  const file = join(s.root, ".manifest.sig");
  writeFileSync(file, signature, { mode: 0o600 });
  try {
    execFileSync("ssh-keygen", ["-Y", "verify", "-f", join(s.etc, "allowed_signers"), "-I", namespace, "-n", namespace, "-s", file], { input: manifest, stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(file, { force: true });
  }
}

/** The manifest, once it is known to be ours: its fields are looked at before anything of it is used. */
function readManifest(s, bytes) {
  let m;
  try {
    m = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Stop("refused", 4, "the manifest is signed but is not JSON");
  }
  const bad = (why) => new Stop("refused", 4, `the manifest is signed but ${why}`);
  if (m?.format !== FORMAT) throw bad(`is of format ${JSON.stringify(m?.format)}, not ${FORMAT}: this program has to be updated by whoever put it here`);
  if (m.channel !== s.channel) throw bad(`is for the channel ${JSON.stringify(m.channel)}, not ${s.channel}`);
  if (!/^[0-9a-f]{40}$/.test(m.commit ?? "")) throw bad("has no commit");
  if (!Number.isInteger(m.node?.major) || m.node.major < 1) throw bad("does not say which Node it needs");
  const archive = m.archive;
  if (archive?.name !== `turtlzim-${s.channel}.tar.gz` || !/^[0-9a-f]{64}$/.test(archive.sha256 ?? "") || !Number.isInteger(archive.size) || archive.size < 1 || archive.size > ARCHIVE_MAX) throw bad("does not describe its archive");
  if (m.web !== undefined && !/^[0-9a-f]{64}$/.test(m.web?.sw ?? "")) throw bad("has a service worker hash that is not one");
  return m;
}

/** The server, asked: does it answer as it should? `{ ok, why }`. */
async function answers(s, manifest) {
  try {
    const health = await get(`https://127.0.0.1:${s.httpsPort}/api/health`, { insecure: true, timeoutMs: 5000 });
    const body = await readBody(health, 4096);
    if (health.statusCode !== 200 || JSON.parse(body.toString("utf8")).ok !== true) return { ok: false, why: `/api/health said ${health.statusCode}` };
    if (manifest?.web?.sw) {
      const sw = await get(`https://127.0.0.1:${s.httpsPort}/sw.js`, { insecure: true, timeoutMs: 5000 });
      const served = sha256(await readBody(sw, 8 * 1048576));
      if (served !== manifest.web.sw) return { ok: false, why: "the service worker that it serves is not the one of the build that was published" };
    }
    if (s.redirectPort !== undefined) {
      const redirect = await get(`http://127.0.0.1:${s.redirectPort}/`, { timeoutMs: 5000, follow: false });
      redirect.resume();
      if (redirect.statusCode !== 307 || !String(redirect.headers.location).startsWith(`https://127.0.0.1:${s.httpsPort}/`)) return { ok: false, why: `its http port answered ${redirect.statusCode}, not a redirect to https` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, why: error.message };
  }
}

/** Wait for the server to answer as it should, for the time that is allowed. */
async function settle(s, manifest) {
  const until = Date.now() + s.healthSeconds * 1000;
  let last = { ok: false, why: "no answer yet" };
  while (Date.now() < until) {
    last = await answers(s, manifest);
    if (last.ok) return last;
    await sleep(s.pollMs);
  }
  return last;
}

/**
 * The new version started on its own, with a COPY of the backup that was just made (and nothing of the real settings or secrets: a clean environment), on ports that nobody has, over https as it will be: if it
 * comes up and answers, and its port that redirects does, then it can start here. `{ ok, why }`.
 */
async function tryOut(s, release, backup) {
  const scratch = mkdtempSync(join(s.root, ".preflight-"));
  let child;
  try {
    mkdirSync(join(scratch, "data"), { mode: 0o700 });
    mkdirSync(join(scratch, "state"), { mode: 0o700 });
    if (backup) {
      try {
        execFileSync(process.execPath, [backup.tool, "restore", backup.folder, "--data", join(scratch, "data")], { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
      } catch (error) {
        return { ok: false, why: `the backup could not be put in a place to try out the new version: ${String(error.stderr || error.message).trim()}` };
      }
    }
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, ZIM_SERVER_DATA: join(scratch, "data"), XDG_STATE_HOME: join(scratch, "state"), ZIM_BASE_URL: "https://127.0.0.1" };
    const args = [join(release, "server/src/main.mjs"), "--host", "127.0.0.1", "--port", "0", "--tls", "--name", "127.0.0.1", ...(s.redirectPort === undefined ? [] : ["--redirect-port", "0"]), "--dir", join(release, "web/dist")];
    child = spawn(process.execPath, args, { cwd: join(release, "server"), env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const up = await new Promise((resolveUp) => {
      const timer = setTimeout(() => resolveUp(false), 60_000);
      const look = () => output.includes("Data: ") && (clearTimeout(timer), resolveUp(true));
      child.stdout.on("data", look);
      child.on("exit", () => (clearTimeout(timer), resolveUp(false)));
    });
    const tail = () => output.trim().split("\n").slice(-4).join(" | ");
    if (!up) return { ok: false, why: `the new version did not come up on a copy of the data: ${tail()}` };
    const port = /https:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1];
    const redirectPort = /Plain http, on port (\d+)/.exec(output)?.[1];
    if (!port) return { ok: false, why: `the new version did not say where it listens: ${tail()}` };
    const probe = await answers({ ...s, httpsPort: Number(port), redirectPort: redirectPort === undefined ? undefined : Number(redirectPort) }, null);
    return probe.ok ? { ok: true } : { ok: false, why: `the new version came up on a copy of the data but ${probe.why}` };
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => {
        const timer = setTimeout(() => (child.kill("SIGKILL"), resolveExit()), 10_000);
        child.on("exit", () => (clearTimeout(timer), resolveExit()));
      });
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// the look

/**
 * One look at what is published, and what follows from it. `log` says each step. Returns `{ outcome, code, commit?, detail }`; it never throws for what the network, the files or the server do.
 */
export async function update(s, log = console.log) {
  mkdirSync(join(s.root, "releases"), { recursive: true });
  const release = takeLock(s);
  if (!release) {
    // (the status that is there is the one of the look that is going on: not overwritten)
    log("busy: another look is going on");
    return { outcome: "busy", code: 0, detail: "another look is going on" };
  }
  try {
    return report(s, log, await look(s, log));
  } catch (error) {
    if (error instanceof Stop) return report(s, log, { outcome: error.outcome, code: error.code, detail: error.message });
    return report(s, log, { outcome: "error", code: 1, detail: `unexpected: ${error.stack ?? error.message}` });
  } finally {
    release();
  }
}

function report(s, log, result) {
  log(`${result.outcome}${result.commit ? ` ${result.commit.slice(0, 12)}` : ""}: ${result.detail}`);
  try {
    writeStatus(s, result);
  } catch {
    // (a status that cannot be written is not worth stopping for)
  }
  return result;
}

async function look(s, log) {
  if (existsSync(join(s.etc, "pause"))) return { outcome: "paused", code: 0, detail: `${join(s.etc, "pause")} is there: no update until it is taken away` };
  if (!existsSync(join(s.etc, "allowed_signers"))) throw new Stop("refused", 4, `${join(s.etc, "allowed_signers")} is not there: there is no key to check what is published against`);
  for (const stale of readdirSync(join(s.root, "releases")).filter((name) => name.endsWith(".partial"))) rmSync(join(s.root, "releases", stale), { recursive: true, force: true });
  for (const stale of readdirSync(s.root).filter((name) => name.startsWith(".preflight-"))) rmSync(join(s.root, stale), { recursive: true, force: true });

  // 1. what is published: the manifest and its signature
  const names = { manifest: `turtlzim-${s.channel}.json`, signature: `turtlzim-${s.channel}.json.sig`, archive: `turtlzim-${s.channel}.tar.gz` };
  let manifestBytes;
  let signatureBytes;
  try {
    const manifestAnswer = await get(`${s.releaseUrl}/${names.manifest}`);
    if (manifestAnswer.statusCode === 404) {
      manifestAnswer.resume();
      return { outcome: "nothing-published", code: 0, detail: `${s.releaseUrl}/${names.manifest} is not there (yet)` };
    }
    if (manifestAnswer.statusCode !== 200) throw new Error(`the manifest was answered ${manifestAnswer.statusCode}`);
    manifestBytes = await readBody(manifestAnswer, MANIFEST_MAX);
    const signatureAnswer = await get(`${s.releaseUrl}/${names.signature}`);
    if (signatureAnswer.statusCode !== 200) throw new Error(`the signature was answered ${signatureAnswer.statusCode}`);
    signatureBytes = await readBody(signatureAnswer, SIGNATURE_MAX);
  } catch (error) {
    return { outcome: "unreachable", code: 0, detail: `what is published could not be read now (${error.message}): it will be looked at again` };
  }
  if (!signedByUs(s, manifestBytes, signatureBytes)) throw new Stop("not-ours", 3, "the manifest's signature is not a good one for the key of this machine: nothing was installed (it can be a look at the moment a new version was being put there; it will be looked at again)");
  const manifest = readManifest(s, manifestBytes);
  const id = manifest.commit.slice(0, 12);

  // 2. is there anything to do
  const here = pointedAt(s, "current");
  if (here?.commit === manifest.commit) return { outcome: "up-to-date", code: 0, commit: manifest.commit, detail: "this version is the one that is here" };
  if (existsSync(join(s.root, "failed", manifest.commit))) return { outcome: "skipped", code: 0, commit: manifest.commit, detail: `this version was tried here and did not work (${join(s.root, "failed", manifest.commit)}): it waits for a newer one` };
  const needs = manifest.node.major;
  if (Number(process.versions.node.split(".")[0]) < needs) throw new Stop("refused", 4, `the version asks for Node ${needs} and this is Node ${process.versions.node}: the machine's Node has to be brought up first (the provisioning script does)`);
  log(`a new version: ${manifest.commit.slice(0, 12)}, built ${manifest.built ?? "?"} (here: ${here ? here.commit.slice(0, 12) : "nothing yet"})`);
  const bad = (why) => {
    mkdirSync(join(s.root, "failed"), { recursive: true });
    writeFileSync(join(s.root, "failed", manifest.commit), `${JSON.stringify({ at: new Date().toISOString(), why })}\n`);
  };

  // 3. the archive, shown to be the one that the manifest describes
  const archive = join(s.root, `.${id}.tar.gz`);
  try {
    const answer = await get(`${s.releaseUrl}/${names.archive}`, { timeoutMs: 120_000 });
    if (answer.statusCode !== 200) throw new Error(`the archive was answered ${answer.statusCode}`);
    const saved = await saveBody(answer, archive, manifest.archive.size);
    if (saved.size !== manifest.archive.size || saved.sha256 !== manifest.archive.sha256) {
      throw new Stop("not-ours", 3, `the archive is not the one that the signed manifest describes (${saved.size} bytes, SHA-256 ${saved.sha256.slice(0, 16)}…): nothing was installed (it can be a look while the files were being replaced: it will be looked at again)`);
    }
  } catch (error) {
    rmSync(archive, { force: true });
    if (error instanceof Stop) throw error;
    if (error.tooBig) throw new Stop("not-ours", 3, `the archive is longer than the signed manifest says (${manifest.archive.size} bytes): nothing was installed`);
    return { outcome: "unreachable", code: 0, detail: `the archive could not be read now (${error.message}): it will be looked at again` };
  }

  // 4. unpacked beside the others
  const unpacked = join(s.root, "releases", `.${id}.partial`);
  const dir = join(s.root, "releases", id);
  try {
    mkdirSync(unpacked, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", unpacked, "--no-same-owner", "--no-same-permissions"], { stdio: ["ignore", "pipe", "pipe"] });
    const inside = JSON.parse(readFileSync(join(unpacked, "RELEASE.json"), "utf8"));
    if (inside.commit !== manifest.commit || inside.channel !== manifest.channel || inside.format !== FORMAT) throw new Error("the archive says it is another version than the manifest does");
    for (const need of NEEDED) if (!existsSync(join(unpacked, need))) throw new Error(`the archive lacks ${need}`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(unpacked, dir);
  } catch (error) {
    rmSync(unpacked, { recursive: true, force: true });
    bad(`it could not be unpacked: ${error.message}`);
    throw new Stop("refused", 4, `the archive could not be unpacked (${String(error.stderr || error.message).trim()}): nothing was changed`);
  } finally {
    rmSync(archive, { force: true });
  }

  // 5. a backup of what is there, then the new version on a copy of it
  let backup = null;
  if (here && existsSync(join(s.data, "zim.sqlite"))) {
    const tool = join(here.dir, "server/src/backup.mjs");
    try {
      const said = execFileSync(process.execPath, [tool, "backup", "--data", s.data], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
      const folder = /^backed up to (.+?) \(/m.exec(said)?.[1];
      if (!folder) throw new Error(`it did not say where the copy is: ${said.trim()}`);
      backup = { folder, tool };
      log(`backup: ${folder}`);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw new Stop("refused", 4, `no backup could be made, so nothing was changed (${String(error.stderr || error.message).trim()})`);
    }
  } else {
    log(here ? "no database yet: nothing to back up" : "first version on this machine: nothing to back up");
  }
  const tried = await tryOut(s, dir, backup);
  if (!tried.ok) {
    bad(tried.why);
    rmSync(dir, { recursive: true, force: true });
    throw new Stop("refused", 4, `${tried.why}: nothing was changed, and this version will not be tried again`);
  }
  log("the new version came up on a copy of the data and answered");

  // 6. it takes the place of the old one
  const before = here?.id ?? null;
  point(s, "previous", before);
  point(s, "current", id);
  systemctl(s, "restart", s.unit);
  log(`${s.unit} restarted on ${id}`);
  const asked = await settle(s, manifest);
  if (asked.ok) {
    prune(s, log);
    return { outcome: "installed", code: 0, commit: manifest.commit, detail: `now on ${id}` };
  }
  log(`the server does not answer as it should (${asked.why}): putting the old version back`);
  bad(asked.why);
  return await putBack(s, log, { before, backup, manifest, why: asked.why });
}

/** The new version does not work on the real data: the old one is put back, and if that does not answer either, the backup too. */
async function putBack(s, log, { before, backup, manifest, why }) {
  if (before === null) {
    // (the first version on this machine: with no `current`, the unit has nothing to start)
    point(s, "current", null);
    point(s, "previous", null);
    try {
      systemctl(s, "stop", s.unit);
    } catch {
      // (it may not be running)
    }
    return { outcome: "rolled-back", code: 1, commit: manifest.commit, detail: `the first version did not work (${why}); there is nothing to put back, so nothing runs` };
  }
  point(s, "current", before);
  point(s, "previous", null);
  systemctl(s, "restart", s.unit);
  if ((await settle(s, null)).ok) return { outcome: "rolled-back", code: 1, commit: manifest.commit, detail: `the new version did not work (${why}); ${before} is back and answers` };
  if (backup) {
    log("the old version does not answer on this data: a new version's migrations may have changed it; putting the backup back");
    try {
      systemctl(s, "stop", s.unit);
      execFileSync(process.execPath, [backup.tool, "restore", backup.folder, "--data", s.data], { stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
      systemctl(s, "restart", s.unit);
    } catch (error) {
      return { outcome: "needs-a-person", code: 5, commit: manifest.commit, detail: `neither version answers and the backup could not be put back (${String(error.stderr || error.message).trim()}): ${backup.folder}` };
    }
    if ((await settle(s, null)).ok) return { outcome: "rolled-back-and-restored", code: 1, commit: manifest.commit, detail: `the new version did not work (${why}); ${before} and the backup ${backup.folder} are back and answer` };
  }
  return { outcome: "needs-a-person", code: 5, commit: manifest.commit, detail: `neither version answers (${why})${backup ? `; the backup is ${backup.folder}` : ""}` };
}

/** Only the newest versions are kept, and never the one that runs or the one before it. */
function prune(s, log) {
  const keep = new Set([pointedAt(s, "current")?.id, pointedAt(s, "previous")?.id]);
  const versions = readdirSync(join(s.root, "releases"))
    .filter((name) => /^[0-9a-f]{12}$/.test(name))
    .map((name) => ({ name, at: statSync(join(s.root, "releases", name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const version of versions.slice(s.keep)) {
    if (keep.has(version.name)) continue;
    rmSync(join(s.root, "releases", version.name), { recursive: true, force: true });
    log(`removed the old version ${version.name}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let settings;
  try {
    settings = settingsFrom();
  } catch (error) {
    console.error(`turtlzim-update: ${error.message}`);
    process.exit(4);
  }
  update(settings).then((result) => (process.exitCode = result.code));
}
