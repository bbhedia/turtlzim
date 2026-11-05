// The plain-http port that only sends people to https (`--redirect-port`, docs/zim-server.md): where it sends them, what it refuses, and that nothing a request says can make it send anyone to another
// site. The rules are tried on their own first, then the server with real connections (a request written byte by byte, so that what Node's own client would tidy up is seen as it is), then the program
// as `scripts/run.sh` starts it (https on a free port, with its state in a folder of its own).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalHost, createRedirectServer, hostOf, redirectFor, safeTarget } from "../src/redirect.mjs";

const main = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const dist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const folders = [];
const children = [];
const closers = [];
// (a server or a program that a failed test left running would keep the whole run from ending)
after(() => {
  children.forEach((child) => child.kill("SIGKILL"));
  closers.forEach((close) => close());
  folders.forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});

const NAMES = ["localhost", "127.0.0.1", "::1", "203.0.113.7", "192.168.10.11"];
const go = (host, url = "/", port = 8244, names = NAMES) => redirectFor({ host, url, names, port });

describe("the host that a request names", () => {
  it("is read from a name or an address, with or without a port, in any case, and an IPv6 address is written the short way", () => {
    for (const [header, host] of [
      ["192.168.10.11", "192.168.10.11"],
      ["192.168.10.11:8281", "192.168.10.11"],
      ["Example.ORG:8281", "example.org"],
      ["localhost", "localhost"],
      [" localhost ", "localhost"],
      ["[::1]:8281", "::1"],
      ["[0:0:0:0:0:0:0:1]", "::1"],
      ["[2001:DB8:ABCD:1234:5678:9ABC:DEF0:1234]:8281", "2001:db8:abcd:1234:5678:9abc:def0:1234"],
    ]) {
      assert.equal(hostOf(header), host, header);
    }
    assert.equal(canonicalHost("0:0:0:0:0:0:0:1"), "::1");
    assert.equal(canonicalHost("EXAMPLE.org"), "example.org");
  });

  it("is nothing at all when what the header says is not a host", () => {
    for (const header of [
      undefined, "", " ", "a b", "evil.example/x", "user@host", "host:80:90", "::1", "[::1", "[::1]x", "[::1]:99999x", "host:", "example.org.", "1.2.3", "999.1.1.1", "fe80::1%eth0", "[fe80::1%eth0]",
      "exa\tmple.org", "a".repeat(300), "-bad.example", "bad-.example", "a..b", "http://example.org", "example.org\r\nSet-Cookie: x=1",
    ]) {
      assert.equal(hostOf(header), null, JSON.stringify(header));
    }
  });
});

