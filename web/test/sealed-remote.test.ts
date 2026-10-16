// The remote that keeps an encrypted notebook sealed (src/account/sealed-remote.ts): what it writes and in which order, what it reads back, and what it refuses. The sealing itself is the engine's
// (core/turtl-core-rs/src/seal.rs, tested there and in a real browser); here a stand-in that only binds what it seals to the notebook and the name, so that the remote's own rules can be tried
// one at a time without an engine: the stand-in is not secret and is used nowhere else.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WireFile } from "../src/account/client";
import type { Manifest, Remote, Version } from "../src/account/remote";
import { GENERIC_TITLE, GROUP_BYTES, GROUP_ITEMS, INDEX_OBJECT, SealedCopyError, SealedRemote } from "../src/account/sealed-remote";
import { base64ToBytes, bytesToBase64 } from "../src/vault/base64";
import type { PlainFile, SealedFile, SealedIndex, VaultSeal } from "../src/vault/seal";
import type { ZipEntry } from "../src/zip";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const tag = (notebook: string, name: string, plain: Uint8Array) => createHmac("sha256", `key of ${notebook}`).update(name).update("\0").update(plain).digest();

/** Seals as the engine's contract says: a name from the path, an object that opens only under its notebook and its name, an index that opens only under its notebook. Not secret. */
class StandInSeal {
  /** How many objects and bytes each call took (the engine accepts at most 2000 objects and 64 MiB in one). */
  calls: Array<{ items: number; bytes: number }> = [];

  private take(items: number, bytes: number): void {
    this.calls.push({ items, bytes });
    if (items > 2000 || bytes > 64 << 20) throw new Error("at most 2000 objects and 64 MiB at a time");
  }

  async seal(notebook: string, files: PlainFile[]): Promise<SealedFile[]> {
    this.take(files.length, files.reduce((n, f) => n + f.bytes.length, 0));
    return files.map((f) => {
      const name = `${createHmac("sha256", `names of ${notebook}`).update(f.path).digest("hex").slice(0, 32)}.zseal`;
      return { path: f.path, name, sealed: Buffer.concat([tag(notebook, name, f.bytes), f.bytes]), size: f.bytes.length, sha256: sha256(f.bytes) };
    });
  }

  async open(notebook: string, objects: Array<{ name: string; sealed: Uint8Array }>): Promise<Array<{ name: string; bytes: Uint8Array }>> {
    this.take(objects.length, objects.reduce((n, o) => n + o.sealed.length, 0));
    return objects.map((o) => {
      const plain = o.sealed.subarray(32);
      if (o.sealed.length < 32 || hex(o.sealed.subarray(0, 32)) !== hex(tag(notebook, o.name, plain))) throw new Error("does not open");
      return { name: o.name, bytes: plain };
    });
  }

  async sealIndex(notebook: string, index: SealedIndex): Promise<Uint8Array> {
    const plain = Buffer.from(JSON.stringify(index));
    return Buffer.concat([tag(notebook, INDEX_OBJECT, plain), plain]);
  }

  async openIndex(notebook: string, sealed: Uint8Array): Promise<SealedIndex> {
    const plain = sealed.subarray(32);
    if (sealed.length < 32 || hex(sealed.subarray(0, 32)) !== hex(tag(notebook, INDEX_OBJECT, plain))) throw new Error("does not open");
    return JSON.parse(Buffer.from(plain).toString("utf8")) as SealedIndex;
  }
}

/** The other place, in memory: files under names, a version that moves with every write, and a log of what was written and when. */
class MemoryRemote implements Remote {
  place = "the server";
  files = new Map<string, Uint8Array>();
  version = 0;
  present = false;
  writes: Array<{ title: string; put: string[]; remove: string[]; base: Version }> = [];

  async manifest(): Promise<Manifest | null> {
    if (!this.present) return null;
    return { version: this.version, marks: Object.fromEntries([...this.files].map(([name, bytes]) => [name, sha256(bytes)])) };
  }

