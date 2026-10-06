// The vault and the client of the core, in Node: the core runs in this process (see helpers/direct-core.ts),
// which keeps its databases in memory. What needs a real browser (the Worker, the private file system,
// data surviving a reload) is in the browser test.
import { describe, expect, it } from "vitest";
import { CoreClient, CoreError } from "../src/vault/core-client";
import type { CoreTransport } from "../src/vault/core-client";
import { NoVaultError, Vault, VaultBusyError, VaultExistsError, VaultUnavailableError, WrongPassphraseError, checkPassphrase } from "../src/vault/vault";
import { DirectTransport } from "./helpers/direct-core";

// unlocking costs what it is meant to cost an attacker (scrypt with 128 MiB), a second or two each
const SLOW = 120_000;
const PASSPHRASE = "pale river stone lantern";

const newVault = () => new Vault({ connect: () => new DirectTransport(), persistence: null });

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
  function scripted(reply: (message: string[]) => unknown[]): CoreTransport & { sent: string[][]; lose(reason: string): void; closed: boolean } {
    const transport = {
      sent: [] as string[][],
      closed: false,
      onMessage: null as CoreTransport["onMessage"],
      onLost: null as CoreTransport["onLost"],
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

  it("explains why the data can't be kept, or is in use, instead of showing what the core said", async () => {
    const failing = (message: string) => new Vault({
      persistence: null,
      connect: () => ({
        onMessage: null,
        onLost: null,
        async boot() {
          throw new Error(message);
        },
        send() {},
        async close() {},
      }),
    });
    await expect(failing("the stored data is in use by another tab or worker (close it and try again): Error").create(PASSPHRASE)).rejects.toBeInstanceOf(VaultBusyError);
    await expect(failing("couldn't set up persistent storage: nope").unlock(PASSPHRASE)).rejects.toBeInstanceOf(VaultUnavailableError);
    await expect(failing("something else entirely").unlock(PASSPHRASE)).rejects.toThrow("something else entirely");
  });
});
