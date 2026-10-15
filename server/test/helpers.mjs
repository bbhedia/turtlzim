// What the tests of the server share: a server's parts in memory, with a clock that the test moves and a mailer that keeps what it was given.
import { randomBytes } from "node:crypto";
import { Accounts } from "../src/accounts.mjs";
import { openDatabase } from "../src/db.mjs";
import { OutboxMailer } from "../src/mail.mjs";

export function make(extra = {}) {
  const clock = { t: 1_800_000_000 };
  const db = openDatabase(":memory:");
  const mailer = new OutboxMailer();
  const config = { secret: randomBytes(32), sessionDays: 30, quotaBytes: 1024 * 1024, ...extra };
  const accounts = new Accounts({ db, mailer, config, now: () => clock.t });
  return { accounts, db, mailer, clock, config };
}

/** The six-digit code in the last message that was sent to `to`. */
export function lastCode(mailer, to) {
  const mail = [...mailer.sent].reverse().find((m) => m.to === to);
  const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1];
  if (!code) throw new Error(`no code was mailed to ${to}`);
  return code;
}

export const PASSWORD = "correct horse battery";

/** An account that is made and confirmed. */
export async function confirmed(parts, email = "ada@example.org", password = PASSWORD) {
  await parts.accounts.register(email, password);
  return parts.accounts.verify(email, lastCode(parts.mailer, email));
}

/** What an error that a person may see says, and its status. */
export async function refused(promiseOrFunction) {
  try {
    await (typeof promiseOrFunction === "function" ? promiseOrFunction() : promiseOrFunction);
  } catch (error) {
    return { message: error.message, status: error.status, code: error.extra?.code, retryAfter: error.extra?.retryAfter };
  }
  throw new Error("it was not refused");
}
