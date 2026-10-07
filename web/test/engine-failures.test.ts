// What the page does when the engine misbehaves or is ended at a bad moment: it goes silent, it is ended
// while it starts, an answer to an unlock arrives just as the vault is locked, or the page has text that
// the engine could not read. A scripted transport stands for the engine; what the real Worker adds
// (terminating it for real, its heartbeat) is in the browser tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreClient, wellFormed } from "../src/vault/core-client";
import type { CoreTransport } from "../src/vault/core-client";
import { Vault } from "../src/vault/vault";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const PASSPHRASE = "pale river stone lantern";

/** An engine on a script: its start can be held until the test lets go, and everything it is sent is kept. */
function engine(options: { holdStart?: boolean; onSend?: (id: string, command: string, args: unknown[]) => void } = {}) {
  let failStart: ((error: Error) => void) | undefined;
  const transport = {
    sent: [] as string[],
    starting: false,
    terminated: false,
    closed: false,
    onMessage: null as CoreTransport["onMessage"],
    onLost: null as CoreTransport["onLost"],
    onHeard: null as CoreTransport["onHeard"],
    boot() {
      if (!options.holdStart) return Promise.resolve();
      transport.starting = true;
      return new Promise<void>((_resolve, reject) => {
        failStart = reject;
      });
    },
    send(message: string) {
      transport.sent.push(message);
      const [id, command, ...args] = JSON.parse(message) as [string, string, ...unknown[]];
      options.onSend?.(id, command, args);
      // (the real core says so when the logout is done, which is what a lock waits for)
      if (command === "user:logout") setTimeout(() => transport.onMessage?.("any", JSON.stringify({ e: "user:logout", d: null })), 0);
    },
    async close() {
      transport.closed = true;
    },
    terminate() {
      transport.terminated = true;
      // (as the real one does: a start that is waited for is over)
      failStart?.(new Error("The encrypted notebooks were locked before this finished."));
    },
    answer(id: string, d: unknown = null) {
      transport.onMessage?.("any", JSON.stringify({ id, e: 0, d }));
    },
    idOf(n: number): string {
      return (JSON.parse(transport.sent[n] as string) as string[])[0] as string;
    },
  };
  return transport;
}

describe("an engine that goes silent", () => {
  it("is taken to be dead when something waits for it and it says nothing at all", async () => {
    const quiet = engine();
    const client = await CoreClient.boot(quiet, null, 200);
    const lost = vi.fn();
    client.onLost(lost);
    await expect(client.request("anything")).rejects.toThrow(/stopped unexpectedly/);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(String(lost.mock.calls[0]?.[0])).toMatch(/said nothing/);
    // and it is ended, not just given up on
    expect(quiet.terminated).toBe(true);
    await expect(client.request("again")).rejects.toThrow(/locked/);
  });

  it("is not, while it keeps saying that it is alive, however long a request takes", async () => {
    const busy = engine();
    const client = await CoreClient.boot(busy, null, 300);
    const lost = vi.fn();
    client.onLost(lost);
    const beat = setInterval(() => busy.onHeard?.(), 80);
    try {
      let settled = false;
      const answer = client.request("a long job");
      answer.then(
        () => (settled = true),
        () => (settled = true),
      );
      await sleep(900);
      expect(settled).toBe(false);
      expect(lost).not.toHaveBeenCalled();
      busy.answer(busy.idOf(0), "done");
      await expect(answer).resolves.toBe("done");
    } finally {
      clearInterval(beat);
      await client.close();
    }
  });

  it("is left alone when nothing waits for it, and its silence is counted from when something starts to", async () => {
    const idle = engine();
    const client = await CoreClient.boot(idle, null, 200);
    const lost = vi.fn();
    client.onLost(lost);
    await sleep(600);
    expect(lost).not.toHaveBeenCalled();
    // it has been quiet for three times as long as is allowed, but nobody was waiting: a request now gets its time
    const answer = client.request("now");
    await sleep(100);
    expect(lost).not.toHaveBeenCalled();
    idle.answer(idle.idOf(0), "fine");
    await expect(answer).resolves.toBe("fine");
    await client.close();
  });
});

