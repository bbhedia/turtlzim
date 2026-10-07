// What a Worker can do to reach the network, taken away. The core in local-only mode makes no request
// (it is built to refuse them, see `Api::req`), and nothing the engine's Worker does after it has loaded
// needs one; but the page's policy can't be counted on to keep a Worker's requests in (the policy that
// governs a Worker comes with the Worker's own script, and a host that serves none leaves it free). So
// the ways a Worker has of reaching out are made to refuse, for good. This is a second lock on a door
// that is already shut, not a sandbox: a module Worker can still `import()` a script by its address, which
// only a policy can stop (`connect-src` and `script-src` in serve.mjs say what the app asks of its host).

/** The ways a Worker has of reaching out, by the name each has on its global object. */
export const NETWORK_APIS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker"] as const;

export const NETWORK_REFUSED = "The engine of the encrypted notebooks can't use the network.";

/** From now on `scope` (a Worker's global object) refuses every way of reaching out, and can't be made to allow it again. */
export function cutOffFromTheNetwork(scope: object = self): void {
  // (a function, so that `new WebSocket(...)` says why as plainly as `fetch(...)` does)
  const refuse = function refuse(): never {
    throw new Error(NETWORK_REFUSED);
  };
  for (const name of NETWORK_APIS) {
    try {
      Object.defineProperty(scope, name, { value: refuse, writable: false, configurable: false });
    } catch {
      // not to be changed in this browser: nothing more can be done about it
    }
  }
}
