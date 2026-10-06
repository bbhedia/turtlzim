import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pageKey } from "../src/notebook-core";
import { FileUrls } from "../src/notebook/file-urls";
import { NotebookSession } from "../src/notebook/session";
import { MemoryStore } from "../src/notebook/store";
import type { PageChange, StoredFile } from "../src/notebook/store";
import { initZimSync } from "../src/zim";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});
afterEach(() => vi.restoreAllMocks());

const picture = (content: string, modified = 1): StoredFile => ({ path: "Home/a.png", blob: new Blob([content], { type: "image/png" }), modified });

async function open(store = new MemoryStore(pageKey)) {
  const info = await store.createNotebook({ title: "T", home: "Home", kind: "open" }, [{ name: "Home", text: "{{./a.png}}", bom: false, lineEnding: "lf", modified: 1 }], [picture("one")]);
  return NotebookSession.open(store, info.id);
}

/** Wait until `urls` has said it settled `times` times. */
function settled(): { calls: () => number; until: (n: number) => Promise<void>; onSettled: () => void } {
  let calls = 0;
  const waiting: Array<[number, () => void]> = [];
  return {
    calls: () => calls,
    onSettled: () => {
      calls++;
      for (const [n, resolve] of waiting) if (calls >= n) resolve();
    },
    until: (n) => (calls >= n ? Promise.resolve() : new Promise((resolve) => waiting.push([n, resolve]))),
  };
}

describe("the addresses of a notebook's pictures", () => {
  it("are loading the first time they are asked for, and ready once the store has answered", async () => {
    const session = await open();
    const events = settled();
    const urls = new FileUrls(session, events.onSettled);
    expect(urls.get("Home/a.png")).toEqual({ status: "loading" });
    expect(urls.get("HOME/A.PNG")).toEqual({ status: "loading" }); // asking again does not load it twice
    await events.until(1);
    const ready = urls.get("home/a.png");
    expect(ready).toMatchObject({ status: "ready", url: expect.stringMatching(/^blob:/) });
    expect(urls.get("Home/a.png")).toEqual(ready);
    expect(events.calls()).toBe(1);
    const blob = await fetch((ready as { url: string }).url).then((r) => r.blob()).catch(() => null);
    if (blob) expect(await blob.text()).toBe("one"); // (where the runtime can fetch its own blob URLs)
    urls.close();
  });

  it("make a data address for an SVG, so that it can't run as this site if it is opened as a page, and release nothing for it", async () => {
    const store = new MemoryStore(pageKey);
    const info = await store.createNotebook({ title: "T", home: "Home", kind: "open" }, [], [{ path: "Home/evil.svg", blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'], { type: "image/svg+xml" }), modified: 1 }, picture("one")]);
    const session = await NotebookSession.open(store, info.id);
    const events = settled();
    const urls = new FileUrls(session, events.onSettled);
    urls.get("Home/evil.svg");
    urls.get("Home/a.png");
    await events.until(2);
    expect((urls.get("Home/evil.svg") as { url: string }).url).toMatch(/^data:image\/svg\+xml;base64,/);
    expect((urls.get("Home/a.png") as { url: string }).url).toMatch(/^blob:/);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    urls.close();
    expect(revoke).toHaveBeenCalledTimes(1); // only the blob address
  });

  it("say there is nothing for a file that isn't there", async () => {
    const session = await open();
    const urls = new FileUrls(session, () => {});
    expect(urls.get("Home/nope.png")).toEqual({ status: "failed" });
    urls.close();
  });

  it("keep an address for a file that did not change, and replace it for one that did", async () => {
    const session = await open();
    const events = settled();
    const urls = new FileUrls(session, events.onSettled);
    urls.get("Home/a.png");
    await events.until(1);
    const first = (urls.get("Home/a.png") as { url: string }).url;
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    urls.sync();
    expect((urls.get("Home/a.png") as { url: string }).url).toBe(first);
    expect(revoke).not.toHaveBeenCalled();
    // the file is replaced (an import over it)
    await session.addPages([], [picture("a different picture", 99)]);
    urls.sync();
    expect(revoke).toHaveBeenCalledWith(first);
    expect(urls.get("Home/a.png")).toEqual({ status: "loading" });
    await events.until(2);
    const second = urls.get("Home/a.png") as { status: string; url: string };
    expect(second.status).toBe("ready");
    expect(second.url).not.toBe(first);
    // and it is deleted
    await session.removeFile("Home/a.png");
    urls.sync();
    expect(revoke).toHaveBeenCalledWith(second.url);
    expect(urls.get("Home/a.png")).toEqual({ status: "failed" });
    urls.close();
  });

  it("follow a file when its page is renamed", async () => {
    const session = await open();
    const events = settled();
    const urls = new FileUrls(session, events.onSettled);
    urls.get("Home/a.png");
    await events.until(1);
    const before = (urls.get("Home/a.png") as { url: string }).url;
    await session.rename("Home", "Front");
    urls.sync();
    // the old path is gone, the new one is the same picture: it is loaded again (an address is made per path)
    expect(urls.get("Home/a.png")).toEqual({ status: "failed" });
    expect(urls.get("Front/a.png")).toEqual({ status: "loading" });
    await events.until(2);
    expect(urls.get("Front/a.png")).toMatchObject({ status: "ready" });
    expect((urls.get("Front/a.png") as { url: string }).url).not.toBe(before);
    urls.close();
  });

  it("are not asked for again when the store fails, and are tried again after files change", async () => {
    class Unreadable extends MemoryStore {
      broken = true;
      loads = 0;
      override async loadFile(id: string, path: string): Promise<Blob | undefined> {
        this.loads++;
        if (this.broken) throw new Error("unreadable");
        return super.loadFile(id, path);
      }
      override async replacePages(id: string, change: PageChange): Promise<void> {
        return super.replacePages(id, change);
      }
    }
    const store = new Unreadable(pageKey);
    const session = await open(store);
    const events = settled();
    const urls = new FileUrls(session, events.onSettled);
    expect(urls.get("Home/a.png")).toEqual({ status: "loading" });
    await events.until(1);
    expect(urls.get("Home/a.png")).toEqual({ status: "failed" });
    expect(urls.get("Home/a.png")).toEqual({ status: "failed" });
    expect(store.loads).toBe(1); // it did not try again by itself
    store.broken = false;
    urls.sync(); // a change of files clears the failures
    expect(urls.get("Home/a.png")).toEqual({ status: "loading" });
    await events.until(2);
    expect(urls.get("Home/a.png")).toMatchObject({ status: "ready" });
    urls.close();
  });

  it("are all released when the notebook is closed, and nothing is made after that", async () => {
    const session = await open();
    const events = settled();
    const urls = new FileUrls(session, events.onSettled);
    urls.get("Home/a.png");
    await events.until(1);
    const url = (urls.get("Home/a.png") as { url: string }).url;
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    urls.close();
    expect(revoke).toHaveBeenCalledWith(url);
    const late = new FileUrls(session, events.onSettled);
    late.get("Home/a.png");
    late.close(); // closed before the store answers
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.calls()).toBe(1);
  });
});
