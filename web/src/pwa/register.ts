// The page's side of the service worker (web/pwa/sw.js, which says what it does and why): it registers the
// worker, learns which version of the app is running and whether another is installed and waiting for the
// person to approve it, and starts the page again when the version has changed. What the person sees of it
// is in app/app.ts.

/** A version that is installed and waits to be approved. */
export interface Offer {
  id: string;
  files: number;
  bytes: number;
  /** The files that differ from the running version (at most a few are told). */
  changed: string[];
}

export type Phase = "unsupported" | "starting" | "installing" | "ready" | "failed";

export interface PwaState {
  phase: Phase;
  /** Why the app is not saved on this device, when it isn't. */
  reason: string | null;
  /** The version this page runs, once known: a fingerprint of every file of it. */
  running: string | null;
  files: number;
  bytes: number;
  offer: Offer | null;
  /** The version that was approved, if the browser lost its files and the server no longer has them, so that another runs. */
  replaced: string | null;
  /** A new version was found and not installed: its files were not what its list said, or could not be had. */
  refused: boolean;
}

/** The part of the browser the page uses, so that a test can give it another. */
export interface PwaHost {
  serviceWorker: ServiceWorkerContainer | undefined;
  secure: boolean;
  /** Where the worker is. Undefined when this is not a build to install (a development server). */
  scriptUrl: string | undefined;
  /** For `beforeinstallprompt` and `appinstalled`. */
  events: EventTarget;
}

/** Chromium's way of offering to install the app. */
export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface VersionReply {
  type: "version";
  running: string;
  files: number;
  bytes: number;
  replaced: string | null;
  offered: Offer | null;
}

function isVersionReply(value: unknown): value is VersionReply {
  const v = value as Partial<VersionReply> | null;
  return !!v && typeof v === "object" && v.type === "version" && typeof v.running === "string" && typeof v.files === "number" && typeof v.bytes === "number";
}

/** Send the worker a message and wait for what it answers on a channel of its own; null if it says nothing in time. */
function ask(worker: ServiceWorker, message: object, ms = 5000): Promise<unknown> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const done = (answer: unknown) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(answer);
    };
    const timer = setTimeout(() => done(null), ms);
    channel.port1.onmessage = (event: MessageEvent) => done(event.data);
    try {
      worker.postMessage(message, [channel.port2]);
    } catch {
      done(null);
    }
  });
}

