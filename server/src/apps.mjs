// Native apps (the program on a computer, the app on a phone) signed in to an account. It is done the way the IETF wrote it for apps that send the person to their own browser
// (RFC 8252, with PKCE, RFC 7636): the app makes a secret (the verifier) and shows the server only its hash (the challenge); the browser, where the person is signed in as
// always, says "yes, this app"; the server gives the browser a code that is good once and for two minutes, to be carried back to the app at an address that only the app can
// receive (a loopback address of the computer, or the app's own scheme on a phone); the app gives the server the code and the secret and gets a token. The password and the
// browser's session never reach the app, and a code that is caught on the way is worth nothing without the secret.
//
// What an app's token can do is less than a browser's session can: it keeps notebooks (and uses the services connected for that), but it can't make another token, change the
// password, delete the account or take the data away: that is done in a browser. The token of a lost phone is ended from the list in the web app, and a changed or reset password ends
// them all. Only a hash of a code or of a token is kept.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AccountError } from "./accounts.mjs";
import { transaction } from "./db.mjs";

/** How long a code is good for: the time to carry it from the browser back to the app. */
export const CODE_SECONDS = 120;
/** Where the Android app receives the code (the reverse of the app's id, which is what RFC 8252 asks of an address of that kind). */
export const ANDROID_REDIRECT = "org.zimnotebook.app:/callback";
/** Where the iPhone app receives it: a scheme of its own, so that the list of what is connected names it for what it is (an address is all that tells one kind of app from another). */
export const IOS_REDIRECT = "org.zimnotebook.app.ios:/callback";
/** Where the program on a computer receives it: a port that it opened, on the computer's own address. */
const LOOPBACK = /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/callback$/;
/** What each kind of app is called in the list of what is connected (the app does not choose: nothing that a link could make up is shown as a name). */
export const CLIENT_LABELS = { desktop: "Zim Notebook for computers", android: "Zim Notebook for Android", ios: "Zim Notebook for iPhone" };

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const refuse = (message, code) => new AccountError(message, 400, { code });

/** Which kind of app an address is the return address of, or null if it is not one that this server sends people to (nothing else is: no other host, no query, no fragment). */
export function clientOf(redirectUri) {
  if (typeof redirectUri !== "string" || redirectUri.length > 60) return null;
  const loopback = LOOPBACK.exec(redirectUri);
  // (a port above the ones that only a privileged program may listen on)
  if (loopback) return Number(loopback[1]) >= 1024 && Number(loopback[1]) <= 65535 ? "desktop" : null;
  if (redirectUri === ANDROID_REDIRECT) return "android";
  return redirectUri === IOS_REDIRECT ? "ios" : null;
}

export class Apps {
  /** @param {{ accounts: import("./accounts.mjs").Accounts }} options */
  constructor({ accounts }) {
    this.accounts = accounts;
    this.db = accounts.db;
  }

  /**
   * The person, signed in in a browser, allows an app: a code is made for it and the address to send the browser to (the app's return address, with the code and the `state` the app
   * gave, which the app checks to know that what comes back is the answer to its own request).
   */
  authorize(userId, { redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method, state } = {}) {
    const client = clientOf(redirectUri);
    if (!client) throw refuse("That app can't be signed in: its return address is not one that this server sends people to.", "bad-redirect");
    if (method !== "S256" || typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw refuse("That request from the app is not valid.", "bad-request");
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) throw refuse("That request from the app is not valid.", "bad-request");
    this.accounts.limit(`app:authorize:${userId}`, 20, 600);
    const code = randomBytes(32).toString("base64url");
    const now = this.accounts.now();
    transaction(this.db, () => {
      this.db.prepare("delete from app_codes where user_id = ? and expires_at < ?").run(userId, now);
      this.db.prepare("insert into app_codes (hash, user_id, challenge, redirect_uri, client, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)").run(sha256(code), userId, challenge, redirectUri, client, now, now + CODE_SECONDS);
    });
    return { client, label: CLIENT_LABELS[client], redirect: `${redirectUri}?code=${code}&state=${state}` };
  }

  /**
   * The app gives back the code and the secret that its challenge was made from: if they go together, and the code is the one for this return address and is not over, the app
   * gets a token. A code is used up by the first try, right or wrong: it can't be guessed at.
   */
  redeem({ code, code_verifier: verifier, redirect_uri: redirectUri } = {}, { ip = "-" } = {}) {
    this.accounts.limit(`app:token:ip:${ip}`, 30, 600);
    const bad = () => refuse("That sign-in did not work, or took too long. Start it again from the app.", "bad-grant");
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw bad();
    if (typeof verifier !== "string" || !/^[A-Za-z0-9_.~-]{43,128}$/.test(verifier)) throw bad();
    const now = this.accounts.now();
    const row = transaction(this.db, () => {
      const found = this.db.prepare("select * from app_codes where hash = ?").get(sha256(code));
      if (found) this.db.prepare("delete from app_codes where hash = ?").run(found.hash);
      return found;
    });
    if (!row || row.expires_at < now || redirectUri !== row.redirect_uri) throw bad();
    const expected = Buffer.from(row.challenge);
    const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw bad();
    const user = this.db.prepare("select * from users where id = ?").get(row.user_id);
    if (!user || user.disabled) throw bad();
    const token = this.accounts.createSession(user.id, { kind: "app", label: CLIENT_LABELS[row.client] });
    return { token, user: this.accounts.publicUser(user), label: CLIENT_LABELS[row.client] };
  }

  /** What is connected to the account: each app that was signed in, newest first. The id is for ending one; it is not the token, and says nothing of it. */
  list(userId) {
    return this.db.prepare("select public_id, label, created_at, last_used from sessions where user_id = ? and kind = 'app' order by created_at desc, public_id").all(userId).map((row) => ({ id: row.public_id, label: row.label, connectedAt: row.created_at, lastUsed: row.last_used }));
  }

  /** End one app's session (the app is signed out the next time it asks). */
  revoke(userId, id) {
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) throw refuse("That is not an app that is connected.", "no-such-app");
    const done = this.db.prepare("delete from sessions where user_id = ? and kind = 'app' and public_id = ?").run(userId, id).changes;
    if (done === 0) throw new AccountError("That app is not connected (any more).", 404, { code: "no-such-app" });
    return { ok: true };
  }
}
