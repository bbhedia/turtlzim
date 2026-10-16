// Allowing the server to reach a person's Dropbox or Google Drive: the authorisation-code flow with PKCE, begun by someone who is signed in and finished by the same person in the same
// browser. The state can be used once, is kept hashed, belongs to the user who began it and to the browser that was given its nonce, and does not last (ten minutes). What is kept at the end
// is the refresh token, sealed, as the settings of a new connection.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AccountError } from "../accounts.mjs";
import { transaction } from "../db.mjs";
import { hit } from "../limits.mjs";
import { DRIVERS } from "./index.mjs";
import { ConnectorError, safeRequest } from "./safe-fetch.mjs";

const STATE_SECONDS = 600;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const b64url = (bytes) => bytes.toString("base64url");

export class ConnectorOAuth {
  /** @param {{ db: import("node:sqlite").DatabaseSync, connectors: import("./index.mjs").Connectors, config: { baseUrl: string }, now?: () => number }} parts */
  constructor({ db, connectors, config, now = () => Math.floor(Date.now() / 1000) }) {
    this.db = db;
    this.connectors = connectors;
    this.config = config;
    this.now = now;
  }

  kinds() {
    return Object.values(DRIVERS).filter((d) => d.oauth && this.connectors.options.apps[d.kind]?.clientId).map((d) => d.kind);
  }

  endpoints(kind) {
    return { ...DRIVERS[kind].oauth, ...(this.connectors.options.endpoints?.[kind] ?? {}) };
  }

  redirectUri(kind) {
    return `${this.config.baseUrl}/api/connectors/oauth/${kind}/callback`;
  }

  start(userId, kind) {
    if (!this.kinds().includes(kind)) throw new AccountError("That service can't be connected here.", 404, { code: "no-provider" });
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(24));
    this.db.prepare("insert into oauth_states (state, provider, verifier, nonce_hash, created_at, user_id) values (?, ?, ?, ?, ?, ?)").run(sha256(state), `connect:${kind}`, verifier, sha256(nonce), this.now(), userId);
    const e = this.endpoints(kind);
    const url = new URL(e.authorize);
    url.searchParams.set("client_id", this.connectors.options.apps[kind].clientId);
    url.searchParams.set("redirect_uri", this.redirectUri(kind));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", e.scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    for (const [name, value] of Object.entries(e.extra ?? {})) url.searchParams.set(name, value);
    return { url: url.toString(), nonce };
  }

  async finish(userId, kind, query, nonce, { ip = "-" } = {}) {
    if (!this.kinds().includes(kind)) throw new AccountError("That service can't be connected here.", 404, { code: "no-provider" });
    const limited = hit(this.db, `connect:ip:${ip}`, 30, 600, this.now());
    if (!limited.ok) throw new AccountError("Too many tries. Wait a few minutes.", 429, { code: "failed", retryAfter: limited.retryAfter });
    const label = DRIVERS[kind].label;
    // (the state is used up whatever comes of it)
    const row = typeof query.state === "string" && query.state.length < 100 ? transaction(this.db, () => {
      const found = this.db.prepare("select * from oauth_states where state = ?").get(sha256(query.state));
      if (found) this.db.prepare("delete from oauth_states where state = ?").run(found.state);
      return found;
    }) : undefined;
    const expired = new AccountError("This connection took too long or was not begun here. Try again.", 400, { code: "expired" });
    if (!row || row.provider !== `connect:${kind}` || row.user_id !== userId || this.now() - row.created_at > STATE_SECONDS) throw expired;
    const theirs = Buffer.from(row.nonce_hash, "hex");
    const mine = Buffer.from(sha256(String(nonce ?? "")), "hex");
    if (theirs.length !== mine.length || !timingSafeEqual(theirs, mine)) throw expired;
    if (query.error) throw new AccountError(`${label} was not allowed access (${String(query.error).slice(0, 40)}).`, 403, { code: "cancelled" });
    if (typeof query.code !== "string" || query.code.length > 2000) throw new AccountError(`${label} did not send a code.`, 400, { code: "failed" });

    const app = this.connectors.options.apps[kind];
    let response;
    try {
      response = await safeRequest({
        url: this.endpoints(kind).token,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: this.redirectUri(kind), client_id: app.clientId, client_secret: app.clientSecret, code_verifier: row.verifier }).toString(),
        allowPrivate: this.connectors.options.allowPrivate,
        allowInsecure: this.connectors.options.allowInsecure,
        lookup: this.connectors.options.lookup,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw new AccountError(`${label} could not be reached. Try again in a moment.`, 502, { code: "failed" });
      throw error;
    }
    let token;
    try {
      token = JSON.parse(response.body.toString("utf8"));
    } catch {
      token = {};
    }
    if (response.status !== 200 || typeof token.access_token !== "string") throw new AccountError(`${label} did not give access (${String(token.error ?? response.status).slice(0, 40)}).`, 502, { code: "failed" });
    if (typeof token.refresh_token !== "string" || !token.refresh_token) throw new AccountError(`${label} did not give a lasting access. Remove this app's access in your ${label} settings and connect again.`, 502, { code: "no-refresh" });
    return this.connectors.addOAuth(userId, kind, token.refresh_token, label);
  }
}
