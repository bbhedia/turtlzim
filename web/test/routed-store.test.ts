// The store that puts the open notebooks and the encrypted ones side by side: where each request goes,
// what the ids look like, and what is not there while the vault is locked.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pageKey } from "../src/notebook-core";
import { FOLDER_PREFIX, isFolderId } from "../src/notebook/folder-store";
import { ENCRYPTED_PREFIX, RoutedStore, isEncryptedId } from "../src/notebook/routed-store";
import { MemoryStore } from "../src/notebook/store";
import type { StoredFile, StoredPage } from "../src/notebook/store";
import { initZimSync } from "../src/zim";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

const page = (name: string, text = ""): StoredPage => ({ name, text, bom: false, lineEnding: "lf", modified: 1 });
const file = (path: string, content: string): StoredFile => ({ path, blob: new Blob([content]), modified: 1 });

/** The encrypted side is a memory store that says "encrypted", as the vault's store does. */
class SealedStub extends MemoryStore {
  override async listNotebooks() {
    return (await super.listNotebooks()).map((info) => ({ ...info, kind: "encrypted" as const }));
  }
}

function make(vaultOpen = { value: true }) {
  const open = new MemoryStore(pageKey);
  const sealed = new SealedStub(pageKey);
  return { open, sealed, vaultOpen, store: new RoutedStore(open, sealed, () => vaultOpen.value) };
}

/** The folder side is a memory store that says "folder" and has a place for each notebook, as the folder store's are. */
class FolderStub extends MemoryStore {
  override async listNotebooks() {
    return (await super.listNotebooks()).map((info) => ({ ...info, kind: "folder" as const, location: info.id }));
  }
  override async createNotebook(info: Parameters<MemoryStore["createNotebook"]>[0], pages?: StoredPage[], files?: StoredFile[]) {
    return super.createNotebook({ ...info, kind: "folder" }, pages, files);
  }
}

/** The encrypted side with somewhere to keep the link of each notebook, as the vault's store does. */
class LinkingStub extends SealedStub {
  links = new Map<string, string>();
  async readLink(id: string): Promise<string | null> {
    return this.links.get(id) ?? null;
  }
  async writeLink(id: string, text: string | null): Promise<void> {
    if (text === null) this.links.delete(id);
    else this.links.set(id, text);
  }
}

describe("where an encrypted notebook is kept (its link) is in the vault, and only there", () => {
  const withLinks = (vaultOpen = { value: true }) => {
    const open = new MemoryStore(pageKey);
    const sealed = new LinkingStub(pageKey);
    return { open, sealed, vaultOpen, store: new RoutedStore(open, sealed, () => vaultOpen.value) };
  };

  it("keeps the link of an encrypted notebook on the encrypted side, under the id the vault knows it by, and gives it back", async () => {
    const { store, sealed } = withLinks();
    const secret = await store.createNotebook({ title: "Secret", home: "Home", kind: "encrypted" }, [page("Home")]);
    expect(isEncryptedId(secret.id)).toBe(true);
    expect(await store.readLink?.(secret.id)).toBeNull();
    await store.writeLink?.(secret.id, '{"remoteId":"zsl-1"}');
    expect(await store.readLink?.(secret.id)).toBe('{"remoteId":"zsl-1"}');
    expect([...sealed.links.keys()]).toEqual([secret.id.slice(ENCRYPTED_PREFIX.length)]);
    await store.writeLink?.(secret.id, null);
    expect(await store.readLink?.(secret.id)).toBeNull();
    expect(sealed.links.size).toBe(0);
  });

  it("has no link for an open notebook, and refuses to keep one in the vault for it", async () => {
    const { store, sealed } = withLinks();
    const plain = await store.createNotebook({ title: "Plain", home: "Home", kind: "open" }, [page("Home")]);
    expect(await store.readLink?.(plain.id)).toBeNull();
    await expect(store.writeLink?.(plain.id, "x")).rejects.toThrow(/Only an encrypted notebook/);
    expect(sealed.links.size).toBe(0);
  });

  it("answers for an open notebook while the vault is locked (it has no link to ask the vault for)", async () => {
    const vaultOpen = { value: false };
    const { store } = withLinks(vaultOpen);
    const plain = await store.createNotebook({ title: "Plain", home: "Home", kind: "open" }, [page("Home")]);
    expect(await store.readLink?.(plain.id)).toBeNull();
  });

  it("neither reads nor writes a link while the vault is locked, and the link is there again once it is open", async () => {
    const vaultOpen = { value: true };
    const { store } = withLinks(vaultOpen);
    const secret = await store.createNotebook({ title: "Secret", home: "Home", kind: "encrypted" }, [page("Home")]);
    await store.writeLink?.(secret.id, "kept");
    vaultOpen.value = false;
    await expect(store.readLink?.(secret.id)).rejects.toThrow(/locked/);
    await expect(store.writeLink?.(secret.id, "changed")).rejects.toThrow(/locked/);
    vaultOpen.value = true;
    expect(await store.readLink?.(secret.id)).toBe("kept");
  });
});