  async read(paths?: string[]): Promise<{ title?: string; files: WireFile[]; version: Version }> {
    const names = paths ?? [...this.files.keys()];
    return { title: GENERIC_TITLE, files: names.filter((n) => this.files.has(n)).map((n) => ({ path: n, base64: bytesToBase64(this.files.get(n) as Uint8Array) })), version: this.version };
  }

  async write(title: string, put: ZipEntry[], remove: string[], base: Version): Promise<{ version: Version }> {
    this.writes.push({ title, put: put.map((p) => p.path), remove: [...remove], base });
    for (const p of put) this.files.set(p.path, p.bytes);
    for (const name of remove) this.files.delete(name);
    this.present = true;
    return { version: ++this.version };
  }

  async remove(): Promise<void> {
    this.files.clear();
    this.present = false;
  }
}

const NOTEBOOK = "zsl-abcdef0123456789";
const text = (s: string): ZipEntry => ({ path: "", bytes: Buffer.from(s) });
const entry = (path: string, s: string): ZipEntry => ({ ...text(s), path });
const make = (inner: MemoryRemote, seen = 0, title = "Zebra Journal", notebook = NOTEBOOK, seal = new StandInSeal()) => new SealedRemote(inner, seal as unknown as VaultSeal, notebook, seen, () => title);

