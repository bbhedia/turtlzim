// The service worker (web/pwa/sw.js), the file as the build writes it, in a pretend browser
// (helpers/sw-sim.ts): what it keeps, what it refuses, and that the app it serves changes only when
// a new version is approved. The same promises are kept in a real browser by test/browser.mjs.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Version } from "../scripts/pwa.mjs";
import { writeServiceWorker } from "../scripts/pwa.mjs";
import { FOLDER, FakeCaches, FakeServer, FakeWorker, textOf } from "./helpers/sw-sim";

const folders: string[] = [];
afterAll(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

interface Build {
  source: string;
  version: Version;
  files: Record<string, string>;
}

/** A built app: these files, with the worker that scripts/pwa.mjs makes for them. */
function build(files: Record<string, string>): Build {
  const dir = mkdtempSync(join(tmpdir(), "zim-pwa-"));
  folders.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const version = writeServiceWorker(dir);
  return { source: readFileSync(join(dir, "sw.js"), "utf8"), version, files };
}

const ONE = build({ "index.html": "<html>version one</html>", "assets/app-aaa.js": "console.log('one')", "assets/core-bbb.wasm": "wasm one", "manifest.webmanifest": "{}" });
const TWO = build({ "index.html": "<html>version two</html>", "assets/app-ccc.js": "console.log('two')", "assets/core-bbb.wasm": "wasm one", "manifest.webmanifest": "{}" });

/** A browser with its caches and the server that has `served`'s files. */
function browser(served: Build) {
  const caches = new FakeCaches();
  const server = new FakeServer(served.files);
  return { caches, server, worker: (made: Build) => new FakeWorker(made.source, caches, server) };
}

/** A browser that has installed and activated `first`. */
async function installed(first: Build) {
  const world = browser(first);
  const worker = world.worker(first);
  await worker.install();
  await worker.activate();
  return { ...world, first: worker };
}

const names = (caches: FakeCaches) => caches.keys().then((keys) => keys.sort());

describe("installing", () => {
  it("keeps every file of the version, each checked against its list, and approves the first version as it comes", async () => {
    const { caches, first, server } = await installed(ONE);
    expect(await names(caches)).toEqual([`zim-web-state`, `zim-web-v-${ONE.version.id}`]);
    const kept = await caches.open(`zim-web-v-${ONE.version.id}`);
    expect([...kept.entries.keys()].sort()).toEqual(ONE.version.files.map((f) => `https://app.test/${f.url}`).sort());
    expect(server.log.sort()).toEqual(ONE.version.files.map((f) => `/${f.url}`).sort());
    expect(await first.describe()).toMatchObject({ type: "version", running: ONE.version.id, offered: null, replaced: null, files: 4 });
    expect(first.claimed).toBe(true);
  });

  it("refuses a file that is not the one that was built (one byte different), and keeps nothing of the version", async () => {
    const world = browser(ONE);
    world.server.put("assets/app-aaa.js", "console.log('ONE')");
    const worker = world.worker(ONE);
    await expect(worker.install()).rejects.toThrow(/assets\/app-aaa\.js: it is not the file this version was built with/);
    expect(await names(world.caches)).toEqual([]);
  });

  it("refuses a file of another size, a missing file, a server error and a redirect", async () => {
    const cases: Array<[string, (server: FakeServer) => void, RegExp]> = [
      ["a longer file", (s) => s.put("assets/core-bbb.wasm", "wasm one, and more"), /not the file this version was built with/],
      ["a missing file", (s) => void s.files.delete("assets/core-bbb.wasm"), /the server does not have it/],
      ["a server error", (s) => void s.errors.set("assets/core-bbb.wasm", 500), /the server answered 500/],
      ["a redirect", (s) => void s.redirects.add("assets/core-bbb.wasm"), /the server sent it somewhere else/],
      ["the network gone", (s) => void (s.offline = true), /the server can't be reached/],
    ];
    for (const [name, spoil, why] of cases) {
      const world = browser(ONE);
      spoil(world.server);
      await expect(world.worker(ONE).install(), name).rejects.toThrow(why);
      expect(await names(world.caches), name).toEqual([]);
    }
  });

  it("asks the server, not the browser's own cache, for each file", async () => {
    // (the request says `reload`: a file that an earlier visit left in the HTTP cache is not what is checked)
    const asked: string[] = [];
    const world = browser(ONE);
    const real = world.server.fetch;
    world.server.fetch = async (input) => {
      asked.push(typeof input === "string" ? "?" : (input as Request).cache);
      return real(input);
    };
    await world.worker(ONE).install();
    expect(new Set(asked)).toEqual(new Set(["reload"]));
  });
});

describe("an app in a folder of a site", () => {
  it("keeps and answers for that folder only, and the files are asked for there", async () => {
    const caches = new FakeCaches();
    const server = new FakeServer(ONE.files, "/notes/");
    const worker = new FakeWorker(ONE.source, caches, server, FOLDER);
    await worker.install();
    await worker.activate();
    expect(server.log.every((path) => path.startsWith("/notes/"))).toBe(true);
    const kept = await caches.open(`zim-web-v-${ONE.version.id}`);
    expect([...kept.entries.keys()].every((key) => key.startsWith("https://app.test/notes/"))).toBe(true);
    server.log.length = 0;
    expect(await textOf(await worker.fetch("/notes/", { navigate: true }))).toBe("<html>version one</html>");
    expect(await textOf(await worker.fetch("/notes/assets/app-aaa.js"))).toBe("console.log('one')");
    expect(server.log).toEqual([]);
    // what is outside the folder is not the worker's business
    expect(await worker.fetch("/", { navigate: true })).toBeNull();
    expect(await worker.fetch("/assets/app-aaa.js")).toBeNull();
    expect(await worker.fetch("/notes-elsewhere/index.html")).toBeNull();
  });
});

describe("answering", () => {
  it("serves the files from the cache, without asking the server again, and the page for the folder and for its own address", async () => {
    const { first, server } = await installed(ONE);
    server.log.length = 0;
    expect(await textOf(await first.fetch("/", { navigate: true }))).toBe("<html>version one</html>");
    expect(await textOf(await first.fetch("/index.html"))).toBe("<html>version one</html>");
    expect(await textOf(await first.fetch("/index.html?from=a-link#x"))).toBe("<html>version one</html>");
    expect(await textOf(await first.fetch("/assets/app-aaa.js"))).toBe("console.log('one')");
    expect(await textOf(await first.fetch("/assets/app-aaa.js?v=2"))).toBe("console.log('one')");
    expect(server.log).toEqual([]);
  });

  it("works with the server switched off", async () => {
    const { first, server } = await installed(ONE);
    server.offline = true;
    expect(await textOf(await first.fetch("/", { navigate: true }))).toBe("<html>version one</html>");
    expect(await textOf(await first.fetch("/assets/core-bbb.wasm"))).toBe("wasm one");
  });

  it("leaves everything else to the network: other methods, ranges, other origins, and what is none of its files", async () => {
    const { first, server } = await installed(ONE);
    expect(await first.fetch("/assets/app-aaa.js", { method: "POST" })).toBeNull();
    expect(await first.fetch("/assets/core-bbb.wasm", { range: true })).toBeNull();
    expect(await first.fetch("https://elsewhere.test/assets/app-aaa.js", { absolute: true })).toBeNull();
    // a request in the folder that is none of the files goes to the server as if there were no worker
    server.log.length = 0;
    expect((await first.fetch("/not-a-file.txt", { navigate: true }))?.status).toBe(404);
    expect((await first.fetch("/something-else.png"))?.status).toBe(404);
    expect(server.log).toEqual(["/not-a-file.txt", "/something-else.png"]);
  });
});

describe("a browser that has cleared the files", () => {
  it("gets a file again from the server, if it is the one that was built, and keeps it", async () => {
    const { caches, first, server } = await installed(ONE);
    await caches.delete(`zim-web-v-${ONE.version.id}`);
    server.log.length = 0;
    expect(await textOf(await first.fetch("/assets/app-aaa.js"))).toBe("console.log('one')");
    expect(server.log).toEqual(["/assets/app-aaa.js"]);
    server.log.length = 0;
    expect(await textOf(await first.fetch("/assets/app-aaa.js"))).toBe("console.log('one')");
    expect(server.log).toEqual([]);
  });

  it("refuses a file that the server now sends changed, and says that the files could not be checked", async () => {
    const { caches, first, server } = await installed(ONE);
    await caches.delete(`zim-web-v-${ONE.version.id}`);
    server.put("assets/app-aaa.js", "alert('not the app')");
    server.put("index.html", "<html>not the app</html>");
    const script = await first.fetch("/assets/app-aaa.js");
    expect(script?.type === "error" || script?.status === 0 || script?.ok === false).toBe(true);
    const page = await first.fetch("/", { navigate: true });
    expect(page?.status).toBe(503);
    const shown = await textOf(page);
    expect(shown).toContain("could not be checked");
    expect(shown).not.toContain("not the app</html>");
    // and nothing unchecked was kept
    expect((await caches.open(`zim-web-v-${ONE.version.id}`)).entries.size).toBe(0);
  });

  it("is told to try again, and does not change what is approved, when the server can't be reached", async () => {
    const { caches, first, server } = await installed(ONE);
    await caches.delete(`zim-web-v-${ONE.version.id}`);
    server.offline = true;
    const page = await first.fetch("/", { navigate: true });
    expect(page?.status).toBe(503);
    expect((await first.describe()).running).toBe(ONE.version.id);
  });
});

describe("an update", () => {
  /** v1 is installed and approved; the server now has v2, and the browser has found its worker and installed it. */
  async function waiting() {
    const world = await installed(ONE);
    world.server.files.clear();
    for (const [path, content] of Object.entries(TWO.files)) world.server.put(path, content);
    const second = world.worker(TWO);
    await second.install();
    return { ...world, second };
  }

  it("installs and waits: the version that runs is still the approved one, and what is offered is described", async () => {
    const { caches, second } = await waiting();
    expect(await names(caches)).toEqual(["zim-web-state", `zim-web-v-${ONE.version.id}`, `zim-web-v-${TWO.version.id}`].sort());
    const described = await second.describe();
    expect(described).toMatchObject({ running: ONE.version.id, offered: { id: TWO.version.id, files: 4 } });
    // the files that differ: what is new, and what has gone
    expect([...(described.offered as { changed: string[] }).changed].sort()).toEqual(["assets/app-aaa.js", "assets/app-ccc.js", "index.html"]);
    expect(second.skippedWaiting).toBe(false);
  });

  it("goes on serving the approved version even when the browser makes the new worker the active one", async () => {
    // (all the pages were closed, and the browser activated what was waiting)
    const { second, server } = await waiting();
    await second.activate();
    expect(second.claimed).toBe(true);
    expect(await textOf(await second.fetch("/", { navigate: true }))).toBe("<html>version one</html>");
    expect(await textOf(await second.fetch("/assets/app-aaa.js"))).toBe("console.log('one')");
    // (a file that only the new version has is not served: the approved version has no such file)
    server.log.length = 0;
    expect((await second.fetch("/assets/app-ccc.js"))?.status).toBe(200);
    expect(server.log).toEqual(["/assets/app-ccc.js"]);
    // and it still says that there is a version to approve
    expect(await second.describe()).toMatchObject({ running: ONE.version.id, offered: { id: TWO.version.id } });
  });

  it("changes what is served only when it is approved: then the new files, the old ones gone, the pages told", async () => {
    const { caches, second } = await waiting();
    const [reply] = await second.message({ type: "approve", id: TWO.version.id });
    expect(reply).toEqual({ type: "approved", ok: true, id: TWO.version.id });
    expect(second.skippedWaiting).toBe(true);
    expect(second.sent).toContainEqual({ type: "updated", id: TWO.version.id });
    expect(await names(caches)).toEqual(["zim-web-state", `zim-web-v-${TWO.version.id}`].sort());
    await second.activate();
    expect(await textOf(await second.fetch("/", { navigate: true }))).toBe("<html>version two</html>");
    expect(await textOf(await second.fetch("/assets/app-ccc.js"))).toBe("console.log('two')");
    expect(await second.describe()).toMatchObject({ running: TWO.version.id, offered: null });
  });

  it("is approved only by naming the version that the worker has", async () => {
    const { caches, second } = await waiting();
    const before = await names(caches);
    const [refused] = await second.message({ type: "approve", id: ONE.version.id });
    expect(refused).toMatchObject({ type: "approved", ok: false });
    expect((await second.message({ type: "approve" }))[0]).toMatchObject({ ok: false });
    expect(await names(caches)).toEqual(before);
    expect((await second.describe()).running).toBe(ONE.version.id);
    expect(second.skippedWaiting).toBe(false);
  });

  it("is refused when one of its files is not what its list says, and the version that runs is not touched", async () => {
    const world = await installed(ONE);
    world.server.files.clear();
    for (const [path, content] of Object.entries(TWO.files)) world.server.put(path, content);
    world.server.put("assets/app-ccc.js", "console.log('two, changed on the way')");
    const second = world.worker(TWO);
    await expect(second.install()).rejects.toThrow(/assets\/app-ccc\.js: it is not the file this version was built with/);
    expect(await names(world.caches)).toEqual(["zim-web-state", `zim-web-v-${ONE.version.id}`].sort());
    expect(await textOf(await world.first.fetch("/", { navigate: true }))).toBe("<html>version one</html>");
  });

  it("is not approved by a file that was changed after it was installed: approving fetches what is missing, and checks it", async () => {
    const { caches, second, server } = await waiting();
    await caches.delete(`zim-web-v-${TWO.version.id}`);
    server.put("assets/app-ccc.js", "console.log('two, changed since')");
    const [reply] = await second.message({ type: "approve", id: TWO.version.id });
    expect(reply).toMatchObject({ type: "approved", ok: false });
    expect(String(reply?.reason)).toContain("not the file this version was built with");
    expect((await second.describe()).running).toBe(ONE.version.id);
  });

  it("takes the place of the approved version when the browser has cleared that and the server no longer has it, and says so", async () => {
    const { caches, second } = await waiting();
    await second.activate();
    await caches.delete(`zim-web-v-${ONE.version.id}`);
    // (the server has version two only: version one's files are gone from it)
    expect(await textOf(await second.fetch("/", { navigate: true }))).toBe("<html>version two</html>");
    expect(await second.describe()).toMatchObject({ running: TWO.version.id, replaced: ONE.version.id, offered: null });
    expect(await names(caches)).toEqual(["zim-web-state", `zim-web-v-${TWO.version.id}`].sort());
  });

  it("does not take its place because the network is down", async () => {
    const { caches, second, server } = await waiting();
    await second.activate();
    await caches.delete(`zim-web-v-${ONE.version.id}`);
    server.offline = true;
    expect((await second.fetch("/", { navigate: true }))?.status).toBe(503);
    expect(await second.describe()).toMatchObject({ running: ONE.version.id, replaced: null });
  });
});

describe("what it keeps and what it trusts", () => {
  it("throws away its own caches that belong to no version it knows, and none of anybody else's", async () => {
    const world = browser(ONE);
    await (await world.caches.open("zim-web-v-an-old-one")).put("https://app.test/x", new Response("x"));
    await (await world.caches.open("another-app")).put("https://app.test/y", new Response("y"));
    const worker = world.worker(ONE);
    await worker.install();
    await worker.activate();
    expect(await names(world.caches)).toEqual(["another-app", "zim-web-state", `zim-web-v-${ONE.version.id}`].sort());
  });

  it("takes its own version to be approved if the record of what was approved has gone", async () => {
    const { caches, first } = await installed(ONE);
    await caches.delete("zim-web-state");
    expect(await first.describe()).toMatchObject({ running: ONE.version.id, offered: null });
    // (and it is a record again, not something made up each time: what is approved is written down)
    const record = await (await caches.open("zim-web-state")).match("https://app.test/zim-web-approved");
    expect(JSON.parse(await textOf(record ?? null)).id).toBe(ONE.version.id);
  });

  it("does not believe a record that is not a list of files of the app: a path that climbs out, an address, a hash that is not one", async () => {
    for (const file of [{ url: "../../etc/passwd", size: 1, sha256: "0".repeat(64) }, { url: "https://evil.test/a.js", size: 1, sha256: "0".repeat(64) }, { url: "/a.js", size: 1, sha256: "0".repeat(64) }, { url: "a.js", size: 1, sha256: "zz" }]) {
      const { caches, first } = await installed(ONE);
      await (await caches.open("zim-web-state")).put("https://app.test/zim-web-approved", new Response(JSON.stringify({ id: "planted", files: [file] })));
      expect((await first.describe()).running, JSON.stringify(file)).toBe(ONE.version.id);
    }
    const { caches, first } = await installed(ONE);
    await (await caches.open("zim-web-state")).put("https://app.test/zim-web-approved", new Response("not json at all"));
    expect((await first.describe()).running).toBe(ONE.version.id);
  });

  it("ignores messages that are not its own", async () => {
    const { first } = await installed(ONE);
    expect(await first.message(null)).toEqual([]);
    expect(await first.message("describe")).toEqual([]);
    expect(await first.message({ type: "something else" })).toEqual([]);
    expect(await first.message({ type: 5 })).toEqual([]);
  });

  it("is made for exactly the files of its list: an unbuilt copy of the worker approves and keeps nothing", async () => {
    const world = browser(ONE);
    const unbuilt = readFileSync(new URL("../pwa/sw.js", import.meta.url), "utf8");
    const worker = world.worker({ source: unbuilt, version: ONE.version, files: ONE.files });
    await worker.install();
    expect(await worker.describe()).toMatchObject({ running: "unbuilt", files: 0 });
  });
});
