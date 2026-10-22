// Passwords and e-mail addresses: what is accepted, and how a password is kept (scrypt with a salt of its own: nothing here can be turned back into the password).
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { availableParallelism } from "node:os";
import { AccountError } from "./errors.mjs";

const N = 32768;
const R = 8;
const P = 1;
const KEY = 32;
const MEMORY = 128 * N * R * 2;

const scryptOf = (password, salt, n, r, p) =>
  new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, KEY, { N: n, r, p, maxmem: Math.max(MEMORY, 128 * n * r * 2) }, (error, key) => (error ? reject(error) : resolve(key))));

// How many passwords are hashed at the same time. A hash is made costly on purpose (32 MiB and tens of milliseconds each), and a crowd of strangers signing in with passwords that are wrong still has the
// server pay for every one: left to Node's thread pool (four at a time), that fills every processor, and the people who are only keeping their notebooks in step wait behind it (measured: a storm of
// sign-ins made the answer to a request that costs nothing four times slower, scripts/load.mjs --storm). So half of the processors do it (one at least), the next ones wait in turn, and when too many wait
// the next is turned away at once with a time to come back in, instead of being answered a long time late.
let slots;
let waitingMax;
let hashing;
let running = 0;
const waiting = [];

/** How many at once, how many may wait, and what does the hashing. Called with nothing it sets what a server has (and the module does so when it is loaded: a server never calls it); a test says other things. */
export function limitHashing({ slots: at = Math.max(1, Math.floor(availableParallelism() / 2)), waiting: queued = 64, run = scryptOf } = {}) {
  slots = at;
  waitingMax = queued;
  hashing = run;
}
limitHashing();

/** How many places there are now, and how many may wait for one (a test says what the defaults are). */
export const hashingLimits = () => ({ slots, waiting: waitingMax });

function acquire() {
  if (running < slots) {
    running++;
    return Promise.resolve();
  }
  if (waiting.length >= waitingMax) return Promise.reject(new AccountError("The server is busy: try again in a moment.", 503, { code: "busy", retryAfter: 5 }));
  // (the place is handed over when it is let go: `running` does not change in between)
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

const derive = async (password, salt, n = N, r = R, p = P) => {
  await acquire();
  try {
    return await hashing(password, salt, n, r, p);
  } finally {
    release();
  }
};

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Whether `password` is the one that `stored` was made from (and nothing is learned from how long it takes, or from a malformed `stored`). */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    await derive(password, Buffer.alloc(16)); // (as long as a real one takes)
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  try {
    const expected = Buffer.from(hash, "base64");
    const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch (error) {
    // (a server that is too busy to hash says so: it is not a password that is wrong)
    if (error instanceof AccountError) throw error;
    return false;
  }
}

/** The form of the address that is kept and compared, or null if it is not an address. (Only the case is made equal: `a+b@x` is not `a@x`.) */
export function normalizeEmail(input) {
  const email = String(input ?? "").trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  if (!/^[^\s@,;<>()[\]\\"]+@[^\s@,;<>()[\]\\"]+\.[^\s@,;<>()[\]\\"]{2,}$/.test(email)) return null;
  const [local, domain] = email.split("@");
  if (!local || local.length > 64 || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  return email;
}

const COMMON = new Set(
  "password,password1,password12,password123,passw0rd,123456789,1234567890,12345678910,qwertyuiop,qwerty123,azertyuiop,azerty123,iloveyou1,letmein123,welcome123,admin12345,changeme123,motdepasse,motdepasse1,0123456789,1q2w3e4r5t,abcdefghij,zimnotebook,turtlzim123".split(","),
);

/** Why this password is not accepted, or null if it is. Length is what counts; there are no rules about kinds of characters. */
export function passwordProblem(password, email = "") {
  if (typeof password !== "string") return "Choose a password.";
  const normal = password.normalize("NFKC");
  if (normal.length < 10) return "The password needs at least 10 characters.";
  if (normal.length > 200) return "The password can have at most 200 characters.";
  const lower = normal.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(normal)) return "That password is too common: choose another.";
  const local = String(email).split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && lower.includes(local)) return "The password should not contain your e-mail address.";
  return null;
}