describe("a sealed copy kept over another remote", () => {
  it("is not there until something is written, and says so without an error", async () => {
    const inner = new MemoryRemote();
    expect(await make(inner).manifest()).toBeNull();
  });

  it("writes the objects first and the index last, under a title that says nothing, and names every object by a hash", async () => {
    const inner = new MemoryRemote();
    const remote = make(inner);
    await remote.write("Zebra Journal", [entry("Home.txt", "SECRET home"), entry("Projects/Garden.txt", "SECRET garden")], [], 0);
    expect(inner.writes).toHaveLength(1);
    const write = inner.writes[0]!;
    expect(write.title).toBe(GENERIC_TITLE);
    expect(write.put.at(-1)).toBe(INDEX_OBJECT);
    expect(write.put.slice(0, -1).every((name) => /^[0-9a-f]{32}\.zseal$/.test(name))).toBe(true);
    expect(write.put).toHaveLength(3);
    // (what the objects hold is the engine's to hide, and is looked for in the real thing by the browser scenarios; what the remote chooses itself is the names and the title)
    const names = [...inner.files.keys()].join("");
    for (const secret of ["Home", "Garden", "Zebra", "Projects", "txt"]) expect(names.includes(secret), secret).toBe(false);
  });

  it("gives its marks as the SHA-256 of what each page says, whatever the other remote marks its objects with", async () => {
    const inner = new MemoryRemote();
    const remote = make(inner);
    await remote.write("x", [entry("Home.txt", "one"), entry("Other.txt", "two")], [], 0);
    const listed = await make(inner).manifest();
    expect(listed?.marks).toEqual({ "Home.txt": sha256(Buffer.from("one")), "Other.txt": sha256(Buffer.from("two")) });
    expect(listed?.version).toBe(inner.version);
  });

  it("reads back all of its pages, or only the ones asked for, with the notebook's title", async () => {
    const inner = new MemoryRemote();
    await make(inner).write("x", [entry("Home.txt", "one"), entry("Other.txt", "two")], [], 0);
    const reader = make(inner, 0, "ignored");
    await reader.manifest();
    const all = await reader.read();
    expect(all.title).toBe("Zebra Journal");
    expect(Object.fromEntries(all.files.map((f) => [f.path, Buffer.from(base64ToBytes(f.base64)).toString()]))).toEqual({ "Home.txt": "one", "Other.txt": "two" });
    const some = await reader.read(["Other.txt"]);
    expect(some.files.map((f) => f.path)).toEqual(["Other.txt"]);
  });

  it("raises the index's counter with each write, and never starts below what this device has seen", async () => {
    const inner = new MemoryRemote();
    const first = make(inner);
    await first.write("x", [entry("Home.txt", "one")], [], 0);
    expect(first.counter).toBe(1);
    await first.write("x", [entry("Home.txt", "two")], [], 1);
    expect(first.counter).toBe(2);
    const fresh = make(new MemoryRemote(), 7);
    await fresh.write("x", [entry("Home.txt", "one")], [], 0);
    expect(fresh.counter).toBe(8);
  });

  it("keeps the pages that a write does not mention, and drops the objects of the pages that are deleted (after the new index)", async () => {
    const inner = new MemoryRemote();
    const remote = make(inner);
    await remote.write("x", [entry("A.txt", "a"), entry("B.txt", "b"), entry("C.txt", "c")], [], 0);
    const before = new Set(inner.files.keys());
    await remote.write("x", [entry("A.txt", "a2")], ["B.txt"], 1);
    const listed = await make(inner).manifest();
    expect(Object.keys(listed?.marks ?? {}).sort()).toEqual(["A.txt", "C.txt"]);
    const second = inner.writes[1]!;
    expect(second.put.at(-1)).toBe(INDEX_OBJECT);
    expect(second.remove).toHaveLength(1);
    expect(before.has(second.remove[0] as string)).toBe(true);
    expect(inner.files.has(second.remove[0] as string)).toBe(false);
  });

  it("refuses a whole old copy put back (an index older than the highest this device has seen), and says it may have been put back", async () => {
    const inner = new MemoryRemote();
    const writer = make(inner);
    await writer.write("x", [entry("Home.txt", "one")], [], 0);
    const old = new Map(inner.files);
    await writer.write("x", [entry("Home.txt", "two")], [], 1);
    inner.files = old;
    const error = await make(inner, 2).manifest().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SealedCopyError);
    expect((error as Error).message).toMatch(/older than one this device has seen/);
    // a device that has not seen the newer one has no way to tell
    expect((await make(inner, 1).manifest())?.marks["Home.txt"]).toBe(sha256(Buffer.from("one")));
  });

  it("refuses an index that was changed, one that was sealed for another notebook, and an object that the index lists but is not there", async () => {
    const inner = new MemoryRemote();
    await make(inner).write("x", [entry("Home.txt", "one"), entry("Other.txt", "two")], [], 0);
    const index = inner.files.get(INDEX_OBJECT) as Uint8Array;
    const damaged = Buffer.from(index);
    damaged.writeUInt8(damaged.readUInt8(damaged.length - 3) ^ 1, damaged.length - 3);
    inner.files.set(INDEX_OBJECT, damaged);
    await expect(make(inner).manifest()).rejects.toThrow(/can't be opened/);
    inner.files.set(INDEX_OBJECT, index);
    await expect(make(inner, 0, "x", "zsl-another-notebook").manifest()).rejects.toThrow(/can't be opened/);
    const [object] = [...inner.files.keys()].filter((name) => name !== INDEX_OBJECT);
    const bytes = inner.files.get(object as string) as Uint8Array;
    inner.files.delete(object as string);
    await expect(make(inner).manifest()).rejects.toThrow(/is missing a page/);
    inner.files.set(object as string, bytes);
    expect(await make(inner).manifest()).not.toBeNull();
  });

  it("refuses a page that was damaged, one put under another's name, and an older version of the same page (it opens, but it is not the one the index lists)", async () => {
    const inner = new MemoryRemote();
    const writer = make(inner);
    await writer.write("x", [entry("Home.txt", "one"), entry("Other.txt", "two")], [], 0);
    const [homeName, otherName] = [...inner.files.keys()].filter((name) => name !== INDEX_OBJECT) as [string, string];
    const homeV1 = inner.files.get(homeName) as Uint8Array;
    // the page changes: the index now lists the second version, under the same name
    await writer.write("x", [entry("Home.txt", "one, then two")], [], 1);
    const homeV2 = inner.files.get(homeName) as Uint8Array;
    expect(Buffer.from(homeV2).equals(Buffer.from(homeV1))).toBe(false);
    const readHome = async () => {
      const reader = make(inner, 0);
      await reader.manifest();
      return reader.read(["Home.txt"]);
    };
    inner.files.set(homeName, homeV1);
    await expect(readHome()).rejects.toThrow(/not the one its index lists/);
    const damaged = Buffer.from(homeV2);
    damaged.writeUInt8(damaged.readUInt8(damaged.length - 1) ^ 1, damaged.length - 1);
    inner.files.set(homeName, damaged);
    await expect(readHome()).rejects.toThrow(/can't be opened/);
    inner.files.set(homeName, inner.files.get(otherName) as Uint8Array);
    await expect(readHome()).rejects.toThrow(/can't be opened/);
    inner.files.set(homeName, homeV2);
    const good = await readHome();
    expect(good.files.map((f) => Buffer.from(base64ToBytes(f.base64)).toString())).toEqual(["one, then two"]);
  });

  it("seals and opens a notebook of thousands of pages in groups that the engine accepts, and gets every page back in its place", async () => {
    const inner = new MemoryRemote();
    const seal = new StandInSeal();
    const pages = Array.from({ length: GROUP_ITEMS * 2 + 345 }, (_, i) => entry(`Section ${i % 7}/Page ${i}.txt`, `page ${i}`));
    await make(inner, 0, "Big", NOTEBOOK, seal).write("x", pages, [], 0);
    expect(seal.calls.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...seal.calls.map((c) => c.items))).toBeLessThanOrEqual(GROUP_ITEMS);
    const reader = make(inner, 0, "Big", NOTEBOOK, seal);
    const listed = await reader.manifest();
    expect(Object.keys(listed?.marks ?? {})).toHaveLength(pages.length);
    const back = await reader.read();
    expect(back.files).toHaveLength(pages.length);
    expect(Object.fromEntries(back.files.map((f) => [f.path, Buffer.from(base64ToBytes(f.base64)).toString()]))[pages[1003]!.path]).toBe("page 1003");
    expect(Math.max(...seal.calls.map((c) => c.items))).toBeLessThanOrEqual(GROUP_ITEMS);
  });

  it("seals and opens big attachments in groups of a few megabytes, one that is bigger than a group alone", async () => {
    const inner = new MemoryRemote();
    const seal = new StandInSeal();
    const big = (n: number): ZipEntry => ({ path: `files/big-${n}.bin`, bytes: Buffer.alloc(GROUP_BYTES / 2 + 1000, n) });
    const huge: ZipEntry = { path: "files/huge.bin", bytes: Buffer.alloc(GROUP_BYTES + 5000, 9) };
    await make(inner, 0, "Big", NOTEBOOK, seal).write("x", [big(1), big(2), big(3), huge, entry("Home.txt", "home")], [], 0);
    expect(seal.calls.length).toBeGreaterThanOrEqual(3);
    // (no call took more than a group's worth, but for the one file that is bigger than a group by itself)
    for (const call of seal.calls) expect(call.bytes <= GROUP_BYTES + 100 || call.items === 1).toBe(true);
    const reader = make(inner, 0, "Big", NOTEBOOK, seal);
    await reader.manifest();
    const back = await reader.read();
    expect(back.files.map((f) => f.path).sort()).toEqual(["Home.txt", "files/big-1.bin", "files/big-2.bin", "files/big-3.bin", "files/huge.bin"]);
    expect(Buffer.from(base64ToBytes(back.files.find((f) => f.path === "files/huge.bin")!.base64)).equals(Buffer.alloc(GROUP_BYTES + 5000, 9))).toBe(true);
  }, 120_000);

  it("deletes the sealed copy through the other remote", async () => {
    const inner = new MemoryRemote();
    const remote = make(inner);
    await remote.write("x", [entry("Home.txt", "one")], [], 0);
    await remote.remove();
    expect(await make(inner).manifest()).toBeNull();
  });
});