describe("the store of notebooks in folders, beside the open and the encrypted ones", () => {
  const withFolders = () => {
    const open = new MemoryStore(pageKey);
    const sealed = new SealedStub(pageKey);
    const folders = new FolderStub(pageKey);
    const problems: Array<[string, string]> = [];
    return { open, sealed, folders, problems, store: new RoutedStore(open, sealed, () => true, (error, which) => problems.push([error.message, which]), folders) };
  };

  it("makes a folder notebook in the folder store, gives it an id that says so, and sends everything about it there", async () => {
    const { store, open, folders } = withFolders();
    const plain = await store.createNotebook({ title: "Plain", home: "Home", kind: "open" }, [page("Home", "p")]);
    const kept = await store.createNotebook({ title: "In a folder", home: "Home", kind: "folder", location: "somewhere" }, [page("Home", "f")], [file("Home/a.png", "A")]);
    expect(isFolderId(kept.id)).toBe(true);
    expect(isFolderId(plain.id)).toBe(false);
    expect(kept.id.startsWith(FOLDER_PREFIX)).toBe(true);
    expect((await open.listNotebooks()).map((n) => n.title)).toEqual(["Plain"]);
    expect((await folders.listNotebooks()).map((n) => n.title)).toEqual(["In a folder"]);
    expect((await store.listNotebooks()).map((n) => [n.title, n.kind, isFolderId(n.id)])).toEqual([["Plain", "open", false], ["In a folder", "folder", true]]);
    expect((await store.loadPages(kept.id)).map((p) => p.text)).toEqual(["f"]);
    expect((await store.listFiles(kept.id)).map((f) => f.path)).toEqual(["Home/a.png"]);
    expect(await (await store.loadFile(kept.id, "Home/a.png"))?.text()).toBe("A");
    await store.replacePages(kept.id, { remove: ["Home"], put: [page("Front", "g")] });
    expect((await folders.loadPages(kept.id.slice(FOLDER_PREFIX.length))).map((p) => p.name)).toEqual(["Front"]);
    await store.updateNotebook({ ...kept, title: "Renamed" });
    expect((await store.listNotebooks()).map((n) => n.title)).toContain("Renamed");
    await store.deleteNotebook(kept.id);
    expect((await store.listNotebooks()).map((n) => n.title)).toEqual(["Plain"]);
  });

  it("lists the others, and says which side it was, when the folders can't be listed", async () => {
    const { store, folders, problems } = withFolders();
    await store.createNotebook({ title: "Plain", home: "Home", kind: "open" });
    folders.listNotebooks = async () => {
      throw new Error("the program says no");
    };
    expect((await store.listNotebooks()).map((n) => n.title)).toEqual(["Plain"]);
    expect(problems).toEqual([["the program says no", "folders"]]);
  });

  it("says which side it was when the encrypted ones can't be listed", async () => {
    const { store, sealed, problems } = withFolders();
    sealed.listNotebooks = async () => {
      throw new Error("the engine is broken");
    };
    await store.listNotebooks();
    expect(problems).toEqual([["the engine is broken", "encrypted"]]);
  });

  it("has no folder notebooks, and can't make or reach one, where there is no program to give them", async () => {
    const { store } = make();
    expect((await store.listNotebooks()).map((n) => n.kind)).toEqual([]);
    await expect(store.createNotebook({ title: "F", home: "Home", kind: "folder", location: "x" })).rejects.toThrow(/desktop program/);
    await expect(store.loadPages(`${FOLDER_PREFIX}x`)).rejects.toThrow(/desktop program/);
  });
});

