#!/usr/bin/env node
// Makes the service worker of a built app (web/pwa/sw.js, with the list of the app's files written in)
// and says which version that is.
//
//   node scripts/pwa.mjs [dir]           # after `vite build`: writes dir/sw.js (default dir: dist)
//   node scripts/pwa.mjs --check [dir]   # says whether dir's files are the ones its sw.js was made for
//   node scripts/pwa.mjs --remote URL    # the same for what a server serves, fetched from it
//
// The list has every file of the folder (but the worker itself) with its size and SHA-256. The worker
// downloads each, refuses any that is not the one listed, and keeps the app running as that list says
// until the person approves a new one (see pwa/sw.js). The version's id is a fingerprint of the list and
// of the worker's own code: the same files and worker give the same id, and one changed byte gives another,
// so two copies of the app can be compared by it, and a build made from the same source and tools should give
// the one that was released. `--remote` is for checking a server without trusting the page: it fetches the
// worker and every file from the address, as a person with `curl` would, and says what they add up to.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = fileURLToPath(new URL("../pwa/sw.js", import.meta.url));
export const WORKER_FILE = "sw.js";
const MARKERS = /\/\*MANIFEST\*\/[\s\S]*?\/\*END\*\//;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The paths (with `/`, relative to `dir`) of every file the app is made of, in order: not the worker, and nothing a server won't give out (a dotfile). */
export function listFiles(dir) {
  const found = [];
  const walk = (folder, prefix) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(join(folder, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile() && `${prefix}${entry.name}` !== WORKER_FILE) found.push(`${prefix}${entry.name}`);
    }
  };
  walk(dir, "");
  return found.sort();
}

/** A fingerprint of the worker's code, whatever list of files is written into it. */
export function workerDigest(workerText) {
  return sha256(workerText.replace(MARKERS, "/*MANIFEST*//*END*/"));
}

/** The id of a version: of its files and of the code of the worker that holds the app to them. */
function idOf(files, workerText) {
  return sha256(`${workerDigest(workerText)}\n${files.map((f) => `${f.url}\t${f.size}\t${f.sha256}\n`).join("")}`).slice(0, 16);
}

/** The version of the app in `dir`: `{ id, files: [{ url, size, sha256 }] }`. */
export function buildVersion(dir, source = SOURCE) {
  const files = listFiles(dir).map((url) => {
    const bytes = readFileSync(join(dir, url));
    return { url, size: bytes.length, sha256: sha256(bytes) };
  });
  return { id: idOf(files, readFileSync(source, "utf8")), files };
}

/** Writes `dir/sw.js`: the worker with the version of the files in `dir` in it. Gives the version. */
export function writeServiceWorker(dir, source = SOURCE) {
  const text = readFileSync(source, "utf8");
  if ((text.match(new RegExp(MARKERS, "g")) ?? []).length !== 1) throw new Error(`${source} should have the place for the list of files exactly once`);
  const version = buildVersion(dir, source);
  writeFileSync(join(dir, WORKER_FILE), text.replace(MARKERS, () => `/*MANIFEST*/ ${JSON.stringify(version)} /*END*/`));
  return version;
}

/** The version a `sw.js` was made for, as written in it. */
export function versionOf(workerSource) {
  const marked = MARKERS.exec(workerSource);
  if (!marked) throw new Error("no list of files in it");
  return JSON.parse(marked[0].slice("/*MANIFEST*/".length, -"/*END*/".length));
}

/** What differs between the files of `dir` and the version its worker was made for: the paths, with what is wrong with each. */
export function problemsWith(dir) {
  const worker = readFileSync(join(dir, WORKER_FILE), "utf8");
  const wanted = versionOf(worker);
  const have = buildVersion(dir, join(dir, WORKER_FILE));
  const problems = [];
  if (idOf(wanted.files, worker) !== wanted.id) problems.push("the worker's id is not the one its code and its list of files add up to");
  const listed = new Map(wanted.files.map((f) => [f.url, f]));
  for (const f of have.files) {
    const was = listed.get(f.url);
    if (!was) problems.push(`${f.url}: not in the list`);
    else if (was.size !== f.size || was.sha256 !== f.sha256) problems.push(`${f.url}: not the file that was listed`);
  }
  for (const f of wanted.files) if (!have.files.some((h) => h.url === f.url)) problems.push(`${f.url}: missing`);
  return { version: wanted, problems };
}

/**
 * What a server serves, fetched from it: the worker, then each file the worker lists, each compared with its
 * list. (No browser and no worker in the way: what comes back is what anybody asking would get.)
 */
export async function remoteProblems(address, fetcher = fetch) {
  const base = address.endsWith("/") ? address : `${address}/`;
  const get = async (path) => {
    const response = await fetcher(new URL(path, base), { cache: "no-store", redirect: "error" });
    if (!response.ok) throw new Error(`${path}: the server answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const worker = (await get(WORKER_FILE)).toString("utf8");
  const version = versionOf(worker);
  const problems = [];
  if (idOf(version.files, worker) !== version.id) problems.push("the worker's id is not the one its code and its list of files add up to");
  for (const file of version.files) {
    try {
      const bytes = await get(file.url);
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) problems.push(`${file.url}: not the file that was listed`);
    } catch (error) {
      problems.push(error.message);
    }
  }
  return { version, workerSha256: sha256(Buffer.from(worker)), problems };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  try {
    if (args[0] === "--remote") {
      if (!args[1]) throw new Error("--remote needs the address of the app");
      const { version, workerSha256, problems } = await remoteProblems(args[1]);
      for (const problem of problems) console.error(problem);
      console.log(`version ${version.id}: ${version.files.length} files${problems.length ? `, ${problems.length} wrong` : ", all as listed"}; worker script sha256 ${workerSha256}`);
      process.exit(problems.length ? 1 : 0);
    }
    const dir = args.find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("../dist", import.meta.url));
    statSync(dir);
    if (check) {
      const { version, problems } = problemsWith(dir);
      for (const problem of problems) console.error(problem);
      console.log(`version ${version.id}: ${version.files.length} files${problems.length ? `, ${problems.length} wrong` : ", all as listed"}`);
      process.exit(problems.length ? 1 : 0);
    }
    const version = writeServiceWorker(dir);
    console.log(`version ${version.id}: ${version.files.length} files, ${version.files.reduce((n, f) => n + f.size, 0)} bytes -> ${join(dir, WORKER_FILE)}`);
  } catch (error) {
    console.error(`pwa: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
