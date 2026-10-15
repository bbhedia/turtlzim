// Sign-in with Google and GitHub, by the authorization-code flow with the server as the client that holds the secret (a page can't: GitHub's token
// endpoint needs the secret and does not answer a browser). What is asked of the service is the person's address, which it has to have confirmed itself,
// and its own name for the person; nothing else is kept, and the tokens it gives are used once, here, and thrown away.
//
// A sign-in is begun with `start` (a state that can be used once, a PKCE verifier kept here, and a nonce given to the browser as a cookie, so that a
// sign-in that someone else began can't be finished in this browser) and ended with `finish`.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AccountError } from "./accounts.mjs";
import { transaction } from "./db.mjs";
import { hit } from "./limits.mjs";

export const DEFAULT_ENDPOINTS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    name: "Google",
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    user: "https://api.github.com/user",
    emails: "https://api.github.com/user/emails",
    scope: "read:user user:email",
    name: "GitHub",
  },
};

const STATE_SECONDS = 600;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const b64url = (bytes) => bytes.toString("base64url");

export class OAuth {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, accounts: import("./accounts.mjs").Accounts, config: { baseUrl: string, providers: Record<string, { clientId: string, clientSecret: string, endpoints?: object }> }, fetchImpl?: typeof fetch, now?: () => number }} options
   */
  constructor({ db, accounts, config, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000) }) {
    this.db = db;
    this.accounts = accounts;
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
  }

  /** The services that are set up (have a client id and a secret). */
  providers() {
    return Object.keys(DEFAULT_ENDPOINTS).filter((name) => this.config.providers[name]);
  }

  endpoints(provider) {
    return { ...DEFAULT_ENDPOINTS[provider], ...(this.config.providers[provider]?.endpoints ?? {}) };
  }

  redirectUri(provider) {
    return `${this.config.baseUrl}/api/oauth/${provider}/callback`;
  }

  /** Where to send the browser to sign in, and the nonce to give it as a cookie. */
  start(provider) {
    if (!this.providers().includes(provider)) throw new AccountError("That way of signing in is not set up here.", 404, { code: "no-provider" });
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(24));
    this.db.prepare("insert into oauth_states (state, provider, verifier, nonce_hash, created_at) values (?, ?, ?, ?, ?)").run(sha256(state), provider, verifier, sha256(nonce), this.now());
    const e = this.endpoints(provider);
    const url = new URL(e.authorize);
    url.searchParams.set("client_id", this.config.providers[provider].clientId);
    url.searchParams.set("redirect_uri", this.redirectUri(provider));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", e.scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    if (provider === "google") url.searchParams.set("prompt", "select_account");
    return { url: url.toString(), nonce };
  }

  async json(url, init, what) {
    let response;
    try {
      response = await this.fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new AccountError(`${what} could not be reached. Try again in a moment.`, 502, { code: "failed" });
    }
    if (!response.ok) throw new AccountError(`${what} refused the request (${response.status}).`, 502, { code: "failed" });
    try {
      return await response.json();
    } catch {
      throw new AccountError(`${what} gave an answer that can't be read.`, 502, { code: "failed" });
    }
  }

  /**
   * The browser is back from the service. Checks that this is the sign-in that was begun here, in this browser, not too long ago and not before; trades the
   * code for the person's name and address; and gives the account (made, or found, or joined: see `Accounts.signInWithIdentity`).
   */
  async finish(provider, query, nonce, { ip = "-" } = {}) {
    if (!this.providers().includes(provider)) throw new AccountError("That way of signing in is not set up here.", 404, { code: "no-provider" });
    const limited = hit(this.db, `oauth:ip:${ip}`, 30, 600, this.now());
    if (!limited.ok) throw new AccountError("Too many tries. Wait a few minutes.", 429, { code: "failed", retryAfter: limited.retryAfter });
    const name = DEFAULT_ENDPOINTS[provider].name;

    // the state is used up whatever comes of it
    const row = typeof query.state === "string" && query.state.length < 100 ? transaction(this.db, () => {
      const found = this.db.prepare("select * from oauth_states where state = ?").get(sha256(query.state));
      if (found) this.db.prepare("delete from oauth_states where state = ?").run(found.state);
      return found;
    }) : undefined;
    const expired = new AccountError("This sign-in took too long or was not begun here. Try again.", 400, { code: "expired" });
    if (!row || row.provider !== provider || this.now() - row.created_at > STATE_SECONDS) throw expired;
    const theirs = Buffer.from(row.nonce_hash, "hex");
    const mine = Buffer.from(sha256(String(nonce ?? "")), "hex");
    if (theirs.length !== mine.length || !timingSafeEqual(theirs, mine)) throw expired;
    if (query.error) throw new AccountError(`${name} did not let you in (${String(query.error).slice(0, 40)}).`, 403, { code: "cancelled" });
    if (typeof query.code !== "string" || query.code.length > 2000) throw new AccountError(`${name} did not send a code.`, 400, { code: "failed" });

    const settings = this.config.providers[provider];
    const e = this.endpoints(provider);
    const token = await this.json(e.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, code: query.code, redirect_uri: this.redirectUri(provider), grant_type: "authorization_code", code_verifier: row.verifier }).toString(),
    }, name);
    if (typeof token.access_token !== "string" || !token.access_token) throw new AccountError(`${name} did not give access (${String(token.error ?? "no token").slice(0, 40)}).`, 502, { code: "failed" });
    const auth = { authorization: `Bearer ${token.access_token}`, accept: "application/json", "user-agent": "zim-notebook-server" };

    let subject;
    let email;
    let verified;
    if (provider === "google") {
      const info = await this.json(e.userinfo, { headers: auth }, name);
      subject = String(info.sub ?? "");
      email = info.email;
      verified = info.email_verified === true || info.email_verified === "true";
    } else {
      const user = await this.json(e.user, { headers: { ...auth, accept: "application/vnd.github+json" } }, name);
      subject = String(user.id ?? "");
      const emails = await this.json(e.emails, { headers: { ...auth, accept: "application/vnd.github+json" } }, name);
      // the primary address if it is confirmed, else any that is: GitHub's own word for which addresses are confirmed
      const confirmed = Array.isArray(emails) ? emails.filter((m) => m && m.verified === true && typeof m.email === "string") : [];
      const chosen = confirmed.find((m) => m.primary) ?? confirmed[0];
      email = chosen?.email;
      verified = !!chosen;
    }
    if (!subject || subject === "undefined" || subject === "null") throw new AccountError(`${name} did not say who you are.`, 502, { code: "failed" });
    return this.accounts.signInWithIdentity(provider, subject, email, verified);
  }
}
