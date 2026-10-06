// What a host does to get the core running, in the order the core needs it (see the docs of
// core/turtl-core-rs/src/wasm_host.rs). The Worker does this in the browser, and a test does it in
// Node with the wasm bytes it read itself, so that both run the same sequence.
import init, { enablePersistence, initCore, initWasmCrypto, sendMessage, setMessageHandler, startCore, stopCore } from "../turtl-core/turtl_core.js";
import type { Persistence } from "./protocol";

/**
 * What the core is told about itself. `local_only`: there is no server, so accounts are made and
 * logged into on this device alone and nothing is ever sent anywhere (core/turtl-core-rs
 * docs: `Turtl::local_only`). The core's address is a placeholder it never uses.
 */
export const CORE_CONFIG = {
  local_only: true,
  logging: { level: "warn" },
  api: { endpoint: "https://invalid.invalid" },
} as const;

export interface BootOptions {
  /** The core's wasm, if the host has the bytes (Node); a browser leaves it out and the bundler's URL is used. */
  wasm?: BufferSource;
  /** libsodium.js: `libsodium-wrappers-sumo`'s default export. The core calls it for every bit of crypto. */
  sodium: unknown;
  /** Keep the databases in the origin-private file system. Only in a dedicated Worker, in a secure context. */
  persistence: Persistence | null;
  /** Where everything the core sends goes. */
  onMessage: (channel: string, message: string) => void;
}

/** Load the core, give it its crypto, set up where its data goes, and start it. */
export async function bootCore(options: BootOptions): Promise<void> {
  await init(options.wasm === undefined ? undefined : { module_or_path: options.wasm });
  await initWasmCrypto(options.sodium);
  if (options.persistence) await enablePersistence(options.persistence.directory);
  initCore(JSON.stringify(CORE_CONFIG));
  setMessageHandler(options.onMessage);
  startCore();
}

/** Hand the core a message (a JSON string). */
export function sendToCore(message: string): void {
  sendMessage(message);
}

/** Stop the core. */
export function stopTheCore(): void {
  stopCore();
  setMessageHandler(null);
}
