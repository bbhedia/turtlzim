// The page's side of the conversation with the core: requests that are promises, errors that say
// what went wrong, and events. How the messages travel (a Worker in the browser, a plain call in a
// Node test) is the transport's business.
import { RESPONSE_CHANNEL } from "./protocol";
import type { CoreEvent, CoreResponse, Persistence, WorkerReply, WorkerRequest } from "./protocol";

/** How the page reaches a running core. */
export interface CoreTransport {
  /** Start the core, keeping its databases in the origin-private file system if `persistence` is given. Rejects with an Error that says why it can't. */
  boot(persistence: Persistence | null): Promise<void>;
  /** Hand the core a message (a JSON string). */
  send(message: string): void;
  /** Called with everything the core sends: the channel, and the message (a JSON string). */
  onMessage: ((channel: string, message: string) => void) | null;
  /** Called if the core goes away without having been asked to (its Worker died). */
  onLost: ((reason: string) => void) | null;
  /** Called whenever the core is heard from, even if only to say that it is alive. */
  onHeard: (() => void) | null;
  /** Stop the core and end what it runs on, so that whatever it held in memory (keys included) goes with it. */
  close(): Promise<void>;
  /** End what the core runs on at once, without a word to it, and without waiting for anything. Nothing can be sent afterwards. */
  terminate(): void;
}

/** What the core says when it refuses or fails: `{type, subtype?, message?, ...}`. */
export interface CoreErrorDetail {
  type?: string;
  subtype?: string;
  message?: unknown;
  errors?: unknown;
}

/** The core answered a request with an error. */
export class CoreError extends Error {
  constructor(
    readonly command: string,
    readonly detail: CoreErrorDetail,
  ) {
    super(describe(command, detail));
    this.name = "CoreError";
  }

  /** What kind of error the core says it is: `api`, `validation`, `not_found`, `bad_value`, `generic`, ... */
  get kind(): string {
    return this.detail.type ?? "unknown";
  }

  get subtype(): string | undefined {
    return this.detail.subtype;
  }
}

function describe(command: string, detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const d = detail as CoreErrorDetail;
    if (d.type === "validation" && Array.isArray(d.errors)) {
      const reasons = d.errors.map((entry) => (Array.isArray(entry) ? String(entry[1]) : String(entry)));
      if (reasons.length > 0) return reasons.join(" ");
    }
    if (typeof d.message === "string") return d.message;
    if (d.message && typeof d.message === "object" && typeof (d.message as { error?: unknown }).error === "string") return (d.message as { error: string }).error;
  }
  return `${command} failed: ${JSON.stringify(detail)}`;
}

/**
 * A string with every lone surrogate (half of a character, which JavaScript strings can hold and JSON can't
 * carry: `JSON.stringify` writes it as an escape that the core's parser refuses) made into the replacement
 * character. A request the core can't read can't be answered, and one that isn't answered is waited for.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "\uFFFD");
}

/** How long a core that has requests waiting may say nothing at all, not even that it is alive, before it is taken to be dead (ms). */
export const SILENCE_MS = 45_000;

interface Pending {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Each client numbers its requests apart from every other's, so that two clients that hear the same core never take each other's answers. */
let clients = 0;

export class CoreClient {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: CoreEvent) => void>();
  private readonly lostListeners = new Set<(reason: string) => void>();
  private readonly prefix = `c${++clients}r`;
  private counter = 0;
  private closed = false;
  private heard = Date.now();
  private watchdog: ReturnType<typeof setInterval> | undefined;

  /** `silenceMs`: how long a core with requests waiting may say nothing before it is taken to be dead. */
  constructor(
    private readonly transport: CoreTransport,
    private readonly silenceMs = SILENCE_MS,
  ) {
    transport.onMessage = (channel, message) => this.receive(channel, message);
    transport.onHeard = () => {
      this.heard = Date.now();
    };
    transport.onLost = (reason) => this.lose(reason);
    // an engine that is killed without a word (the browser does it when memory runs short) sends nothing at all,
    // and what is waiting for it would wait for ever: so one that is waited on and silent too long is dead
    this.watchdog = setInterval(() => {
      if (this.pending.size > 0 && Date.now() - this.heard > this.silenceMs) {
        this.transport.terminate();
        this.lose(`it said nothing for ${Math.round(this.silenceMs / 1000)} seconds`);
      }
    }, Math.max(100, Math.min(5000, this.silenceMs / 4)));
    (this.watchdog as { unref?: () => void }).unref?.();
  }

  /** Start a core on `transport` and return the client for it. */
  static async boot(transport: CoreTransport, persistence: Persistence | null, silenceMs = SILENCE_MS): Promise<CoreClient> {
    const client = new CoreClient(transport, silenceMs);
    await client.start(persistence);
    return client;
  }

  /** Start the core (with persistence, if given). If it can't be started the transport is closed, and the error says why. */
  async start(persistence: Persistence | null): Promise<void> {
    try {
      await this.transport.boot(persistence);
    } catch (error) {
      clearInterval(this.watchdog);
      this.closed = true;
      await this.transport.close().catch(() => undefined);
      throw error;
    }
    this.heard = Date.now();
  }

