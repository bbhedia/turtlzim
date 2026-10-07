# CLAUDE.md — Zim + Turtl note app

Context file for Claude Code. Goal: build an encrypted, multiplatform note app that uses the
**Zim wiki format**, delivered as **three separate clients** (desktop, web, mobile) sharing
**one core**. Rename or merge this into an existing `CLAUDE.md` if you have one.

Companion docs (copy these into the same folder — e.g. `docs/`):
- `zim-turtl-feasibility-study.md` — why a naive merge fails; what is reusable.
- `zim-turtl-architecture-and-plan.md` — full architecture + roadmap (source of truth).

---

## Goal

A note app where notes are Zim wiki markup, edited like the Zim desktop editor. Encryption is
a **per-notebook** choice (open = plain Zim files; encrypted = libsodium ciphertext). Ships as
three apps: **desktop** (Win/macOS/Linux), **web** (browser), **mobile** (iOS/Android).

---

## Locked decisions

- **One shared core, embedded three ways.** Build on Turtl's Rust `core-rs`. Desktop + mobile
  link it as a native library; the web app runs it compiled to **WebAssembly**. Crypto, sync,
  storage, and Zim-format handling all live in the core.
- **One crypto codebase only.** Never reimplement encryption per platform. The WASM build and
  the native build must produce byte-identical ciphertext. Do not roll custom crypto — use
  libsodium primitives (as Turtl does).
- **Zim format is reimplemented, not copied.** Implement a parser/serializer for Zim wiki
  markup in the core. Do not copy Zim's GPLv2 Python source (avoids a GPLv2/GPLv3 clash).
- **Encryption is per-notebook.** A note cannot be both a plain file and a ciphertext blob.
  Open notebooks on desktop are real `.txt` files; on web/mobile there is no filesystem, so
  they live in local storage / sync.
- **Reuse Turtl's sync server** (Node + Postgres). For encrypted notebooks the server stores
  only ciphertext.
- **Product license: GPL-3.0** (because it embeds `core-rs`, which is GPLv3).

UI decision (confirmed by the user 2026-10-05, see Open issues #1): **shared web UI** — build
the Zim editor once (CodeMirror 6) and reuse it in Tauri (desktop), a Capacitor/webview shell
(mobile), and the browser (web). The editor's document *is* the Zim file text (never an AST that
is serialized back), so saving cannot change bytes; syntax spans for live formatting come from
the core's `zim-format` parser compiled to wasm, so there is one Zim parser. Plan and status:
`docs/zim-editor-plan.md`.

Encrypted notebooks (chosen by the user 2026-10-06): the web app keeps them with **the Turtl core
itself**, compiled to wasm and run in a Worker with `local_only` (no server): one local account (the
vault, unlocked by a passphrase, scrypt at 128 MiB) holds one Turtl *space* per notebook and one *note*
per page and per attachment. Design, threat model, limits and what verifies each claim:
`docs/zim-encrypted-notebooks.md`.

---

## Stack

