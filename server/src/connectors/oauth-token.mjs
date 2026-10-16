// What the connected services that are reached with OAuth (Dropbox, Google Drive) share: the server keeps the person's long-lived *refresh token* (sealed, like any connection's
// settings) and trades it for a short-lived access token when it needs one. Access tokens live only in this process's memory, until shortly before they end.
import { createHash } from "node:crypto";
import { ConnectorError, safeRequest } from "./safe-fetch.mjs";

const cache = new Map(); // sha256(refresh token) -> { token, until }
const key = (refreshToken) => createHash("sha256").update(refreshToken).digest("hex");

/** Forget an access token (a service said it is no good). */
export function forgetAccessToken(refreshToken) {
  cache.delete(key(refreshToken));
}

/**
 * @param {{ tokenUrl: string, app: { clientId: string, clientSecret: string }, refreshToken: string, options: object, name: string }} parts
 * @returns {Promise<string>}
 */
export async function accessToken({ tokenUrl, app, refreshToken, options, name }) {
  const hit = cache.get(key(refreshToken));
  if (hit && hit.until > Date.now()) return hit.token;
  if (!app?.clientId || !app?.clientSecret) throw new ConnectorError(`${name} is not set up on this server any more.`, 400, "no-provider");
  const response = await safeRequest({
    url: tokenUrl,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: app.clientId, client_secret: app.clientSecret }).toString(),
    timeoutMs: options.timeoutMs,
    allowPrivate: options.allowPrivate,
    allowInsecure: options.allowInsecure,
    lookup: options.lookup,
  });
  let body;
  try {
    body = JSON.parse(response.body.toString("utf8"));
  } catch {
    body = {};
  }
  if (response.status === 400 || response.status === 401) throw new ConnectorError(`${name} no longer lets this server in (the connection was revoked or has expired): connect it again.`, 400, "revoked");
  if (response.status !== 200 || typeof body.access_token !== "string") throw new ConnectorError(`${name} did not give access (${response.status}).`);
  cache.set(key(refreshToken), { token: body.access_token, until: Date.now() + Math.max(60, Number(body.expires_in ?? 3600) - 120) * 1000 });
  return body.access_token;
}
