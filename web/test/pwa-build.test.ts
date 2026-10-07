// What the build makes for the service worker (scripts/pwa.mjs): the list of the app's files with their
// hashes, which is what the worker holds the app to, and that the app has what a browser asks of an
// installable one (a manifest, icons of the sizes it names).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { buildVersion, listFiles, problemsWith, remoteProblems, versionOf, workerDigest, writeServiceWorker } from "../scripts/pwa.mjs";
import { createStaticServer } from "../scripts/serve.mjs";

const folders: string[] = [];
afterAll(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "zim-pwa-build-"));
  folders.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const FILES = { "index.html": "<html></html>", "assets/app-1.js": "one", "assets/deep/er/file.wasm": "two", "manifest.webmanifest": "{}" };

describe("the list of the app's files", () => {
  it("has every file, with `/` in its path, in order, and neither the worker nor what a server won't give out", () => {
    const dir = app({ ...FILES, "sw.js": "an old worker", ".hidden": "x", "assets/.also-hidden": "y", ".git/config": "z" });
    expect(listFiles(dir)).toEqual(["assets/app-1.js", "assets/deep/er/file.wasm", "index.html", "manifest.webmanifest"]);
  });

  it("gives each file's size and SHA-256, as another program computes them", () => {
    const dir = app(FILES);
    for (const file of buildVersion(dir).files) {
      const outside = execFileSync("sha256sum", [join(dir, file.url)], { encoding: "utf8" }).split(" ")[0];
      expect(file.sha256, file.url).toBe(outside);
      expect(file.size, file.url).toBe(readFileSync(join(dir, file.url)).length);
    }
  });

  it("is told apart by an id that is the same for the same files wherever they are, and changes with a byte, a name or a file", () => {
    const here = buildVersion(app(FILES)).id;
    expect(buildVersion(app(FILES)).id).toBe(here);
    expect(here).toMatch(/^[0-9a-f]{16}$/);
    expect(buildVersion(app({ ...FILES, "assets/app-1.js": "onE" })).id).not.toBe(here);
    expect(buildVersion(app({ ...FILES, "assets/app-1.js": "one!" })).id).not.toBe(here);
    const { "assets/app-1.js": moved, ...rest } = FILES;
    expect(buildVersion(app({ ...rest, "assets/app-2.js": moved })).id).not.toBe(here);
    expect(buildVersion(app({ ...FILES, "extra.txt": "" })).id).not.toBe(here);
  });
});

