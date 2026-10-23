// The test of the app from the inside (test/ios-e2e.ts) run in a browser: the logic of it (the DOM it drives, the order, what it waits for) is tried here, in Chromium and in WebKit,
// before CI runs it in a real iPhone WebView. A "restart" of the app is a reload of the page, which keeps what the browser keeps (IndexedDB, the file system).
//
// For the steps that need an account, the browser is given stand-ins for what the app's own code does (ZimNativePlugin: the requests, the keychain, trusting a certificate by its
// fingerprint, made here by Node with the plugin's rules and its words), and a real account server is started as CI starts it (scripts/ios-server.mjs). What this tries is the test and
// the server's doors, not the Swift: only the simulator tells whether the plugin does what these stand-ins do.
//
//   cd mobile && npm run test:e2e-local            (ZIM_BROWSER=webkit for WebKit; needs ../web/dist: `npm run build` in ../web, and the browsers of ../web/scripts/setup-browser.sh)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import tlsModule from "node:tls";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../../web/scripts/serve.mjs";
import { launchBrowser } from "../../web/test/browser-launch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "scripts/prepare.mjs")], { cwd: root, env: { ...process.env, ZIM_E2E: "1" }, stdio: "inherit" });

// a real account server, as CI starts it
const serverFolder = mkdtempSync(join(tmpdir(), "zim-ios-e2e-"));
const accountServer = spawn(process.execPath, [join(root, "scripts/ios-server.mjs"), serverFolder], { stdio: ["ignore", "inherit", "inherit"] });
for (let waited = 0; !existsSync(join(serverFolder, "server.json")); waited += 100) {
  if (waited > 60_000) throw new Error("the account server did not start");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
}
const account = JSON.parse(readFileSync(join(serverFolder, "server.json"), "utf8"));

const server = createStaticServer({ dir: join(root, "www") });
await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
const origin = `http://127.0.0.1:${server.address().port}/`;
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: "block" });
await standInPlugin(context, account);
const page = await context.newPage();
page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));

const failures = [];
async function result(label) {
  // (the page's own result: `final` is set when the test is over, whatever came of it)
  await page.waitForFunction(() => window.__e2e?.final === true, null, { timeout: 300_000 });
  const done = await page.evaluate(() => window.__e2e);
  for (const step of done.steps) console.log(`${step.ok ? "ok  " : "FAIL"} [${label}] ${step.name} (${step.ms} ms)${step.error ? ` ${step.error}` : ""}`);
  if (done.error) console.log(`FAIL [${label}] ${done.error}`);
  if (done.errors.length) console.log(`     [${label}] the page noted: ${done.errors.join(" | ")}`);
  if (!done.ok) failures.push(label);
  return done;
}

try {
  await page.goto(origin);
  const first = await result("first run");
  if (first.phase !== 1) failures.push(`the first run was the run ${first.phase}`);
  await page.reload();
  const second = await result("after a restart");
  if (second.phase !== 2) failures.push(`what was written was not there after the restart (it was the run ${second.phase})`);
} finally {
  await context.close();
  await browser.close();
  server.close();
  accountServer.kill("SIGTERM");
}
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "the app works, from the inside");
process.exit(failures.length ? 1 : 0);

/**
 * What the app's own code does for an account (ZimNativePlugin), made here by Node with the same rules and the same words, and given to the page as the hooks that the shell gives it. What was trusted
 * and what the keychain keeps live in this process, so they outlast a reload of the page as they outlast the app's restart. A certificate that was trusted is compared with what the server shows on the one
 * connection that the request then goes over, before a byte of it is sent.
 */
