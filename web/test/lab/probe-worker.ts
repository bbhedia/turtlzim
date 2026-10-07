// A Worker for the browser test of the network cut-off (src/vault/cut-off.ts): it asks for a file from the
// network, has the real cut-off applied to its real global object, and then tries every way it has of
// reaching out, and of getting them back.
import { NETWORK_APIS, cutOffFromTheNetwork } from "../../src/vault/cut-off";

const global = self as unknown as Record<string, unknown>;

self.onmessage = async (event: MessageEvent<{ url: string }>) => {
  const { url } = event.data;
  const realFetch = global.fetch;
  const before = await fetch(url).then(
    (response) => `status ${response.status}`,
    (error: Error) => `failed: ${error.message}`,
  );

  cutOffFromTheNetwork();

  const after: Record<string, string> = {};
  for (const name of NETWORK_APIS) {
    try {
      new (global[name] as new (address: string) => unknown)(url);
      after[name] = "was allowed";
    } catch (error) {
      after[name] = (error as Error).message;
    }
  }
  try {
    await (global.fetch as (address: string) => Promise<unknown>)(url);
    after.fetchCalled = "was allowed";
  } catch (error) {
    after.fetchCalled = (error as Error).message;
  }
  // what the code in the Worker can do to get it back
  const restored: string[] = [];
  try {
    global.fetch = realFetch;
    if (global.fetch === realFetch) restored.push("assigned");
  } catch {
    // refused
  }
  try {
    Object.defineProperty(self, "fetch", { value: realFetch });
    restored.push("redefined");
  } catch {
    // refused
  }
  try {
    delete global.fetch;
    if (typeof global.fetch !== "function" || global.fetch === realFetch) restored.push("deleted");
  } catch {
    // refused
  }
  let stillRefused = false;
  try {
    await (global.fetch as (address: string) => Promise<unknown>)(url);
  } catch {
    stillRefused = true;
  }
  self.postMessage({ before, after, restored, stillRefused });
};