describe("the store of open and encrypted notebooks", () => {
  it("makes a notebook where its kind says, and gives encrypted ones an id that says so", async () => {
    const { store, open, sealed } = make();
    const plain = await store.createNotebook({ title: "Plain", home: "Home", kind: "open" }, [page("Home", "p")]);
    const secret = await store.createNotebook({ title: "Secret", home: "Home", kind: "encrypted" }, [page("Home", "s")]);
    expect(isEncryptedId(plain.id)).toBe(false);
    expect(secret.id.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    expect((await open.listNotebooks()).map((n) => n.title)).toEqual(["Plain"]);
    expect((await sealed.listNotebooks()).map((n) => n.title)).toEqual(["Secret"]);
    // nothing of the secret one is in the open store
    expect((await open.listNotebooks()).some((n) => n.title === "Secret")).toBe(false);
  });

  it("lists both, the open ones first, with the kind each has", async () => {
    const { store } = make();
    await store.createNotebook({ title: "Secret 1", home: "Home", kind: "encrypted" });
    await store.createNotebook({ title: "Plain 1", home: "Home", kind: "open" });
    await store.createNotebook({ title: "Secret 2", home: "Home", kind: "encrypted" });
    const listed = await store.listNotebooks();
    expect(listed.map((n) => [n.title, n.kind])).toEqual([["Plain 1", "open"], ["Secret 1", "encrypted"], ["Secret 2", "encrypted"]]);
    expect(listed.every((n) => isEncryptedId(n.id) === (n.kind === "encrypted"))).toBe(true);
  });

  it("sends every request to the store the notebook is in, with the id that store gave it", async () => {
    const { store, open, sealed } = make();
    const plain = await store.createNotebook({ title: "Plain", home: "Home", kind: "open" }, [page("Home", "p")], [file("a.txt", "plain file")]);
    const secret = await store.createNotebook({ title: "Secret", home: "Home", kind: "encrypted" }, [page("Home", "s")], [file("a.txt", "secret file")]);
    for (const [info, text, content] of [[plain, "p", "plain file"], [secret, "s", "secret file"]] as const) {
      expect((await store.loadPages(info.id)).map((p) => p.text)).toEqual([text]);
      expect((await store.listFiles(info.id)).map((f) => f.path)).toEqual(["a.txt"]);
      expect(await (await store.loadFile(info.id, "a.txt"))?.text()).toBe(content);
      await store.replacePages(info.id, { remove: [], put: [page("Other", "o")] });
      expect((await store.loadPages(info.id)).map((p) => p.name).sort()).toEqual(["Home", "Other"]);
      await store.updateNotebook({ ...info, title: `${info.title} renamed`, home: "Other" });
    }
    expect((await open.listNotebooks()).map((n) => [n.title, n.home])).toEqual([["Plain renamed", "Other"]]);
    expect((await sealed.listNotebooks()).map((n) => [n.title, n.home])).toEqual([["Secret renamed", "Other"]]);
    // what went to the secret store did not touch the other one, in either direction
    expect((await open.loadPages((await open.listNotebooks())[0]!.id)).map((p) => p.text)).toEqual(["p", "o"]);
    await store.deleteNotebook(secret.id);
    expect((await store.listNotebooks()).map((n) => n.title)).toEqual(["Plain renamed"]);
    await store.deleteNotebook(plain.id);
    expect(await store.listNotebooks()).toEqual([]);
  });

  it("lists the open notebooks, and says why, when the encrypted ones can't be listed", async () => {
    const problems: string[] = [];
    const open = new MemoryStore(pageKey);
    const sealed = new SealedStub(pageKey);
    const store = new RoutedStore(open, sealed, () => true, (error) => problems.push(error.message));
    await store.createNotebook({ title: "Plain", home: "Home", kind: "open" });
    await store.createNotebook({ title: "Secret", home: "Home", kind: "encrypted" });
    sealed.listNotebooks = async () => {
      throw new Error("the engine is broken");
    };
    expect((await store.listNotebooks()).map((n) => n.title)).toEqual(["Plain"]);
    expect(problems).toEqual(["the engine is broken"]);
    // (and without anyone to tell, it is still the open ones, not an error that leaves the app with no notebooks to show)
    const silent = new RoutedStore(open, sealed, () => true);
    expect((await silent.listNotebooks()).map((n) => n.title)).toEqual(["Plain"]);
  });

  it("knows nothing of the encrypted notebooks while the vault is locked, and refuses to touch them", async () => {
    const vault = { value: true };
    const { store } = make(vault);
    const plain = await store.createNotebook({ title: "Plain", home: "Home", kind: "open" }, [page("Home", "p")]);
    const secret = await store.createNotebook({ title: "Secret", home: "Home", kind: "encrypted" }, [page("Home", "s")]);
    vault.value = false;
    expect((await store.listNotebooks()).map((n) => n.title)).toEqual(["Plain"]);
    await expect(store.loadPages(secret.id)).rejects.toThrow(/locked/);
    await expect(store.listFiles(secret.id)).rejects.toThrow(/locked/);
    await expect(store.loadFile(secret.id, "a.txt")).rejects.toThrow(/locked/);
    await expect(store.replacePages(secret.id, { remove: [], put: [page("X")] })).rejects.toThrow(/locked/);
    await expect(store.updateNotebook({ ...secret, title: "X" })).rejects.toThrow(/locked/);
    await expect(store.deleteNotebook(secret.id)).rejects.toThrow(/locked/);
    await expect(store.createNotebook({ title: "Another secret", home: "Home", kind: "encrypted" })).rejects.toThrow(/locked/);
    // the open ones are as they were
    expect((await store.loadPages(plain.id)).map((p) => p.text)).toEqual(["p"]);
    vault.value = true;
    expect((await store.listNotebooks()).map((n) => n.title)).toEqual(["Plain", "Secret"]);
    expect((await store.loadPages(secret.id)).map((p) => p.text)).toEqual(["s"]);
  });
});
