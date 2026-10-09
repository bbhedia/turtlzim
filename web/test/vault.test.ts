// The vault and the client of the core, in Node: the core runs in this process (see helpers/direct-core.ts),
// which keeps its databases in memory. What needs a real browser (the Worker, the private file system,
// data surviving a reload) is in the browser test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreClient, CoreError } from "../src/vault/core-client";
import type { CoreTransport } from "../src/vault/core-client";
import { base64ToBytes, bytesToBase64 } from "../src/vault/base64";
import { MAX_BACKUP_BYTES, NoVaultError, NotABackupError, Vault, VaultBusyError, VaultExistsError, VaultUnavailableError, WrongPassphraseError, checkPassphrase, normalizePassphrase } from "../src/vault/vault";
import { DirectTransport } from "./helpers/direct-core";

// unlocking costs what it is meant to cost an attacker (scrypt with 128 MiB), a second or two each
const SLOW = 120_000;
const PASSPHRASE = "pale river stone lantern";

const newVault = () => new Vault({ connect: () => new DirectTransport(), persistence: null });

/** An engine that records what it is sent, answers what it is asked as `reply` says (and with an account of its own, and nothing else, when `reply` says nothing), and can be told to send events. */
function scriptedEngine(reply: (command: string, args: unknown[]) => { e: number; d: unknown; events?: Array<{ e: string; d: unknown }>; delay?: number } | null = () => null) {
  const sent: Array<[string, unknown[]]> = [];
  const transports: CoreTransport[] = [];
  /** How many of the engines were closed (a vault that is done with one closes it). */
  const closed = { count: 0 };
  const connect = (): CoreTransport => {
    const transport: CoreTransport = {
      onMessage: null,
      onLost: null,
      onHeard: null,
      terminate() {},
      async boot() {},
      send(message: string) {
        const [id, command, ...args] = JSON.parse(message) as [string, string, ...unknown[]];
        sent.push([command, args]);
        const scripted = reply(command, args);
        const answer = scripted ?? { e: 0, d: command === "user:local-accounts" ? ["some-vault"] : {} };
        for (const event of answer.events ?? []) setTimeout(() => transport.onMessage?.("any", JSON.stringify(event)), 0);
        setTimeout(() => transport.onMessage?.("any", JSON.stringify({ id, e: answer.e, d: answer.d })), answer.delay ?? 1);
        if (command === "user:logout") setTimeout(() => transport.onMessage?.("any", JSON.stringify({ e: "user:logout", d: null })), 0);
      },
      async close() {
        closed.count++;
      },
    };
    transports.push(transport);
    return transport;
  };
  return { sent, connect, transports, closed };
}

/** `length` bytes that are not all the same, from `from` on of a sequence that does not repeat for a long time. */
const sequence = (from: number, length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => ((from + i) * 7 + ((from + i) >> 8)) & 0xff);
const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());
/** Whether two arrays of bytes are the same (`toEqual` takes seconds over millions of them). */
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));


// The core in this process holds one vault for as long as the process lives (its memory is the "browser"),
// so it is made the first time a test needs it, and every test takes it from there.
let made: Promise<void> | undefined;
async function existingVault(): Promise<Vault> {
  made ??= (async () => {
    const maker = newVault();
    await maker.create(PASSPHRASE);
    await maker.lock();
  })();
  await made;
  return newVault();
}

