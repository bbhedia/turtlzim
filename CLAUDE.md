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

Working default for the one open UI decision (see Open issues #1): **shared web UI** — build
the Zim editor once (CodeMirror 6) and reuse it in Tauri (desktop), a Capacitor/webview shell
(mobile), and the browser (web).

---

## Stack

| Piece | Choice |
|---|---|
| Shared core | Rust (`core-rs`), libsodium, storage abstraction |
| Web crypto/storage/net | libsodium-wasm, IndexedDB, `fetch` (the WASM port swaps out native libsodium / SQLite / blocking reqwest) |
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

# Web app
npm run dev                         # web client dev server
npm run build                       # web client production build

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
- Zim `.txt` round-trips must be byte-identical (write a golden-file test against real Zim
  notebooks early).
- Never copy Zim source into this repo; reimplement the format from its documented syntax.

---

## Open issues / risks

1. **OPEN DECISION — shared web UI vs. native UIs.** Brief assumes shared web UI. Native UIs
   per platform ~triple the editor work and change the mobile/desktop stack. Confirm before
   building the editor.
2. **WASM port of `core-rs`** is the central effort: replace native libsodium → libsodium-wasm,
   SQLite (`rusqlite`) → IndexedDB, blocking `reqwest` → `fetch`. Prove ciphertext parity
   between native and WASM.
3. **Turtl is dormant / old deps** (libsodium 1.0.16, old crates, Node 8 server). Budget time
   just to get everything building on current toolchains before adding features.
4. **iOS FFI build does not exist yet** in upstream (only Android JNI). Needs to be created.
5. **Open-notebook sync privacy:** decide policy — local-only, sync-with-disclosure, or
   server-side key (at-rest, not end-to-end). Encrypted notebooks are always end-to-end.
6. **Web-crypto trust model:** a served web app could ship malicious JS ("host-proof hosting"
   critique). Mitigate with an installed PWA (pinned service worker + SRI); the packaged
   desktop build is the strongest guarantee. Document the trade-off for users.
7. **Zim editor fidelity:** live inline formatting, `[[internal links]]`, checkboxes,
   attachments, verbatim blocks — the largest UI task.
8. **License check:** confirm Zim's exact license only matters if any Zim source is ever
   copied (it should not be).

---

## References

- Architecture + roadmap: `zim-turtl-architecture-and-plan.md`
- Feasibility rationale: `zim-turtl-feasibility-study.md`
- Claude Code docs: https://docs.claude.com/en/docs/claude-code/overview
