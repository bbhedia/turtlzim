// The shell's script: it runs in the page before the app does, and gives the app what a WebView does not do by itself
// (web/src/app/shell.ts says which hooks there are). The web app depends on none of this.
(() => {
  if (!window.__TAURI_INTERNALS__) return;
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__zimShell = {
    version: "__ZIM_VERSION__",
    // A link to a Blob that has `download`, which is how a browser saves a file, does nothing in a WebView: the file goes to the
    // program, which asks where to save it (the system's own dialog) and writes it.
    async saveFile(fileName, blob) {
      const name = String(fileName).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await invoke("save_file", bytes, { headers: { "x-file-name": encodeURIComponent(name) } });
    },
  };
})();