describe("where a request is sent on", () => {
  it("is the host that the person typed, the server's https port, and the path and the query as they were asked", () => {
    assert.deepEqual(go("192.168.10.11:8281"), { status: 307, location: "https://192.168.10.11:8244/" });
    assert.deepEqual(go("203.0.113.7:8281", "/api/me?x=1&y=%20"), { status: 307, location: "https://203.0.113.7:8244/api/me?x=1&y=%20" });
    assert.deepEqual(go("LocalHost", "/#/Home"), { status: 307, location: "https://localhost:8244/#/Home" });
    assert.deepEqual(go("[::1]:8281"), { status: 307, location: "https://[::1]:8244/" });
    // (the address in another form is the same host)
    assert.deepEqual(go("[::1]", "/", 8244, ["0:0:0:0:0:0:0:1"]), { status: 307, location: "https://[::1]:8244/" });
    assert.deepEqual(go("localhost", "/", 9000), { status: 307, location: "https://localhost:9000/" });
    // (the port of https's own default is not written)
    assert.deepEqual(go("localhost", "/x", 443), { status: 307, location: "https://localhost/x" });
  });

  it("is nowhere when the certificate is not for the host, whatever else the request says", () => {
    for (const host of [
      "evil.example", "evil.example:8281", "192.168.10.12", "203.0.113.8", undefined, "", "localhost.evil.example", "xlocalhost", "192.168.10.11.evil.example", "[::2]", "localhost@evil.example",
      "evil.example#localhost", "evil.example, localhost",
    ]) {
      assert.deepEqual(go(host, "/?next=https://localhost/"), { status: 421 }, String(host));
    }
  });

  it("is a refusal when the target is not a path (an address with a host in it, `*`, nothing)", () => {
    for (const url of ["*", "", "x", "http://evil.example/x", "evil.example:443", "\\\\evil.example"]) {
      assert.deepEqual(go("localhost", url), { status: 400 }, JSON.stringify(url));
    }
    // (`go` would put its own default where a target is missing)
    assert.deepEqual(redirectFor({ host: "localhost", url: undefined, names: NAMES, port: 8244 }), { status: 400 });
  });

  it("writes the path so that it cannot end a header line, leave the address, or mean something in a page", () => {
    assert.equal(safeTarget("/café"), "/caf%E9");
    assert.equal(safeTarget("/a b"), "/a%20b");
    assert.equal(safeTarget("/a\r\nSet-Cookie: x=1"), "/a%0D%0ASet-Cookie:%20x=1");
    assert.equal(safeTarget('/"<>`{}|^\\'), "/%22%3C%3E%60%7B%7D%7C%5E%5C");
    assert.equal(safeTarget("/%41%2f"), "/%41%2f", "what was encoded stays encoded");
    assert.equal(safeTarget("/\u007f\u0000"), "/%7F%00");
    assert.equal(safeTarget("/€"), "/%E2%82%AC", "a character above one byte is written as its UTF-8 bytes");
    assert.equal(safeTarget("/a?b=c&d=e#f"), "/a?b=c&d=e#f");
    for (const url of ["//evil.example/x", "/\\evil.example", "/@evil.example", "/.@evil.example/"]) {
      const { location } = go("localhost", url);
      assert.equal(new URL(location).hostname, "localhost", url);
    }
  });

  it("cannot be made to leave the server's own address, however the target is written (a random test, the same every time)", () => {
    let seed = 20261104;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ["/", "\\", "@", ":", "?", "#", "%", "[", "]", "<", ">", '"', "'", " ", "\t", "\r", "\n", ".", "-", "_", "~", "a", "Z", "0", "9", "é", "€", "\u0000", "\u007f", "%2f", "%5c"];
    for (let i = 0; i < 500; i++) {
      let url = "/";
      for (let j = Math.floor(next() * 40); j > 0; j--) url += alphabet[Math.floor(next() * alphabet.length)];
      const answer = go("localhost", url);
      assert.equal(answer.status, 307, JSON.stringify(url));
      assert.ok(!/[^\x21-\x7e]/.test(answer.location), `a character that does not belong in a header: ${JSON.stringify(answer.location)}`);
      const where = new URL(answer.location);
      assert.equal(where.origin, "https://localhost:8244", JSON.stringify(url));
      assert.equal(where.username + where.password, "", JSON.stringify(url));
    }
  });
});

/** One request, written byte by byte as the test says, and what came back (the server ends the connection after its answer). */
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(Buffer.from(text, "latin1")));
    const chunks = [];
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("no answer in five seconds"));
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      const split = text.indexOf("\r\n\r\n");
      const lines = (split < 0 ? text : text.slice(0, split)).split("\r\n");
      const headers = {};
      for (const line of lines.slice(1)) headers[line.slice(0, line.indexOf(":")).toLowerCase()] = line.slice(line.indexOf(":") + 1).trim();
      resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0])?.[1]), headers, body: split < 0 ? "" : text.slice(split + 4) });
    });
  });
}

/** A request for `path` to this port, from a client that says it is looking for `host`. */
function ask(port, { method = "GET", path = "/", host, body, version = "1.1" } = {}) {
  const lines = [`${method} ${path} HTTP/${version}`];
  if (host !== undefined) lines.push(`Host: ${host}`);
  if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return raw(port, `${lines.join("\r\n")}\r\n\r\n${body ?? ""}`);
}