describe("the core's client", () => {
  /** A transport that answers by script, to see what the client does with every kind of answer. */
  function scripted(reply: (message: string[]) => unknown[]): CoreTransport & { sent: string[][]; lose(reason: string): void; closed: boolean; terminated: boolean } {
    const transport = {
      sent: [] as string[][],
      closed: false,
      onMessage: null as CoreTransport["onMessage"],
      onLost: null as CoreTransport["onLost"],
      onHeard: null as CoreTransport["onHeard"],
      terminated: false,
      terminate() {
        transport.terminated = true;
      },
      async boot() {},
      send(message: string) {
        const parsed = JSON.parse(message) as string[];
        transport.sent.push(parsed);
        for (const out of reply(parsed)) setTimeout(() => transport.onMessage?.("any", JSON.stringify(out)), 0);
      },
      async close() {
        transport.closed = true;
      },
      lose(reason: string) {
        transport.onLost?.(reason);
      },
    };
    return transport;
  }

  it("sends a command with its arguments and resolves with what the core answers", async () => {
    const transport = scripted(([id, command, ...args]) => [{ id, e: 0, d: { command, args } }]);
    const client = await CoreClient.boot(transport, null);
    expect(await client.request("do:it", 1, "two", { three: 3 })).toEqual({ command: "do:it", args: [1, "two", { three: 3 }] });
    expect(transport.sent[0]?.slice(1)).toEqual(["do:it", 1, "two", { three: 3 }]);
  });

  it("matches each answer to its own request, whatever order they come in", async () => {
    const waiting: string[] = [];
    const transport = scripted(([id]) => {
      waiting.push(id as string);
      return waiting.length === 2 ? [{ id: waiting[1], e: 0, d: "second" }, { id: waiting[0], e: 0, d: "first" }] : [];
    });
    const client = await CoreClient.boot(transport, null);
    const [a, b] = await Promise.all([client.request("a"), client.request("b")]);
    expect([a, b]).toEqual(["first", "second"]);
  });

  it("turns the core's refusals into errors that say what kind they are", async () => {
    const transport = scripted(([id, command]) => [
      command === "bad:login"
        ? { id, e: 1, d: { type: "api", subtype: "Unauthorized", message: { error: "bad login" } } }
        : command === "bad:value"
          ? { id, e: 1, d: { type: "validation", subtype: "user", errors: [["password", "Too short."], ["username", "Too plain."]] } }
          : { id, e: 1, d: { type: "not_found", message: "that is not here" } },
    ]);
    const client = await CoreClient.boot(transport, null);
    const failure = (command: string) => client.request(command).then(() => { throw new Error("it should have been refused"); }, (error: unknown) => error as CoreError);
    const unauthorized = await failure("bad:login");
    expect(unauthorized).toBeInstanceOf(CoreError);
    expect([unauthorized.kind, unauthorized.subtype, unauthorized.message, unauthorized.command]).toEqual(["api", "Unauthorized", "bad login", "bad:login"]);
    expect((await failure("bad:value")).message).toBe("Too short. Too plain.");
    const missing = await failure("bad:thing");
    expect([missing.kind, missing.message]).toEqual(["not_found", "that is not here"]);
  });

  it("passes on the events nobody asked about, until told to stop", async () => {
    const transport = scripted(([id]) => [{ e: "user:login", d: null }, { id, e: 0, d: 1 }]);
    const client = await CoreClient.boot(transport, null);
    const seen: string[] = [];
    const stop = client.onEvent((event) => seen.push(event.e));
    await client.request("x");
    expect(seen).toEqual(["user:login"]);
    stop();
    await client.request("x");
    expect(seen).toEqual(["user:login"]);
  });

  it("refuses what is waiting when the core goes away, and what is asked afterwards", async () => {
    const transport = scripted(() => []);
    const client = await CoreClient.boot(transport, null);
    const waiting = client.request("never");
    transport.lose("out of memory");
    await expect(waiting).rejects.toThrow(/stopped unexpectedly \(out of memory\)/);

    const other = scripted(() => []);
    const second = await CoreClient.boot(other, null);
    const pending = second.request("never");
    await second.close();
    await expect(pending).rejects.toThrow(/locked/);
    expect(other.closed).toBe(true);
    await expect(second.request("again")).rejects.toThrow(/locked/);
  });

  it("tells whoever is listening when the core goes away on its own, and not when it is closed", async () => {
    const transport = scripted(() => []);
    const client = await CoreClient.boot(transport, null);
    const reasons: string[] = [];
    client.onLost((reason) => reasons.push(reason));
    transport.lose("the worker died");
    expect(reasons).toEqual(["the worker died"]);
    await expect(client.request("anything")).rejects.toThrow(/locked/);

    const calm = scripted(() => []);
    const other = await CoreClient.boot(calm, null);
    const heard: string[] = [];
    other.onLost((reason) => heard.push(reason));
    await other.close();
    expect(heard).toEqual([]);
  });

  it("closes the transport when the core can't be started, and says why", async () => {
    const transport = scripted(() => []);
    transport.boot = async () => {
      throw new Error("no luck");
    };
    await expect(CoreClient.boot(transport, null)).rejects.toThrow("no luck");
    expect(transport.closed).toBe(true);
  });

  it("ignores what it can't read", async () => {
    const transport = scripted(([id]) => [{ id, e: 0, d: "fine" }]);
    const client = await CoreClient.boot(transport, null);
    transport.onMessage?.("any", "not json {");
    transport.onMessage?.("any", "17");
    transport.onMessage?.("any", JSON.stringify({ id: "nobody asked", e: 0, d: 1 }));
    expect(await client.request("x")).toBe("fine");
  });
});

describe("what a passphrase has to be", () => {
  it("is long enough, and not one a stranger would try first", () => {
    expect(checkPassphrase("")).toMatch(/at least 10/);
    expect(checkPassphrase("short one")).toMatch(/at least 10/);
    expect(checkPassphrase("aaaaaaaaaaaaaaaa")).toMatch(/repeats/);
    expect(checkPassphrase("abababababababab")).toMatch(/repeats/);
    expect(checkPassphrase("Passphrase")).toMatch(/first a stranger/);
    expect(checkPassphrase("1234567890")).toMatch(/first a stranger/);
    expect(checkPassphrase("pale river stone lantern")).toBeNull();
    // length is counted in characters people see, not in bytes
    expect(checkPassphrase("日本語のパスフレーズです")).toBeNull();
    expect(checkPassphrase("😀😁😂🤣😃😄😅😆😉😊")).toBeNull();
    expect(checkPassphrase("😀😁😂🤣😃😄😅😆😉")).toMatch(/at least 10/);
  });
});

