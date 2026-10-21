// The shell's script: it runs in the page before the app does, and gives the app what a WebView does not do by itself
// (web/src/app/shell.ts says which hooks there are). The web app depends on none of this.
(() => {
  const debugging = __ZIM_DEBUG__;
  // (for finding out why a page does not start: with ZIM_DESKTOP_DEBUG set, the page's errors and a report of what the WebView offers go to
  // the program's standard error and onto the page itself, where a page that does not start shows nothing else)
  let panel = null;
  const show = (text) => {
    if (!debugging) return;
    panel ??= Object.assign(document.createElement("pre"), { id: "zim-debug" });
    Object.assign(panel.style, { position: "fixed", left: "0", right: "0", bottom: "0", maxHeight: "45vh", overflow: "auto", margin: "0", padding: "6px", background: "#fffbe6", color: "#000", font: "12px monospace", whiteSpace: "pre-wrap", zIndex: "2147483647" });
    if (!panel.isConnected) (document.body ?? document.documentElement).append(panel);
    panel.textContent += text + "\n";
  };
  const tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return show("shell.js ran, but window.__TAURI_INTERNALS__ is not there");
  const invoke = tauri.invoke;

  if (debugging) {
    const say = (text) => {
      show(String(text).slice(0, 700));
      void invoke("debug_log", { message: String(text).slice(0, 2000) }).catch((e) => show("debug_log failed: " + e));
    };
    say("shell.js ran");
    for (const level of ["error", "warn"]) {
      const original = console[level].bind(console);
      console[level] = (...args) => (say(`${level}: ${args.map((a) => (a instanceof Error ? a.stack : typeof a === "object" ? JSON.stringify(a) : a)).join(" ")}`), original(...args));
    }
    window.addEventListener("error", (event) => say(`error: ${event.message} (${event.filename}:${event.lineno})`));
    // (what the page's content policy refuses is not an error of the page's own: it is told by this event only)
    document.addEventListener("securitypolicyviolation", (event) => say(`policy: ${event.violatedDirective} refused ${event.blockedURI} (${event.sourceFile ?? ""}:${event.lineNumber ?? ""})`));
    window.addEventListener("unhandledrejection", (event) => say(`rejected: ${event.reason?.stack ?? event.reason}`));
    // what this WebView offers the app, told once the page has had time to start (no page text: only what is there, and whether it answers)
    setTimeout(async () => {
      const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("no answer in " + ms + " ms"), ms))]);
      const attempt = async (what) => {
        try {
          return await within(what(), 4000);
        } catch (error) {
          return "failed: " + error;
        }
      };
      const opened = () => new Promise((resolve, reject) => { const r = indexedDB.open("zim-probe"); r.onsuccess = () => { r.result.close(); resolve("opened"); }; r.onerror = () => reject(r.error); r.onblocked = () => resolve("blocked"); });
      say("facts: " + JSON.stringify({
        href: location.href, secure: isSecureContext, worker: typeof Worker, wasm: typeof WebAssembly, subtle: typeof crypto?.subtle,
        storage: typeof navigator.storage, opfs: typeof navigator.storage?.getDirectory, notebookTitle: document.querySelector(".notebook-title")?.textContent ?? null,
        indexedDB: await attempt(opened),
        opfsRoot: await attempt(async () => (await navigator.storage.getDirectory(), "opened")),
      }));
    }, 12000);
  }

  // A change of a notebook folder: the new files are staged in the folder (beside the notebook), then the program makes the whole change or none of it.
  const transaction = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const folders = {
    roots: () => invoke("fs_roots"),
    pick: () => invoke("fs_pick"),
    forget: (id) => invoke("fs_forget", { id }),
    list: (id) => invoke("fs_list", { id }),
    read: async (id, path) => new Uint8Array(await invoke("fs_read", { id, path })),
    async apply(id, change) {
      const txn = transaction();
      const writes = [];
      for (const [number, write] of change.writes.entries()) {
        const headers = { "x-root": id, "x-txn": txn, "x-n": String(number) };
        if (write.modified) headers["x-modified"] = String(Math.round(write.modified));
        await invoke("fs_stage", write.bytes, { headers });
        writes.push({ path: write.path, staged: number });
      }
      await invoke("fs_commit", { id, txn, plan: { writes, deletes: change.deletes, moves: change.moves } });
    },
  };

  // An account on a server (web/src/account/native.ts is the page's side of it): the program makes the requests itself (the page's content policy lets it ask nowhere but its own address),
  // the person signs in in their own browser (the program opens it, and waits for it to come back to a port of this computer), and the token is kept where the system keeps secrets.
  // What an answer or a failure is, is the program's to say: a failure comes back as the words for a person, and, when it is about the server's certificate, with a `code` that the page acts on
  // (`certificate-untrusted`, `certificate-changed`): the program sends that as an object, and the page is given an error that has both.
  const failed = (error) => {
    if (error === null || typeof error !== "object") throw error;
    throw Object.assign(new Error(String(error.message ?? "The request could not be made.")), error.code ? { code: String(error.code) } : {});
  };
  const account = {
    // the address that the program suggests when the person connects (ZIM_ACCOUNT_SERVER, or none)
    defaultServer: __ZIM_ACCOUNT_SERVER__,
    request: (request) => invoke("account_request", { request }).catch(failed),
    signIn: {
      begin: (state) => invoke("account_sign_in_begin", { state }),
      wait: (url) => invoke("account_sign_in_wait", { url }),
      cancel: () => void invoke("account_sign_in_cancel").catch(() => {}),
    },
    secrets: {
      get: (name) => invoke("account_secret_get", { name }),
      set: (name, value) => invoke("account_secret_set", { name, value }),
      remove: (name) => invoke("account_secret_remove", { name }),
    },
    // a server whose certificate the system does not know, trusted by its fingerprint after the person has looked at it (tls.rs, pins.rs): the program keeps what was trusted
    trust: {
      inspect: (origin) => invoke("account_trust_inspect", { origin }).catch(failed),
      pin: (origin, fingerprint) => invoke("account_trust_pin", { origin, fingerprint }).catch(failed),
      pinned: (origin) => invoke("account_trust_pinned", { origin }),
      unpin: (origin) => invoke("account_trust_unpin", { origin }),
    },
  };

  window.__zimShell = {
    version: "__ZIM_VERSION__",
    folders,
    account,
    // A link to a Blob that has `download`, which is how a browser saves a file, does nothing in a WebView: the file goes to the
    // program, which asks where to save it (the system's own dialog) and writes it.
    async saveFile(fileName, blob) {
      const name = String(fileName).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await invoke("save_file", bytes, { headers: { "x-file-name": encodeURIComponent(name) } });
    },
  };
})();
