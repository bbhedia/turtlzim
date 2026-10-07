// A pretend browser for the service worker (web/pwa/sw.js): the real file, as scripts/pwa.mjs writes it,
// runs in a vm with a Cache API, a fetch that talks to a pretend server, and the few things a worker uses
// of `self`. A test drives it as a browser does (install, activate, a request, a message) and tampers
// with the server or the caches to see what it does. What this can't show (a real browser's lifecycle, the
// worker's own cache of its script, real headers) is in test/browser.mjs.
import { webcrypto } from "node:crypto";
import vm from "node:vm";

export const ORIGIN = "https://app.test";
export const SCOPE = `${ORIGIN}/`;
/** The folder of the site that the app is in, for a worker that is not at the top of it. */
export const FOLDER = `${ORIGIN}/notes/`;

interface Stored {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

class FakeCache {
  readonly entries = new Map<string, Stored>();

  async match(request: string | Request): Promise<Response | undefined> {
    const kept = this.entries.get(typeof request === "string" ? request : request.url);
    return kept ? new Response(kept.body.length ? (kept.body as BodyInit) : null, { status: kept.status, statusText: kept.statusText, headers: kept.headers }) : undefined;
  }

  async put(request: string | Request, response: Response): Promise<void> {
    if (response.status === 206) throw new TypeError("a partial response can't be kept");
    const body = new Uint8Array(await response.arrayBuffer());
    this.entries.set(typeof request === "string" ? request : request.url, { status: response.status, statusText: response.statusText, headers: [...response.headers], body });
  }
}

/** The caches of one origin, which every worker of it shares (and so does a person with the page's own script). */
export class FakeCaches {
  readonly stores = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let store = this.stores.get(name);
    if (!store) this.stores.set(name, (store = new FakeCache()));
    return store;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }
}

/** The server: the files of a site, which can be changed, taken away, redirected or switched off. */
export class FakeServer {
  readonly files = new Map<string, Uint8Array>();
  readonly redirects = new Set<string>();
  readonly errors = new Map<string, number>();
  offline = false;
  /** What was asked for, in order. */
  readonly log: string[] = [];

  /** `folder`: the app is in a folder of the site ("/notes/"), and nothing else is there. */
  constructor(files: Record<string, string | Uint8Array> = {}, readonly folder = "/") {
    for (const [path, content] of Object.entries(files)) this.put(path, content);
  }

  put(path: string, content: string | Uint8Array): void {
    this.files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
  }

  fetch = async (input: string | Request): Promise<Response> => {
    const request = typeof input === "string" ? new Request(input) : input;
    this.log.push(new URL(request.url).pathname);
    if (this.offline) throw new TypeError("Failed to fetch");
    const url = new URL(request.url);
    if (!url.pathname.startsWith(this.folder)) return new Response("Not found", { status: 404 });
    let path = decodeURIComponent(url.pathname.slice(this.folder.length));
    if (path === "") path = "index.html";
    const status = this.errors.get(path);
    if (status) return new Response("an error", { status });
    const bytes = this.files.get(path);
    if (!bytes) return new Response("Not found", { status: 404 });
    const response = new Response(bytes as BodyInit, { status: 200, headers: { "content-type": path.endsWith(".html") ? "text/html" : "application/octet-stream" } });
    if (this.redirects.has(path)) Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
}

interface Listener {
  (event: unknown): void;
}

export interface Reply {
  type: string;
  [key: string]: unknown;
}

/** One service worker: the file, running, with the pretend browser's caches and server. */
export class FakeWorker {
  private readonly listeners = new Map<string, Listener[]>();
  /** What the worker has sent to the pages. */
  readonly sent: unknown[] = [];
  skippedWaiting = false;
  claimed = false;
  /** The pages that are open (the worker tells them things). */
  readonly pages: Array<{ postMessage(message: unknown): void }> = [{ postMessage: (message) => void this.sent.push(message) }];

  constructor(
    source: string,
    readonly caches: FakeCaches,
    readonly server: FakeServer,
    readonly scope = SCOPE,
  ) {
    const self: Record<string, unknown> = {
      addEventListener: (type: string, listener: Listener) => this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]),
      registration: { scope },
      clients: {
        claim: async () => void (this.claimed = true),
        matchAll: async () => this.pages,
      },
      skipWaiting: async () => void (this.skippedWaiting = true),
    };
    const sandbox = vm.createContext({ ...self, self, caches, fetch: server.fetch, Request, Response, URL, crypto: webcrypto, console });
    (sandbox as { self: unknown }).self = sandbox;
    vm.runInContext(source, sandbox, { filename: "sw.js" });
  }

  private async dispatch(type: string, event: Record<string, unknown>): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const listener of this.listeners.get(type) ?? []) listener({ ...event, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
  }

  /** The browser installs the worker. Rejects if the worker refuses. */
  install(): Promise<void> {
    return this.dispatch("install", {});
  }

  activate(): Promise<void> {
    return this.dispatch("activate", {});
  }

  /** A request from a page. Null: the worker let it go to the network. */
  async fetch(path: string, init: { method?: string; navigate?: boolean; range?: boolean; absolute?: boolean } = {}): Promise<Response | null> {
    const url = init.absolute ? path : new URL(path, ORIGIN).href;
    const headers = init.range ? { range: "bytes=0-9" } : undefined;
    // (a request object can't be made with mode "navigate"; the worker only reads it)
    const request = new Request(url, { method: init.method ?? "GET", headers });
    if (init.navigate) Object.defineProperty(request, "mode", { value: "navigate" });
    let answer: Promise<Response> | undefined;
    for (const listener of this.listeners.get("fetch") ?? []) listener({ request, respondWith: (promise: Promise<Response>) => (answer = promise) });
    return answer ? await answer : null;
  }

  /** A page sends the worker a message; what the worker answers on the port. */
  async message(data: unknown): Promise<Reply[]> {
    const replies: Reply[] = [];
    await this.dispatch("message", { data, ports: [{ postMessage: (reply: Reply) => replies.push(reply) }], source: null });
    return replies;
  }

  /** `describe`, answered. */
  async describe(): Promise<Reply> {
    const [reply] = await this.message({ type: "describe" });
    if (!reply) throw new Error("the worker did not answer");
    return reply;
  }
}

/** The text of a response. */
export const textOf = async (response: Response | null): Promise<string> => (response ? await response.text() : "(the network)");
