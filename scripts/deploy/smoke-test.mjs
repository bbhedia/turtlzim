// A look, from the outside, at a server that is running (docs/zim-delivery.md): with nothing but its address, does it answer, does it serve the web app that was published, and does its http port redirect to https. It is
// what to run after the router has been set up (from a computer that is not on the staging machine's own network: then it is what a person on the Internet gets), and after a delivery to production.
// With --insecure a certificate that nothing knows is accepted (the staging's own), and its SHA-256 fingerprint is told: compare it with what the server printed when it started, and with what an app asks you to trust.
//
//   node scripts/deploy/smoke-test.mjs ADDRESS [--insecure] [--sw SHA256] [--redirect URL]
//     ADDRESS      https://host:port (http://host:port only for a server that is not served over https)
//     --sw SHA256  the service worker's SHA-256 that the release's manifest says (turtlzim-beta.json, web.sw): the server has to serve that very build
//     --redirect   the address of the http port that redirects, e.g. http://host:8281/: it has to answer 307 to the same host over https
//   Exit 0 if every look is fine, 1 if one is not.
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function get(url, { insecure = false, timeoutMs = 15_000 } = {}) {
  return new Promise((resolveGet, reject) => {
    const target = new URL(url);
    const options = { timeout: timeoutMs, headers: { "user-agent": "turtlzim-smoke-test", accept: "*/*" } };
    if (target.protocol === "https:" && insecure) options.rejectUnauthorized = false;
    const request = (target.protocol === "https:" ? https : http).get(target, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveGet({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(`no answer from ${target.host} in ${timeoutMs / 1000} s`)));
    request.on("error", reject);
  });
}

/** The SHA-256 fingerprint of the certificate that a server shows (whatever it is: nothing is sent). */
function certificateOf(url) {
  return new Promise((resolveCertificate, reject) => {
    const target = new URL(url);
    const socket = tls.connect({ host: target.hostname.replace(/^\[|\]$/g, ""), port: Number(target.port || 443), rejectUnauthorized: false, servername: /^[\d.:]+$/.test(target.hostname.replace(/^\[|\]$/g, "")) ? undefined : target.hostname }, () => {
      const { fingerprint256 } = socket.getPeerCertificate();
      socket.end();
      resolveCertificate(fingerprint256);
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error("no answer")));
    socket.on("error", reject);
  });
}

/** Look at the server; `{ ok, lines }` says each look. */
export async function smokeTest({ address, insecure = false, sw, redirect }) {
  const base = new URL(address);
  const lines = [];
  let ok = true;
  const look = async (name, fn) => {
    try {
      lines.push(`ok    ${name}: ${await fn()}`);
    } catch (error) {
      ok = false;
      lines.push(`FAIL  ${name}: ${error.message}`);
    }
  };
  const ask = (path) => get(new URL(path, base).href, { insecure });

  if (base.protocol === "https:" && insecure) await look("certificate", async () => `SHA-256 ${await certificateOf(base.href)} (nothing knows it: this is the one to compare with what the server printed)`);
  await look("/api/health", async () => {
    const answer = await ask("/api/health");
    if (answer.status !== 200 || JSON.parse(answer.body.toString("utf8")).ok !== true) throw new Error(`${answer.status}, not {"ok":true}`);
    return "200 {ok: true}";
  });
  await look("/api/providers", async () => {
    const answer = await ask("/api/providers");
    if (answer.status !== 200) throw new Error(`${answer.status}`);
    return `200 (${Object.keys(JSON.parse(answer.body.toString("utf8"))).join(", ") || "none"})`;
  });
  await look("/ (the web app)", async () => {
    const answer = await ask("/");
    if (answer.status !== 200 || !/<title>[^<]+<\/title>/i.test(answer.body.toString("utf8"))) throw new Error(`${answer.status}, no page with a title`);
    return `200, "${/<title>([^<]+)<\/title>/i.exec(answer.body.toString("utf8"))[1]}"`;
  });
  await look("/sw.js (the service worker)", async () => {
    const answer = await ask("/sw.js");
    if (answer.status !== 200) throw new Error(`${answer.status}`);
    const served = createHash("sha256").update(answer.body).digest("hex");
    if (sw && served !== sw) throw new Error(`SHA-256 ${served} is not the ${sw} of the build that was published`);
    return `200, SHA-256 ${served.slice(0, 16)}…${sw ? " (the published build's)" : ""}`;
  });
  if (redirect) {
    await look(`${redirect} (the http port)`, async () => {
      const answer = await get(redirect, { insecure });
      const where = String(answer.headers.location ?? "");
      if (answer.status !== 307 || !where.startsWith(`https://${new URL(redirect).hostname}`)) throw new Error(`${answer.status}${where ? ` to ${where}` : ""}, not a redirect to https on the same host`);
      return `307 to ${where}`;
    });
  }
  return { ok, lines };
}

async function main(argv) {
  const options = { insecure: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--insecure") options.insecure = true;
    else if (flag === "--sw" || flag === "--redirect") {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = argv[++i];
    } else if (flag.startsWith("--")) throw new Error(`unknown option ${flag}`);
    else if (options.address) throw new Error("one address only");
    else options.address = flag;
  }
  if (!options.address) throw new Error("an ADDRESS is needed, e.g. https://example.org:8244");
  if (options.sw && !/^[0-9a-f]{64}$/.test(options.sw)) throw new Error("--sw is a SHA-256 in hexadecimal");
  return smokeTest(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    ({ ok, lines }) => {
      for (const line of lines) console.log(line);
      process.exit(ok ? 0 : 1);
    },
    (error) => {
      console.error(`smoke-test: ${error.message}`);
      process.exit(2);
    },
  );
}
