// The network taken away from the engine's Worker (cut-off.ts), on a scope of a test's own. What a real
// Worker's global object does with it is in the browser test of the vault (`npm run test:vault`).
import { describe, expect, it } from "vitest";
import { NETWORK_APIS, NETWORK_REFUSED, cutOffFromTheNetwork } from "../src/vault/cut-off";

/** A scope that has every way of reaching out, as a Worker's global object does, and answers when they are used. */
function workerScope(): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  for (const name of NETWORK_APIS) scope[name] = () => `${name} reached the network`;
  scope.postMessage = () => "not a way out of the machine";
  scope.crypto = { subtle: {} };
  return scope;
}

describe("cutting a Worker off from the network", () => {
  it("makes every way of reaching out refuse, called or constructed", () => {
    const scope = workerScope();
    for (const name of NETWORK_APIS) expect((scope[name] as () => string)()).toBe(`${name} reached the network`);
    cutOffFromTheNetwork(scope);
    for (const name of NETWORK_APIS) {
      expect(() => (scope[name] as () => void)(), name).toThrow(NETWORK_REFUSED);
      expect(() => new (scope[name] as new () => unknown)(), `new ${name}`).toThrow(NETWORK_REFUSED);
    }
  });

  it("can't be undone by the code that runs in the Worker afterwards", () => {
    const scope = workerScope();
    const real = scope.fetch;
    cutOffFromTheNetwork(scope);
    expect(() => {
      scope.fetch = real;
    }).toThrow();
    expect(() => {
      delete scope.fetch;
    }).toThrow();
    expect(() => Object.defineProperty(scope, "fetch", { value: real })).toThrow();
    expect(() => (scope.fetch as () => void)()).toThrow(NETWORK_REFUSED);
  });

  it("takes away what a browser does not have as well (a way that comes later can't be used either), and nothing else", () => {
    const scope: Record<string, unknown> = { postMessage: () => "ok", crypto: { subtle: {} }, setInterval: () => 1 };
    cutOffFromTheNetwork(scope);
    for (const name of NETWORK_APIS) expect(() => (scope[name] as () => void)()).toThrow(NETWORK_REFUSED);
    expect((scope.postMessage as () => string)()).toBe("ok");
    expect((scope.setInterval as () => number)()).toBe(1);
    expect(scope.crypto).toEqual({ subtle: {} });
  });

  it("is harmless done twice, or on a scope that was already locked down", () => {
    const scope = workerScope();
    cutOffFromTheNetwork(scope);
    expect(() => cutOffFromTheNetwork(scope)).not.toThrow();
    for (const name of NETWORK_APIS) expect(() => (scope[name] as () => void)()).toThrow(NETWORK_REFUSED);
  });

  it("covers the ways a Worker reaches out that a policy of the page can't be counted on to keep in", () => {
    expect([...NETWORK_APIS].sort()).toEqual(["EventSource", "SharedWorker", "WebSocket", "WebTransport", "Worker", "XMLHttpRequest", "fetch", "importScripts"]);
  });
});