describe("what is sent to the engine", () => {
  it("is text the engine can read: half of a character becomes the replacement character, whole characters are left", async () => {
    const listening = engine();
    const client = await CoreClient.boot(listening, null);
    // (a string from a keyboard or a file can end in half of an emoji; JSON writes it as an escape the core's parser refuses, and a request it can't read is never answered)
    const sent = client.request("save", "ok \u{1F600} half: \ud83d and \ude00 end");
    sent.catch(() => undefined);
    const message = listening.sent[0] as string;
    expect(JSON.parse(message)[2]).toBe("ok \u{1F600} half: � and � end");
    expect(message).not.toMatch(/\\ud[89a-f]/i);
    expect(wellFormed("😀")).toBe("😀");
    expect(wellFormed("a\ud83d")).toBe("a�");
    expect(wellFormed("\ude00a")).toBe("�a");
    expect(wellFormed("plain, é, 漢字")).toBe("plain, é, 漢字");
    await client.close();
  });

  it("is numbered apart from what any other client sends, so that two that hear one core never take each other's answers", async () => {
    const first = engine();
    const second = engine();
    const a = await CoreClient.boot(first, null);
    const b = await CoreClient.boot(second, null);
    a.request("x").catch(() => undefined);
    b.request("x").catch(() => undefined);
    expect(first.idOf(0)).not.toBe(second.idOf(0));
    await a.close();
    await b.close();
  });
});

describe("ending an engine at once", () => {
  it("refuses what waits, says nothing to the engine, and does not call it lost", async () => {
    const running = engine();
    const client = await CoreClient.boot(running, null);
    const lost = vi.fn();
    client.onLost(lost);
    const waiting = client.request("a job");
    client.terminate();
    await expect(waiting).rejects.toThrow(/locked before this finished/);
    expect(running.terminated).toBe(true);
    expect(running.closed).toBe(false);
    expect(running.sent).toHaveLength(1);
    expect(lost).not.toHaveBeenCalled();
    await expect(client.request("more")).rejects.toThrow(/locked/);
    // (and it can be ended again, as a lock that comes twice would)
    client.terminate();
    await client.close();
  });
});

describe("locking the vault while it is being unlocked", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not wait for the unlock: the engine that is starting is ended, the unlock fails, and the vault is locked", async () => {
    const stuck = engine({ holdStart: true });
    const vault = new Vault({ persistence: null, connect: () => stuck });
    const unlocking = vault.unlock(PASSPHRASE).then(
      () => "opened",
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(stuck.starting).toBe(true));
    await vault.lock();
    expect(stuck.terminated).toBe(true);
    expect(await unlocking).toMatch(/locked before this finished/);
    expect(vault.unlocked).toBe(false);
  });

  it("goes on to be unlocked at once afterwards: what was stuck does not hold up the next unlock", async () => {
    const stuck = engine({ holdStart: true });
    const working = engine({
      onSend(id, command) {
        const d = command === "user:local-accounts" ? ["an-account"] : {};
        setTimeout(() => working.answer(id, d), 0);
      },
    });
    const engines = [stuck, working];
    const vault = new Vault({ persistence: null, connect: () => engines.shift() as CoreTransport });
    const first = vault.unlock(PASSPHRASE).catch(() => undefined);
    await vi.waitFor(() => expect(stuck.starting).toBe(true));
    await vault.lock();
    await first;
    const before = Date.now();
    await vault.unlock(PASSPHRASE);
    expect(vault.unlocked).toBe(true);
    expect(Date.now() - before).toBeLessThan(2000);
    await vault.lock();
  });

  it("is not opened by an unlock whose answer came just before the lock", async () => {
    // (the answer to the login is in, the lock comes in the same moment, and the unlock was about to open the vault)
    let loginId: string | undefined;
    const answering = engine({
      onSend(id, command) {
        if (command === "user:login") loginId = id;
        else setTimeout(() => answering.answer(id, command === "user:local-accounts" ? ["an-account"] : {}), 0);
      },
    });
    const vault = new Vault({ persistence: null, connect: () => answering });
    const unlocking = vault.unlock(PASSPHRASE).then(
      () => "opened",
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(loginId).toBeDefined());
    answering.answer(loginId as string, {});
    const locking = vault.lock();
    expect(await unlocking).toMatch(/locked before this finished/);
    await locking;
    expect(vault.unlocked).toBe(false);
    expect(answering.terminated).toBe(true);
  });
});

describe("the browser's promise to keep the data", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is told once the browser has given it, which can be long after the vault was made", async () => {
    // (a browser may ask the person; the vault does not wait for the answer, and the app's notice has to)
    let answer!: (promised: boolean) => void;
    vi.stubGlobal("navigator", { storage: { persist: () => new Promise<boolean>((resolve) => (answer = resolve)) } });
    const made = engine({
      onSend(id, command) {
        setTimeout(() => made.answer(id, command === "user:local-accounts" ? [] : {}), 0);
      },
    });
    const vault = new Vault({ persistence: null, connect: () => made });
    await vault.create(PASSPHRASE);
    expect(vault.unlocked).toBe(true);
    expect(vault.persisted).toBeNull();
    let told: boolean | null | "not yet" = "not yet";
    void vault.kept.then((promised) => (told = promised));
    await sleep(50);
    expect(told).toBe("not yet");
    answer(false);
    expect(await vault.kept).toBe(false);
    expect(vault.persisted).toBe(false);
    await vault.lock();
  });
});
