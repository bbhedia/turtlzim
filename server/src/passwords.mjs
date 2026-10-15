// Passwords and e-mail addresses: what is accepted, and how a password is kept (scrypt with a salt of its own: nothing here can be turned back into the password).
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768;
const R = 8;
const P = 1;
const KEY = 32;
const MEMORY = 128 * N * R * 2;

const derive = (password, salt, n = N, r = R, p = P) =>
  new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, KEY, { N: n, r, p, maxmem: Math.max(MEMORY, 128 * n * r * 2) }, (error, key) => (error ? reject(error) : resolve(key))));

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
  } catch {
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