| Piece | Choice |
|---|---|
| Shared core | Rust (`core-rs`), libsodium, storage abstraction |
| Web crypto | `libsodium.js` (real libsodium C source, Emscripten-built) loaded by the host app as its own wasm module and *injected* into the core (`initWasmCrypto(sodium)`), which calls it through typed wasm-bindgen bindings — byte-identical to native by construction, not a separate implementation. See `docs/wasm-port-plan.md`. |
| Web storage | `sqlite-wasm-rs` (real `libsqlite3` compiled straight to `wasm32-unknown-unknown`, linked directly into the core's own wasm binary; the OPFS-SAHPool VFS from `sqlite-wasm-vfs` for persistence, in a dedicated Worker) — **not** IndexedDB; core-rs's storage/search layer is real SQL + SQLite FTS4, which IndexedDB can't represent without rebuilding full-text search from scratch. See `docs/wasm-port-plan.md`. |
| Web networking | `reqwest` upgraded to its async API (already wasm32-native via `fetch` under the hood) — applies to both native and web so the core's public interface stays identical across targets. |
| Editor / UI | CodeMirror 6 with live Zim-syntax formatting (shared web UI) |
| Desktop shell | Tauri (Rust host → links the core as a crate) |
| Mobile shell | Capacitor/webview; core via JNI (Android) + FFI (iOS) |
| Sync server | Turtl `server` (Node + Postgres) |

---

## Repos

Clone for reuse/reference (upstream Turtl is dormant and pinned to old deps — expect to update):

```
# reuse
git clone https://github.com/turtl/core-rs      # the shared core
git clone https://github.com/turtl/server        # sync server (Node + Postgres)
git clone https://github.com/turtl/mobile        # Android JNI embedding reference
# reference only (format + editor behaviour, do NOT copy code)
git clone https://github.com/zim-desktop-wiki/zim-desktop-wiki
```

---

## Setup steps (toolchains — standard, stable)

```bash
# Rust + WASM target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# Node (via nvm) for web UI + sync server
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install --lts

# Desktop shell
cargo install create-tauri-app        # or: npm create tauri-app@latest

# Mobile shell
npm install -g @capacitor/cli

# libsodium: native lib for the native core build; libsodium-wasm for the web build.
# core-rs currently pins libsodium 1.0.16 — plan to update it.
```

---

## Commands (project scripts — establish these; not yet scaffolded)

These are placeholders to define as the repo takes shape; verify before relying on them.

```bash
# Core (native)
cargo build --release              # in core-rs

# Core (web / WASM)
wasm-pack build --target web        # produces the WASM package the web UI imports

# Zim format crate, notebook rules and their wasm bindings (from the repo root)
cargo test -p zim-format -p zim-notebook -p zim-wasm   # unit, property, fuzz and file-layer tests
scripts/zim-golden.sh                  # real Zim notebooks: byte-identical round trips, every link resolves, renames keep links (clones Zim once)

# Web app: Zim editor + notebook app (web/; see docs/zim-editor-plan.md and docs/zim-web-app.md)
cd web && npm install
npm run wasm                        # build core/zim-wasm into web/src/zim-wasm (needs wasm-pack)
npm run core                        # build core/turtl-core-rs (the Turtl core: encrypted notebooks) into web/src/turtl-core
npm run dev                         # dev server
npm run build                       # typecheck + production build into web/dist, with its service worker (dist/sw.js, the list of every file and its SHA-256)
npm run pwa:check                   # is dist/ what its sw.js was made for?  (node scripts/pwa.mjs --remote ADDRESS: what a server serves)
npm test                            # Vitest: editor logic, headless (ZIM_GOLDEN_DIR=... adds real pages)
scripts/setup-browser.sh            # once: Chromium + libraries + a font, no root
npm run test:browser                # the built app in a real browser (ZIM_GOLDEN_DIR=... adds the real Zim manual; ONLY=text picks scenarios)
npm run test:vault                  # the encrypted-notebook vault in a real browser: Worker, OPFS, reload, crash mid-write (five moments), one tab at a time, the Worker's network cut-off, heartbeat and silent death
npm run screenshots <dir>           # twelve pictures of the app to look at (light, dark, phone, dialogs, pictures)
scripts/serve.sh start --host :: --port 8080   # serve web/dist in the background (see docs/zim-editor-plan.md: trying it from another machine)
scripts/serve.sh start --host :: --port 8443 --tls --name ADDRESS   # https for encrypted notebooks from another machine (docs/zim-pwa.md: trusting its certificate)

# Desktop (Tauri)
npm run tauri dev
npm run tauri build

# Mobile (Capacitor)
npx cap sync
npx cap open android                # / ios

# Sync server
docker compose up                   # Postgres + server (define compose file)
```

---

## Conventions for Claude Code

- Treat the shared core as the single source of truth for crypto, sync, storage, and Zim
  parsing. New logic goes in the core unless it is purely presentational.
- Do not add a second crypto path. Do not weaken or hand-roll crypto.
- Keep the core's public interface identical across native and WASM builds.
- Core code that touches the network is `async` all the way up. Never hold a `std` lock guard
  across an `.await` (a contended std lock panics on wasm32, where all tasks share one thread; see
  `core/turtl-core-rs/src/util/exec.rs`). Test async code with `async_test!` so one scenario runs
  natively and on wasm32.
- Zim `.txt` round-trips must be byte-identical. The golden-file test against real Zim notebooks
  is `scripts/zim-golden.sh` (the corpus stays outside the repo; see
  `core/zim-format/tests/golden_real_notebooks.rs`), and the corpus-free fuzz test runs in every
  `cargo test -p zim-format`. Run both after touching `core/zim-format`.
- Never copy Zim source into this repo; reimplement the format from its documented syntax.
- **An encrypted notebook's contents go nowhere but the vault.** Not the address, the tab's title,
  `history.state`, `localStorage`/`sessionStorage`, IndexedDB, the Cache API, a log, or an error
  message that is kept. A new feature of the app that remembers, stores or exposes anything about a
  page (a name, text, a fold, a recent-pages list, a draft) has to check `App.isPrivate` and keep
  quiet in an encrypted notebook (and what is on the screen after a lock, the status line and notices
  included, must name nothing); the scan in `web/test/browser.mjs` ("nothing of an encrypted notebook
  is in anything the browser keeps") is what catches one that doesn't. The core's `local_only` mode
  asks no server for anything: it refuses the network where requests are made and answers only the
  commands in `dispatch::LOCAL_COMMANDS` (a command that a local core needs is added there on purpose;
  the test that reads every command of the dispatcher says which is missing). Locking must work
  whatever else fails (the keys go first, the screen second), and a dialog that is confirmed later
  acts only on the notebook it was opened on (`App.stale`).
- **The built app is pinned by its service worker** (`web/pwa/sw.js`, `docs/zim-pwa.md`). It lists every file of
  `dist/` with its SHA-256 and runs the app from the version that was approved. So: a file the app fetches at run
  time has to be a file of the build (it is then listed and checked on its own); the worker makes no request to
  anywhere but the app's own folder and keeps nothing but those files; the worker is plain JavaScript that is
  type-checked (`tsc -p pwa`), and a change to it is a new version of the app. Do not turn it into a runtime
  cache or add a way to skip the check. `window.__ZIM_TEST__` scenarios run with service workers blocked unless
  they are about the worker.
- Notebook rules (what a name or a link means, tree, backlinks, search, rename) live in
  `core/zim-notebook` and nowhere else: the web app calls them through wasm and holds none of its own.
  A UI change is not done until it has been looked at (`npm run screenshots`) and driven in the real
  browser test (`npm run test:browser`); the unit tests cannot see layout, focus or timing.

---

## Open issues / risks

1. **DECIDED (2026-10-05) — shared web UI, not native UIs.** Native UIs per platform would
   ~triple the editor work and change the mobile/desktop stack; the user confirmed the shared
   CodeMirror 6 editor and chose to build it first, standalone (no server needed), as the `web/`
   package.
2. **WASM port of `core-rs`** is the central effort. Approach decided (see
   `docs/wasm-port-plan.md` for the full research/rationale): real `libsodium.js` via a JS
   bridge for crypto (byte-identical by construction), `sqlite-wasm-rs` (real SQLite, one wasm
   binary) for storage/search rather than IndexedDB, async `reqwest`/`fetch` for networking,
   and single-threaded async (`wasm_bindgen_futures`, one dedicated Web Worker) rather than
   real multithreading for concurrency. Prove ciphertext parity between native and WASM with a
   golden-vector test suite before trusting the crypto bridge.
3. **Turtl is dormant / old deps** (libsodium 1.0.16, old crates, Node 8 server). Budget time
   just to get everything building on current toolchains before adding features.
4. **iOS FFI build does not exist yet** in upstream (only Android JNI). Needs to be created.
5. **Open-notebook sync privacy:** decide policy — local-only, sync-with-disclosure, or
   server-side key (at-rest, not end-to-end). Encrypted notebooks are always end-to-end.
   (Encrypted notebooks exist now, on one device; syncing them to the Turtl server is not done.)
6. **Web-crypto trust model:** a served web app could ship malicious JS ("host-proof hosting"
   critique). Mitigated, not solved: the app can be installed and its code pinned by a service
   worker (every file checked against a list, a new version offered and waiting for approval,
   works offline: `docs/zim-pwa.md`), but the worker script itself comes from the host, so a
   hostile host is not stopped, only made checkable (`scripts/pwa.mjs --remote`). The packaged
   desktop build is the strongest guarantee. The trade-off is documented for users in
   `docs/zim-pwa.md` and `docs/zim-encrypted-notebooks.md`.
7. **Zim editor fidelity:** live inline formatting, `[[internal links]]`, checkboxes,
   attachments, verbatim blocks — the largest UI task.
8. **License check:** confirm Zim's exact license only matters if any Zim source is ever
   copied (it should not be).

---

## References

- Architecture + roadmap: `docs/zim-turtl-architecture-and-plan.md`
- Feasibility rationale: `docs/zim-turtl-feasibility-study.md`
- Zim wiki text format spec (implementation spec for `core/zim-format`): `docs/zim-wiki-format-spec.md`
- `core-rs` revival notes (getting it building/testing on current toolchains): `docs/core-rs-revival-notes.md`
- WASM port plan (crypto/storage/networking/concurrency approach + research): `docs/wasm-port-plan.md`
- Encrypted notebooks (design, threat model, limits, what verifies what): `docs/zim-encrypted-notebooks.md`
- The app on the device (installable, offline, pinned code, updates that wait for approval): `docs/zim-pwa.md`
- The Zim editor (decisions, span model, keys, performance, serving it): `docs/zim-editor-plan.md`
- Notebook rules (names, links, tree, backlinks, search, rename): `docs/zim-notebook.md`
- The notebook app in the browser (stores, saving, import/export, what verifies it, gaps): `docs/zim-web-app.md`
- Claude Code docs: https://docs.claude.com/en/docs/claude-code/overview
