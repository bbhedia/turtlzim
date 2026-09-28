# Target Architecture & Build Plan (revised)

Written to your **firm constraints**:

- **Three separate client apps**: a **desktop app**, a **web app**, and a **mobile app**
- **Both encrypted and non-encrypted notes**
- **Zim wiki format**, edited like in the Zim desktop editor

> This revision replaces the earlier "web-first single codebase" version. Because you want
> three real clients (not one web app that doubles as mobile), the right design is a **shared
> core** embedded three ways — which is exactly what Turtl's Rust `core-rs` was built for.

---

## 1. The decision the constraints force

Three separate apps must not each re-implement crypto, sync, the Zim format, and storage —
that is three chances to get encryption wrong. So put all of that in **one shared core** and
embed it per platform. This is precisely Turtl's design philosophy ("if it *can* go in the
core, it *should*"), so **Turtl's `core-rs` is the asset you build on**, not discard.

| App | How it uses the core | UI |
|---|---|---|
| Desktop (Win/macOS/Linux) | Native library, linked directly (Tauri is Rust, so the core is just a crate). | Webview UI inside Tauri (or native). |
| Mobile (iOS/Android) | Native library via FFI/JNI — **Turtl already did the Android JNI build**. | Webview/Capacitor shell (or native). |
| Web | Same core **compiled to WebAssembly**, running in the browser so crypto stays client-side. | The browser itself. |

Keep **one** crypto implementation. Do not reimplement the core in JavaScript "just for the
web" — two implementations that must produce byte-identical ciphertext is where encrypted
apps break.

---

## 2. The one hard part: the web / WASM port

Turtl's `core-rs` today uses **native libsodium**, **native SQLite (`rusqlite`)**, and
**blocking `reqwest`** — none of which run in a browser. Porting the core to WASM means
swapping those for browser-compatible equivalents:

| Core dependency today | Browser/WASM replacement |
|---|---|
| native libsodium (`sodiumoxide`) | `libsodium` compiled to WASM (same primitives) |
| SQLite (`rusqlite`) | IndexedDB |
| blocking `reqwest` | `fetch` (async) |

This is the central effort and risk of the whole project. The payoff is that the *same*
audited logic and ciphertext format run on all three platforms.

(The alternative — a JS reimplementation for web only — is faster short-term but leaves you
maintaining two crypto stacks that must interoperate exactly. Not recommended for an
encryption app.)

---

## 3. The main cost lever: shared UI vs. native UIs

The Zim editor is the largest UI piece. You choose once:

- **Shared web UI (recommended):** one Zim editor built for the web (e.g. CodeMirror 6 with
  live Zim-syntax formatting), reused inside Tauri's webview (desktop), a webview/Capacitor
  shell (mobile), and the browser (web). The editor is written **once**.
- **Native UIs per platform:** a more "native" feel, but the Zim editor must be rebuilt for
  each platform — roughly triple the UI work.

For "edited like the Zim desktop editor," a CodeMirror-6 editor with live inline formatting
(headings, bold/italic/strike, bullet & checkbox lists, `[[internal links]]` to subpages,
images/attachments, verbatim blocks) reproduces the feel well and serializes back to exact
Zim `.txt`.

---

## 4. Encrypted vs. non-encrypted, per platform

Encryption is a **per-notebook** property — the only way to have both kinds, since a note
cannot be a readable file and an encrypted blob at once.

| Notebook | Bytes | Desktop | Web / mobile |
|---|---|---|---|
| **Open** (non-encrypted) | Plain Zim text | **Real folder of `.txt` files** — full Zim compatibility, grep, git, external editors; can open an existing Zim notebook. | No real filesystem → stored as plaintext records in IndexedDB / via sync. |
| **Encrypted** | libsodium ciphertext | Ciphertext in local store + sync server. Never plaintext at rest. | Same. |

So "Zim `.txt` files like the desktop editor" is delivered **fully on desktop**; on web/mobile
the same notebook is reached through sync, not as files on the device.

---

## 5. Sync server

Reuse / adapt **Turtl's server** (Node + Postgres): accounts, encrypted-blob storage, sync,
and later sharing/permissions. For encrypted notebooks the server only ever sees ciphertext
(true end-to-end). Decide how **open** notebooks sync: keep them local-only, or sync with a
clear disclosure that the server can read them, or protect them server-side with a server-held
key (at-rest protection, **not** end-to-end).

---

## 6. What gets reused

| From Zim | From Turtl | New |
|---|---|---|
| Wiki **file format** (reimplemented in the core) | **`core-rs`** as the shared core (crypto, sync, storage) | WASM build target for the core |
| Page-tree + `[[link]]` concept | Android **JNI** embedding (already exists) | Zim web editor (CodeMirror 6) |
| (No Zim source copied) | **Sync server** (Node + Postgres) | Desktop (Tauri) + mobile (Capacitor) shells |

Licensing: you now embed Turtl `core-rs`, which is **GPL-3.0**, so the product is GPLv3. Since
the Zim *format* is reimplemented (an idea, not copied GPLv2 code), the earlier GPLv2-vs-GPLv3
clash does not arise. Reusing Turtl's server (GPLv3) as a separate process is also clean.
Confirm Zim's license only matters if you ever copy Zim's actual source.

---

## 7. Build roadmap

1. **Revive the core.** Get `core-rs` building on a current Rust toolchain; confirm
   encrypt/decrypt, local storage, and server sync still work natively.
2. **Add the Zim format to the core.** Parser + serializer; round-trip real existing Zim
   notebooks to byte-identical `.txt`.
3. **WASM target.** Port the core to WebAssembly (libsodium-wasm, IndexedDB, `fetch`).
   Prove identical ciphertext between the native and WASM builds.
4. **Web app + editor.** CodeMirror-6 Zim editor over the WASM core; create/open/edit
   notebooks; per-notebook encrypted vs. open toggle. This is your web client.
5. **Desktop app.** Wrap the same UI in Tauri over the native core; add filesystem access so
   open notebooks are real Zim `.txt` folders.
6. **Mobile app.** Wrap the same UI in a Capacitor/webview shell over the native core
   (reuse Turtl's Android JNI; add an iOS FFI build).
7. **Sync + sharing.** Bring the (adapted) Turtl server fully online.

Biggest effort: steps 2–4 (Zim editor + WASM port). Highest risk: step 3 (crypto interop —
reuse libsodium, never roll your own).

---

## 8. Summary

Three separate apps point to **one shared core embedded three ways** — native in desktop and
mobile, WebAssembly in the web app — which is the architecture Turtl's `core-rs` already
targets. You reuse Turtl's core, Android embedding, and sync server, plus the Zim file format,
and build a single Zim web editor reused across all three shells. The work and risk concentrate
in two places: the **WASM port of the core** and the **Zim-style editor**. Encryption is
per-notebook, so open notebooks remain real Zim `.txt` files on desktop while encrypted
notebooks are libsodium ciphertext everywhere.
