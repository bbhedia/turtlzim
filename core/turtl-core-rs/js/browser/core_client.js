// The page's side of core_worker.js: boots the core in a Worker, and turns the core's messages into
// promises. A reference for how the UI talks to the core; the protocol is the same one every
// platform uses (["<id>", "<command>", args..] in, {id, e, d} responses and {e, d} events out).

export class CoreClient {
    constructor(workerUrl) {
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.worker.onmessage = (event) => this.onWorkerMessage(event.data);
        this.worker.onerror = (event) => this.fail(new Error(`worker error: ${event.message}`));
        this.nextId = 1;
        this.pending = new Map();      // request id -> { resolve }
        this.events = [];              // every event the core has sent: { e, d }
        this.eventWaiters = [];        // { predicate, resolve }
        this.lifecycle = new Map();    // 'booted' / 'stopped' -> { resolve, reject }
    }

    /**
     * Start the core. `config` is the runtime config (see wasm_host.rs); `persistence`, if given
     * ({ directory }), keeps the databases in OPFS. Resolves once the core is up.
     */
    boot(config, persistence) {
        return this.lifecycleStep('booted', { op: 'boot', config, persistence });
    }

    /** Stop the core (the worker stays; `terminate()` ends that). */
    stop() {
        return this.lifecycleStep('stopped', { op: 'stop' });
    }

    /** Kill the worker, as closing or reloading the page would. */
    terminate() {
        this.worker.terminate();
    }

    /** Send a command and resolve with its response: { id, e, d } (e is 0 on success). */
    request(command, ...args) {
        const id = `r${this.nextId++}`;
        return this.withTimeout(`the response to ${command}`, (resolve) => {
            this.pending.set(id, { resolve });
            this.worker.postMessage({ op: 'send', message: JSON.stringify([id, command, ...args]) });
        });
    }

    /** Resolve with the first event (already seen, or still to come) that `predicate` accepts. */
    waitForEvent(predicate) {
        const seen = this.events.find(predicate);
        if (seen) return Promise.resolve(seen);
        return this.withTimeout('an event', (resolve) => this.eventWaiters.push({ predicate, resolve }));
    }

    lifecycleStep(name, request) {
        return this.withTimeout(name, (resolve, reject) => {
            this.lifecycle.set(name, { resolve, reject });
            this.worker.postMessage(request);
        });
    }

    /** A promise for what `start(resolve, reject)` sets up, rejected if it takes longer than 60 s. */
    withTimeout(what, start) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 60000);
            start((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
        });
    }

    onWorkerMessage(data) {
        switch (data.type) {
            case 'booted':
            case 'stopped': {
                const step = this.lifecycle.get(data.type);
                if (step) step.resolve();
                break;
            }
            case 'error':
                this.fail(new Error(`${data.op}: ${data.error}`));
                break;
            case 'message': {
                const message = JSON.parse(data.message);
                if (message.id !== undefined && this.pending.has(message.id)) {
                    this.pending.get(message.id).resolve(message);
                    this.pending.delete(message.id);
                } else if (typeof message.e === 'string') {
                    this.events.push(message);
                    this.eventWaiters = this.eventWaiters.filter((waiter) => {
                        if (!waiter.predicate(message)) return true;
                        waiter.resolve(message);
                        return false;
                    });
                }
                break;
            }
        }
    }

    fail(error) {
        for (const step of this.lifecycle.values()) step.reject(error);
        this.lifecycle.clear();
    }
}
