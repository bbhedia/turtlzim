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