/** The server for that port on a free port of this computer; `lines` is what it logged. */
async function serve({ names = ["127.0.0.1", "localhost"], port = () => 8244 } = {}) {
  const lines = [];
  const server = createRedirectServer({ names, httpsPort: port, log: (line) => lines.push(line) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => (server.close(), server.closeAllConnections()));
  return { port: server.address().port, lines, server };
}

describe("the port that only redirects", () => {
  it("sends a GET to the same path and query at https, and says so in a way that nothing keeps or reads as a page", async () => {
    const { port } = await serve();
    const answer = await ask(port, { path: "/a/b?x=1", host: `127.0.0.1:${port}` });
    assert.equal(answer.status, 307);
    assert.equal(answer.headers.location, "https://127.0.0.1:8244/a/b?x=1");
    assert.equal(answer.headers["cache-control"], "no-store");
    assert.equal(answer.headers["x-content-type-options"], "nosniff");
    assert.equal(answer.headers["referrer-policy"], "no-referrer");
    assert.equal(answer.headers.connection, "close");
    assert.match(answer.headers["content-type"], /^text\/plain/);
    assert.equal(answer.headers["set-cookie"], undefined);
    assert.equal(Number(answer.headers["content-length"]), Buffer.byteLength(answer.body));
    assert.ok(answer.body.includes("https://127.0.0.1:8244/a/b?x=1"));
  });

  it("answers a HEAD as it answers a GET, without the body", async () => {
    const { port } = await serve();
    const get = await ask(port, { path: "/x", host: "localhost" });
    const head = await ask(port, { method: "HEAD", path: "/x", host: "localhost" });
    assert.equal(head.status, 307);
    assert.equal(head.headers.location, get.headers.location);
    assert.equal(head.headers["content-length"], get.headers["content-length"]);
    assert.equal(head.body, "");
  });

  it("refuses what is not a GET or a HEAD instead of sending it on, so that nothing sensitive keeps travelling over http because the redirect made it work", async () => {
    const { port } = await serve();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const answer = await ask(port, { method, path: "/api/login", host: "localhost", body: method === "OPTIONS" ? undefined : "password=x" });
      assert.equal(answer.status, 405, method);
      assert.equal(answer.headers.allow, "GET, HEAD");
      assert.equal(answer.headers.location, undefined, method);
    }
  });

  it("serves nothing at all: the app, the API and the files that it hands out are all a redirect", async () => {
    const { port } = await serve();
    for (const path of ["/", "/index.html", "/api/health", "/api/me", "/zim-notebook.apk", "/sw.js", "/ca.pem"]) {
      const answer = await ask(port, { path, host: "localhost" });
      assert.equal(answer.status, 307, path);
      assert.equal(answer.headers.location, `https://localhost:8244${path}`);
      assert.ok(!answer.body.includes('"ok"') && !answer.body.includes("<html"), path);
    }
  });

  it("will not send anyone to a host that the certificate is not for, nor when no host was asked for", async () => {
    const { port } = await serve();
    const other = await ask(port, { host: "evil.example" });
    assert.equal(other.status, 421);
    assert.equal(other.headers.location, undefined);
    const none = await ask(port, { version: "1.0" });
    assert.equal(none.status, 421);
    assert.equal(none.headers.location, undefined);
  });

  it("answers 400 to a request for something that is not a path, and does not go where such a request points", async () => {
    const { port } = await serve();
    for (const target of ["*", "http://evil.example/x"]) {
      const answer = await raw(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
      assert.equal(answer.status, 400, target);
      assert.equal(answer.headers.location, undefined, target);
      assert.ok(!JSON.stringify(answer).includes("evil"), target);
    }
  });

  it("never sees a request line with bytes that are not ASCII: Node's own parser refuses it first, and nothing is sent on", async () => {
    const { port, lines } = await serve();
    const answer = await raw(port, "GET /café HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert.equal(answer.status, 400);
    assert.equal(answer.headers.location, undefined);
    assert.equal(lines.length, 0, "the redirect was not asked about it");
  });

  it("asks for the https port at each request, since it can be known only once https listens", async () => {
    let current = 8244;
    const { port } = await serve({ port: () => current });
    assert.equal((await ask(port, { host: "localhost" })).headers.location, "https://localhost:8244/");
    current = 9000;
    assert.equal((await ask(port, { host: "localhost" })).headers.location, "https://localhost:9000/");
  });

  it("logs the path and the answer, and nothing of the query", async () => {
    const { port, lines } = await serve();
    await ask(port, { path: "/x?token=secret", host: "localhost" });
    assert.equal(lines.length, 1);
    assert.match(lines[0], / GET \/x 307 /);
    assert.ok(!lines[0].includes("secret") && !lines[0].includes("token"), lines[0]);
  });

  it("refuses a request whose headers are too big to be anything but an attack", async () => {
    const { port } = await serve();
    const answer = await raw(port, `GET / HTTP/1.1\r\nHost: localhost\r\nX-Big: ${"a".repeat(9000)}\r\n\r\n`);
    assert.equal(answer.status, 431);
  });
});

/** Start the program, as `scripts/run.sh` does, with its state in a folder of its own. */
function launch(args) {
  const state = mkdtempSync(join(tmpdir(), "zim-server-redirect-"));
  folders.push(state);
  // (the pid file is what `scripts/run.sh` takes for "it is running": it has to be there only when everything that was asked for listens)
  const pidFile = join(state, "server.pid");
  const child = spawn(process.execPath, [main, "--dir", dist, "--host", "127.0.0.1", "--pid-file", pidFile, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, XDG_STATE_HOME: join(state, "state"), ZIM_SERVER_DATA: join(state, "data"), ZIM_BASE_URL: "https://127.0.0.1" },
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const ended = new Promise((resolve) => child.on("exit", resolve));
  const said = (pattern) =>
    new Promise((resolve, reject) => {
      const look = () => {
        const found = pattern.exec(output);
        if (found) resolve(found);
      };
      const timer = setTimeout(() => reject(new Error(`the server did not say ${pattern}: ${output}`)), 20_000);
      child.stdout.on("data", look);
      child.on("exit", () => {
        clearTimeout(timer);
        look();
        reject(new Error(`the server ended before it said ${pattern}: ${output}`));
      });
      look();
    });
  const stop = () => new Promise((resolve) => (child.once("exit", resolve), child.kill("SIGTERM")));
  return { output: () => output, ended, said, stop, pid: child.pid, pidFile };
}

const refused = (port) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => (socket.destroy(), reject(new Error(`something still listens on ${port}`))));
    socket.on("error", (error) => resolve(error.code));
  });

