// HTTP requests that the server makes for a person to an address they gave (their Nextcloud, say). Such an address is the most dangerous input of the server: left alone it would let
// anybody make the server call its own admin pages, the cloud's metadata service or the machines of its network (SSRF). So: https only (unless the operator allowed otherwise), the address
// the name resolves to is checked *when connecting* (a name that answers a public address to the check and a private one to the connection is not trusted), no redirect is followed, and the
// time, the size of the answer and the size of the request are capped.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class ConnectorError extends Error {
  constructor(message, status = 502, code = "connector") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Whether an address is one that a public service never has: this machine, its network, a link-local or reserved range. */
export function isPrivateAddress(address) {
  let ip = String(address).toLowerCase();
  if (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const first = parseInt(ip.split(":")[0] || "0", 16);
    return ip === "::" || ip === "::1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || ip.startsWith("64:ff9b:") || ip.startsWith("2001:db8:");
  }
  return true; // (not an address at all)
}

/**
 * @param {{ url: string, method?: string, headers?: Record<string, string>, body?: Buffer | string,
 *   timeoutMs?: number, maxBytes?: number, allowPrivate?: boolean, allowInsecure?: boolean, lookup?: Function }} options
 * @returns {Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: Buffer }>}
 */
export function safeRequest({ url, method = "GET", headers = {}, body, timeoutMs = 20_000, maxBytes = 12 * 1024 * 1024, allowPrivate = false, allowInsecure = false, lookup = dns.lookup }) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new ConnectorError("That address is not a web address.", 400, "bad-address"));
  }
  if (target.protocol !== "https:" && !(allowInsecure && target.protocol === "http:")) return Promise.reject(new ConnectorError("The address has to start with https://.", 400, "insecure"));
  if (target.username || target.password) return Promise.reject(new ConnectorError("Put the user name and password in their own fields, not in the address.", 400, "bad-address"));
  // (Node does not look up a name that already is an address, so a literal address is judged here)
  const literal = target.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal) && !allowPrivate && isPrivateAddress(literal)) return Promise.reject(new ConnectorError("That address leads to a private network, which the server does not call.", 400, "private-address"));
  const client = target.protocol === "https:" ? https : http;
  const guardedLookup = (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }];
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) return callback(new ConnectorError("That address leads to a private network, which the server does not call.", 400, "private-address"));
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
  return new Promise((resolveOnce, rejectOnce) => {
    let settled = false;
    const resolve = (value) => settled || ((settled = true), resolveOnce(value));
    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.destroy();
      rejectOnce(error instanceof ConnectorError ? error : new ConnectorError(error.code === "ENOTFOUND" ? "That address was not found." : `The service can't be reached (${error.code ?? error.message}).`, 502, "unreachable"));
    };
    const bytes = body === undefined ? undefined : Buffer.from(body);
    const request = client.request(
      target,
      { method, headers: { ...headers, ...(bytes ? { "content-length": String(bytes.length) } : {}), "user-agent": "zim-notebook-server" }, lookup: guardedLookup, timeout: timeoutMs },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return fail(new ConnectorError("The service's answer is too big.", 502, "too-big"));
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on("error", fail);
        response.on("aborted", () => fail(new ConnectorError("The service cut the answer short.", 502, "cut")));
      },
    );
    request.on("timeout", () => fail(new ConnectorError("The service did not answer in time.", 504, "timeout")));
    request.on("error", fail);
    if (bytes) request.write(bytes);
    request.end();
  });
}
