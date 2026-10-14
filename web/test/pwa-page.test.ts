// The page's side of the service worker (src/pwa/register.ts) against a pretend browser: what the page
// learns of the version that runs and of one that waits, when it starts again, and what it says when the app
// could not be saved. (The worker itself is in pwa-worker.test.ts, and both together in a real browser in
// browser.mjs.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pwa } from "../src/pwa/register";
import type { PwaHost } from "../src/pwa/register";

type Answer = (message: { type?: string; id?: string }) => unknown;

class FakeWorker extends EventTarget {
  state = "installing";
  readonly received: Array<{ type?: string; id?: string }> = [];
  constructor(private readonly answer: Answer = () => undefined) {
    super();
  }
  postMessage(message: { type?: string; id?: string }, transfer: MessagePort[]): void {
    this.received.push(message);
    const reply = this.answer(message);
    if (reply !== undefined) transfer[0]?.postMessage(reply);
  }
  become(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  updates = 0;
  onUpdate: () => void | Promise<void> = () => undefined;
  async update(): Promise<void> {
    this.updates++;
    await this.onUpdate();
  }
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  registered: { url: string; options: { scope?: string; updateViaCache?: string } } | null = null;
  registration = new FakeRegistration();
  failWith: Error | null = null;
  startedMessages = false;
  async register(url: string, options: { scope?: string; updateViaCache?: string }): Promise<FakeRegistration> {
    if (this.failWith) throw this.failWith;
    this.registered = { url, options };
    return this.registration;
  }
  startMessages(): void {
    this.startedMessages = true;
  }
}

const version = (running: string, offered: { id: string; files?: number; bytes?: number; changed?: string[] } | null = null, extra: object = {}) => ({
  type: "version",
  running,
  files: 4,
  bytes: 4000,
  replaced: null,
  offered: offered && { files: 4, bytes: 4100, changed: [], ...offered },
  ...extra,
});

function pretend(options: { secure?: boolean; scriptUrl?: string | undefined; noWorkers?: boolean; native?: string | null } = {}) {
  const container = new FakeContainer();
  const events = new EventTarget();
  const host: PwaHost = {
    serviceWorker: options.noWorkers ? undefined : (container as unknown as ServiceWorkerContainer),
    secure: options.secure ?? true,
    scriptUrl: "scriptUrl" in options ? options.scriptUrl : "https://app.test/sw.js",
    events,
    native: options.native ?? null,
  };
  const pwa = new Pwa(host);
  const restarts: number[] = [];
  pwa.restart = () => {
    restarts.push(restarts.length);
    return true;
  };
  return { container, events, pwa, restarts, registration: container.registration };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => vi.useRealTimers());

describe("where the app can't be saved on the device", () => {
  it("says why, and registers nothing: a development copy, a browser without workers, a page that is not secure", async () => {
    for (const [what, options, why] of [
      ["a development copy", { scriptUrl: undefined }, /development copy/],
      ["a browser without workers", { noWorkers: true }, /can't save an app/],
      ["a page that is not secure", { secure: false }, /secure page: https, or localhost/],
    ] as const) {
      const { container, pwa } = pretend(options);
      await pwa.start();
      expect(pwa.state.phase, what).toBe("unsupported");
      expect(pwa.state.reason, what).toMatch(why);
      expect(container.registered, what).toBeNull();
      pwa.stop();
    }
  });

  it("is the installed app in a native shell: it registers no worker, offers no install, and says that its code is the app's", async () => {
    const { container, events, pwa } = pretend({ native: "android" });
    await pwa.start();
    expect(pwa.state.phase).toBe("native");
    expect(pwa.state.reason).toMatch(/installed app: its code is part of the app/);
    expect(container.registered).toBeNull();
    expect(container.startedMessages).toBe(false);
    events.dispatchEvent(new Event("beforeinstallprompt"));
    expect(pwa.canInstall).toBe(false);
    pwa.stop();
  });

  it("says that it could not be saved when the browser refuses the worker", async () => {
    const { container, pwa } = pretend();
    container.failWith = new Error("a certificate error");
    await pwa.start();
    expect(pwa.state).toMatchObject({ phase: "failed" });
    expect(pwa.state.reason).toContain("a certificate error");
    pwa.stop();
  });

  it("does not throw when the browser answers its registration with nothing (what a browser told to allow no workers does), or with something that breaks", async () => {
    const none = pretend();
    none.container.register = async () => undefined as never;
    await none.pwa.start();
    expect(none.pwa.state).toMatchObject({ phase: "failed" });
    expect(none.pwa.state.reason).toMatch(/would not register/);
    none.pwa.stop();
    const broken = pretend();
    broken.container.register = async () => ({}) as never;
    await broken.pwa.start();
    expect(broken.pwa.state.phase).toBe("failed");
    broken.pwa.stop();
  });
});

describe("saving the app", () => {
  it("registers the worker next to the page, asks the browser to look for a new one every time, and learns the version once it is active", async () => {
    const { container, pwa, registration } = pretend();
    const worker = new FakeWorker((m) => (m.type === "describe" ? version("abc123") : undefined));
    registration.installing = worker;
    await pwa.start();
    expect(container.registered).toEqual({ url: "https://app.test/sw.js", options: { scope: "https://app.test/", updateViaCache: "none" } });
    expect(container.startedMessages).toBe(true);
    expect(pwa.state.phase).toBe("installing");
    // it installs, and activates
    registration.installing = null;
    registration.active = worker;
    worker.become("installed");
    worker.become("activated");
    await vi.waitFor(() => expect(pwa.state.phase).toBe("ready"));
    expect(pwa.state).toMatchObject({ running: "abc123", files: 4, bytes: 4000, offer: null, replaced: null, refused: false });
    pwa.stop();
  });

  it("is ready at once when the app was saved before", async () => {
    const { container, pwa, registration } = pretend();
    registration.active = new FakeWorker((m) => (m.type === "describe" ? version("abc123") : undefined));
    container.controller = registration.active;
    await pwa.start();
    expect(pwa.state).toMatchObject({ phase: "ready", running: "abc123" });
    pwa.stop();
  });

  it("says that it could not be saved when the worker fails to install, and that a new version was refused when a later one does", async () => {
    const first = pretend();
    const failing = new FakeWorker();
    first.registration.installing = failing;
    await first.pwa.start();
    failing.become("redundant");
    expect(first.pwa.state.phase).toBe("failed");
    expect(first.pwa.state.reason).toMatch(/could not be checked/);
    first.pwa.stop();

    const later = pretend();
    later.registration.active = new FakeWorker((m) => (m.type === "describe" ? version("abc123") : undefined));
    later.container.controller = later.registration.active;
    await later.pwa.start();
    const refused = new FakeWorker();
    later.registration.installing = refused;
    later.registration.dispatchEvent(new Event("updatefound"));
    refused.become("redundant");
    expect(later.pwa.state).toMatchObject({ phase: "ready", refused: true, offer: null });
    later.pwa.stop();
  });

  it("does not take a worker that was replaced after it had installed for one that failed", async () => {
    const { pwa, registration, container } = pretend();
    registration.active = new FakeWorker((m) => (m.type === "describe" ? version("abc123") : undefined));
    container.controller = registration.active;
    await pwa.start();
    const waiting = new FakeWorker((m) => (m.type === "describe" ? version("abc123", { id: "def456" }) : undefined));
    registration.installing = waiting;
    registration.dispatchEvent(new Event("updatefound"));
    registration.installing = null;
    registration.waiting = waiting;
    waiting.become("installed");
    waiting.become("redundant");
    expect(pwa.state.refused).toBe(false);
    pwa.stop();
  });
});

describe("a new version", () => {
  async function waiting() {
    const world = pretend();
    const active = new FakeWorker((m) => (m.type === "describe" ? version("abc123") : undefined));
    const waitingWorker = new FakeWorker((m) => {
      if (m.type === "describe") return version("abc123", { id: "def456", changed: ["index.html", "assets/app-2.js"] });
      if (m.type === "approve") return { type: "approved", ok: m.id === "def456", id: m.id, reason: "refused" };
      return undefined;
    });
    world.registration.active = active;
    world.registration.waiting = waitingWorker;
    world.container.controller = active;
    await world.pwa.start();
    return { ...world, active, waitingWorker };
  }

  it("is offered when one waits, with what differs, while the running version is still the old one", async () => {
    const { pwa } = await waiting();
    expect(pwa.state).toMatchObject({ phase: "ready", running: "abc123", offer: { id: "def456", changed: ["index.html", "assets/app-2.js"] } });
    pwa.stop();
  });

  it("is offered also when the browser has already made it the active one (the worker says it holds an unapproved version)", async () => {
    const world = pretend();
    const active = new FakeWorker((m) => (m.type === "describe" ? version("abc123", { id: "def456" }) : undefined));
    world.registration.active = active;
    world.container.controller = active;
    await world.pwa.start();
    expect(world.pwa.state.offer?.id).toBe("def456");
    world.pwa.stop();
  });

  it("is approved by naming it to the worker that has it, and then the page starts again, once", async () => {
    const { pwa, waitingWorker, restarts } = await waiting();
    await pwa.approve();
    expect(waitingWorker.received.filter((m) => m.type === "approve")).toEqual([{ type: "approve", id: "def456" }]);
    expect(restarts).toHaveLength(1);
    await pwa.approve().catch(() => undefined);
    expect(restarts).toHaveLength(1);
    pwa.stop();
  });

  it("is not started again for when the worker says no, and says why", async () => {
    const { pwa, waitingWorker, restarts } = await waiting();
    waitingWorker.postMessage = (message, transfer) => {
      waitingWorker.received.push(message);
      if (message.type === "describe") transfer[0]?.postMessage(version("abc123", { id: "def456" }));
      else transfer[0]?.postMessage({ type: "approved", ok: false, reason: "a file is not what it was built with" });
    };
    await expect(pwa.approve()).rejects.toThrow("a file is not what it was built with");
    expect(restarts).toHaveLength(0);
    pwa.stop();
  });

  it("can't be approved when there is none", async () => {
    const { pwa, registration, container } = pretend();
    registration.active = new FakeWorker((m) => (m.type === "describe" ? version("abc123") : undefined));
    container.controller = registration.active;
    await pwa.start();
    await expect(pwa.approve()).rejects.toThrow(/no new version/);
    pwa.stop();
  });

  it("is looked for on request: the browser is asked, what is found is waited for, and then it is offered", async () => {
    const { pwa, registration, active } = await (async () => {
      const world = pretend();
      const active = new FakeWorker((m) => (m.type === "describe" ? version("abc123") : undefined));
      world.registration.active = active;
      world.container.controller = active;
      await world.pwa.start();
      return { ...world, active };
    })();
    const found = new FakeWorker((m) => (m.type === "describe" ? version("abc123", { id: "def456" }) : undefined));
    registration.onUpdate = () => {
      registration.installing = found;
      setTimeout(() => {
        registration.installing = null;
        registration.waiting = found;
        found.become("installed");
      }, 1);
    };
    await pwa.update();
    expect(registration.updates).toBe(1);
    expect(pwa.state.offer?.id).toBe("def456");
    expect(active.received.some((m) => m.type === "describe")).toBe(true);
    pwa.stop();
  });

  it("can't be looked for when the server can't be reached: the browser's refusal reaches the person", async () => {
    const { pwa, registration, container } = pretend();
    registration.active = new FakeWorker((m) => (m.type === "describe" ? version("abc123") : undefined));
    container.controller = registration.active;
    await pwa.start();
    registration.onUpdate = () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(pwa.update()).rejects.toThrow("Failed to fetch");
    pwa.stop();
  });
});

describe("starting again", () => {
  async function running(controlled: boolean) {
    const world = pretend();
    world.registration.active = new FakeWorker((m) => (m.type === "describe" ? version("abc123") : undefined));
    if (controlled) world.container.controller = world.registration.active;
    await world.pwa.start();
    return world;
  }

  it("happens when the worker that controls the page is replaced, but not when the app was saved for the first time (it takes over a page that had none)", async () => {
    const was = await running(true);
    was.container.dispatchEvent(new Event("controllerchange"));
    await settle();
    expect(was.restarts).toHaveLength(1);
    const first = await running(false);
    first.container.dispatchEvent(new Event("controllerchange"));
    await settle();
    expect(first.restarts).toHaveLength(0);
    was.pwa.stop();
    first.pwa.stop();
  });

  it("happens when another page approves a version, but not for the version that runs", async () => {
    const { container, pwa, restarts } = await running(true);
    container.dispatchEvent(new MessageEvent("message", { data: { type: "updated", id: "abc123" } }));
    container.dispatchEvent(new MessageEvent("message", { data: { type: "something else", id: "zzz" } }));
    container.dispatchEvent(new MessageEvent("message", { data: null }));
    container.dispatchEvent(new MessageEvent("message", { data: { type: "updated", id: 5 } }));
    await settle();
    expect(restarts).toHaveLength(0);
    container.dispatchEvent(new MessageEvent("message", { data: { type: "updated", id: "def456" } }));
    container.dispatchEvent(new MessageEvent("message", { data: { type: "updated", id: "def456" } }));
    await settle();
    expect(restarts).toHaveLength(1);
    pwa.stop();
  });

  it("can be asked for again after a page that could not save what was typed put it off", async () => {
    const { container, pwa } = await running(true);
    let answers = [false, true];
    const asked: number[] = [];
    pwa.restart = async () => {
      asked.push(asked.length);
      return answers.shift() ?? true;
    };
    container.dispatchEvent(new MessageEvent("message", { data: { type: "updated", id: "def456" } }));
    await settle();
    container.dispatchEvent(new MessageEvent("message", { data: { type: "updated", id: "def456" } }));
    await settle();
    container.dispatchEvent(new MessageEvent("message", { data: { type: "updated", id: "def456" } }));
    await settle();
    expect(asked).toHaveLength(2);
    answers = [];
    pwa.stop();
  });

  it("is not stopped by a page whose restart throws", async () => {
    const { container, pwa } = await running(true);
    let tried = 0;
    pwa.restart = () => {
      tried++;
      throw new Error("no");
    };
    container.dispatchEvent(new MessageEvent("message", { data: { type: "updated", id: "def456" } }));
    await settle();
    container.dispatchEvent(new MessageEvent("message", { data: { type: "updated", id: "def456" } }));
    await settle();
    expect(tried).toBe(2);
    pwa.stop();
  });
});

describe("a worker that says nothing", () => {
  it("is waited for a few seconds, and then the page goes on without it", async () => {
    vi.useFakeTimers();
    const { pwa, registration, container } = pretend();
    registration.active = new FakeWorker(() => undefined);
    container.controller = registration.active;
    const started = pwa.start();
    await vi.advanceTimersByTimeAsync(5001);
    await started;
    expect(pwa.state.phase).toBe("starting");
    expect(pwa.state.running).toBeNull();
    pwa.stop();
  });

  it("is not believed when it answers with something that is not a version", async () => {
    const { pwa, registration, container } = pretend();
    registration.active = new FakeWorker(() => ({ type: "version", running: 5, files: 4, bytes: 5 }));
    container.controller = registration.active;
    await pwa.start();
    expect(pwa.state.running).toBeNull();
    expect(pwa.state.phase).toBe("starting");
    pwa.stop();
  });
});

describe("installing the app as one of the computer's", () => {
  it("is offered when the browser offers, and once asked is not offered again", async () => {
    const { events, pwa } = pretend({ scriptUrl: undefined });
    await pwa.start();
    expect(pwa.canInstall).toBe(false);
    let prevented = false;
    let prompted = 0;
    const offer = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: async () => void prompted++,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    offer.preventDefault = () => void (prevented = true);
    events.dispatchEvent(offer);
    expect(prevented).toBe(true);
    expect(pwa.canInstall).toBe(true);
    expect(await pwa.install()).toBe(true);
    expect(prompted).toBe(1);
    expect(pwa.canInstall).toBe(false);
    expect(await pwa.install()).toBe(false);
    pwa.stop();
  });

  it("is no longer offered once it is installed, and a refusal is told", async () => {
    const { events, pwa } = pretend({ scriptUrl: undefined });
    await pwa.start();
    events.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "dismissed" as const }) }));
    expect(await pwa.install()).toBe(false);
    events.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "accepted" as const }) }));
    expect(pwa.canInstall).toBe(true);
    events.dispatchEvent(new Event("appinstalled"));
    expect(pwa.canInstall).toBe(false);
    pwa.stop();
  });

  it("stops listening when told to", async () => {
    const { events, pwa } = pretend({ scriptUrl: undefined });
    await pwa.start();
    pwa.stop();
    events.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "accepted" as const }) }));
    expect(pwa.canInstall).toBe(false);
  });
});
