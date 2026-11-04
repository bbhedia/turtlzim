// The look from the outside (scripts/deploy/smoke-test.mjs, docs/zim-delivery.md), tried against the real server started as a program, with its http port that redirects, and against servers that are not right.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { smokeTest } from "../../scripts/deploy/smoke-test.mjs";

const main = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const dist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/deploy/smoke-test.mjs", import.meta.url));
const folders = [];
const children = [];
const servers = [];
after(() => {
  children.forEach((child) => child.kill("SIGKILL"));
  servers.forEach((server) => (server.close(), server.closeAllConnections()));
  folders.forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});

describe("the look from the outside", () => {
  let state, httpsPort, redirectPort;
  before(async () => {
    state = mkdtempSync(join(tmpdir(), "zim-smoke-"));
    folders.push(state);
    const child = spawn(process.execPath, [main, "--dir", dist, "--host", "127.0.0.1", "--port", "0", "--tls", "--name", "127.0.0.1", "--redirect-port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, XDG_STATE_HOME: join(state, "state"), ZIM_SERVER_DATA: join(state, "data"), ZIM_BASE_URL: "https://127.0.0.1" },
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`it did not start: ${output}`)), 20_000);
      child.stdout.on("data", () => output.includes("Data: ") && (clearTimeout(timer), resolve()));
      child.on("exit", () => reject(new Error(`it ended: ${output}`)));
    });
    httpsPort = /https:\/\/127\.0\.0\.1:(\d+)\//.exec(output)[1];
    redirectPort = /Plain http, on port (\d+)/.exec(output)[1];
  });

  it("finds a server that is right right: it answers, serves the web app and the service worker that it should, redirects from its http port, and tells the certificate that it shows", async () => {
    const sw = createHash("sha256").update(readFileSync(join(dist, "sw.js"))).digest("hex");
    const certificate = new X509Certificate(readFileSync(join(state, "state", "zim-web", "tls", "cert.pem")));
    const result = await smokeTest({ address: `https://127.0.0.1:${httpsPort}`, insecure: true, sw, redirect: `http://127.0.0.1:${redirectPort}/` });
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.equal(result.lines.length, 6);
    assert.ok(result.lines.every((line) => line.startsWith("ok ")), result.lines.join("\n"));
    assert.ok(result.lines[0].includes(certificate.fingerprint256), "the fingerprint of the certificate that the server shows");
    assert.match(result.lines.join("\n"), /307 to https:\/\/127\.0\.0\.1:\d+\//);
  });

  it("does not accept a certificate that nothing knows unless it is told to, and says so", async () => {
    const result = await smokeTest({ address: `https://127.0.0.1:${httpsPort}` });
    assert.equal(result.ok, false);
    assert.ok(result.lines.some((line) => /^FAIL  \/api\/health: .*(self[- ]signed|certificate|unable to verify)/i.test(line)), result.lines.join("\n"));
  });

  it("says that a server serves another build than the one that was published, and that an http port does not redirect", async () => {
    const result = await smokeTest({ address: `https://127.0.0.1:${httpsPort}`, insecure: true, sw: "0".repeat(64), redirect: `https://127.0.0.1:${httpsPort}/` });
    assert.equal(result.ok, false);
    assert.ok(result.lines.some((line) => /^FAIL  \/sw\.js .*is not the 0{64} of the build that was published/.test(line)), result.lines.join("\n"));
    assert.ok(result.lines.some((line) => /^FAIL  https:\/\/127\.0\.0\.1:\d+\/ \(the http port\): 200, not a redirect to https/.test(line)), result.lines.join("\n"));
  });

  it("says that nothing answers, and that something answers wrongly", async () => {
    const closed = await smokeTest({ address: "http://127.0.0.1:1" });
    assert.equal(closed.ok, false);
    assert.ok(closed.lines.some((line) => /^FAIL  \/api\/health: .*ECONNREFUSED/.test(line)), closed.lines.join("\n"));
    const wrong = http.createServer((req, res) => (res.writeHead(req.url === "/api/health" ? 500 : 404), res.end("no")));
    servers.push(wrong);
    await new Promise((resolve) => wrong.listen(0, "127.0.0.1", resolve));
    const result = await smokeTest({ address: `http://127.0.0.1:${wrong.address().port}` });
    assert.equal(result.ok, false);
    assert.ok(result.lines.some((line) => /^FAIL  \/api\/health: 500, not \{"ok":true\}/.test(line)), result.lines.join("\n"));
    assert.ok(result.lines.some((line) => /^FAIL  \/ \(the web app\): 404/.test(line)), result.lines.join("\n"));
  });

  it("is not satisfied by a health that says it is not ok, nor by a redirect that is not a temporary one", async () => {
    const odd = http.createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"ok":false}');
      }
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html><body>no title here</body></html>");
      }
      res.writeHead(301, { location: `https://127.0.0.1${req.url}` });
      res.end();
    });
    servers.push(odd);
    await new Promise((resolve) => odd.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${odd.address().port}`;
    const result = await smokeTest({ address, redirect: `${address}/r` });
    assert.equal(result.ok, false);
    assert.ok(result.lines.some((line) => /^FAIL  \/api\/health: 200, not \{"ok":true\}/.test(line)), result.lines.join("\n"));
    assert.ok(result.lines.some((line) => /^FAIL  \/ \(the web app\): 200, no page with a title/.test(line)), result.lines.join("\n"));
    assert.ok(result.lines.some((line) => /^FAIL  http:\/\/127\.0\.0\.1:\d+\/r \(the http port\): 301 to https:\/\/127\.0\.0\.1\/r/.test(line)), result.lines.join("\n"));
  });

  it("is a program that says it in its exit status, and refuses what it cannot read", () => {
    const good = spawnSync(process.execPath, [script, `https://127.0.0.1:${httpsPort}`, "--insecure"], { encoding: "utf8" });
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /^ok    certificate: SHA-256 /m);
    const bad = spawnSync(process.execPath, [script, "http://127.0.0.1:1"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
    assert.match(spawnSync(process.execPath, [script, "http://x", "--sw", "nope"], { encoding: "utf8" }).stderr, /--sw is a SHA-256 in hexadecimal/);
    assert.match(execFileSync(process.execPath, [script, `https://127.0.0.1:${httpsPort}`, "--insecure", "--redirect", `http://127.0.0.1:${redirectPort}/`], { encoding: "utf8" }), /\(the http port\): 307 to/);
  });
});
