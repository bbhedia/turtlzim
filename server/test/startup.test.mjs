// What the server says when it starts, over https: the person who runs it has to be told the fingerprint of the certificate that it presents, because an app of a computer or a phone asks the
// person to compare what it shows with that (docs/zim-server.md, *A server that the apps don't know the certificate of*). The server is started as a program, as `scripts/run.sh` does, with
// its state in a folder of its own (a certificate made here is not the live server's).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const dist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const folders = [];
const children = [];
// (a server that a failed test left running would keep the whole run from ending)
after(() => {
  children.forEach((child) => child.kill("SIGKILL"));
  folders.forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});

/** Start the server over https on a free port, wait for what it prints about its certificate, and give what it printed, its port and the state folder; `stop` ends it. */
async function start() {
  const state = mkdtempSync(join(tmpdir(), "zim-server-startup-"));
  folders.push(state);
  const child = spawn(process.execPath, [main, "--dir", dist, "--host", "127.0.0.1", "--port", "0", "--tls", "--name", "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, XDG_STATE_HOME: join(state, "state"), ZIM_SERVER_DATA: join(state, "data"), ZIM_BASE_URL: "https://127.0.0.1" },
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the server did not say its fingerprint: ${output}`));
    }, 20_000);
    const look = () => {
      if (output.includes("SHA-256 fingerprint:")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", look);
    child.on("exit", () => reject(new Error(`the server ended: ${output}`)));
  });
  const port = Number(/https:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1]);
  const stop = () => new Promise((resolve) => (child.once("exit", resolve), child.kill("SIGTERM")));
  return { output, port, state, stop };
}

describe("the server started over https", () => {
  it("tells the fingerprint of the certificate that it presents (not the authority's), the names it is for, and what an app does with it", async () => {
    const server = await start();
    try {
      const certificate = new X509Certificate(readFileSync(join(server.state, "state", "zim-web", "tls", "cert.pem")));
      const authority = new X509Certificate(readFileSync(join(server.state, "state", "zim-web", "tls", "ca.pem")));
      assert.notEqual(certificate.fingerprint256, authority.fingerprint256);
      assert.match(server.output, new RegExp(`The server's own certificate, SHA-256 fingerprint: ${certificate.fingerprint256} \\(`));
      assert.ok(!server.output.includes(`SHA-256 fingerprint: ${authority.fingerprint256}`), "the authority's fingerprint is not given as the certificate's");
      assert.match(server.output, /trust it only if it shows exactly this/);
      assert.match(server.output, /it will ask again when the certificate is made again/);
      // the authority's own is given too, for a browser that is asked to trust it, and it is the authority's
      assert.ok(server.output.includes(authority.fingerprint256), "the authority's fingerprint is told, as what a browser is asked to trust");
      assert.match(server.output, /The certificate is for .*127\.0\.0\.1/);
      // and it is the certificate that a client sees in the handshake: what an app computes is what the server printed
      const shown = await new Promise((resolve, reject) => {
        const socket = tls.connect({ host: "127.0.0.1", port: server.port, rejectUnauthorized: false }, () => {
          const { fingerprint256 } = socket.getPeerCertificate();
          socket.end();
          resolve(fingerprint256);
        });
        socket.on("error", reject);
      });
      assert.equal(shown, certificate.fingerprint256);
    } finally {
      await server.stop();
    }
  });

  it("is not told anything of a certificate when it speaks plain http", async () => {
    const state = mkdtempSync(join(tmpdir(), "zim-server-startup-"));
    folders.push(state);
    const child = spawn(process.execPath, [main, "--dir", dist, "--host", "127.0.0.1", "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, XDG_STATE_HOME: join(state, "state"), ZIM_SERVER_DATA: join(state, "data"), ZIM_BASE_URL: "http://127.0.0.1" },
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the server did not start: ${output}`));
      }, 20_000);
      child.stdout.on("data", () => {
        if (output.includes("Data:")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    try {
      assert.ok(!output.includes("fingerprint"), output);
    } finally {
      await new Promise((resolve) => (child.once("exit", resolve), child.kill("SIGTERM")));
    }
  });
});

describe("the server's settings for hashing passwords", () => {
  /** Start the server (no https) with these settings, and give what it printed until it said where its data is, or until it ended, with the status it ended with (null if it was still there). */
  async function startedWith(settings) {
    const state = mkdtempSync(join(tmpdir(), "zim-server-hash-"));
    folders.push(state);
    const child = spawn(process.execPath, [main, "--dir", dist, "--host", "127.0.0.1", "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, XDG_STATE_HOME: join(state, "state"), ZIM_SERVER_DATA: join(state, "data"), ZIM_BASE_URL: "http://127.0.0.1", ...settings },
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the server neither said where its data is nor ended: ${output}`));
      }, 20_000);
      child.stdout.on("data", () => {
        if (output.includes("Data: ")) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(null);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    return { output, status };
  }

  it("says how many passwords it hashes at a time and how many may wait, as it was told, and by default as the code says", async () => {
    const told = await startedWith({ ZIM_HASH_SLOTS: "3", ZIM_HASH_QUEUE: "11" });
    assert.match(told.output, /Passwords are hashed 3 at a time, and 11 may wait for their turn/);
    const unsaid = await startedWith({ ZIM_HASH_SLOTS: "", ZIM_HASH_QUEUE: "" });
    assert.ok(unsaid.output.includes(`Passwords are hashed ${Math.max(1, Math.floor(availableParallelism() / 2))} at a time, and 64 may wait for their turn`), unsaid.output);
  });

  it("does not start with a setting that is not a whole number of at least one, and says which", async () => {
    const refused = await startedWith({ ZIM_HASH_QUEUE: "lots" });
    assert.equal(refused.status, 2);
    assert.match(refused.output, /server: ZIM_HASH_QUEUE must be a whole number of at least 1 \(it is "lots"\)/);
    assert.doesNotMatch(refused.output, /Serving/);
  });
});