describe("the worker that is written", () => {
  it("is the source of the worker with the list written in, and nothing else changed", () => {
    const dir = app(FILES);
    const version = writeServiceWorker(dir);
    const written = readFileSync(join(dir, "sw.js"), "utf8");
    const source = readFileSync(new URL("../pwa/sw.js", import.meta.url), "utf8");
    expect(versionOf(written)).toEqual(version);
    expect(written.replace(/\/\*MANIFEST\*\/[\s\S]*?\/\*END\*\//, "")).toBe(source.replace(/\/\*MANIFEST\*\/[\s\S]*?\/\*END\*\//, ""));
    // and the list of the version it was written for is the one of the folder (without the worker itself)
    expect(buildVersion(dir)).toEqual(version);
  });

  it("has an id that covers the worker's own code as well as the files, which are what holds the app to them", () => {
    const dir = app(FILES);
    const source = readFileSync(new URL("../pwa/sw.js", import.meta.url), "utf8");
    const changed = join(dir, "..", "changed-worker.js");
    writeFileSync(changed, source.replace("const PREFIX =", "// a change in what the worker does\nconst PREFIX ="));
    folders.push(changed);
    const same = buildVersion(dir);
    const other = buildVersion(dir, changed);
    expect(other.id).not.toBe(same.id);
    expect(other.files).toEqual(same.files);
    expect(workerDigest(readFileSync(changed, "utf8"))).not.toBe(workerDigest(source));
    // and the digest of a worker does not depend on the list that was written into it
    writeServiceWorker(dir);
    expect(workerDigest(readFileSync(join(dir, "sw.js"), "utf8"))).toBe(workerDigest(source));
  });

  it("is made again for the same files, byte for byte", () => {
    const dir = app(FILES);
    writeServiceWorker(dir);
    const first = readFileSync(join(dir, "sw.js"));
    writeServiceWorker(dir);
    expect(readFileSync(join(dir, "sw.js")).equals(first)).toBe(true);
  });

  it("is not made from a source that has no place for the list, or two", () => {
    const dir = app(FILES);
    const none = join(dir, "..", "none.js");
    const two = join(dir, "..", "two.js");
    writeFileSync(none, "// nothing here\n");
    writeFileSync(two, "const a = /*MANIFEST*/ {} /*END*/; const b = /*MANIFEST*/ {} /*END*/;\n");
    folders.push(none, two);
    expect(() => writeServiceWorker(dir, none)).toThrow(/exactly once/);
    expect(() => writeServiceWorker(dir, two)).toThrow(/exactly once/);
  });
});

describe("checking a folder against its worker", () => {
  it("finds nothing wrong with what was built, and each change that was made since", () => {
    const dir = app(FILES);
    writeServiceWorker(dir);
    expect(problemsWith(dir).problems).toEqual([]);
    writeFileSync(join(dir, "assets/app-1.js"), "changed");
    writeFileSync(join(dir, "added.txt"), "new");
    rmSync(join(dir, "index.html"));
    expect(problemsWith(dir).problems.sort()).toEqual(["added.txt: not in the list", "assets/app-1.js: not the file that was listed", "index.html: missing"]);
  });

  it("finds a worker whose id is not what its code and its list add up to", () => {
    const dir = app(FILES);
    const version = writeServiceWorker(dir);
    const written = readFileSync(join(dir, "sw.js"), "utf8");
    writeFileSync(join(dir, "sw.js"), written.replace(`"id":"${version.id}"`, `"id":"0123456789abcdef"`));
    expect(problemsWith(dir).problems).toEqual(["the worker's id is not the one its code and its list of files add up to"]);
    writeFileSync(join(dir, "sw.js"), written.replace("const PREFIX =", "const PREFIX_ =").replace("PREFIX ", "PREFIX_ "));
    expect(problemsWith(dir).problems.length).toBeGreaterThan(0);
  });

  it("holds for the app that is built, when there is one", () => {
    const dist = new URL("../dist", import.meta.url).pathname;
    if (!existsSync(join(dist, "sw.js"))) return; // (not built: `npm run build` first)
    const { version, problems } = problemsWith(dist);
    expect(problems).toEqual([]);
    expect(version.files.map((f) => f.url)).toContain("index.html");
    expect(version.files.some((f) => /^assets\/.*\.wasm$/.test(f.url))).toBe(true);
  });
});

describe("checking what a server serves", () => {
  async function serving(files: Record<string, string>) {
    const dir = app(files);
    const version = writeServiceWorker(dir);
    const server = createStaticServer({ dir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    return { dir, version, address, stop: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
  }

  it("says what the files that are served add up to, and finds nothing wrong with a server that serves what was built", async () => {
    const site = await serving(FILES);
    try {
      const checked = await remoteProblems(site.address);
      expect(checked.problems).toEqual([]);
      expect(checked.version).toEqual(site.version);
      expect(checked.workerSha256).toMatch(/^[0-9a-f]{64}$/);
      // (the command says it the way a person reads it)
      const { stdout } = await promisify(execFile)(process.execPath, [new URL("../scripts/pwa.mjs", import.meta.url).pathname, "--remote", site.address]);
      expect(stdout).toContain(`version ${site.version.id}: 4 files, all as listed; worker script sha256 ${checked.workerSha256}`);
    } finally {
      await site.stop();
    }
  });

  it("finds a file that the server serves changed, one it does not serve, and a worker that does not add up", async () => {
    const site = await serving(FILES);
    try {
      writeFileSync(join(site.dir, "assets/app-1.js"), "ONE"); // (as long as the file was: only its hash can tell)
      rmSync(join(site.dir, "assets/deep/er/file.wasm"));
      expect((await remoteProblems(site.address)).problems.sort()).toEqual(["assets/app-1.js: not the file that was listed", "assets/deep/er/file.wasm: the server answered 404"]);
      const worker = readFileSync(join(site.dir, "sw.js"), "utf8");
      writeFileSync(join(site.dir, "sw.js"), worker.replace(`"id":"${site.version.id}"`, `"id":"ffffffffffffffff"`));
      expect((await remoteProblems(site.address)).problems).toContain("the worker's id is not the one its code and its list of files add up to");
      await expect(promisify(execFile)(process.execPath, [new URL("../scripts/pwa.mjs", import.meta.url).pathname, "--remote", site.address])).rejects.toMatchObject({ code: 1 });
    } finally {
      await site.stop();
    }
  });

  it("is not fooled by a server that sends the files somewhere else", async () => {
    const answers: Record<string, () => Response> = {};
    const fetcher = (async (url: URL) => (answers[url.pathname] ?? (() => new Response("", { status: 404 })))()) as unknown as typeof fetch;
    const dir = app(FILES);
    const version = writeServiceWorker(dir);
    answers["/sw.js"] = () => new Response(readFileSync(join(dir, "sw.js")));
    for (const file of version.files) answers[`/${file.url}`] = () => new Response(readFileSync(join(dir, file.url)));
    expect((await remoteProblems("https://app.test/", fetcher)).problems).toEqual([]);
    answers["/index.html"] = () => new Response("<html>something else</html>");
    expect((await remoteProblems("https://app.test/", fetcher)).problems).toEqual(["index.html: not the file that was listed"]);
  });
});

describe("what makes the app installable", () => {
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8")) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  };

  it("has a name, a place to start, and a window of its own", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(["standalone", "minimal-ui", "fullscreen"]).toContain(manifest.display);
  });

  it("has icons of the sizes it says, and one that a phone may cut to a shape", () => {
    expect(manifest.icons.some((i) => i.sizes === "192x192" && i.type === "image/png")).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === "512x512" && i.type === "image/png" && !i.purpose)).toBe(true);
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons.filter((i) => i.type === "image/png")) {
      const bytes = readFileSync(new URL(`../public/${icon.src}`, import.meta.url));
      expect(bytes.subarray(0, 8).toString("hex"), icon.src).toBe("89504e470d0a1a0a");
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
    }
  });

  it("is linked from the page, with its icons and colours", () => {
    const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(page).toContain('rel="manifest"');
    expect(page).toContain('rel="apple-touch-icon"');
    expect(page).toContain('name="theme-color"');
    expect(readFileSync(new URL("../public/icons/apple-touch-icon.png", import.meta.url)).readUInt32BE(16)).toBe(180);
  });
});
