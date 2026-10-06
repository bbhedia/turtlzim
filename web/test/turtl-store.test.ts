// What the encrypted store promises beyond the contract every store keeps (store.test.ts): that a
// change which fails halfway leaves nothing behind, that what was kept is found again by a store that
// knows nothing, that it follows the vault when it is locked and unlocked, and that it refuses what
// it can't do instead of doing half.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pageKey } from "../src/notebook-core";
import type { StoredFile, StoredPage } from "../src/notebook/store";
import type { CoreClient } from "../src/vault/core-client";
import { MAX_FILE_BYTES, TurtlStore } from "../src/vault/turtl-store";
import { initZimSync } from "../src/zim";
import { freshAccount } from "./helpers/direct-core";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

const SLOW = 120_000;
const page = (name: string, text = "", extra: Partial<StoredPage> = {}): StoredPage => ({ name, text, bom: false, lineEnding: "lf", modified: 1, ...extra });
const file = (path: string, content = path, type = "application/octet-stream", modified = 1): StoredFile => ({ path, blob: new Blob([content], { type }), modified });
const names = async (store: TurtlStore, id: string) => (await store.loadPages(id)).map((p) => p.name).sort();
const paths = async (store: TurtlStore, id: string) => (await store.listFiles(id)).map((f) => f.path).sort();

/** Make the core's `nth` request of this kind fail (and, if asked, the rollback too), to see what a store does when a change breaks halfway. */
function failing(core: CoreClient, command: string, nth: number, alsoRollback = false): { count(): number } {
  const real = core.request.bind(core);
  let seen = 0;
  core.request = ((name: string, ...args: unknown[]) => {
    if (name === command && ++seen === nth) return Promise.reject(new Error("the core failed"));
    if (alsoRollback && name === "profile:batch:rollback" && seen >= nth) return Promise.reject(new Error("and could not undo it"));
    return real(name, ...args);
  }) as CoreClient["request"];
  return { count: () => seen };
}

