// @ts-check
// The service worker. It makes the app work without the network, and it pins the code the app runs.
//
//  * Every file of a version is listed below with its size and SHA-256 (written in by scripts/pwa.mjs
//    when the app is built). The worker downloads them all when it is installed, checks each against that
//    list, and keeps them in a cache of their own. A file that is not the one listed (a server that sent
//    something else, a proxy that changed a byte) fails the install, and the version that was there goes on.
//  * The first version is trusted as it comes. After that the version the app runs is the one that was
//    approved. A new worker that the browser finds on the server installs itself and waits: the page is
//    told that a new version is ready, with its id, and nothing changes until the person says yes. Even
//    when the browser makes the new worker the active one (the last tab was closed), it goes on answering
//    with the approved version's files, from the approved version's list, until it is approved.
//  * A file that is not in the cache (the browser cleared it) is fetched again, and served only if it is
//    the file the approved version was built with.
//  * Nothing else: no other file is kept, nothing is sent anywhere, no request is changed. A request for
//    something that is not one of the files goes to the network as if there were no worker.
//
// What it is kept in: `zim-web-v-<id>` is a cache of a version's files, and `zim-web-state` holds one
// entry, `zim-web-approved`: the list of the version that is approved. The page talks to the worker with
// two messages, `describe` and `approve` (the end of this file).
//
// This file is not compiled: what is read here is what runs. It is checked by `tsc -p pwa` and run, as
// it is built, by web/test/pwa-worker.test.ts (against a pretend browser) and web/test/browser.mjs (in
// Chromium).

/**
 * @typedef {{ url: string, size: number, sha256: string }} Entry
 * @typedef {{ id: string, files: Entry[], replaced?: string }} Version
 */

/** The version this worker was built with: written in by scripts/pwa.mjs, the one place that makes the list. */
const THIS_VERSION = /** @type {Version} */ (/*MANIFEST*/ { id: "unbuilt", files: [] } /*END*/);

const worker = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
const STATE_CACHE = "zim-web-state";
const APPROVED = "zim-web-approved";
const PREFIX = "zim-web-";

/** @param {string} id */
const versionCache = (id) => `${PREFIX}v-${id}`;
/** Where a file of the app is, from its path in the list. @param {string} path */
const where = (path) => new URL(path, worker.registration.scope).href;

// ------------------------------------------------------------------------------------------------
// what the files are

/** A file that is not what it should be, or can't be had. `kind` says which: "network", "missing", "changed" or "other". */
class Unverified extends Error {
  /** @param {string} kind @param {string} message */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** @param {ArrayBuffer} bytes */
async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The file as the server has it now, if it is the one that was built: the same size, the same SHA-256.
 * (Not from the browser's own cache: that is what could have been changed.)
 * @param {Entry} entry
 */
async function fetchVerified(entry) {
  let response;
  try {
    response = await fetch(new Request(where(entry.url), { cache: "reload" }));
  } catch {
    throw new Unverified("network", `${entry.url}: the server can't be reached`);
  }
  if (response.status === 404 || response.status === 410) throw new Unverified("missing", `${entry.url}: the server does not have it`);
  if (response.redirected) throw new Unverified("other", `${entry.url}: the server sent it somewhere else`);
  if (!response.ok || response.type === "opaque") throw new Unverified("other", `${entry.url}: the server answered ${response.status}`);
  const bytes = await response.clone().arrayBuffer();
  if (bytes.byteLength !== entry.size || (await sha256(bytes)) !== entry.sha256) throw new Unverified("changed", `${entry.url}: it is not the file this version was built with`);
  return response;
}

/**
 * All of a version's files are in its cache, each checked when it came. If one isn't what it should be
 * the cache is thrown away, so that nothing unchecked is ever there.
 * @param {Version} version
 */
async function fill(version) {
  const cache = await caches.open(versionCache(version.id));
  try {
    await Promise.all(
      version.files.map(async (entry) => {
        if (await cache.match(where(entry.url), { ignoreVary: true })) return;
        await cache.put(where(entry.url), await fetchVerified(entry));
      }),
    );
  } catch (error) {
    await caches.delete(versionCache(version.id));
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------
// which version is approved

/** @param {unknown} value @returns {value is Version} */
function isVersion(value) {
  const v = /** @type {Partial<Version> | null} */ (value);
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.id === "string" &&
    Array.isArray(v.files) &&
    v.files.every((f) => !!f && typeof f.url === "string" && !/^[a-z][a-z0-9+.-]*:|^\/|(^|\/)\.\.(\/|$)/i.test(f.url) && Number.isInteger(f.size) && typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256))
  );
}

/** @returns {Promise<Version | null>} */
async function readApproved() {
  const stored = await (await caches.open(STATE_CACHE)).match(where(APPROVED), { ignoreVary: true });
  if (!stored) return null;
  try {
    const version = await stored.json();
    return isVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/** @param {Version} version */
async function writeApproved(version) {
  await (await caches.open(STATE_CACHE)).put(where(APPROVED), new Response(JSON.stringify(version), { headers: { "content-type": "application/json" } }));
}

/** The approved version. If none is (the browser cleared the record), this worker's is, as it was at the first install. */
async function approvedVersion() {
  const approved = await readApproved();
  if (approved) return approved;
  await writeApproved(THIS_VERSION);
  return THIS_VERSION;
}

/** What is not this version or the approved one is thrown away. */
async function tidy() {
  const approved = await readApproved();
  const keep = new Set([STATE_CACHE, versionCache(THIS_VERSION.id)]);
  if (approved) keep.add(versionCache(approved.id));
  for (const name of await caches.keys()) if (name.startsWith(PREFIX) && !keep.has(name)) await caches.delete(name);
}

// ------------------------------------------------------------------------------------------------
// install, activate

worker.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await fill(THIS_VERSION);
      // the first version is trusted as it comes; a later one waits to be approved
      if (!(await readApproved())) await writeApproved(THIS_VERSION);
    })(),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await tidy();
      await worker.clients.claim();
    })(),
  );
});

