import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, certificateName, createStaticServer, selfSignedCertificate, urlsFor } from "../scripts/serve.mjs";

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
  it("says that no accounts are on offer (not an error) where there is no account server, and hands /api/ to the account server where there is one", async () => {
    const plain = await request(await start(), "/api/providers");
    expect(plain.status).toBe(200);
    expect(JSON.parse(plain.body.toString())).toEqual({ email: false, providers: [] });
    expect((await request(await start(), "/api/me")).status).toBe(404);
    const server = createStaticServer({
      dir: site,
      api: (req, res) => {
        if (req.url !== "/api/hello") return false;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("from the api");
        return true;
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const answered = await request(port, "/api/hello");
    expect(answered.body.toString()).toBe("from the api");
    expect(answered.headers["x-content-type-options"]).toBe("nosniff");
    expect((await request(port, "/api/other")).status).toBe(404);
    expect((await request(port, "/api/providers")).status).toBe(404);
    expect((await request(port, "/apiary.html")).status).toBe(404);
  });

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

describe("a file given out from outside the site", () => {
  const given = (app: string, options: { auth?: string } = {}) => {
    const server = createStaticServer({ dir: site, downloads: [{ path: "/zim-notebook.apk", file: app }], ...options });
    return new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        servers.push(server);
        resolve((server.address() as AddressInfo).port);
      }),
    );
  };

  it("is a download at the one address it was given, and nothing else of its folder is reachable through it", async () => {
    const app = join(outside, "zim-notebook.apk");
    writeFileSync(app, Buffer.from("PK-an-app"));
    const port = await given(app);
    const reply = await request(port, "/zim-notebook.apk");
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toBe("PK-an-app");
    expect(reply.headers["content-type"]).toBe("application/vnd.android.package-archive");
    expect(reply.headers["content-disposition"]).toBe('attachment; filename="zim-notebook.apk"');
    expect(reply.headers["content-length"]).toBe("9");
    expect(reply.headers["cache-control"]).toBe("no-cache");
    expect(reply.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect((await request(port, "/zim-notebook.apk?download=1")).status).toBe(200);
    const head = await request(port, "/zim-notebook.apk", { method: "HEAD" });
    expect([head.status, head.body.length, head.headers["content-length"]]).toEqual([200, 0, "9"]);
    // (that address as a whole: not under it, not in another case, and not the folder that the file is in)
    for (const path of ["/zim-notebook.apk/", "/zim-notebook.apk/x", "/ZIM-NOTEBOOK.APK", "/secret.txt", "/%2e%2e/zim-notebook.apk", "/site/../zim-notebook.apk"]) expect((await request(port, path)).status, path).toBe(404);
    // the site is as it was
    expect((await request(port, "/")).status).toBe(200);
  });

  it("is found when the file is made, and goes when it does (the app is built after the server starts, and again after that)", async () => {
    const app = join(outside, "built-later.apk");
    const port = await given(app);
    expect((await request(port, "/zim-notebook.apk")).status).toBe(404);
    writeFileSync(app, Buffer.from("PK-first"));
    expect((await request(port, "/zim-notebook.apk")).body.toString()).toBe("PK-first");
    writeFileSync(app, Buffer.from("PK-a-newer-one"));
    expect((await request(port, "/zim-notebook.apk")).body.toString()).toBe("PK-a-newer-one");
    rmSync(app);
    expect((await request(port, "/zim-notebook.apk")).status).toBe(404);
  });

  it("asks for the password first, like the rest", async () => {
    const app = join(outside, "protected.apk");
    writeFileSync(app, Buffer.from("PK-private"));
    const port = await given(app, { auth: "me:secret" });
    expect((await request(port, "/zim-notebook.apk")).status).toBe(401);
    const authorised = await request(port, "/zim-notebook.apk", { headers: { authorization: `Basic ${Buffer.from("me:secret").toString("base64")}` } });
    expect([authorised.status, authorised.body.toString()]).toEqual([200, "PK-private"]);
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

  it("takes --download as an address and a file, and refuses anything else", () => {
    for (const bad of ["/app.apk", "app.apk=file", "/=file", "/a/../b=file", "/a b=file", "/app.apk=", "//app.apk=file", "/a?x=file"]) {
      const result = run("--download", bad);
      expect([bad, result.status, result.stderr.includes("--download must look like")]).toEqual([bad, 2, true]);
    }
    expect(run("--download").stderr).toContain("needs a value");
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
    // (an older certificate, made before there was an authority to go with it, is made again)
    rmSync(join(directory, "ca.pem"));
    expect(selfSignedCertificate(directory).cert.equals(first.cert)).toBe(false);
    first.cert = selfSignedCertificate(directory).cert;
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

  it("names the addresses and host names it is given, and not the machine's own unless asked, so that the name visitors use is in it", () => {
    const made = selfSignedCertificate(join(outside, "tls-names"), ["130.180.221.123", "Notes.Example.org"]);
    expect([...made.names].sort()).toEqual(["127.0.0.1", "130.180.221.123", "::1", "localhost", "notes.example.org"]);
    const parsed = new X509Certificate(made.cert);
    expect(parsed.subjectAltName).toContain("IP Address:130.180.221.123");
    expect(parsed.subjectAltName).toContain("DNS:notes.example.org");
    for (const addresses of Object.values(networkInterfaces())) {
      for (const a of addresses ?? []) if (a.family === "IPv4" && !a.internal && a.address !== "130.180.221.123") expect(parsed.subjectAltName).not.toContain(`IP Address:${a.address}`);
    }
    // another set of names is another certificate, and the same names are the same one
    const directory = join(outside, "tls-names");
    expect(selfSignedCertificate(directory, ["notes.example.org", "130.180.221.123"]).cert.equals(made.cert)).toBe(true);
    expect(selfSignedCertificate(directory, ["130.180.221.123"]).cert.equals(made.cert)).toBe(false);
  });

  it("is a server's certificate and not an authority's: it can sign nothing", () => {
    const made = selfSignedCertificate(join(outside, "tls-server"), ["130.180.221.123"]);
    expect(new X509Certificate(made.cert).ca).toBe(false);
    const text = execFileSync("openssl", ["x509", "-noout", "-text"], { input: made.cert, encoding: "utf8" });
    expect(text).toContain("CA:FALSE");
    expect(text).toContain("TLS Web Server Authentication");
    expect(text).not.toContain("Certificate Sign");
  });

  it("is signed by an authority that can vouch for these names and no others, and that has no key any more", () => {
    const directory = join(outside, "tls-authority");
    const made = selfSignedCertificate(directory, ["130.180.221.123", "notes.example.org"]);
    // nothing is left of the authority's key, or of what was used to sign with it
    expect(readdirSync(directory).sort()).toEqual(["ca.pem", "cert.pem", "key.pem", "names.txt"]);
    const text = execFileSync("openssl", ["x509", "-in", join(directory, "ca.pem"), "-noout", "-text"], { encoding: "utf8" });
    expect(text).toContain("CA:TRUE, pathlen:0");
    expect(text).toMatch(/X509v3 Name Constraints: critical/);
    expect(text).toContain("IP:130.180.221.123/255.255.255.255");
    expect(text).toContain("DNS:notes.example.org");
    expect(text).not.toContain("Digital Signature");
    // the server's certificate checks out against it for each of its names, and for no other
    const verify = (...args: string[]) => spawnSync("openssl", ["verify", "-CAfile", join(directory, "ca.pem"), ...args, join(directory, "cert.pem")], { encoding: "utf8" });
    for (const ip of ["130.180.221.123", "127.0.0.1"]) expect(verify("-verify_ip", ip).status, ip).toBe(0);
    for (const host of ["notes.example.org", "localhost"]) expect(verify("-verify_hostname", host).status, host).toBe(0);
    for (const ip of ["1.2.3.4", "130.180.221.124"]) expect(verify("-verify_ip", ip).status, ip).not.toBe(0);
    expect(verify("-verify_hostname", "evil.example.com").status).not.toBe(0);
    // what it says to check is the authority's fingerprint
    expect(made.fingerprint).toBe(new X509Certificate(readFileSync(join(directory, "ca.pem"))).fingerprint256);
    expect(made.authorityFile).toBe(join(directory, "ca.pem"));
    // and, for an app that pins the server's own certificate, the fingerprint of that one (which is not the authority's, and is the first of what the server sends)
    expect(made.certificateFingerprint).toBe(new X509Certificate(readFileSync(join(directory, "cert.pem"))).fingerprint256);
    expect(made.certificateFingerprint).toBe(new X509Certificate(made.cert).fingerprint256);
    expect(made.certificateFingerprint).not.toBe(made.fingerprint);
  });

  it("presents the certificate whose fingerprint it announces: what an app that pins it computes from the handshake is that fingerprint", async () => {
    const made = selfSignedCertificate(join(outside, "tls-presented"), ["127.0.0.1"]);
    const server = createStaticServer({ dir: site, tls: { key: made.key, cert: made.cert }, authority: made.authority });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const presented = await new Promise<string>((resolve, reject) => {
      const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        resolve(createHash("sha256").update(certificate.raw).digest("hex").toUpperCase().replace(/(..)(?=.)/g, "$1:"));
      });
      socket.on("error", reject);
    });
    expect(presented).toBe(made.certificateFingerprint);
  });

  it("takes only names: an address or a host name, nothing that openssl's settings would read as something else", () => {
    expect(certificateName("Notes.Example.org")).toBe("DNS:notes.example.org");
    expect(certificateName(" 130.180.221.123 ")).toBe("IP:130.180.221.123");
    expect(certificateName("2A05:6E02::1")).toBe("IP:2a05:6e02::1");
    expect(certificateName("my-host")).toBe("DNS:my-host");
    for (const bad of ["", "two words", "a;b", "x,DNS:evil.test", "1.2.3.4/8", "999.1.1.1", "fe80::1%eth0", "-leading.test", "trailing-.test", "double..dot", "under_score.test", "a=b", "\n", "*.test"]) {
      expect(() => certificateName(bad), JSON.stringify(bad)).toThrow(/not an address or a host name/);
      expect(() => selfSignedCertificate(join(outside, "tls-bad"), [bad]), JSON.stringify(bad)).toThrow(/not an address or a host name/);
    }
  });

  it("gives out the authority's certificate at /ca.pem, for a computer to be asked to trust, and nothing else of its own: never a key", async () => {
    const made = selfSignedCertificate(join(outside, "tls-ca-route"), ["130.180.221.123"]);
    const server = createStaticServer({ dir: site, tls: { key: made.key, cert: made.cert }, authority: made.authority });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const res = await secureRequest(port, "/ca.pem");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-x509-ca-cert");
    expect(res.headers["content-disposition"]).toContain("zim-web-authority.crt");
    expect(res.body).toBe(made.authority.toString());
    expect(res.body).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(res.body.match(/BEGIN/g)).toHaveLength(1);
    expect(res.body).not.toContain("PRIVATE KEY");
    expect(new X509Certificate(res.body).fingerprint256).toBe(made.fingerprint);
    // (with a query, the same; and the security headers are on it as on everything)
    expect((await secureRequest(port, "/ca.pem?x=1")).status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    // a server that has no authority to give has no such file
    const plain = createStaticServer({ dir: site });
    servers.push(plain);
    await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
    expect((await request((plain.address() as AddressInfo).port, "/ca.pem")).status).toBe(404);
    // and it is not given to anybody who has not got the password, when there is one
    const guarded = createStaticServer({ dir: site, auth: "me:secret", tls: { key: made.key, cert: made.cert }, authority: made.authority });
    servers.push(guarded);
    await new Promise<void>((resolve) => guarded.listen(0, "127.0.0.1", resolve));
    expect((await secureRequest((guarded.address() as AddressInfo).port, "/ca.pem")).status).toBe(401);
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
        if (match && output.includes("SHA-256 fingerprint:")) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    try {
      expect(output).toContain("over https");
      expect(output).toContain("signed by an authority that exists only for it");
      // the server's own certificate's fingerprint, which an app that pins it shows (not the authority's)
      const own = new X509Certificate(readFileSync(join(state, "zim-web", "tls", "cert.pem"))).fingerprint256;
      expect(output).toContain(`The server's own certificate, SHA-256 fingerprint: ${own} (`);
      expect((await secureRequest(Number(new URL(url).port), "/")).status).toBe(200);
      expect(existsSync(join(state, "zim-web", "tls", "cert.pem"))).toBe(true);
    } finally {
      const exit = new Promise<number | null>((resolve) => child.on("exit", resolve));
      child.kill("SIGTERM");
      await exit;
    }
  });

  it("is given names on the command line, and says them and the fingerprint of the authority to check; names without --tls, or bad ones, are refused", async () => {
    const state = join(outside, "state-names");
    const child = spawn(process.execPath, [script(), "--dir", site, "--port", "0", "--tls", "--name", "130.180.221.123", "--name", "notes.example.org"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: state } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no fingerprint announced: ${output}`)), 15000);
      child.stdout.on("data", () => {
        if (output.includes("SHA-256 fingerprint:")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    try {
      const made = new X509Certificate(readFileSync(join(state, "zim-web", "tls", "ca.pem")));
      expect(output).toContain("130.180.221.123");
      expect(output).toContain("notes.example.org");
      expect(output).toContain(`Its SHA-256: ${made.fingerprint256}`);
      expect(output).toContain(join(state, "zim-web", "tls", "ca.pem"));
      expect(output).toMatch(/will not run the offline app/);
    } finally {
      const exit = new Promise<number | null>((resolve) => child.on("exit", resolve));
      child.kill("SIGTERM");
      await exit;
    }
    // (a server that wrongly starts would run for ever: it is given a few seconds, and then ended)
    const run = (...args: string[]) => spawnSync(process.execPath, [script(), ...args], { encoding: "utf8", timeout: 8000, killSignal: "SIGKILL" });
    expect(run("--dir", site, "--name", "130.180.221.123").stderr).toContain("--name goes with --tls");
    expect(run("--dir", site, "--tls", "--name", "two words").stderr).toContain("is not an address or a host name");
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
