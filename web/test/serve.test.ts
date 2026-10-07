import { spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticServer, selfSignedCertificate, urlsFor } from "../scripts/serve.mjs";

// A site in a temp directory next to a secret that is *not* in it: nothing may ever return the secret.
const SECRET = "the secret outside the site";
let outside: string;
let site: string;
const servers: http.Server[] = [];

beforeAll(() => {
  outside = mkdtempSync(join(tmpdir(), "zim-serve-test-"));
  site = join(outside, "site");
  mkdirSync(join(site, "assets"), { recursive: true });
  writeFileSync(join(outside, "secret.txt"), SECRET);
  writeFileSync(join(site, "index.html"), "<!doctype html><title>Zim</title><p>" + "hello ".repeat(200));
  writeFileSync(join(site, "assets", "app-3f9a1c.js"), "export const x = 1;\n".repeat(100));
  writeFileSync(join(site, "assets", "zim_bg-77aa.wasm"), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  writeFileSync(join(site, ".env"), "TOKEN=hidden");
  writeFileSync(join(site, "assets", ".hidden"), "hidden");
  symlinkSync(join(outside, "secret.txt"), join(site, "link-to-secret.txt"));
  symlinkSync(outside, join(site, "link-to-outside"));
});

afterAll(() => {
  for (const server of servers) server.close();
  rmSync(outside, { recursive: true, force: true });
});

async function start(options: { auth?: string } = {}): Promise<number> {
  const server = createStaticServer({ dir: site, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A raw request: the path goes out exactly as given (a client library would tidy `/../` away). */
function request(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("what it serves", () => {
  it("the page at / and /index.html, with security headers", async () => {
    const port = await start();
    for (const path of ["/", "/index.html", "/?utm=1", "/#frag"]) {
      const reply = await request(port, path);
      expect(reply.status, path).toBe(200);
      expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(reply.body.toString()).toContain("<title>Zim</title>");
    }
    const { headers } = await request(port, "/");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    const csp = String(headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("wasm as application/wasm and scripts as JavaScript", async () => {
    const port = await start();
    expect((await request(port, "/assets/zim_bg-77aa.wasm")).headers["content-type"]).toBe("application/wasm");
    expect((await request(port, "/assets/app-3f9a1c.js")).headers["content-type"]).toBe("text/javascript; charset=utf-8");
  });

  it("caches hashed assets for good and makes the page revalidate", async () => {
    const port = await start();
    expect((await request(port, "/assets/app-3f9a1c.js")).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await request(port, "/")).headers["cache-control"]).toBe("no-cache");
  });

  it("compresses what compresses, only for clients that ask, and says so", async () => {
    const port = await start();
    const plain = await request(port, "/assets/app-3f9a1c.js");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const zipped = await request(port, "/assets/app-3f9a1c.js", { headers: { "accept-encoding": "gzip, deflate, br" } });
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.headers["vary"]).toBe("Accept-Encoding");
    expect(zipped.body.length).toBeLessThan(plain.body.length);
    expect(Number(zipped.headers["content-length"])).toBe(zipped.body.length);
    expect(gunzipSync(zipped.body).equals(plain.body)).toBe(true);
  });

  it("answers a repeat request with 304 when the tag matches", async () => {
    const port = await start();
    const first = await request(port, "/");
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^W\/"/);
    const again = await request(port, "/", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect((await request(port, "/", { headers: { "if-none-match": 'W/"stale"' } })).status).toBe(200);
  });

  it("sends the new file after it changes on disk", async () => {
    const port = await start();
    writeFileSync(join(site, "changing.txt"), "one");
    expect((await request(port, "/changing.txt")).body.toString()).toBe("one");
    writeFileSync(join(site, "changing.txt"), "two!");
    expect((await request(port, "/changing.txt")).body.toString()).toBe("two!");
  });

  it("only GET and HEAD, and HEAD has the headers without the body", async () => {
    const port = await start();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const reply = await request(port, "/", { method });
      expect(reply.status, method).toBe(405);
      expect(reply.headers.allow).toBe("GET, HEAD");
    }
    const head = await request(port, "/", { method: "HEAD" });
    const get = await request(port, "/");
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
  });
});

describe("what it refuses", () => {
  const attempts = [
    "/../secret.txt",
    "/assets/../../secret.txt",
    "/..%2fsecret.txt",
    "/%2e%2e%2fsecret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/%2e%2e/secret.txt",
    "/%252e%252e%252fsecret.txt",
    "/..\\secret.txt",
    "/assets/..\\..\\secret.txt",
    "//secret.txt",
    "/./../secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/index.html%00.txt",
    "/%00",
    "/%E0%A4%A", // not valid percent-encoding
    "http://evil.example/../../secret.txt", // absolute-form target
    "/secret.txt",
  ];

  it("never returns anything from outside the directory", async () => {
    const port = await start();
    for (const path of attempts) {
      const reply = await request(port, path);
      expect(reply.body.toString(), path).not.toContain(SECRET);
      expect([400, 404], path).toContain(reply.status);
    }
  });

  it("does not follow a symlink out of the directory", async () => {
    const port = await start();
    for (const path of ["/link-to-secret.txt", "/link-to-outside/secret.txt", "/link-to-outside"]) {
      const reply = await request(port, path);
      expect(reply.status, path).toBe(404);
      expect(reply.body.toString(), path).not.toContain(SECRET);
    }
  });

  it("never serves dotfiles, and never lists a directory", async () => {
    const port = await start();
    for (const path of ["/.env", "/assets/.hidden", "/.git/config", "/assets/", "/assets", "/nope", "/assets/missing.js"]) {
      const reply = await request(port, path);
      expect(reply.status, path).toBe(404);
      expect(reply.body.toString(), path).not.toMatch(/TOKEN|hidden|app-3f9a1c/);
    }
  });
});

describe("password protection", () => {
  const credentials = (value: string) => ({ authorization: `Basic ${Buffer.from(value).toString("base64")}` });

  it("asks, rejects the wrong password, and accepts the right one", async () => {
    const port = await start({ auth: "zim:s3cret pass" });
    const anonymous = await request(port, "/");
    expect(anonymous.status).toBe(401);
    expect(String(anonymous.headers["www-authenticate"])).toContain("Basic");
    expect(anonymous.body.toString()).not.toContain("Zim");
    expect((await request(port, "/", { headers: credentials("zim:wrong") })).status).toBe(401);
    expect((await request(port, "/", { headers: credentials("other:s3cret pass") })).status).toBe(401);
    expect((await request(port, "/", { headers: { authorization: "Bearer s3cret pass" } })).status).toBe(401);
    expect((await request(port, "/", { headers: credentials("zim:s3cret pass") })).status).toBe(200);
  });

  it("reveals nothing about which files exist, and still sends the security headers", async () => {
    const port = await start({ auth: "zim:pw" });
    const missing = await request(port, "/does-not-exist");
    const present = await request(port, "/assets/app-3f9a1c.js");
    expect([missing.status, present.status]).toEqual([401, 401]);
    expect(missing.headers["content-security-policy"]).toBeDefined();
  });
});

describe("addresses", () => {
  it("a single host is a single URL, with IPv6 in brackets", () => {
    expect(urlsFor("127.0.0.1", 8080)).toEqual(["http://127.0.0.1:8080/"]);
    expect(urlsFor("::1", 9000)).toEqual(["http://[::1]:9000/"]);
    expect(urlsFor("example.org", 80)).toEqual(["http://example.org:80/"]);
  });

  it("a wildcard lists the machine's real addresses, never loopback or link-local", () => {
    for (const host of ["0.0.0.0", "::"]) {
      for (const url of urlsFor(host, 8080)) {
        expect(url).toMatch(/^http:\/\/(\[[0-9a-f:]+\]|[0-9.]+):8080\/$/);
        expect(url).not.toContain("127.0.0.1");
        expect(url).not.toContain("fe80");
      }
    }
    expect(urlsFor("0.0.0.0", 8080).every((url) => !url.includes("["))).toBe(true);
  });
});

describe("the command line", () => {
  const script = fileURLToPath(new URL("../scripts/serve.mjs", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("explains itself, and refuses nonsense", () => {
    expect(run("--help").stdout).toContain("Usage:");
    expect(run("--port", "70000").status).toBe(2);
    expect(run("--port", "abc").stderr).toContain("--port");
    expect(run("--bogus").stderr).toContain("unknown option --bogus");
    expect(run("--host").stderr).toContain("needs a value");
    expect(run("--auth", "nopassword").stderr).toContain("user:password");
  });

  it("won't start without a build to serve", () => {
    const result = run("--dir", join(outside, "no-such-build"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm run build");
  });

  it("serves, reports its address and pid, and cleans up when told to stop", async () => {
    const pidFile = join(outside, "serve.pid");
    const child = spawn(process.execPath, [script, "--dir", site, "--port", "0", "--pid-file", pidFile], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no address announced: ${output}`)), 8000);
      child.stdout.on("data", () => {
        const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    expect(url).not.toContain(":0/");
    const port = Number(new URL(url).port);
    expect((await request(port, "/")).status).toBe(200);
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(child.pid));
    const exit = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    expect(await exit).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
  });
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!hasOpenssl)("https", () => {
  /** GET `path` over https from a server whose certificate nobody signed. */
  const secureRequest = (port: number, path: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      https
        .get({ host: "127.0.0.1", port, path, rejectUnauthorized: false }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on("error", reject);
    });

  it("makes a certificate that names this machine, and keeps it until the machine's addresses change", () => {
    const directory = join(outside, "tls-1");
    const first = selfSignedCertificate(directory);
    const parsed = new X509Certificate(first.cert);
    expect(parsed.subjectAltName).toContain("DNS:localhost");
    expect(parsed.subjectAltName).toContain("IP Address:127.0.0.1");
    // for the day it is needed: a private key that only its owner can read
    expect(statSync(join(directory, "key.pem")).mode & 0o077).toBe(0);
    // asked again, it is the same one (not another every time the server starts)
    expect(selfSignedCertificate(directory).cert.equals(first.cert)).toBe(true);
    // the machine's addresses changed: a certificate for the old ones is no use
    writeFileSync(join(directory, "names.txt"), "IP:10.9.8.7");
    const second = selfSignedCertificate(directory);
    expect(second.cert.equals(first.cert)).toBe(false);
    // and one that is nearly a year old is made again
    const old = new Date(Date.now() - 301 * 24 * 3600 * 1000);
    utimesSync(join(directory, "cert.pem"), old, old);
    expect(selfSignedCertificate(directory).cert.equals(second.cert)).toBe(false);
  });

  it("serves the same site with the same security headers, and plain http gets nothing from it", async () => {
    const server = createStaticServer({ dir: site, tls: selfSignedCertificate(join(outside, "tls-2")) });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const res = await secureRequest(port, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect((await secureRequest(port, "/../secret.txt")).status).toBe(404);
    await expect(request(port, "/")).rejects.toThrow();
  });

  it("is asked for on the command line, and says that the certificate is its own", async () => {
    const state = join(outside, "state");
    const child = spawn(process.execPath, [script(), "--dir", site, "--port", "0", "--tls"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: state } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no address announced: ${output}`)), 15000);
      child.stdout.on("data", () => {
        const match = /https:\/\/127\.0\.0\.1:\d+\//.exec(output);
        // (what it says about the certificate comes in the lines after the address: wait for all that is asserted on)
        if (match && output.includes("self-signed")) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    try {
      expect(output).toContain("over https");
      expect(output).toContain("self-signed");
      expect((await secureRequest(Number(new URL(url).port), "/")).status).toBe(200);
      expect(existsSync(join(state, "zim-web", "tls", "cert.pem"))).toBe(true);
    } finally {
      const exit = new Promise<number | null>((resolve) => child.on("exit", resolve));
      child.kill("SIGTERM");
      await exit;
    }
  });

  it("takes a certificate of one's own, and refuses half of one or two kinds", () => {
    const own = selfSignedCertificate(join(outside, "tls-own"));
    const files = { cert: join(outside, "tls-own", "cert.pem"), key: join(outside, "tls-own", "key.pem") };
    expect(own.cert.length).toBeGreaterThan(0);
    const run = (...args: string[]) => spawnSync(process.execPath, [script(), ...args], { encoding: "utf8" });
    expect(run("--cert", files.cert).stderr).toContain("--cert and --key go together");
    expect(run("--key", files.key).stderr).toContain("--cert and --key go together");
    expect(run("--tls", "--cert", files.cert, "--key", files.key).stderr).toContain("not both");
    expect(run("--dir", site, "--cert", join(outside, "nothing.pem"), "--key", files.key).stderr).toContain("serve:");
  });

  it("names https in the addresses it announces", () => {
    expect(urlsFor("127.0.0.1", 8443, "https")).toEqual(["https://127.0.0.1:8443/"]);
    expect(urlsFor("::1", 8443, "https")).toEqual(["https://[::1]:8443/"]);
  });
});

function script() {
  return fileURLToPath(new URL("../scripts/serve.mjs", import.meta.url));
}