/** Who is logged in to the core in this process right now (nobody, if the vault is locked): asked of the core itself, not of a Vault. */
async function whoIsLoggedIn(): Promise<string> {
  const client = await CoreClient.boot(new DirectTransport(), null);
  try {
    return (await client.request<{ user: { username: string } }>("profile:load")).user.username;
  } finally {
    await client.close();
  }
}

describe("what a passphrase is counted as", () => {
  it("is what the key is made from: fullwidth digits are digits, and an accent typed in two parts is one character", () => {
    // (ten fullwidth digits are 1234567890 once they are a key)
    expect(checkPassphrase("\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18\uff19\uff10")).toMatch(/first a stranger would try/);
    // (five letters with their accents typed apart are ten code points, and five characters)
    expect(checkPassphrase("e\u0301a\u0301i\u0301o\u0301u\u0301")).toMatch(/at least 10 characters/);
    // the same ten characters typed with the accents made in
    expect(checkPassphrase("\u00e9\u00e1\u00ed\u00f3\u00fa\u00e9\u00e1\u00ed\u00f3\u00fa")).toBeNull();
  });
});

describe("the passphrase as it becomes a key", () => {
  it("is the same however an accent was typed, and for fullwidth letters, and unchanged for ASCII", () => {
    const composed = "caf\u00e9 cr\u00e8me br\u00fbl\u00e9e";
    const decomposed = "cafe\u0301 cre\u0300me bru\u0302le\u0301e";
    expect(composed).not.toBe(decomposed);
    expect(normalizePassphrase(decomposed)).toBe(normalizePassphrase(composed));
    expect(normalizePassphrase("\uff21\uff22\uff23 passphrase")).toBe("ABC passphrase");
    // the passphrases that were typed before this existed (ASCII, and any that were already in NFC) are the same keys
    for (const same of ["pale river stone lantern", "  spaces  kept ", "tab\tand\nnewline", composed, "日本語のパスフレーズです", "😀😁😂🤣😃😄😅😆😉😊"]) expect(normalizePassphrase(same)).toBe(same);
    // and nothing is trimmed: a space at the end is part of what was typed
    expect(normalizePassphrase("ends with a space ")).toBe("ends with a space ");
  });
});

