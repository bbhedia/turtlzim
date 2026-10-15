// Accounts: sign-up with a code sent by e-mail, sign-in, sessions, a forgotten password, deleting an account, and the accounts that Google and GitHub vouch for.
// Everything here takes the database, the mailer and the clock as given, so that it runs the same in a test as in the server, and never touches HTTP.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { transaction } from "./db.mjs";
import { hit } from "./limits.mjs";
import { messages } from "./mail.mjs";
import { hashPassword, normalizeEmail, passwordProblem, verifyPassword } from "./passwords.mjs";

/** An error whose message may be shown to the person, with the HTTP status that goes with it. */
export class AccountError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const RESEND_SECONDS = 60;
const SESSION_TOUCH_SECONDS = 24 * 3600;
const UNCONFIRMED_DAYS = 2;
const DAY = 24 * 3600;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export class Accounts {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, mailer: { send(message: object): Promise<void> }, config: { secret: Buffer, sessionDays: number, quotaBytes: number }, now?: () => number }} options
   */
  constructor({ db, mailer, config, now = () => Math.floor(Date.now() / 1000) }) {
    this.db = db;
    this.mailer = mailer;
    this.config = config;
    this.now = now;
    /** A hash to compare against when there is no account, so that "no such account" takes as long as "wrong password". */
    this.decoy = hashPassword("a password that nobody has");
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // codes

  codeHash(userId, purpose, code) {
    return createHmac("sha256", this.config.secret).update(`${purpose}:${userId}:${code}`).digest("hex");
  }

  /** Make a code for the user (a new one replaces the old) and mail it. A code is six digits, valid for ten minutes, and kept only as a keyed hash. */
  async sendCode(user, purpose) {
    const now = this.now();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    transaction(this.db, () => {
      this.db.prepare("delete from codes where user_id = ? and purpose = ?").run(user.id, purpose);
      this.db.prepare("insert into codes (user_id, purpose, hash, expires_at, attempts, created_at) values (?, ?, ?, ?, 0, ?)").run(user.id, purpose, this.codeHash(user.id, purpose, code), now + CODE_MINUTES * 60, now);
    });
    const message = purpose === "register" ? messages.confirmation(code, CODE_MINUTES) : messages.reset(code, CODE_MINUTES);
    await this.mailer.send({ to: user.email, ...message });
  }

  /** Whether a code was sent less than a minute ago (then it is not sent again, and the person is not told which). */
  recentCode(userId, purpose) {
    const row = this.db.prepare("select created_at from codes where user_id = ? and purpose = ?").get(userId, purpose);
    return !!row && this.now() - row.created_at < RESEND_SECONDS;
  }

  /** Check a code. It is used up when it is right, and after five wrong tries; it can't be used after it has expired. */
  checkCode(userId, purpose, code) {
    const wrong = () => new AccountError("That code is wrong or has expired. Ask for a new one.", 400, { code: "wrong-code" });
    const row = this.db.prepare("select id, hash, expires_at, attempts from codes where user_id = ? and purpose = ?").get(userId, purpose);
    if (!row || row.expires_at < this.now() || row.attempts >= CODE_TRIES) throw wrong();
    const given = String(code ?? "").replace(/\s+/g, "");
    this.db.prepare("update codes set attempts = attempts + 1 where id = ?").run(row.id);
    const expected = Buffer.from(row.hash, "hex");
    const actual = Buffer.from(this.codeHash(userId, purpose, given), "hex");
    if (!/^\d{6}$/.test(given) || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw wrong();
    this.db.prepare("delete from codes where id = ?").run(row.id);
  }

  limit(key, max, seconds) {
    const result = hit(this.db, key, max, seconds, this.now());
    if (!result.ok) throw new AccountError(`Too many tries. Wait ${Math.ceil(result.retryAfter / 60)} minute(s) and try again.`, 429, { retryAfter: result.retryAfter });
  }

  userByEmail(email) {
    return this.db.prepare("select * from users where email = ?").get(email);
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // sign-up

  /**
   * Start an account: the address and a password, and a code mailed to the address. It answers the same whether or not the address already has an account
   * (a person who owns it is told by e-mail), so that the form can't be used to find out who has one.
   */
  async register(emailInput, password, { ip = "-" } = {}) {
    const email = normalizeEmail(emailInput);
    if (!email) throw new AccountError("That does not look like an e-mail address.", 400, { code: "bad-email" });
    const problem = passwordProblem(password, email);
    if (problem) throw new AccountError(problem, 400, { code: "bad-password" });
    this.limit(`register:ip:${ip}`, 10, 3600);
    this.limit(`register:email:${email}`, 5, 3600);

    const existing = this.userByEmail(email);
    if (existing?.verified_at) {
      if (!this.recentCode(existing.id, "already")) await this.mailer.send({ to: email, ...messages.alreadyRegistered() });
      this.db.prepare("delete from codes where user_id = ? and purpose = 'already'").run(existing.id);
      this.db.prepare("insert into codes (user_id, purpose, hash, expires_at, attempts, created_at) values (?, 'already', '', ?, 0, ?)").run(existing.id, this.now() + 60, this.now());
      return { ok: true };
    }
    const hash = await hashPassword(password);
    let user = existing;
    if (!user) {
      this.db.prepare("insert into users (email, password_hash, created_at, quota_bytes) values (?, ?, ?, ?)").run(email, hash, this.now(), this.config.quotaBytes);
      user = this.userByEmail(email);
    } else {
      // (an account that was never confirmed: the new password replaces the old, so whoever started it first has no hold on it)
      this.db.prepare("update users set password_hash = ? where id = ?").run(hash, user.id);
    }
    if (!this.recentCode(user.id, "register")) await this.sendCode(user, "register");
    return { ok: true };
  }

  /** Send the code again (not more than once a minute). Always answers the same. */
  async resend(emailInput, { ip = "-" } = {}) {
    const email = normalizeEmail(emailInput);
    if (!email) throw new AccountError("That does not look like an e-mail address.", 400, { code: "bad-email" });
    this.limit(`resend:ip:${ip}`, 10, 3600);
    this.limit(`resend:email:${email}`, 5, 3600);
    const user = this.userByEmail(email);
    if (user && !user.verified_at && !this.recentCode(user.id, "register")) await this.sendCode(user, "register");
    return { ok: true };
  }

  /** The code that was mailed: the account is confirmed and the person is signed in. */
  verify(emailInput, code, { ip = "-" } = {}) {
    const email = normalizeEmail(emailInput);
    this.limit(`verify:ip:${ip}`, 30, 3600);
    const user = email ? this.userByEmail(email) : undefined;
    if (!user || user.verified_at) throw new AccountError("That code is wrong or has expired. Ask for a new one.", 400, { code: "wrong-code" });
    this.checkCode(user.id, "register", code);
    this.db.prepare("update users set verified_at = ? where id = ?").run(this.now(), user.id);
    return this.publicUser(this.userByEmail(email));
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // signing in

  /** The address and the password. A wrong password and an unknown address get the same answer, in the same time. */
  async login(emailInput, password, { ip = "-" } = {}) {
    const email = normalizeEmail(emailInput) ?? "";
    this.limit(`login:ip:${ip}`, 20, 600);
    this.limit(`login:email:${email}`, 10, 600);
    const user = email ? this.userByEmail(email) : undefined;
    const good = await verifyPassword(String(password ?? ""), user?.password_hash ?? (await this.decoy));
    if (!user || !user.password_hash || !good || user.disabled) throw new AccountError("Wrong e-mail address or password.", 401, { code: "bad-login" });
    if (!user.verified_at) throw new AccountError("This account is not confirmed yet: enter the code that was sent to your e-mail address.", 403, { code: "unconfirmed" });
    return this.publicUser(user);
  }

  publicUser(user) {
    return { id: user.id, email: user.email, createdAt: user.created_at, quotaBytes: user.quota_bytes, hasPassword: !!user.password_hash };
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // sessions

  /** A new session for the user: the token that is given to the browser, of which only a hash is kept. */
  createSession(userId) {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db.prepare("insert into sessions (id, user_id, created_at, expires_at, last_used) values (?, ?, ?, ?, ?)").run(sha256(token), userId, now, now + this.config.sessionDays * DAY, now);
    return token;
  }

  /** The user a token belongs to, or null. A session in use is made to last (but not more than once a day, to keep the database quiet). */
  session(token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
    const id = sha256(token);
    const now = this.now();
    const row = this.db.prepare("select s.created_at, s.expires_at, s.last_used, u.* from sessions s join users u on u.id = s.user_id where s.id = ?").get(id);
    if (!row || row.expires_at < now || row.disabled) return null;
    if (now - row.last_used > SESSION_TOUCH_SECONDS) this.db.prepare("update sessions set last_used = ?, expires_at = ? where id = ?").run(now, now + this.config.sessionDays * DAY, id);
    return { user: this.publicUser(row), createdAt: row.created_at };
  }

  destroySession(token) {
    if (typeof token === "string") this.db.prepare("delete from sessions where id = ?").run(sha256(token));
  }

  destroyAllSessions(userId) {
    this.db.prepare("delete from sessions where user_id = ?").run(userId);
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // a forgotten password

  /** Mail a code to choose a new password. Always answers the same. (This does not give back notes that were encrypted with a passphrase: nothing can.) */
  async requestReset(emailInput, { ip = "-" } = {}) {
    const email = normalizeEmail(emailInput);
    if (!email) throw new AccountError("That does not look like an e-mail address.", 400, { code: "bad-email" });
    this.limit(`reset:ip:${ip}`, 10, 3600);
    this.limit(`reset:email:${email}`, 5, 3600);
    const user = this.userByEmail(email);
    if (user?.verified_at && !user.disabled && !this.recentCode(user.id, "reset")) await this.sendCode(user, "reset");
    return { ok: true };
  }

  /** The code and the new password: the password is changed and every session ends. */
  async reset(emailInput, code, password, { ip = "-" } = {}) {
    const email = normalizeEmail(emailInput);
    this.limit(`resetting:ip:${ip}`, 30, 3600);
    const user = email ? this.userByEmail(email) : undefined;
    if (!user || !user.verified_at) throw new AccountError("That code is wrong or has expired. Ask for a new one.", 400, { code: "wrong-code" });
    const problem = passwordProblem(password, email);
    if (problem) throw new AccountError(problem, 400, { code: "bad-password" });
    this.checkCode(user.id, "reset", code);
    this.db.prepare("update users set password_hash = ? where id = ?").run(await hashPassword(password), user.id);
    this.destroyAllSessions(user.id);
    return { ok: true };
  }

  /** The password changed by someone who is signed in and knows the old one; the other sessions end. */
  async changePassword(userId, current, next, keepToken) {
    const user = this.db.prepare("select * from users where id = ?").get(userId);
    if (!user) throw new AccountError("No such account.", 404);
    this.limit(`change:user:${userId}`, 10, 600);
    if (user.password_hash && !(await verifyPassword(String(current ?? ""), user.password_hash))) throw new AccountError("The current password is wrong.", 403, { code: "bad-login" });
    const problem = passwordProblem(next, user.email);
    if (problem) throw new AccountError(problem, 400, { code: "bad-password" });
    this.db.prepare("update users set password_hash = ? where id = ?").run(await hashPassword(next), userId);
    this.db.prepare("delete from sessions where user_id = ? and id != ?").run(userId, keepToken ? sha256(keepToken) : "");
    return { ok: true };
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // Google and GitHub

  /**
   * The person that a service vouches for: its name for them (`subject`) and an address, which has to be one that the service has itself confirmed. Known
   * subject: that account. An address that an account of ours has: the two are joined (both addresses are confirmed). A new address: a new account, with no password.
   * An account that was begun with a password and never confirmed loses that password when someone who really has the address signs in this way: it can't have
   * been the owner who chose it.
   */
  signInWithIdentity(provider, subject, emailInput, emailVerified) {
    const known = this.db.prepare("select u.* from identities i join users u on u.id = i.user_id where i.provider = ? and i.subject = ?").get(provider, subject);
    if (known) {
      if (known.disabled) throw new AccountError("This account is disabled.", 403);
      return this.publicUser(known);
    }
    const email = normalizeEmail(emailInput);
    if (!email || !emailVerified) throw new AccountError(`${provider === "github" ? "GitHub" : "Google"} did not confirm an e-mail address for you, so an account can't be made or found from it. Confirm one there, or sign up with your e-mail address.`, 403, { code: "unverified-email" });
    const now = this.now();
    return transaction(this.db, () => {
      let user = this.userByEmail(email);
      if (!user) {
        this.db.prepare("insert into users (email, password_hash, created_at, verified_at, quota_bytes) values (?, NULL, ?, ?, ?)").run(email, now, now, this.config.quotaBytes);
        user = this.userByEmail(email);
      } else if (!user.verified_at) {
        this.db.prepare("update users set password_hash = NULL, verified_at = ? where id = ?").run(now, user.id);
        this.db.prepare("delete from codes where user_id = ?").run(user.id);
        user = this.userByEmail(email);
      }
      if (user.disabled) throw new AccountError("This account is disabled.", 403);
      this.db.prepare("insert into identities (provider, subject, user_id, email, created_at) values (?, ?, ?, ?, ?)").run(provider, subject, user.id, email, now);
      return this.publicUser(user);
    });
  }

  identities(userId) {
    return this.db.prepare("select provider, email, created_at from identities where user_id = ? order by created_at").all(userId).map((i) => ({ provider: i.provider, email: i.email, linkedAt: i.created_at }));
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // the account's own data

  /** Everything the server keeps about the person, for them to take away. */
  exportData(userId) {
    const user = this.db.prepare("select * from users where id = ?").get(userId);
    if (!user) throw new AccountError("No such account.", 404);
    return { email: user.email, createdAt: user.created_at, confirmedAt: user.verified_at, quotaBytes: user.quota_bytes, hasPassword: !!user.password_hash, signIns: this.identities(userId), sessions: this.db.prepare("select count(*) as n from sessions where user_id = ?").get(userId).n };
  }

  /** Delete the account and everything of it. A password account asks for the password; one that has none asks for a session of the last ten minutes. */
  async deleteAccount(userId, password, sessionCreatedAt) {
    const user = this.db.prepare("select * from users where id = ?").get(userId);
    if (!user) throw new AccountError("No such account.", 404);
    this.limit(`delete:user:${userId}`, 5, 600);
    if (user.password_hash) {
      if (!(await verifyPassword(String(password ?? ""), user.password_hash))) throw new AccountError("The password is wrong.", 403, { code: "bad-login" });
    } else if (this.now() - sessionCreatedAt > 600) {
      throw new AccountError("Sign in again, then delete the account: it asks for a recent sign-in.", 403, { code: "recent-login" });
    }
    this.db.prepare("delete from users where id = ?").run(userId);
    return { ok: true };
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // housekeeping

  /** Clear away what is over: codes and sessions that expired, accounts never confirmed, sign-in attempts that were never finished. */
  purge() {
    const now = this.now();
    return {
      codes: this.db.prepare("delete from codes where expires_at < ?").run(now).changes,
      sessions: this.db.prepare("delete from sessions where expires_at < ?").run(now).changes,
      unconfirmed: this.db.prepare("delete from users where verified_at is null and created_at < ?").run(now - UNCONFIRMED_DAYS * DAY).changes,
      states: this.db.prepare("delete from oauth_states where created_at < ?").run(now - 3600).changes,
      limits: this.db.prepare("delete from limits where window_start < ?").run(now - DAY).changes,
    };
  }
}
