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
- **How notebooks are organised** (decided 2026-10-16, `docs/suivi/suivi.pdf`, *Principes d'organisation des carnets*): the unit is the **notebook** (carnet); a note is a page, pages may have sub-pages ("project" is a possible future grouping, not built).
  A notebook is **either encrypted or clear** (never both kinds of page) and **either local or remote** (never both durably; mixed only transiently while it is being changed: first send, change of destination, a conflict being settled). Encryption is **per notebook**
  (one key each); storage and sync of a remote notebook are **per page** (an object per page and attachment, with an index; only changed pages travel; different pages changed on two devices merge, the same page asks). An encrypted notebook reuses the
  **local vault's passphrase** (no second passphrase). The interface keeps one list with two worded badges (encrypted; synced where / this device only) and a state dot (done, E16c: `notebookBadges` in `web/src/app/app.ts`, states in `web/src/account/sync-ui.ts`; the *New notebook* dialog asks Encryption and Where apart). These are choices, to relax later if the use shows a need.
  The sealing of a remote encrypted notebook is in the core (`core/turtl-core-rs/src/seal.rs`, commands `seal:*` in `LOCAL_COMMANDS`, `web/src/vault/seal.ts`; `docs/zim-encrypted-notebooks.md`): the master key stays in the vault's keychain and is never handed out unwrapped; objects are sealed with the same libsodium primitives as everything else (no second crypto path), and its known answers are asserted on native and wasm32.
  **Done, E16d**: an encrypted notebook can be kept on the account's server or on a connected service, sealed page by page (`web/src/account/sealed-remote.ts`: a `Remote` that seals what the sync sends and opens what it reads; the other place holds hashed `.zseal` objects and a sealed index, under the id `zsl-…` and the title "Encrypted notebook"). The master key is made by `seal:master:make` (which checks the vault's passphrase and keeps nothing), kept by the account wrapped by that passphrase (`/api/sync/keychain`, compare-and-swap so two devices that make a first key at the same moment end with one), and only then taken into the vault by `seal:master:unwrap`. A changed vault passphrase wraps it again (same key). A forgotten passphrase can be given up (**E16i**): `POST /api/sync/keychain/reset` deletes the account's key and its sealed notebooks of the account's own space after a warning, only if the key is the one that was seen (compare-and-swap), and `seal:master:forget` (the vault's passphrase) lets a browser drop a key that is not the account's; what a connected service holds is never deleted by it. The *link* of an encrypted notebook (where it is kept, its marks, the highest index counter seen) is a hidden `zim-link` note in the notebook's own space **in the vault**, never in `localStorage`, and is dropped from memory at a lock.
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
per page and per attachment. The passphrase can be changed (a crash half way is settled by whichever passphrase
is typed next) and the whole vault can be backed up to one still-encrypted file and restored in another browser.
Design, threat model, limits and what verifies each claim: `docs/zim-encrypted-notebooks.md`.

---

## Stack

| Piece | Choice |
|---|---|
| Shared core | Rust (`core-rs`), libsodium, storage abstraction |
| Web crypto | `libsodium.js` (real libsodium C source, Emscripten-built) loaded by the host app as its own wasm module and *injected* into the core (`initWasmCrypto(sodium)`), which calls it through typed wasm-bindgen bindings — byte-identical to native by construction, not a separate implementation. See `docs/wasm-port-plan.md`. |
| Web storage | `sqlite-wasm-rs` (real `libsqlite3` compiled straight to `wasm32-unknown-unknown`, linked directly into the core's own wasm binary; the OPFS-SAHPool VFS from `sqlite-wasm-vfs` for persistence, in a dedicated Worker) — **not** IndexedDB; core-rs's storage/search layer is real SQL + SQLite FTS4, which IndexedDB can't represent without rebuilding full-text search from scratch. See `docs/wasm-port-plan.md`. |
| Web networking | `reqwest` upgraded to its async API (already wasm32-native via `fetch` under the hood) — applies to both native and web so the core's public interface stays identical across targets. |
| Editor / UI | CodeMirror 6 with live Zim-syntax formatting (shared web UI) |
| Desktop shell | Tauri 2 (`desktop/`, `docs/zim-desktop-shell.md`): `web/dist` in the system WebView; installers for Linux (.deb, .rpm, .AppImage) and Windows (NSIS, MSI) built by `.github/workflows/desktop.yml` on every change of the web app. Not a GTK/Qt UI (the editor would be written again) |
| Mobile shell | Capacitor/webview (built for Android: `mobile/`, `docs/zim-mobile-shell.md`; iOS needs a Mac); core via JNI (Android) + FFI (iOS), not yet: the shell runs the wasm core in its WebView |
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
scripts/setup-webkit.sh             # once, after that: WebKit (the engine of an iPhone's Safari) and the libraries it lacks, no root
npm run test:browser                # the built app in a real browser (ZIM_GOLDEN_DIR=... adds the real Zim manual; ONLY=text or ONLY="a|b" picks scenarios, SKIP="a|b" leaves some out)
npm run test:browser:webkit         # the same scenarios in WebKit (a profile folder per context; the service-worker and certificate ones, which drive Chromium's DevTools, are left out)
npm run test:vault                  # the encrypted-notebook vault in a real browser: Worker, OPFS, reload, crash mid-write (five moments), a passphrase change and a restore cut off, backup and restore between browsers, every byte of the file system tried with the old key, one tab at a time, the Worker's network cut-off, heartbeat and silent death
npm run measure:unlock -- [pages ...]      # what unlocking costs as a vault grows (a real browser; numbers in docs/zim-encrypted-notebooks.md)
npm run screenshots <dir>           # pictures of the app to look at (light, dark, phone, a phone writing with the keyboard up, dialogs, pictures, tables, the journal and tags, completing a link)
scripts/serve.sh start --host :: --port 8080   # serve web/dist in the background (see docs/zim-editor-plan.md: trying it from another machine)
scripts/serve.sh start --host :: --port 8443 --tls --name ADDRESS   # https for encrypted notebooks from another machine (docs/zim-pwa.md: trusting its certificate)

# Mobile shell, Android (mobile/; docs/zim-mobile-shell.md): a Capacitor project around web/dist; JDK 21 + Android SDK in ~/android, no root
cd mobile && npm install
npm run apk                         # prepare www/ from web/dist (npm run build in web/ first), cap sync, gradle -> mobile/out/zim-notebook-debug.apk
scripts/emulator.sh start|stop|shot # a headless Android 15 emulator (needs /dev/kvm) to try the app in a real WebView
npm run test:device                # the app in the emulator's WebView (installs the APK; VAULT=1 adds an encrypted notebook)
cd ../web && scripts/serve.sh restart --host :: --port 8443 --tls --name ADDRESS --download /zim-notebook.apk=../mobile/out/zim-notebook-debug.apk   # give the APK out beside the web app

# Desktop program (desktop/; docs/zim-desktop-shell.md): Tauri around web/dist; Linux needs `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev patchelf file`
cd desktop && npm install
npm run package -- --web            # npm run build in web/, then tauri build -> desktop/out/ (.deb .rpm .AppImage on Linux, .exe .msi on Windows) + SHA256SUMS
(cd src-tauri && cargo test)        # the program's folder code: paths, listing, the all-or-nothing change and its recovery

# Mobile (Capacitor)
npx cap sync
npx cap open android                # / ios

# Account server (server/; docs/zim-server.md): the web app + /api/ (sign-up with an e-mailed code, Google and GitHub sign-in), Node 24, no root
cd server && npm install && npm test   # accounts, OAuth against stand-ins, the HTTP layer
ZIM_BASE_URL=https://localhost:8443 scripts/run.sh start --host :: --port 8443 --tls --name ADDRESS   # serves web/dist and /api/; scripts/run.sh stop|status|log

# The follow-up document (docs/suivi/: what is done, in progress, waiting, postponed, dropped, and what remains for each point), in French; tectonic installed without root (see the script's header)
scripts/suivi.sh                    # recompile docs/suivi/suivi.pdf from suivi.tex (updates the commit and date in its header)

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
- **An encrypted notebook's contents go nowhere but the vault** (the two exceptions, both by the person's choice and both sealed: the vault's own *sealed backup* sent to their account server, `web/src/account/sealed.ts`, and a notebook **kept sealed** on the server or a connected service, `web/src/account/sealed-remote.ts`, E16d: object by object, under hashed names, with the key wrapped by the vault's passphrase in the account. Nothing readable leaves the browser in either: the browser scenarios scan every request, the server's database, the service's files and both browsers' storage for a page's text, a page's name and the notebook's title, and no page of an encrypted notebook is ever sent as a page, whatever the remote. Anything new that talks to a remote about an encrypted notebook goes through `SealedRemote`, never around it). Not the address, the tab's title,
  `history.state`, `localStorage`/`sessionStorage`, IndexedDB, the Cache API, a log, or an error
  message that is kept. A new feature of the app that remembers, stores or exposes anything about a
  page (a name, text, a fold, a recent-pages list, a draft) has to check `App.isPrivate` and keep
  quiet in an encrypted notebook (and what is on the screen after a lock, the status line and notices
  included, must name nothing); the scan in `web/test/browser.mjs` ("nothing of an encrypted notebook
  is in anything the browser keeps") is what catches one that doesn't. The core's `local_only` mode
  asks no server for anything: it refuses the network where requests are made and answers only the
  commands in `dispatch::LOCAL_COMMANDS` (a command that a local core needs is added there on purpose;
  the test that reads every command of the dispatcher says which is missing). Every database the core opens
  runs with `secure_delete`: what is replaced or deleted is written over, so a key or record that was replaced
  (a changed passphrase) is not left in the file, and a new place that keeps something sealed must not
  go around that. Locking must work
  whatever else fails (the keys go first, the screen second), and a dialog that is confirmed later
  acts only on the notebook it was opened on (`App.stale`).
- **The built app is pinned by its service worker** (`web/pwa/sw.js`, `docs/zim-pwa.md`). It lists every file of
  `dist/` with its SHA-256 and runs the app from the version that was approved. So: a file the app fetches at run
  time has to be a file of the build (it is then listed and checked on its own); the worker makes no request to
  anywhere but the app's own folder and keeps nothing but those files; the worker is plain JavaScript that is
  type-checked (`tsc -p pwa`), and a change to it is a new version of the app. Do not turn it into a runtime
  cache or add a way to skip the check. `window.__ZIM_TEST__` scenarios run with service workers blocked unless
  they are about the worker.
- Notebook rules (what a name or a link means, tree, backlinks, search, rename, tags, the days of the journal,
  the pages a link being typed can lead to) live in `core/zim-notebook` and nowhere else: the web app calls them
  through wasm and holds none of its own. The same goes for a table: it is read and edited by
  `core/zim-format`'s `table` module (through wasm); the editor draws the grid and runs the commands (one change
  each, one undo) and holds no table rules; drawing or moving in a table never rewrites its text.
  A UI change is not done until it has been looked at (`npm run screenshots`) and driven in the real
  browser test (`npm run test:browser`); the unit tests cannot see layout, focus or timing.
- **Notebooks in folders** (the desktop program, `docs/zim-desktop-shell.md`): a folder notebook is Zim's own layout, read and written by `FolderStore` over
  `window.__zimShell.folders`; the page names a folder only by the id the program gave it, and `desktop/src-tauri/src/folders.rs` (no Tauri in it, `cargo test` in
  `desktop/src-tauri`) is all the program knows of one: paths are checked there, links are not followed, and a change is made entirely or not at all, with a journal. A
  folder is the person's: only what is listed and read as a page or an attachment is written, and removing a notebook only unlists it.
- **Moving a page to another notebook** (E16e, `docs/zim-web-app.md`): what goes with the page, what is in the way and how the links are written for the new names are the notebook rules'
  (`Notebook::plan_move` in `core/zim-notebook`, through wasm: the app holds none of it); `NotebookSession.moveOut` copies first and removes after, so that a failure in between loses nothing. A page
  that leaves an encrypted notebook for one that is not must be ticked for (it stops being encrypted: the question says so), and nothing about a move is kept anywhere the browser keeps things.
- **The follow-up document** (`docs/suivi/suivi.tex` and its PDF): at the end of **every milestone**, in the same commit, change the state and the "reste à faire" of the points it touches, add a line to the journal with the commit ids, update the test counts in
  `docs/suivi/releves.tex`, run `scripts/suivi.sh` and commit the source and the PDF together. A point is *fait* only when tests ran it; what was never tried against the real thing says so in its "reste à faire". Written in French, for the user.
- **Accounts** (`server/`, `docs/zim-server.md`; decided 2026-10-15: Google + GitHub first, a mailed code only at sign-up, on this server): optional;
  a notebook goes to the server, or to a service the person connected (`server/src/connectors/`: WebDAV/Nextcloud, GitHub, GitLab, Dropbox and Google Drive; the server calls it for them, with settings sealed at rest and `safe-fetch.mjs` refusing private addresses: any new connector goes through it, never a bare `fetch`), only if the person chose *Keep this notebook on the server* (an open notebook in clear; an encrypted one only sealed, through `SealedRemote`: `SyncUi.remoteFor` wraps the remote whenever the link says `sealed`, and the browser scenarios scan what the server and the services hold); both-changed is asked about, never overwritten. The web app talks to `/api/` on its own address only (`web/src/account/`), shows account items only when
  `/api/providers` answers, and a native shell shows none. Passwords are scrypt, sessions are `HttpOnly` cookies with only a hash stored, every change needs the `X-Requested-With: zim`
  header and a same-site origin: do not weaken any of it, and a new endpoint gets the same tests. Secrets (OAuth, SMTP) live in `~/.local/state/zim-server`, never in the repo.
- **The desktop program** (`desktop/`) is the same web build in Tauri, not a second UI or branch: `web/dist` goes in as it is, the version is `web/package.json`'s, and what a
  WebView lacks comes through `window.__zimShell` like on a phone. The CI workflow packs it for Linux and Windows on every change of `web/`, `core/` or `desktop/`.
- **The app in a native shell** (`mobile/`, `docs/zim-mobile-shell.md`): the web app depends on no shell package. A shell is recognised by
  `window.Capacitor` and gives what a WebView lacks through `window.__zimShell` (`web/src/app/shell.ts`: a hook for saving a file, the version);
  something a browser does by itself and a WebView does not goes through a hook set by `mobile/shell/shell.ts`, never into the web app's imports.
  In a shell there is no service worker (the code is the app), the page carries the web server's content policy in a `<meta>`, and the manifest has
  no permission it does not use (no `INTERNET` until sync exists) and no backup. Asked 2026-10-13 whether Flutter would be better for the native
  apps: no (the editor would be rewritten), the shell it is.
- **Writing on a phone** (`docs/zim-editor-plan.md`, *Writing on a phone*): the formatting bar runs the commands the keys
  run (no second rule for anything), never takes the focus from the text (a press that did would put the keyboard
  away), and keeps nothing but whether it is wanted (`zim:formatbar`). On a touch screen a tap follows a link only while the
  editor does not have the focus, a page opened by a tap is not given the focus, and the app is as tall as
  `visualViewport` (`web/src/app/viewport.ts`). The notebook menu is long, so it is moved in from the right edge of a narrow screen and scrolls inside
  (`App.fitMenu`; a phone-sized browser test checks that its last line can be reached). The browser tests emulate a phone with touch events and a made-up
  keyboard; no real device has been tried, and the docs say what that leaves open.

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
   (Encrypted notebooks can be kept, sealed page by page and end-to-end, on the account server or a connected service since E16d; the Turtl server itself is not used. An open notebook kept on the server or a service is stored in clear, and the dialog says so.)
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
- Accounts, the Turtlzim SaaS on shared OVH hosting, cloud connectors and encrypted sync (feasibility study in French, roadmap, decisions to take): `docs/zim-cloud-feasibility.md`
- Claude Code docs: https://docs.claude.com/en/docs/claude-code/overview