describe("the vault", () => {
  it("is made with a passphrase, and then it is unlocked", async () => {
    const vault = newVault();
    expect(vault.unlocked).toBe(false);
    expect(() => vault.core).toThrow(/locked/);
    made ??= Promise.resolve();
    await vault.create(PASSPHRASE);
    expect(vault.unlocked).toBe(true);
    const accounts = await vault.core.request<string[]>("user:local-accounts");
    expect(accounts).toHaveLength(1);
    // its name is its own: random, and nothing a person chose
    expect(accounts[0]).toMatch(/^[0-9a-f]{32}$/);
    const profile = await vault.core.request<{ spaces: unknown[] }>("profile:load");
    expect(profile.spaces).toEqual([]);
    await vault.lock();
  }, SLOW);

  it("won't be made with a weak passphrase, and nothing is started for it", async () => {
    const vault = newVault();
    await expect(vault.create("too short")).rejects.toThrow(/at least 10/);
    expect(vault.unlocked).toBe(false);
  });

  it("locks, and then needs the passphrase again: a wrong one is refused and leaves it locked", async () => {
    const vault = await existingVault();
    expect(vault.unlocked).toBe(false);
    expect(() => vault.core).toThrow(/locked/);

    await expect(vault.unlock("pale river stone lantern!")).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(vault.unlocked).toBe(false);
    expect(await whoIsLoggedIn()).toBe("");
    await vault.unlock(PASSPHRASE);
    expect(vault.unlocked).toBe(true);
    expect(await whoIsLoggedIn()).toMatch(/^[0-9a-f]{32}$/);
    // it is the same vault, with its user back (the private part of it is what the passphrase opens)
    const profile = await vault.core.request<{ user: { privkey?: unknown; username: string } }>("profile:load");
    expect(profile.user.username).toMatch(/^[0-9a-f]{32}$/);
    await vault.lock();
    expect(await whoIsLoggedIn(), "locking logs the core out, so what it decrypted and its keys are dropped").toBe("");
    await vault.lock(); // locking what is locked is nothing
  }, SLOW);

  it("opens with an accented passphrase typed either way, and not with another", async () => {
    const sent: string[] = [];
    // an engine that records the passphrase it is given (a vault with no account yet, then one that has it)
    const spy = (): CoreTransport => {
      const transport: CoreTransport = {
        onMessage: null,
        onLost: null,
        onHeard: null,
        terminate() {},
        async boot() {},
        send(message: string) {
          const [id, command, ...args] = JSON.parse(message) as string[];
          if (command === "user:join" || command === "user:login") sent.push(String(args[1]));
          setTimeout(() => transport.onMessage?.("any", JSON.stringify({ id, e: 0, d: command === "user:local-accounts" ? (sent.length > 0 ? ["named"] : []) : {} })), 0);
          if (command === "user:logout") setTimeout(() => transport.onMessage?.("any", JSON.stringify({ e: "user:logout", d: null })), 0);
        },
        async close() {},
      };
      return transport;
    };
    const composed = "caf\u00e9 cr\u00e8me br\u00fbl\u00e9e";
    const decomposed = "cafe\u0301 cre\u0300me bru\u0302le\u0301e";
    const vault = new Vault({ persistence: null, connect: spy });
    // made as one computer types it, opened as another does, and as the first does again: one key
    await vault.create(decomposed);
    await vault.lock();
    await vault.unlock(composed);
    await vault.lock();
    await vault.unlock(decomposed);
    expect(sent).toEqual([composed, composed, composed]);
  });

  it("is made once: a second vault is refused, here or from another Vault object", async () => {
    const first = await existingVault();
    await first.unlock(PASSPHRASE);
    await expect(first.create("another passphrase entirely")).rejects.toBeInstanceOf(VaultExistsError);
    await first.lock();
    await expect(newVault().create("another passphrase entirely")).rejects.toBeInstanceOf(VaultExistsError);
    expect(await newVault().exists()).toBe(true);
    expect(first.unlocked).toBe(false);
  }, SLOW);

  it("goes through unlocking one at a time", async () => {
    const vault = await existingVault();
    const results = await Promise.allSettled([vault.unlock("not this one at all"), vault.unlock(PASSPHRASE), vault.unlock(PASSPHRASE)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(vault.unlocked).toBe(true);
    await vault.lock();
  }, SLOW);

  it("says there is nothing to unlock when there is no vault", async () => {
    const fakeEmpty = new Vault({
      persistence: null,
      connect: () => {
        const real = new DirectTransport();
        const send = real.send.bind(real);
        // an empty browser: the core reports no accounts
        real.send = (message) => {
          const [id, command] = JSON.parse(message) as string[];
          if (command === "user:local-accounts") setTimeout(() => real.onMessage?.("any", JSON.stringify({ id, e: 0, d: [] })), 0);
          else send(message);
        };
        return real;
      },
    });
    await expect(fakeEmpty.unlock(PASSPHRASE)).rejects.toBeInstanceOf(NoVaultError);
    expect(await fakeEmpty.exists()).toBe(false);
  });

  it("knows when its engine is lost, and is then locked, and says so", async () => {
    // an engine that answers just enough to be unlocked, and can be made to die
    let lose: (reason: string) => void = () => undefined;
    const vault = new Vault({
      persistence: null,
      connect: () => {
        const transport: CoreTransport = {
          onMessage: null,
          onLost: null,
          onHeard: null,
          terminate() {},
          async boot() {},
          send(message: string) {
            const [id, command] = JSON.parse(message) as string[];
            const answer = command === "user:local-accounts" ? ["some-vault"] : {};
            setTimeout(() => transport.onMessage?.("any", JSON.stringify({ id, e: 0, d: answer })), 0);
            if (command === "user:logout") setTimeout(() => transport.onMessage?.("any", JSON.stringify({ e: "user:logout", d: null })), 0);
          },
          async close() {},
        };
        lose = (reason) => transport.onLost?.(reason);
        return transport;
      },
    });
    const events: string[] = [];
    vault.onChange((event) => events.push(event.kind === "lost" ? `lost: ${event.reason}` : event.kind));
    await vault.unlock(PASSPHRASE);
    expect(vault.unlocked).toBe(true);
    const waiting = vault.core.request("never answered");
    lose("out of memory");
    await expect(waiting).rejects.toThrow(/stopped unexpectedly/);
    expect(vault.unlocked).toBe(false);
    expect(() => vault.core).toThrow(/locked/);
    expect(events).toEqual(["unlocked", "lost: out of memory"]);

    // unlocking again starts another engine, and locking says so too
    await vault.unlock(PASSPHRASE);
    await vault.lock();
    expect(events).toEqual(["unlocked", "lost: out of memory", "unlocked", "locked"]);
  });

  describe("whether the browser promised to keep the data", () => {
    afterEach(() => vi.unstubAllGlobals());

    /** An engine with no vault in it yet, which makes one when asked. */
    const emptyEngine = (): CoreTransport => {
      const transport: CoreTransport = {
        onMessage: null,
        onLost: null,
        onHeard: null,
        terminate() {},
        async boot() {},
        send(message: string) {
          const [id, command] = JSON.parse(message) as string[];
          setTimeout(() => transport.onMessage?.("any", JSON.stringify({ id, e: 0, d: command === "user:local-accounts" ? [] : {} })), 0);
        },
        async close() {},
      };
      return transport;
    };

    for (const answer of [true, false] as const) {
      it(`knows it when the browser says ${answer}`, async () => {
        vi.stubGlobal("navigator", { storage: { persist: async () => answer } });
        const vault = new Vault({ persistence: null, connect: emptyEngine });
        expect(vault.persisted).toBeNull();
        await vault.create(PASSPHRASE);
        expect(await vault.kept).toBe(answer);
        expect(vault.persisted).toBe(answer);
      });
    }

    it("stays unknown when the browser can't be asked, or refuses to answer", async () => {
      vi.stubGlobal("navigator", {});
      const none = new Vault({ persistence: null, connect: emptyEngine });
      await none.create(PASSPHRASE);
      expect(await none.kept).toBeNull();
      expect(none.persisted).toBeNull();
      vi.stubGlobal("navigator", { storage: { persist: async () => { throw new Error("not allowed"); } } });
      const refusing = new Vault({ persistence: null, connect: emptyEngine });
      await refusing.create(PASSPHRASE);
      expect(await refusing.kept).toBeNull();
      expect(refusing.persisted).toBeNull();
    });
  });

  describe("changing the passphrase", () => {
    it("sends the passphrases as they become keys (typed either way), and says what was done", async () => {
      const engine = scriptedEngine((command) => (command === "user:change-passphrase" ? { e: 0, d: { sealed: 3, unreadable: 1 } } : null));
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await vault.unlock(PASSPHRASE);
      const changed = await vault.changePassphrase("cafe\u0301 cre\u0300me br\u00fbl\u00e9e", "\uff21\uff22\uff23 a longer passphrase");
      expect(changed).toEqual({ sealed: 3, unreadable: 1 });
      expect(engine.sent.filter(([command]) => command === "user:change-passphrase")).toEqual([["user:change-passphrase", ["caf\u00e9 cr\u00e8me br\u00fbl\u00e9e", "ABC a longer passphrase"]]]);
      // it is still unlocked: changing the passphrase doesn't lock anything
      expect(vault.unlocked).toBe(true);
      await vault.lock();
    });

    it("won't take a weak new passphrase, and asks the core nothing for it", async () => {
      const engine = scriptedEngine();
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await vault.unlock(PASSPHRASE);
      await expect(vault.changePassphrase(PASSPHRASE, "too short")).rejects.toThrow(/at least 10/);
      await expect(vault.changePassphrase(PASSPHRASE, "aaaaaaaaaaaaaaaa")).rejects.toThrow(/repeats/);
      expect(engine.sent.some(([command]) => command === "user:change-passphrase")).toBe(false);
      await vault.lock();
    });

    it("needs the vault to be unlocked, and starts nothing when it is not", async () => {
      const engine = scriptedEngine();
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await expect(vault.changePassphrase(PASSPHRASE, "another passphrase altogether")).rejects.toThrow(/locked/);
      expect(engine.transports).toHaveLength(0);
    });

    it("says a wrong current passphrase is wrong, and leaves the vault unlocked, as it was", async () => {
      const engine = scriptedEngine((command) => (command === "user:change-passphrase" ? { e: 1, d: { type: "api", subtype: "Unauthorized", message: { error: "bad login" } } } : null));
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await vault.unlock(PASSPHRASE);
      await expect(vault.changePassphrase("not the passphrase", "another passphrase altogether")).rejects.toBeInstanceOf(WrongPassphraseError);
      expect(vault.unlocked).toBe(true);
      await vault.lock();
    });

    it("passes on what else the core refuses with, in its words", async () => {
      const engine = scriptedEngine((command) => (command === "user:change-passphrase" ? { e: 1, d: { type: "bad_value", message: "an earlier change of passphrase is not finished: lock the vault and unlock it again first" } } : null));
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await vault.unlock(PASSPHRASE);
      const refused = await vault.changePassphrase(PASSPHRASE, "another passphrase altogether").catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CoreError);
      expect((refused as CoreError).message).toMatch(/not finished/);
      expect(vault.unlocked).toBe(true);
      await vault.lock();
    });

    it("changes one at a time: a second change is not started until the first is answered", async () => {
      const at: number[] = [];
      const engine = scriptedEngine((command) => {
        if (command !== "user:change-passphrase") return null;
        at.push(Date.now());
        return { e: 0, d: { sealed: at.length, unreadable: 0 }, delay: 40 };
      });
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await vault.unlock(PASSPHRASE);
      const results = await Promise.all([vault.changePassphrase(PASSPHRASE, "another passphrase altogether"), vault.changePassphrase("another passphrase altogether", "and yet another passphrase")]);
      expect(results.map((r) => r.sealed)).toEqual([1, 2]);
      expect(at).toHaveLength(2);
      expect(at[1]! - at[0]!, "the second change was sent while the first was being made").toBeGreaterThanOrEqual(30);
      await vault.lock();
    });

    it("tells a listener when unlocking settled a change that had been stopped half way, and which way", async () => {
      for (const finished of [true, false]) {
        const engine = scriptedEngine((command) => (command === "user:login" ? { e: 0, d: {}, events: [{ e: "user:passphrase:settled", d: { finished } }] } : null));
        const vault = new Vault({ persistence: null, connect: engine.connect });
        const told: boolean[] = [];
        const stop = vault.onSettled((was) => told.push(was));
        await vault.unlock(PASSPHRASE);
        expect(told).toEqual([finished]);
        await vault.lock();
        stop();
      }
      // nothing to tell when nothing was settled, and nothing after the listener is stopped
      const quiet = scriptedEngine();
      const vault = new Vault({ persistence: null, connect: quiet.connect });
      const told: boolean[] = [];
      vault.onSettled((was) => told.push(was));
      await vault.unlock(PASSPHRASE);
      await vault.lock();
      expect(told).toEqual([]);
    });

    it("does not tell about a change that was settled when the passphrase typed was wrong", async () => {
      const engine = scriptedEngine((command) => (command === "user:login" ? { e: 1, d: { type: "api", subtype: "Unauthorized", message: { error: "bad login" } }, events: [{ e: "user:passphrase:settled", d: { finished: true } }] } : null));
      const vault = new Vault({ persistence: null, connect: engine.connect });
      const told: boolean[] = [];
      vault.onSettled((was) => told.push(was));
      await expect(vault.unlock(PASSPHRASE)).rejects.toBeInstanceOf(WrongPassphraseError);
      expect(told).toEqual([]);
    });

    it("with the real core: the old passphrase stops opening the vault and the new one opens it; a wrong current one changes nothing", async () => {
      const vault = await existingVault();
      const next = "a different passphrase, quite long";
      await vault.unlock(PASSPHRASE);
      try {
        await expect(vault.changePassphrase("not the passphrase", next)).rejects.toBeInstanceOf(WrongPassphraseError);
        expect(await vault.changePassphrase(PASSPHRASE, next)).toEqual({ sealed: 0, unreadable: 0 });
        expect(vault.unlocked).toBe(true);
        // (the account is the same, and what was open stays open)
        const before = await vault.core.request<{ user: { username: string } }>("profile:load");
        await vault.lock();
        await expect(vault.unlock(PASSPHRASE)).rejects.toBeInstanceOf(WrongPassphraseError);
        await vault.unlock(next);
        const after = await vault.core.request<{ user: { username: string } }>("profile:load");
        expect(after.user.username).toBe(before.user.username);
      } finally {
        // (the core of this process holds one vault for all the tests: it goes back to the passphrase the others use)
        if (!vault.unlocked) await vault.unlock(next).catch(() => vault.unlock(PASSPHRASE));
        const now = await vault.core.request<{ user: { username: string } }>("profile:load").then(() => true, () => false);
        if (now) await vault.changePassphrase(next, PASSPHRASE).catch(() => undefined);
        await vault.lock();
      }
      await vault.unlock(PASSPHRASE);
      await vault.lock();
    }, SLOW);
  });

  describe("backing up and restoring", () => {
    it("takes a backup in pieces, as one file with every byte of what the engine made, and lets the engine go of it", async () => {
      const size = 5_000_000;
      const whole = sequence(0, size);
      const engine = scriptedEngine((command, args) => {
        if (command === "vault:backup:make") return { e: 0, d: { size } };
        if (command === "vault:backup:read") {
          const [offset, length] = args as [number, number];
          return { e: 0, d: Buffer.from(whole.subarray(offset, offset + length)).toString("base64") };
        }
        return null;
      });
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await vault.unlock(PASSPHRASE);
      const backup = await vault.exportBackup();
      expect(backup.size).toBe(size);
      expect(same(await bytesOf(backup), whole), "the file is what the engine made").toBe(true);
      const reads = engine.sent.filter(([command]) => command === "vault:backup:read").map(([, args]) => args);
      expect(reads).toEqual([[0, 2097152], [2097152, 2097152], [4194304, 805696]]);
      expect(engine.sent.map(([command]) => command).filter((command) => command.startsWith("vault:"))).toEqual(["vault:backup:make", "vault:backup:read", "vault:backup:read", "vault:backup:read", "vault:backup:drop"]);
      expect(vault.unlocked).toBe(true);
      await vault.lock();
    });

    it("an empty vault's backup is still a file, and a backup that goes wrong is let go of all the same", async () => {
      let fail = false;
      const engine = scriptedEngine((command) => {
        if (command === "vault:backup:make") return { e: 0, d: { size: fail ? 10 : 0 } };
        if (command === "vault:backup:read") return { e: 1, d: { type: "bad_value", message: "there is no backup made" } };
        return null;
      });
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await vault.unlock(PASSPHRASE);
      expect((await vault.exportBackup()).size).toBe(0);
      fail = true;
      await expect(vault.exportBackup()).rejects.toThrow(/no backup made/);
      expect(engine.sent.filter(([command]) => command === "vault:backup:drop")).toHaveLength(2);
      await vault.lock();
    });

    it("is not a backup if what the engine hands out is not as big as it said", async () => {
      const engine = scriptedEngine((command, args) => {
        if (command === "vault:backup:make") return { e: 0, d: { size: 3000 } };
        if (command === "vault:backup:read") return { e: 0, d: Buffer.from(sequence(0, 2900)).toString("base64") };
        return null;
      });
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await vault.unlock(PASSPHRASE);
      await expect(vault.exportBackup()).rejects.toThrow(/2900 bytes, and the engine made 3000/);
      await vault.lock();
    });

    it("needs the vault to be unlocked, and a size that makes sense", async () => {
      const engine = scriptedEngine((command) => (command === "vault:backup:make" ? { e: 0, d: { size: "a lot" } } : null));
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await expect(vault.exportBackup()).rejects.toThrow(/locked/);
      expect(engine.transports).toHaveLength(0);
      await vault.unlock(PASSPHRASE);
      await expect(vault.exportBackup()).rejects.toThrow(/no size/);
      await vault.lock();
    });

    /** What a restore sends, as the engine hears it. */
    const hearing = () => {
      const heard: Uint8Array[] = [];
      const reply = (command: string, args: unknown[]) => {
        if (command === "user:local-accounts") return { e: 0, d: [] };
        if (command === "vault:restore:write") {
          const [offset, piece] = args as [number, string];
          const bytes = new Uint8Array(Buffer.from(piece, "base64"));
          expect(offset).toBe(heard.reduce((sum, part) => sum + part.length, 0));
          heard.push(bytes);
          return { e: 0, d: { size: offset + bytes.length } };
        }
        if (command === "vault:restore:commit") return { e: 0, d: { spaces: 2, notes: 7, files: 1 } };
        return null;
      };
      return { heard, reply };
    };
    const backupFile = (length: number) => new Blob([new TextEncoder().encode("ZIMVAULT"), new Uint8Array(sequence(3, length - 8))]);

    it("sends a backup in pieces, in order, and says what was put back; the engine is closed, and nothing is unlocked", async () => {
      const { heard, reply } = hearing();
      const engine = scriptedEngine(reply);
      const vault = new Vault({ persistence: null, connect: engine.connect });
      const file = backupFile(4_500_000);
      expect(await vault.restoreBackup(file)).toEqual({ spaces: 2, notes: 7, files: 1 });
      const sent = new Uint8Array(heard.reduce((sum, part) => sum + part.length, 0));
      heard.reduce((at, part) => (sent.set(part, at), at + part.length), 0);
      expect(same(sent, await bytesOf(file)), "what the engine heard is the file").toBe(true);
      expect(heard.map((part) => part.length)).toEqual([2097152, 2097152, 305696]);
      expect(engine.sent.map(([command]) => command).filter((command) => command.startsWith("vault:") || command === "user:local-accounts")).toEqual(["user:local-accounts", "vault:restore:write", "vault:restore:write", "vault:restore:write", "vault:restore:commit"]);
      expect(engine.closed.count).toBe(1);
      expect(vault.unlocked).toBe(false);
    });

    it("refuses what is not a backup before an engine is started, and what is too big", async () => {
      const engine = scriptedEngine();
      const vault = new Vault({ persistence: null, connect: engine.connect });
      await expect(vault.restoreBackup(new Blob(["%PDF-1.4 a document"]))).rejects.toBeInstanceOf(NotABackupError);
      await expect(vault.restoreBackup(new Blob([]))).rejects.toBeInstanceOf(NotABackupError);
      await expect(vault.restoreBackup(new Blob(["ZIMVAUL"]))).rejects.toBeInstanceOf(NotABackupError);
      const huge = new Blob(["ZIMVAULT"]);
      Object.defineProperty(huge, "size", { value: MAX_BACKUP_BYTES + 1 });
      await expect(vault.restoreBackup(huge)).rejects.toThrow(/too big/);
      expect(engine.transports).toHaveLength(0);
    });

    it("does not restore over a vault, whether the core says so first or last, and leaves the one that is there as it was", async () => {
      // (it has an account: nothing is sent)
      const there = scriptedEngine();
      const vault = new Vault({ persistence: null, connect: there.connect });
      await expect(vault.restoreBackup(backupFile(100))).rejects.toBeInstanceOf(VaultExistsError);
      expect(there.sent.some(([command]) => command === "vault:restore:write")).toBe(false);
      expect(there.closed.count).toBe(1);
      // (it says there is none, and then that there is: another tab made one in between)
      const late = scriptedEngine((command) => {
        if (command === "user:local-accounts") return { e: 0, d: [] };
        if (command === "vault:restore:commit") return { e: 1, d: { type: "api", subtype: "Conflict", message: { error: "there are already encrypted notebooks on this device" } } };
        return null;
      });
      await expect(new Vault({ persistence: null, connect: late.connect }).restoreBackup(backupFile(100))).rejects.toBeInstanceOf(VaultExistsError);
      // (and a vault that is unlocked is one)
      const unlocked = scriptedEngine();
      const open = new Vault({ persistence: null, connect: unlocked.connect });
      await open.unlock(PASSPHRASE);
      await expect(open.restoreBackup(backupFile(100))).rejects.toBeInstanceOf(VaultExistsError);
      expect(open.unlocked).toBe(true);
      expect(unlocked.transports, "no other engine was started to find that out").toHaveLength(1);
      await open.lock();
    });

    it("passes on what the engine finds wrong with a backup, and cancels what it was sent", async () => {
      const engine = scriptedEngine((command) => {
        if (command === "user:local-accounts") return { e: 0, d: [] };
        if (command === "vault:restore:commit") return { e: 1, d: { type: "bad_value", message: "the backup can't be restored: it is damaged: what it adds up to is not what was written at its end" } };
        return null;
      });
      const vault = new Vault({ persistence: null, connect: engine.connect });
      const refused = await vault.restoreBackup(backupFile(1000)).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CoreError);
      expect((refused as CoreError).message).toMatch(/it is damaged/);
      expect(engine.sent.map(([command]) => command)).toContain("vault:restore:cancel");
      expect(engine.closed.count).toBe(1);
    });

    it("keeps to one thing at a time with the vault's other work", async () => {
      const slow = scriptedEngine((command) => (command === "vault:restore:commit" ? { e: 0, d: { spaces: 1, notes: 1, files: 0 }, delay: 50 } : command === "user:local-accounts" ? { e: 0, d: [] } : null));
      const vault = new Vault({ persistence: null, connect: slow.connect });
      const order: string[] = [];
      const restoring = vault.restoreBackup(backupFile(100)).then(() => order.push("restored"));
      // (once the restore is under way, what else is asked of the vault waits for it)
      while (!slow.sent.some(([command]) => command === "vault:restore:write")) await new Promise((resolve) => setTimeout(resolve, 1));
      const creating = vault.create(PASSPHRASE).then(() => order.push("created"), () => order.push("refused"));
      await Promise.all([restoring, creating]);
      expect(order).toEqual(["restored", "created"]);
    });
  });

  describe("bytes as text", () => {
    it("come back as they went, whatever they are and however many", () => {
      for (const length of [0, 1, 2, 3, 4, 5, 255, 256, 0x7fff, 0x8000, 0x8001, 70_001]) {
        const bytes = sequence(length, length);
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
      }
      expect(bytesToBase64(Uint8Array.from([0, 255, 254, 1]))).toBe("AP/+AQ==");
      expect(() => base64ToBytes("not base64 !")).toThrow();
    });
  });

  it("explains why the data can't be kept, or is in use, instead of showing what the core said", async () => {
    const failing = (message: string) => new Vault({
      persistence: null,
      connect: () => ({
        onMessage: null,
        onLost: null,
        onHeard: null,
        terminate() {},
        async boot() {
          throw new Error(message);
        },
        send() {},
        async close() {},
      }),
    });
    // (the core tags what it means: its prose is not read for the meaning, so a message that only mentions it is not taken for it)
    await expect(failing("[in-use] the stored data is in use by another tab or worker (close it and try again): Error").create(PASSPHRASE)).rejects.toBeInstanceOf(VaultBusyError);
    await expect(failing("[no-storage] couldn't set up persistent storage: nope").unlock(PASSPHRASE)).rejects.toBeInstanceOf(VaultUnavailableError);
    await expect(failing("something else entirely").unlock(PASSPHRASE)).rejects.toThrow("something else entirely");
    const prose = failing("the stored data is in use by another tab or worker, in prose");
    await expect(prose.unlock(PASSPHRASE)).rejects.not.toBeInstanceOf(VaultBusyError);
    await expect(failing("couldn't set up persistent storage, in prose").unlock(PASSPHRASE)).rejects.not.toBeInstanceOf(VaultUnavailableError);
  });
});