// ------------------------------------------------------------------------------------------------
// answering

/**
 * The entry of a version's list that a request is for: the page for the folder it is in, a file for its own
 * address, nothing for any other. (A query or a fragment is not part of what file it is.)
 * @param {Version} version @param {URL} url
 * @returns {Entry | undefined}
 */
function entryFor(version, url) {
  const folder = new URL(worker.registration.scope).pathname;
  let path;
  try {
    path = decodeURIComponent(url.pathname.slice(folder.length));
  } catch {
    return undefined;
  }
  if (path === "") path = "index.html";
  return version.files.find((entry) => entry.url === path);
}

/**
 * A file of a version: from its cache, or, if the browser has cleared it, from the server, if that has the
 * file the version was built with. Says why, if it can't.
 * @param {Version} version @param {Entry} entry
 * @returns {Promise<{ response: Response } | { failure: string }>}
 */
async function serve(version, entry) {
  const cache = await caches.open(versionCache(version.id));
  const kept = await cache.match(where(entry.url), { ignoreVary: true });
  if (kept) return { response: kept };
  try {
    const fresh = await fetchVerified(entry);
    await cache.put(where(entry.url), fresh.clone());
    return { response: fresh };
  } catch (error) {
    return { failure: error instanceof Unverified ? error.kind : "other" };
  }
}

/** @param {Request} request */
function refused(request) {
  if (request.mode !== "navigate") return Response.error();
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Zim Notebook</title>` +
      `<body style="font: 16px system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">` +
      `<h1>The app's files could not be checked</h1>` +
      `<p>This app is saved on this device, but the files it needs are not all here any more (the browser clears them when the disk is short of room), and they could not be fetched again in the form they were installed in. Nothing in your notebooks has been touched.</p>` +
      `<p>Try again when the server can be reached: reload this page.</p>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/** @param {Request} request @param {URL} url */
async function answer(request, url) {
  const approved = await approvedVersion();
  const entry = entryFor(approved, url);
  if (!entry) return fetch(request);
  const served = await serve(approved, entry);
  if ("response" in served) return served.response;
  // The approved version can't be had: the browser cleared its files, and the server has others (or none).
  // Offline is not that: it is tried again. But when the server does not have the files the version was built
  // with, this worker's version takes its place, and the page says so (describe: `replaced`).
  if ((served.failure === "missing" || served.failure === "changed") && approved.id !== THIS_VERSION.id) {
    const own = entryFor(THIS_VERSION, url);
    const ownServed = own && (await serve(THIS_VERSION, own));
    if (ownServed && "response" in ownServed) {
      await writeApproved({ ...THIS_VERSION, replaced: approved.id });
      await tidy();
      return ownServed.response;
    }
  }
  return refused(request);
}

worker.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  const scope = new URL(worker.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith(answer(request, url));
});

// ------------------------------------------------------------------------------------------------
// what the page can ask

/** @param {Entry[]} files */
const total = (files) => files.reduce((sum, entry) => sum + entry.size, 0);

/**
 * What this worker knows: the version that is approved (the one the pages run), and, if this worker has a
 * different one, what it offers, with the names of the files that differ.
 */
async function describe() {
  const approved = await approvedVersion();
  const theirs = new Map(approved.files.map((entry) => [entry.url, entry.sha256]));
  const ours = new Map(THIS_VERSION.files.map((entry) => [entry.url, entry.sha256]));
  const changed = [
    ...THIS_VERSION.files.filter((entry) => theirs.get(entry.url) !== entry.sha256).map((entry) => entry.url),
    ...approved.files.filter((entry) => !ours.has(entry.url)).map((entry) => entry.url),
  ];
  return {
    type: "version",
    running: approved.id,
    files: approved.files.length,
    bytes: total(approved.files),
    replaced: approved.replaced ?? null,
    offered: THIS_VERSION.id === approved.id ? null : { id: THIS_VERSION.id, files: THIS_VERSION.files.length, bytes: total(THIS_VERSION.files), changed },
  };
}

/**
 * The person approves this worker's version: from now on the pages run it. (Its files are made sure of
 * first, and the pages that are open are told, so that they start again on it.)
 * @param {unknown} id
 */
async function approve(id) {
  if (id !== THIS_VERSION.id) return { type: "approved", ok: false, reason: "that is not the version this worker has" };
  try {
    await fill(THIS_VERSION);
  } catch (error) {
    return { type: "approved", ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  await writeApproved(THIS_VERSION);
  await tidy();
  await worker.skipWaiting();
  for (const client of await worker.clients.matchAll({ includeUncontrolled: true, type: "window" })) client.postMessage({ type: "updated", id: THIS_VERSION.id });
  return { type: "approved", ok: true, id: THIS_VERSION.id };
}

worker.addEventListener("message", (event) => {
  const message = /** @type {{ type?: unknown, id?: unknown } | null} */ (event.data);
  if (!message || typeof message !== "object") return;
  /** @param {unknown} reply */
  const reply = (reply) => (event.ports[0] ?? event.source)?.postMessage(reply);
  if (message.type === "describe") event.waitUntil(describe().then(reply));
  else if (message.type === "approve") event.waitUntil(approve(message.id).then(reply));
});