/** How often the page asks the server whether there is a new version (it is also asked each time the page is opened, by the browser). */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export class Pwa {
  state: PwaState = { phase: "starting", reason: null, running: null, files: 0, bytes: 0, offer: null, replaced: null, refused: false };
  /** What happens when the page has to start again for another version. The app replaces it with one that saves what was typed first. Returns whether it did. */
  restart: () => Promise<boolean> | boolean = () => {
    location.reload();
    return true;
  };

  private readonly listeners = new Set<() => void>();
  private registration: ServiceWorkerRegistration | null = null;
  private offerer: ServiceWorker | null = null;
  private hadController = false;
  private restarting = false;
  private prompt: InstallPrompt | null = null;
  private lastChecked = 0;
  private stops: Array<() => void> = [];

  constructor(private readonly host: PwaHost) {}

  /** Be told when anything in `state` (or whether the app can be installed) changes. Returns the function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(change: Partial<PwaState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  /** Whether the browser has offered to install the app (and the person has not yet). */
  get canInstall(): boolean {
    return this.prompt !== null;
  }

  /** Ask the browser to install the app, as it offers to; says whether the person agreed. */
  async install(): Promise<boolean> {
    const prompt = this.prompt;
    if (!prompt) return false;
    this.prompt = null;
    this.set({});
    await prompt.prompt();
    return (await prompt.userChoice).outcome === "accepted";
  }

  /** Register the worker and learn what it says. Never rejects: what goes wrong is in `state`. */
  async start(): Promise<void> {
    try {
      await this.begin();
    } catch (error) {
      this.set({ phase: "failed", reason: `The app could not be saved on this device: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async begin(): Promise<void> {
    const { serviceWorker, secure, scriptUrl, events } = this.host;
    const listen = (target: EventTarget, type: string, listener: (event: Event) => void) => {
      target.addEventListener(type, listener);
      this.stops.push(() => target.removeEventListener(type, listener));
    };
    listen(events, "beforeinstallprompt", (event) => {
      event.preventDefault();
      this.prompt = event as InstallPrompt;
      this.set({});
    });
    listen(events, "appinstalled", () => {
      this.prompt = null;
      this.set({});
    });
    if (!scriptUrl) return this.set({ phase: "unsupported", reason: "This is a development copy: it is not saved on this device." });
    if (!serviceWorker) return this.set({ phase: "unsupported", reason: "This browser can't save an app on the device for use without the network." });
    if (!secure) return this.set({ phase: "unsupported", reason: "Saving the app on this device needs a secure page: https, or localhost." });

    this.hadController = !!serviceWorker.controller;
    // a page that finds the version changed under it (another tab approved one, or this one did) starts again
    listen(serviceWorker, "controllerchange", () => {
      if (this.hadController) void this.startAgain();
    });
    listen(serviceWorker, "message", (event) => {
      const message = (event as MessageEvent).data as { type?: unknown; id?: unknown } | null;
      if (message && message.type === "updated" && typeof message.id === "string" && message.id !== this.state.running) void this.startAgain();
    });
    serviceWorker.startMessages?.();
    let registration: ServiceWorkerRegistration | undefined;
    try {
      registration = await serviceWorker.register(scriptUrl, { scope: new URL("./", scriptUrl).href, updateViaCache: "none" });
    } catch (error) {
      return this.set({ phase: "failed", reason: `The app could not be saved on this device: ${error instanceof Error ? error.message : String(error)}` });
    }
    // (a browser that is told not to allow workers can answer with nothing at all)
    if (!registration) return this.set({ phase: "failed", reason: "The app could not be saved on this device: the browser would not register its worker." });
    this.registration = registration;
    listen(registration, "updatefound", () => registration.installing && this.watch(registration.installing));
    if (registration.installing) this.watch(registration.installing);
    if (registration.active || registration.waiting) await this.check();
    else this.set({ phase: "installing" });
    // looked for again from time to time, and when the page comes back to the screen after a while
    const timer = setInterval(() => void this.update().catch(() => undefined), CHECK_EVERY_MS);
    this.stops.push(() => clearInterval(timer));
    if (typeof document !== "undefined") {
      listen(document, "visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - this.lastChecked > 60 * 60 * 1000) void this.update().catch(() => undefined);
      });
    }
  }

  /** Stop listening and looking (for a test: a page does this by going away). */
  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
  }

  /** Follow a worker the browser is installing. */
  private watch(worker: ServiceWorker): void {
    const first = !this.registration?.active;
    if (first) this.set({ phase: "installing" });
    let installed = worker.state !== "installing" && worker.state !== "parsed";
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") {
        installed = true;
        void this.check();
      } else if (worker.state === "activated") {
        void this.check();
      } else if (worker.state === "redundant" && !installed) {
        // it did not install: its files were not what its list said, or the server could not be reached
        if (first) this.set({ phase: "failed", reason: "The app could not be saved on this device: its files could not be checked against what it was built with. It runs from the server instead, and it will be tried again." });
        else this.set({ refused: true });
      }
    });
  }

  /** Ask every worker there is what it knows: which version runs, and whether one waits to be approved. */
  async check(): Promise<void> {
    const registration = this.registration;
    if (!registration) return;
    this.lastChecked = Date.now();
    const workers = [registration.waiting, registration.active, this.host.serviceWorker?.controller ?? null].filter((w, i, all): w is ServiceWorker => !!w && all.indexOf(w) === i);
    const replies = await Promise.all(workers.map(async (worker) => ({ worker, reply: await ask(worker, { type: "describe" }) })));
    const answers = replies.filter((r): r is { worker: ServiceWorker; reply: VersionReply } => isVersionReply(r.reply));
    const first = answers[0];
    if (!first) return;
    // (the running version is what the page was started from: it is not changed by finding another)
    const running = this.state.running ?? first.reply.running;
    const offering = answers.find((a) => a.reply.offered && a.reply.offered.id !== running);
    this.offerer = offering?.worker ?? null;
    this.set({
      phase: "ready",
      reason: null,
      running,
      files: first.reply.files,
      bytes: first.reply.bytes,
      replaced: first.reply.replaced,
      offer: offering?.reply.offered ?? null,
      refused: offering ? false : this.state.refused,
    });
  }

  /** Ask the browser to look for a new version of the worker now. Resolves when what it found has been installed (or refused). */
  async update(): Promise<void> {
    const registration = this.registration;
    if (!registration) return;
    this.set({ refused: false });
    await registration.update();
    const installing = registration.installing;
    if (installing) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000);
        installing.addEventListener("statechange", () => {
          if (installing.state !== "installing") {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    await this.check();
  }

  /** The person approves the version that waits: from now on the app is that one, and the page starts again on it. */
  async approve(): Promise<void> {
    const { offer } = this.state;
    const worker = this.offerer;
    if (!offer || !worker) throw new Error("There is no new version to approve.");
    const reply = (await ask(worker, { type: "approve", id: offer.id }, 120_000)) as { ok?: unknown; reason?: unknown } | null;
    if (!reply || reply.ok !== true) throw new Error(typeof reply?.reason === "string" ? reply.reason : "The new version could not be approved: the app's worker did not answer.");
    // (the pages were told by the worker; this one is one of them)
    await this.startAgain();
  }

  private async startAgain(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    let done = false;
    try {
      done = await this.restart();
    } catch {
      done = false;
    }
    // (a restart that was put off, because what was typed could not be saved, can be asked for again)
    if (!done) this.restarting = false;
  }
}

/** The page's own browser. */
export function browserHost(): PwaHost {
  return {
    serviceWorker: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
    secure: window.isSecureContext,
    scriptUrl: import.meta.env.PROD ? new URL("sw.js", document.baseURI).href : undefined,
    events: window,
  };
}