describe("the server started with --redirect-port", () => {
  it("sends people to the https address that it really listens on, serves nothing over http, and leaves both ports when it stops", async () => {
    const server = launch(["--port", "0", "--tls", "--name", "127.0.0.1", "--redirect-port", "0"]);
    // (the last thing it says comes when both ports listen, so that whoever waits for it can go on at once)
    await server.said(/Data: /);
    assert.equal(readFileSync(server.pidFile, "utf8").trim(), String(server.pid), "its pid file is there once everything listens");
    const [, httpsPort] = /https:\/\/127\.0\.0\.1:(\d+)\//.exec(server.output());
    const [, redirectPort] = /Plain http, on port (\d+), only sends people to https \(no page, no API\)/.exec(server.output());
    assert.notEqual(httpsPort, redirectPort);
    const first = await ask(Number(redirectPort), { path: "/api/health?x=1", host: `127.0.0.1:${redirectPort}` });
    assert.equal(first.status, 307);
    assert.equal(first.headers.location, `https://127.0.0.1:${httpsPort}/api/health?x=1`);
    // what it points at is the real server
    const followed = await new Promise((resolve, reject) => {
      https
        .get(first.headers.location, { rejectUnauthorized: false }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        })
        .on("error", reject);
    });
    assert.equal(followed.status, 200);
    assert.match(followed.body, /"ok":\s*true/);
    // and over http there is nothing else: not the app, and not a sign-in
    assert.equal((await ask(Number(redirectPort), { path: "/", host: "127.0.0.1" })).status, 307);
    assert.equal((await ask(Number(redirectPort), { method: "POST", path: "/api/login", host: "127.0.0.1", body: "{}" })).status, 405);
    await server.stop();
    assert.equal(await refused(Number(httpsPort)), "ECONNREFUSED");
    assert.equal(await refused(Number(redirectPort)), "ECONNREFUSED");
  });

  it("opens no http port unless it is asked to (and what it says last still comes after everything that it listens on)", async () => {
    const server = launch(["--port", "0", "--tls", "--name", "127.0.0.1"]);
    await server.said(/Data: /);
    assert.doesNotMatch(server.output(), /Plain http/);
    await server.stop();
  });

  it("does not start when the redirect is asked for wrongly, and says why", async () => {
    for (const [args, message] of [
      [["--port", "0", "--tls", "--redirect-port", "70000"], /--redirect-port must be a number from 0 to 65535/],
      [["--port", "0", "--tls", "--redirect-port", "abc"], /--redirect-port must be a number from 0 to 65535/],
      [["--port", "0", "--redirect-port", "8081"], /--redirect-port needs --tls/],
      [["--port", "18999", "--tls", "--redirect-port", "18999"], /--redirect-port must not be the port of the server itself/],
    ]) {
      const server = launch(args);
      assert.equal(await server.ended, 2, args.join(" "));
      assert.match(server.output(), message, args.join(" "));
      assert.doesNotMatch(server.output(), /Serving/);
    }
  });

  it("does not start when its port is taken, and says which", async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    closers.push(() => blocker.close());
    const taken = blocker.address().port;
    const server = launch(["--port", "0", "--tls", "--name", "127.0.0.1", "--redirect-port", String(taken)]);
    assert.equal(await server.ended, 1);
    assert.ok(!existsSync(server.pidFile), "a server that could not listen on everything it was asked to does not say that it is running");
    assert.match(server.output(), new RegExp(`server: port ${taken} is already in use on 127\\.0\\.0\\.1 \\(the plain-http port that redirects\\)`));
  });
});