describe("the encrypted store, beyond the contract", () => {
  it("changes nothing when a change fails halfway, and goes on working", async () => {
    const core = await freshAccount();
    const store = new TurtlStore(() => core, pageKey);
    const n = await store.createNotebook({ title: "N", home: "Home", kind: "encrypted" }, [page("A", "a"), page("B", "b"), page("C", "c")], [file("A/pic.png", "pic"), file("B/doc.txt", "doc")]);

    // a rename's change: pages removed, pages written, files moved and written -- and the fourth write fails
    const failure = failing(core, "profile:sync:model", 4);
    await expect(
      store.replacePages(n.id, {
        remove: ["A", "B"],
        put: [page("Z", "a"), page("Y", "b"), page("C", "c, rewritten")],
        files: { move: [["A/pic.png", "Z/pic.png"]], remove: ["B/doc.txt"], put: [file("new.bin", "new")] },
      }),
    ).rejects.toThrow("the core failed");
    expect(failure.count()).toBeGreaterThanOrEqual(4);
    // (the core's own view agrees, before anything is read through the store: nothing of the change is in it)
    const found = await core.request<{ total: number }>("profile:find-notes", { space_id: n.id, per_page: 100 });
    expect(found.total).toBe(1 + 3 + 2);

    // the store, which has not been asked to read anything since, still knows the notebook as it was: the
    // same change, made when the core works, goes through as if the first had never been tried
    core.request = Object.getPrototypeOf(core).request.bind(core);
    await store.replacePages(n.id, { remove: ["A", "B"], put: [page("Z", "a"), page("Y", "b")], files: { move: [["A/pic.png", "Z/pic.png"]], remove: ["B/doc.txt"] } });
    expect(await names(store, n.id)).toEqual(["C", "Y", "Z"]);
    expect((await store.loadPages(n.id)).find((p) => p.name === "C")?.text).toBe("c");
    expect(await paths(store, n.id)).toEqual(["Z/pic.png"]);
    expect(await (await store.loadFile(n.id, "Z/pic.png"))?.text()).toBe("pic");
  }, SLOW);

  it("makes no notebook at all when making it fails halfway", async () => {
    const core = await freshAccount();
    const store = new TurtlStore(() => core, pageKey);
    failing(core, "profile:sync:model", 5);
    await expect(store.createNotebook({ title: "Half", home: "Home", kind: "encrypted" }, [page("A"), page("B"), page("C"), page("D"), page("E")])).rejects.toThrow("the core failed");
    expect(await store.listNotebooks()).toEqual([]);
    expect((await core.request<{ spaces: unknown[] }>("profile:load")).spaces).toEqual([]);
  }, SLOW);

  it("refuses to be trusted when a failed change can't be undone", async () => {
    const core = await freshAccount();
    const store = new TurtlStore(() => core, pageKey);
    const n = await store.createNotebook({ title: "N", home: "Home", kind: "encrypted" }, [page("A", "a")]);
    failing(core, "profile:sync:model", 2, true);
    await expect(store.replacePages(n.id, { remove: [], put: [page("B", "b"), page("C", "c")] })).rejects.toThrow("the core failed");
    await expect(store.loadPages(n.id)).rejects.toThrow(/Lock them and unlock them again/);
    await expect(store.listNotebooks()).rejects.toThrow(/Lock them and unlock them again/);
  }, SLOW);

  it("is found again, whole, by a store that knows nothing of what the first one did", async () => {
    const core = await freshAccount();
    const first = new TurtlStore(() => core, pageKey);
    const a = await first.createNotebook({ title: "Kept", home: "Start", kind: "encrypted" }, [page("Start", "see [[Other]]", { bom: true, lineEnding: "crlf", modified: 4242 }), page("Other", "x")], [file("Start/a.bin", "bytes", "application/x-test", 99)]);
    await first.updateNotebook({ ...a, title: "Kept, renamed", home: "Other" });

    const second = new TurtlStore(() => core, pageKey);
    const listed = await second.listNotebooks();
    expect(listed).toEqual([{ id: a.id, title: "Kept, renamed", home: "Other", created: a.created, kind: "encrypted" }]);
    // (it hasn't read the pages yet, and a change knows which note each page is)
    await second.replacePages(a.id, { remove: ["Other"], put: [page("Start", "see nothing", { bom: true, lineEnding: "crlf", modified: 4243 })], files: { move: [["Start/a.bin", "Moved/a.bin"]] } });
    expect(await second.loadPages(a.id)).toEqual([page("Start", "see nothing", { bom: true, lineEnding: "crlf", modified: 4243 })]);
    expect(await second.listFiles(a.id)).toEqual([{ path: "Moved/a.bin", size: 5, type: "application/x-test", modified: 99 }]);
    expect(await (await second.loadFile(a.id, "moved/A.BIN"))?.text()).toBe("bytes");
    // and the first, which still believes what it knew, is brought up to date by asking
    expect(await names(first, a.id)).toEqual(["Start"]);
    const found = await core.request<{ total: number }>("profile:find-notes", { space_id: a.id, per_page: 100 });
    expect(found.total).toBe(1 + 1 + 1);
  }, SLOW);

  it("edits a page where it is: a changed page is still one note, not two", async () => {
    const core = await freshAccount();
    const store = new TurtlStore(() => core, pageKey);
    const n = await store.createNotebook({ title: "N", home: "Home", kind: "encrypted" }, [page("Home", "one")]);
    const idsOf = async () => (await core.request<{ notes: Array<{ id: string; type: string }> }>("profile:find-notes", { space_id: n.id, type: "zim-page", per_page: 100 })).notes.map((note) => note.id);
    const before = await idsOf();
    for (const text of ["two", "three", "four"]) await store.replacePages(n.id, { remove: [], put: [page("Home", text)] });
    await store.replacePages(n.id, { remove: ["home"], put: [page("HOME", "five")] });
    expect(await idsOf()).toEqual(before);
    expect(await store.loadPages(n.id)).toEqual([page("HOME", "five")]);
  }, SLOW);

  it("follows the vault: another engine, another account, other notebooks", async () => {
    const one = await freshAccount();
    let current = one;
    const store = new TurtlStore(() => current, pageKey);
    await store.createNotebook({ title: "In the first", home: "Home", kind: "encrypted" }, [page("Home")]);
    expect((await store.listNotebooks()).map((x) => x.title)).toEqual(["In the first"]);
    current = await freshAccount();
    expect(await store.listNotebooks()).toEqual([]);
    const second = await store.createNotebook({ title: "In the second", home: "Home", kind: "encrypted" }, [page("Home", "second")]);
    expect((await store.listNotebooks()).map((x) => x.title)).toEqual(["In the second"]);
    expect((await store.loadPages(second.id))[0]?.text).toBe("second");
  }, SLOW);

  it("won't take an attachment too big to send through the engine, and changes nothing for it", async () => {
    const core = await freshAccount();
    const store = new TurtlStore(() => core, pageKey);
    const big = { path: "big.bin", blob: new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]), modified: 1 };
    await expect(store.createNotebook({ title: "Big", home: "Home", kind: "encrypted" }, [page("Home")], [big])).rejects.toThrow(/more than the 50 MB/);
    expect(await store.listNotebooks()).toEqual([]);
    const n = await store.createNotebook({ title: "Small", home: "Home", kind: "encrypted" }, [page("Home", "kept")]);
    await expect(store.replacePages(n.id, { remove: ["Home"], put: [page("Other")], files: { put: [big] } })).rejects.toThrow(/big\.bin/);
    expect(await names(store, n.id)).toEqual(["Home"]);
  }, SLOW);

  it("keeps the notebooks of one engine apart from each other, with one name and one file path in each", async () => {
    const core = await freshAccount();
    const store = new TurtlStore(() => core, pageKey);
    const [a, b] = [
      await store.createNotebook({ title: "A", home: "Home", kind: "encrypted" }, [page("Home", "in A")], [file("x.bin", "A's")]),
      await store.createNotebook({ title: "B", home: "Home", kind: "encrypted" }, [page("Home", "in B")], [file("x.bin", "B's")]),
    ];
    await store.replacePages(a.id, { remove: ["Home"], put: [page("Home", "A changed")], files: { remove: ["x.bin"] } });
    expect((await store.loadPages(b.id))[0]?.text).toBe("in B");
    expect(await (await store.loadFile(b.id, "x.bin"))?.text()).toBe("B's");
    await store.deleteNotebook(a.id);
    expect((await store.loadPages(b.id))[0]?.text).toBe("in B");
    expect(await (await store.loadFile(b.id, "x.bin"))?.text()).toBe("B's");
    await expect(store.loadPages(a.id)).rejects.toThrow(/no notebook/);
  }, SLOW);
});
