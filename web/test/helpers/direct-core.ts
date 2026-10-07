// The core in the test's own process, for tests that run in Node: there is no Worker here, and no
// origin-private file system, so the databases are in memory (as long as the process runs, an
// account made through one connection can be logged into through the next). A wasm instance holds
// one core and can't start a second, so the first `boot()` starts it and `close()` leaves it running.
// Every client that is open hears everything the core sends and takes what answers its own requests
// (a request's id is its own), as the page's clients each would from a core of their own.
import { readFileSync } from "node:fs";
import sodium from "libsodium-wrappers-sumo";
import { bootCore, sendToCore } from "../../src/vault/core-boot";
import { CoreClient } from "../../src/vault/core-client";
import type { CoreTransport } from "../../src/vault/core-client";

const wasm = readFileSync(new URL("../../src/turtl-core/turtl_core_bg.wasm", import.meta.url));

let started: Promise<void> | null = null;
const open = new Set<DirectTransport>();

export class DirectTransport implements CoreTransport {
  onMessage: ((channel: string, message: string) => void) | null = null;
  onLost: ((reason: string) => void) | null = null;
  onHeard: (() => void) | null = null;

  async boot(persistence: { directory: string } | null): Promise<void> {
    if (persistence) throw new Error("this transport has no file system to keep data in");
    started ??= bootCore({ wasm, sodium, persistence: null, onMessage: (channel, message) => open.forEach((transport) => transport.onMessage?.(channel, message)) });
    await started;
    open.add(this);
  }

  send(message: string): void {
    sendToCore(message);
  }

  async close(): Promise<void> {
    open.delete(this);
  }

  /** (The core here is the test's own process: nothing to end but this connection to it.) */
  terminate(): void {
    open.delete(this);
  }
}

/** Log the core's user out without waiting for the answer (it comes a second after the logout, which is done when the event is). */
export async function logoutQuickly(client: CoreClient): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const stop = client.onEvent((event) => {
      if (event.e === "user:logout") {
        stop();
        resolve();
      }
    });
  });
  client.request("user:logout", false).catch(() => undefined);
  await done;
}

let accounts = 0;

/** A client of the core with an account of its own, new and empty, logged in (whoever was logged in before is logged out). */
export async function freshAccount(): Promise<CoreClient> {
  const client = await CoreClient.boot(new DirectTransport(), null);
  await logoutQuickly(client);
  await client.request("user:join", `test-account-${++accounts}-${Math.random().toString(16).slice(2, 10)}`, "a passphrase for the tests");
  return client;
}