async function standInPlugin(browserContext, accountServerAt) {
  const pins = new Map();
  const secrets = new Map();
  const forwarded = ["authorization", "content-type", "x-requested-with", "accept"];
  const refuse = (message, code) => ({ failed: { message, ...(code ? { code } : {}) } });
  const loopback = (host) => host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
  /** The rules of what is asked: an https address, or http to this device's own, an /api/ path that stays there, no name or password. */
  const checkUrl = (raw) => {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return refuse("That is not an address.");
    }
    if (!url.hostname) return refuse("That is not an address.");
    if (url.protocol === "http:" && !loopback(url.hostname)) return refuse("A server that is not on this device has to be reached over https.");
    if (url.protocol !== "https:" && url.protocol !== "http:") return refuse("That is not an address of a server.");
    if (url.username || url.password) return refuse("There is no name or password in the address of the server.");
    if (!url.pathname.startsWith("/api/") || /%2e%2e|%2f|%5c|\/\.\.(\/|$)/i.test(raw)) return refuse("That is not a request to the account server.");
    return { url };
  };
  const checkOrigin = (raw) => {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return refuse("That is not an address.");
    }
    if (url.protocol !== "https:") return refuse("A certificate can be trusted only for an https address.");
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return refuse("A certificate is trusted for a server, not for a page of it.");
    return { origin: url.origin, host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 443 };
  };
  const notThere = refuse("The server did not answer: check the address, and that this device is online.");
  /** A handshake with a server, taking whatever certificate it shows: the connection, with nothing sent on it. */
  const reach = (host, port) =>
    new Promise((resolveReach, reject) => {
      const socket = tlsModule.connect({ host, port, rejectUnauthorized: false, ...(isIP(host) ? {} : { servername: host }) }, () => resolveReach(socket));
      socket.once("error", reject);
    });

  await browserContext.exposeFunction("__native_request", async (request) => {
    const checked = checkUrl(request.url);
    if (checked.failed) return checked;
    const headers = { "user-agent": "ZimNotebook-iOS" };
    for (const [name, value] of Object.entries(request.headers ?? {})) if (forwarded.includes(name.toLowerCase())) headers[name] = value;
    const body = ["POST", "PUT", "PATCH"].includes(request.method) ? (request.body ?? "") : undefined;
    const target = checked.url;
    const viaFetch = async () => {
      const response = await fetch(target, { method: request.method, headers, body, redirect: "manual" });
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
    };
    if (target.protocol === "http:") {
      try {
        return { ok: await viaFetch() };
      } catch {
        return notThere;
      }
    }
    const pin = pins.get(target.origin);
    if (pin === undefined) {
      try {
        return { ok: await viaFetch() };
      } catch (error) {
        const reason = String(error?.cause?.code ?? "");
        if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(reason)) return refuse("The server's certificate is not one that this device trusts (the certificate is not trusted).", "certificate-untrusted");
        return notThere;
      }
    }
    let socket;
    try {
      socket = await reach(target.hostname.replace(/^\[|\]$/g, ""), Number(target.port) || 443);
    } catch {
      return notThere;
    }
    if (socket.getPeerCertificate().fingerprint256 !== pin) {
      socket.destroy();
      return refuse("The server's certificate is not the one that you trusted for it.", "certificate-changed");
    }
    return new Promise((resolveRequest) => {
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const outgoing = http.request({ agent, method: request.method, host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers: { ...headers, connection: "close" } }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => resolveRequest({ ok: { status: incoming.statusCode, headers: Object.fromEntries(Object.entries(incoming.headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(chunks).toString("utf8") } }));
      });
      outgoing.on("error", () => resolveRequest(notThere));
      outgoing.end(body);
    });
  });
  await browserContext.exposeFunction("__native_inspect", async (raw) => {
    const checked = checkOrigin(raw);
    if (checked.failed) return checked;
    try {
      const socket = await reach(checked.host, checked.port);
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      socket.destroy();
      return { ok: { fingerprint } };
    } catch {
      return notThere;
    }
  });
  await browserContext.exposeFunction("__native_pin", async (raw, fingerprint) => {
    const checked = checkOrigin(raw);
    if (checked.failed) return checked;
    const wanted = String(fingerprint ?? "").replace(/[: ]/g, "");
    if (!/^[0-9a-f]{64}$/i.test(wanted)) return refuse("That is not a fingerprint.");
    try {
      const socket = await reach(checked.host, checked.port);
      const shown = socket.getPeerCertificate().fingerprint256;
      socket.destroy();
      if (shown.replaceAll(":", "").toLowerCase() !== wanted.toLowerCase()) return refuse("The server shows another certificate now, so nothing was trusted.", "certificate-changed");
      pins.set(checked.origin, shown);
      return { ok: null };
    } catch {
      return notThere;
    }
  });
  await browserContext.exposeFunction("__native_pinned", async (raw) => {
    const checked = checkOrigin(raw);
    return checked.failed ? checked : { ok: pins.get(checked.origin) ?? null };
  });
  await browserContext.exposeFunction("__native_unpin", async (raw) => {
    const checked = checkOrigin(raw);
    if (checked.failed) return checked;
    pins.delete(checked.origin);
    return { ok: null };
  });
  /** The system's sign-in sheet, as far as it can be stood in for: the rule about what it is sent to, and the server's page loading in it (a Safari asks the server who is there). */
  await browserContext.exposeFunction("__native_sheet", async (raw) => {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return refuse("A browser is only sent to an https address (or to one on this device).");
    }
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback(url.hostname)))) return refuse("A browser is only sent to an https address (or to one on this device).");
    if (url.protocol === "http:") {
      void fetch(`${url.origin}/api/providers`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1" } }).catch(() => undefined);
    }
    return { ok: null };
  });
  const name = (value) => /^[A-Za-z0-9-]{1,64}$/.test(String(value));
  await browserContext.exposeFunction("__native_secret_get", async (n) => (name(n) ? { ok: secrets.get(n) ?? null } : refuse("That is not a name that a secret can have.")));
  await browserContext.exposeFunction("__native_secret_set", async (n, value) => (name(n) ? (secrets.set(n, value), { ok: null }) : refuse("That is not a name that a secret can have.")));
  await browserContext.exposeFunction("__native_secret_remove", async (n) => (name(n) ? (secrets.delete(n), { ok: null }) : refuse("That is not a name that a secret can have.")));

  await browserContext.addInitScript((given) => {
    window.__e2eServer = given;
    const unwrap = async (promise) => {
      const answer = await promise;
      if (answer.failed) throw Object.assign(new Error(answer.failed.message), answer.failed.code ? { code: answer.failed.code } : {});
      return answer.ok;
    };
    const account = {
      request: (request) => unwrap(window.__native_request(request)),
      // (the shell's own: a sign-in is begun, waited for, and can be cancelled, which ends the wait with this error)
      signIn: (() => {
        let stop = null;
        return {
          begin: async () => ({ redirectUri: "org.zimnotebook.app.ios:/callback" }),
          wait: async (url) => {
            await unwrap(window.__native_sheet(url));
            return new Promise((_, reject) => (stop = reject));
          },
          cancel() {
            stop?.(new Error("The sign-in was cancelled."));
          },
        };
      })(),
      secrets: { get: (n) => unwrap(window.__native_secret_get(n)), set: (n, v) => unwrap(window.__native_secret_set(n, v)), remove: (n) => unwrap(window.__native_secret_remove(n)) },
      trust: { inspect: (o) => unwrap(window.__native_inspect(o)), pin: (o, f) => unwrap(window.__native_pin(o, f)), pinned: (o) => unwrap(window.__native_pinned(o)), unpin: (o) => unwrap(window.__native_unpin(o)) },
    };
    // (the shell's own script sets `__zimShell` when the page loads, without an account, as it does where the app has no plugin: what it sets gets the stand-in's account)
    let hooks;
    Object.defineProperty(window, "__zimShell", { configurable: true, get: () => hooks, set: (value) => (hooks = { ...value, account }) });
  }, accountServerAt);
}