  private lose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.fail(new Error(`The engine that keeps the encrypted notebooks stopped unexpectedly (${reason}).`));
    for (const listener of [...this.lostListeners]) listener(reason);
  }

  /** End the core at once (what is waiting for it is refused), without letting it log out: for an engine that is still starting when the vault is locked. */
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.fail(new Error("The encrypted notebooks were locked before this finished."));
    this.transport.terminate();
  }

  /** Send the core a command and wait for what it answers. Rejects with a `CoreError` if the core says no. */
  request<T = unknown>(command: string, ...args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The encrypted notebooks are locked."));
    const id = `${this.prefix}${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      // (counting the silence from when something began to wait)
      if (this.pending.size === 0) this.heard = Date.now();
      this.pending.set(id, { command, resolve: resolve as (value: unknown) => void, reject });
      try {
        this.transport.send(JSON.stringify([id, command, ...args], (_key, value) => (typeof value === "string" ? wellFormed(value) : value)));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Be told of what happens in the core that nobody asked about. Returns the function that stops it. */
  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Be told if the core goes away without having been closed (its Worker died): everything waiting is refused, and nothing more can be asked. Returns the function that stops it. */
  onLost(listener: (reason: string) => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /** Stop the core and end what it runs on. Requests still waiting for an answer are refused. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.fail(new Error("The encrypted notebooks were locked before this finished."));
    await this.transport.close();
  }

  private receive(_channel: string, message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (typeof (parsed as { id?: unknown }).id === "string") {
      const response = parsed as CoreResponse;
      const waiting = this.pending.get(response.id);
      if (!waiting) return;
      this.pending.delete(response.id);
      if (response.e === 0) waiting.resolve(response.d);
      else waiting.reject(new CoreError(waiting.command, (response.d && typeof response.d === "object" ? response.d : { message: response.d }) as CoreErrorDetail));
    } else if (typeof (parsed as { e?: unknown }).e === "string") {
      for (const listener of [...this.listeners]) listener(parsed as CoreEvent);
    }
  }

  private fail(error: Error): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const request of waiting) request.reject(error);
  }
}

/** How long the engine has to start, in ms: it loads 3 MB of wasm and libsodium, then opens its databases (and waits a few seconds for another tab to let go of them). */
const BOOT_MS = 60_000;

/** The real thing: the core in a module Worker of its own (core-worker.ts). */
export class WorkerTransport implements CoreTransport {
  onMessage: ((channel: string, message: string) => void) | null = null;
  onLost: ((reason: string) => void) | null = null;
  onHeard: (() => void) | null = null;
  private worker: Worker | null;
  private steps = new Map<"booted" | "stopped", { resolve: () => void; reject: (error: Error) => void }>();
  private ended = false;

  constructor(worker: Worker = new Worker(new URL("./core-worker.ts", import.meta.url), { type: "module" })) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => this.fromWorker(event.data);
    worker.onerror = (event) => this.lost(event.message || "the worker failed");
    worker.onmessageerror = () => this.lost("a message could not be read");
  }

  async boot(persistence: Persistence | null): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The engine that keeps the encrypted notebooks did not start.")), BOOT_MS);
    });
    try {
      await Promise.race([this.step("booted", { op: "boot", persistence }), late]);
    } catch (error) {
      this.end();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  send(message: string): void {
    this.post({ op: "send", message });
  }

  async close(): Promise<void> {
    if (!this.worker) return;
    // let the core finish what it is doing (close its databases) before the Worker, and with it all
    // the core held in memory, is ended; but not for long, or a core that has hung would keep its keys
    try {
      await Promise.race([this.step("stopped", { op: "stop" }), new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    } catch {
      // the core is gone already, or refused to stop: either way it is about to be ended
    }
    this.end();
  }

  private post(request: WorkerRequest): void {
    if (!this.worker) throw new Error("The encrypted notebooks are locked.");
    this.worker.postMessage(request);
  }

  private step(name: "booted" | "stopped", request: WorkerRequest): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.steps.set(name, { resolve, reject });
      try {
        this.post(request);
      } catch (error) {
        this.steps.delete(name);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  terminate(): void {
    // (a start or a stop that is waited for is over: nobody is left to answer it, and what waits on it must not wait for the clock to run out)
    const waiting = [...this.steps.values()];
    this.steps.clear();
    for (const step of waiting) step.reject(new Error("The encrypted notebooks were locked before this finished."));
    this.end();
  }

  private fromWorker(reply: WorkerReply): void {
    this.onHeard?.();
    switch (reply.type) {
      case "alive":
        break;
      case "booted":
      case "stopped": {
        const step = this.steps.get(reply.type);
        this.steps.delete(reply.type);
        step?.resolve();
        break;
      }
      case "message":
        this.onMessage?.(reply.channel, reply.message);
        break;
      case "error": {
        const step = this.steps.get(reply.op === "boot" ? "booted" : "stopped");
        if (step) {
          this.steps.delete(reply.op === "boot" ? "booted" : "stopped");
          step.reject(new Error(reply.error));
        }
        break;
      }
    }
  }

  /**
   * End the core without ceremony, as a crash or a closing tab does, and say so to whoever is waiting.
   * (What a test uses to find out what is left after that.)
   */
  kill(reason: string): void {
    this.lost(reason);
  }

  private lost(reason: string): void {
    const failed = [...this.steps.values()];
    this.steps.clear();
    for (const step of failed) step.reject(new Error(reason));
    const unexpected = !this.ended;
    this.end();
    if (unexpected) this.onLost?.(reason);
  }

  private end(): void {
    this.ended = true;
    this.worker?.terminate();
    this.worker = null;
  }
}

export { RESPONSE_CHANNEL };
