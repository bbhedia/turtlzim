import { describe, expect, it } from "vitest";
import { decide, digestOf, fromWire, newRemoteId, toWire } from "../src/account/sync";

const bytes = (...n: number[]) => new Uint8Array(n);

describe("what to do with a notebook that is kept on the server", () => {
  const link = { revision: 3, digest: "a" };
  it("does nothing when neither side changed, sends when only this device did, fetches when only the server did", () => {
    expect(decide(link, "a", 3)).toBe("nothing");
    expect(decide(link, "b", 3)).toBe("send");
    expect(decide(link, "a", 4)).toBe("fetch");
  });
  it("asks when both changed, and never overwrites on its own", () => {
    expect(decide(link, "b", 4)).toBe("conflict");
  });
});

describe("the digest of a notebook's files", () => {
  it("does not depend on the order, and changes with a path, a byte, or the split between files", async () => {
    const a = { path: "A.txt", bytes: bytes(1, 2) };
    const b = { path: "B.txt", bytes: bytes(3) };
    expect(await digestOf([a, b])).toBe(await digestOf([b, a]));
    expect(await digestOf([a, b])).not.toBe(await digestOf([a, { ...b, bytes: bytes(4) }]));
    expect(await digestOf([a, b])).not.toBe(await digestOf([a, { ...b, path: "C.txt" }]));
    // (the same bytes cut differently between two files are not the same notebook)
    expect(await digestOf([{ path: "x", bytes: bytes(1, 2) }, { path: "y", bytes: bytes(3) }])).not.toBe(await digestOf([{ path: "x", bytes: bytes(1) }, { path: "y", bytes: bytes(2, 3) }]));
    expect(await digestOf([])).toMatch(/^[0-9a-f]{64}$/);
  });
  it("ignores when a file was changed, which a copy from the server does not keep", async () => {
    const one = { path: "A.txt", bytes: bytes(1), modified: new Date(1) };
    expect(await digestOf([one])).toBe(await digestOf([{ ...one, modified: new Date(999) }]));
  });
});

describe("files on the wire", () => {
  it("come back byte for byte, whatever the bytes (and files bigger than one chunk)", async () => {
    const all = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    const wire = toWire([{ path: "Home.txt", bytes: new TextEncoder().encode("Héllo\r\n") }, { path: "pic.bin", bytes: all }, { path: "empty", bytes: new Uint8Array() }]);
    const back = fromWire(wire);
    expect(back.map((f) => f.path)).toEqual(["Home.txt", "pic.bin", "empty"]);
    expect(new TextDecoder().decode(back[0]!.bytes)).toBe("Héllo\r\n");
    expect([...back[1]!.bytes!]).toEqual([...all]);
    expect(back[2]!.bytes!.length).toBe(0);
  });
  it("makes ids that the server takes, and different each time", () => {
    const ids = new Set(Array.from({ length: 50 }, newRemoteId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

import { baseOf, conflictCopyPath, planMerge } from "../src/account/sync";

describe("telling what changed, page by page", () => {
  const base: { local: Record<string, string>; remote: Record<string, string> } = { local: { "A.txt": "a1", "B.txt": "b1", "C.txt": "c1", "D.txt": "d1" }, remote: { "A.txt": "ma1", "B.txt": "mb1", "C.txt": "mc1", "D.txt": "md1" } };
  const plan = (local: Record<string, string>, remote: Record<string, string>, b = base) => Object.fromEntries(planMerge(b, local, remote).map((p) => [p.path, p.action]));

  it("leaves what no side changed", () => {
    expect(plan(base.local, base.remote)).toEqual({});
  });

  it("sends what only this side changed, deleted or made, and brings what only the other did", () => {
    expect(plan({ "A.txt": "a2", "B.txt": "b1", "D.txt": "d1", "N.txt": "n" }, base.remote)).toEqual({ "A.txt": "push", "C.txt": "pushDelete", "N.txt": "push" });
    expect(plan(base.local, { ...base.remote, "A.txt": "ma2", "N.txt": "mn", "D.txt": undefined as unknown as string })).toEqual({ "A.txt": "pull", "N.txt": "pull", "D.txt": "pullDelete" });
  });

  it("merges changes to different pages by itself, and asks only for a page that both sides changed", () => {
    const result = plan({ "A.txt": "a2", "B.txt": "b2", "C.txt": "c1", "D.txt": "d1" }, { "A.txt": "ma1", "B.txt": "mb2", "C.txt": "mc2", "D.txt": "md1" });
    expect(result).toEqual({ "A.txt": "push", "B.txt": "conflict", "C.txt": "pull" });
  });

  it("asks when one side deleted a page that the other changed, and lets a page that both deleted go", () => {
    const local = { "A.txt": "a1", "C.txt": "c1", "D.txt": "d1" } as Record<string, string>; // B deleted here
    const remote = { "A.txt": "ma1", "B.txt": "mb2", "D.txt": "md1" } as Record<string, string>; // B changed there, C deleted there
    expect(plan(local, remote)).toEqual({ "B.txt": "conflict", "C.txt": "pullDelete" });
    expect(plan({ "A.txt": "a1" }, { "A.txt": "ma1" }, { local: { "A.txt": "a1", "Z.txt": "z" }, remote: { "A.txt": "ma1", "Z.txt": "mz" } })).toEqual({ "Z.txt": "settled" });
  });

  it("never deletes a file of the other side that this side never took in", () => {
    // (a hidden file there: its mark is the one remembered, and it was never here)
    expect(plan(base.local, { ...base.remote, "hidden.dat": "m" }, { local: base.local, remote: { ...base.remote, "hidden.dat": "m" } })).toEqual({});
  });

  it("works out a base for a link made before pages were told apart", () => {
    const old = { digest: "whole", revision: 3 };
    const local = { "A.txt": "a" };
    const marks = { "A.txt": "m" };
    expect(baseOf(old, local, "whole", 3, marks)).toEqual({ local, remote: marks });
    expect(baseOf(old, local, "other", 3, marks)).toEqual({ local: {}, remote: marks });
    expect(baseOf(old, local, "whole", 4, marks)).toEqual({ local, remote: {} });
    expect(baseOf({ ...old, files: { "X.txt": "x" }, marks: { "X.txt": "mx" } }, local, "other", 4, marks)).toEqual({ local: { "X.txt": "x" }, remote: { "X.txt": "mx" } });
  });

  it("names the other copy of a conflicting file beside it, and never over a file that is there", () => {
    expect(conflictCopyPath("Help/Page.txt", () => false)).toBe("Help/Page_(conflict_copy).txt");
    expect(conflictCopyPath("Page.txt", (p) => p === "Page_(conflict_copy).txt")).toBe("Page_(conflict_copy_2).txt");
    expect(conflictCopyPath("Folder.v2/noext", () => false)).toBe("Folder.v2/noext_(conflict_copy)");
    expect(conflictCopyPath("pic.png", () => false)).toBe("pic_(conflict_copy).png");
  });
});
