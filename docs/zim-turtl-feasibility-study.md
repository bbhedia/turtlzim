# Feasibility Study: Combining Zim Desktop Wiki and Turtl

**Goal of the study:** Decide whether it is feasible to merge the two open-source
projects so that the result is a **multiplatform note app (like Turtl)** that can hold
**both encrypted and plain (non-encrypted) Zim notes**.

---

## 1. Bottom line up front

A literal "merge" of the two codebases is **not realistic**, because they are built on
opposite technologies and opposite philosophies. But the *idea behind* your request is
sound, and there is a realistic path to it.

- **Do not** try to bolt Turtl onto Zim (your Option A). Zim's GTK desktop UI cannot run
  on mobile, so this can never become "multiplatform like Turtl." At best you would get an
  encrypted-at-rest *desktop* Zim, which is easier to achieve with standard tools than with
  Turtl.
- **The promising direction is the second one** (transform Turtl), but in practice it
  becomes a **new application** that *reuses two specific assets*: Zim's **file format** and
  Turtl's **Rust core** (crypto + sync + storage). This is Option C below, and it is the one
  I recommend.
- The single most important design decision: **encryption must be a per-notebook (or
  per-page) property**, because a note cannot be a plain-text file and an encrypted blob at
  the same time. "Open" notebooks stay as real Zim `.txt` files (full Zim compatibility,
  grep, git); "encrypted" notebooks are stored as ciphertext (and lose those properties).

---

## 2. What each project actually is

These facts are taken directly from the current source of each repository.

### Zim Desktop Wiki
- **Language / UI:** Python 3.6+ with GTK 3 (PyGObject). Desktop only.
- **Storage:** Plain-text files in a folder tree. Each page is a human-readable `.txt`
  file using Zim's own wiki markup; pages link to each other by path; attachments sit
  next to the pages. The format is small and documented (the manual ships a
  `Wiki_Syntax` page).
- **Features:** Plugin architecture (task list, equation editor, tray icon, **version
  control**, etc.).
- **Sync / encryption:** **None built in.** Users rely on the filesystem — Syncthing,
  Dropbox, git, or an encrypted volume.
- **Platforms:** Linux (primary), Windows, macOS — all via GTK. **No mobile.**
- **License:** GNU GPL (version 2; needs confirmation whether it is "v2 only" or
  "v2 or later" — this matters, see §7).

### Turtl
Turtl is several repositories, not one program:

| Repo | Role | Tech |
|------|------|------|
| `core-rs` | The real engine. Crypto, sync, storage. Built as a portable shared/static library. | **Rust**, **libsodium** (via `sodiumoxide`), SQLite (`rusqlite`), HTTP (`reqwest`). GPL-3.0. |
| `js` | Older JavaScript core + app logic/UI ("the heart"). | JavaScript |
| `desktop` | Desktop wrapper around the core. | **NW.js** (node-webkit), Node/npm |
| `mobile` | Android app. Embeds the compiled Rust core (`libturtl_core.so`). | Cordova + Android SDK |
| `server` | Sync backend: accounts, encrypted storage, sync, sharing/permissions. | Node ≥ 8 + Postgres ≥ 9.6 |

- **Storage / encryption:** Everything is **end-to-end encrypted on the client** before it
  leaves the device. Notes and boards are serialized and stored as **opaque encrypted
  blobs**; the server only ever sees ciphertext. Keys come from the user's passphrase via a
  per-object keychain.
- **Data model:** Boards (notebooks) and typed notes (text, link, file, password…). It is
  **not** a hierarchical tree of plain-text pages the way Zim is.
- **Platforms:** Desktop (NW.js) + Android. The Rust core is the genuinely cross-platform
  piece (it already supports an Android JNI build and is designed to be embedded on iOS too).
- **Status:** The project is effectively **dormant / unmaintained**, and it is pinned to old
  dependencies (libsodium 1.0.16, NW.js, Node 8, old Rust crates). Reviving it is itself a
  real project.

---

## 3. Why a direct merge does not work

Two fundamental conflicts:

**3.1 Encryption vs. plain text.** Zim's value *is* that notes are transparent plain-text
files. Turtl's value *is* that notes are opaque encrypted blobs. A single note cannot be
both. So "manage both encrypted and non-encrypted Zim notes" is only possible if encryption
is applied **per notebook or per page**, and you accept that an encrypted page is no longer a
readable file on disk (no grep, no plain git diff, no external editor).

**3.2 Desktop GUI vs. multiplatform.** Zim's interface is GTK/Python and cannot run on
phones. There is no realistic path to put the Zim *app* on Android/iOS. Therefore, if
"multiplatform like Turtl" includes mobile, **you cannot reuse Zim's UI** — you can only
reuse its **file format and parsing rules** (which are small and well documented).

Conclusion: the reusable assets are **Zim's format** and **Turtl's Rust core**. Everything
else is either incompatible or would have to be rebuilt.

---

## 4. Evaluating your two proposed options

### Option A — Extend Zim to add encrypted notes "using Turtl"
- **Reuse possible:** Almost none of Turtl is reusable here. Turtl's crypto is tied to its
  keychain, data model, and sync server; you cannot easily extract "just the encryption" and
  attach it to Zim's files.
- **Result:** At best, an encrypted-at-rest **desktop** Zim. It does **not** become
  multiplatform, so it fails your main goal.
- **Cheaper alternative if you only want desktop encryption:** a Zim plugin (Zim already has
  a plugin system) that encrypts a notebook with `age`/`gpg`, or storing the notebook on an
  encrypted volume (`gocryptfs`, VeraCrypt) or with `git-crypt`. None of these need Turtl.
- **Verdict:** Low value, does not meet the multiplatform requirement. **Not recommended.**

### Option B — Transform Turtl to manage Zim notes (encrypted + plain)
- **Reuse possible:** This is the right *architecture* for "multiplatform like Turtl,"
  because Turtl already has the cross-platform skeleton (Rust core + web UI + desktop wrapper
  + Android shell + sync server).
- **What it actually requires:**
  - Reimplement Zim's wiki parser/renderer in the UI language (JavaScript), and possibly in
    Rust for the core.
  - Replace or heavily adapt Turtl's flat board/note model to represent Zim's **hierarchical
    page tree with inter-page links and attachments**.
  - Decide storage semantics (see §5): plain `.txt` for open notebooks vs. encrypted blobs
    for encrypted notebooks.
  - First **revive** Turtl itself (old dependencies, dormant project).
- **Verdict:** Feasible in principle and architecturally correct, but it is **closer to a
  rewrite than a merge**, and it inherits Turtl's abandonment risk. Worth doing only as the
  basis for Option C.

---

## 5. Recommended approach — Option C: a new multiplatform app that reuses both

Stop thinking "merge two programs." Think "build one new app that borrows the best,
already-portable piece from each."

**Reuse from Zim:** the **wiki text format** and notebook/page-tree concept. The format is
small and documented, so it can be reimplemented as a parser in JS (for the UI) and/or Rust
(for the core). This is what gives you compatibility with existing Zim notebooks.

**Reuse from Turtl:** the **Rust `core-rs`** — its libsodium-based end-to-end crypto, its
local SQLite storage, and its sync engine — compiled as a shared/static library and embedded
on every platform (it already builds for Android via JNI and is designed for iOS). Optionally
keep Turtl's Node+Postgres **sync server**.

**Modernize the shell:** Turtl's NW.js desktop wrapper and Cordova Android shell are dated.
A current cross-platform UI layer — **Tauri**, **Flutter**, or **React Native/Electron** —
around the same Rust core gives you desktop + mobile from one codebase.

**The key feature — mixed notebooks:**

| Notebook type | Stored as | You keep | You lose |
|---|---|---|---|
| **Open** (non-encrypted) | Real Zim `.txt` files in a folder | Full Zim compatibility, grep, git, edit in any editor | Confidentiality |
| **Encrypted** | Ciphertext blobs (libsodium), via the Rust core | End-to-end privacy, safe sync to a server | Plain-file access, external editing, plain git diffs |

This is exactly how you satisfy "manage both encrypted and non-encrypted Zim notes" without
the impossible requirement of a note being both at once.

---

## 6. Component-by-component reuse summary

| Need | Best source | Action |
|---|---|---|
| Note/file format | **Zim** | Reimplement parser (JS + optionally Rust). Don't reuse Python code. |
| Page tree, links, attachments | **Zim** concept | New data model on top of Turtl's storage. |
| Encryption | **Turtl `core-rs`** | Reuse directly (libsodium). |
| Local storage | **Turtl `core-rs`** | Reuse (SQLite) for encrypted notebooks; filesystem for open ones. |
| Sync / sharing | **Turtl `server` + core** | Reuse, after modernizing. |
| Mobile support | **Turtl Rust core** | Reuse the embeddable library; build a new mobile UI. |
| Desktop UI | Neither (rebuild) | New cross-platform shell (Tauri/Flutter/Electron). |
| Zim's GTK UI | — | **Not reusable.** |
| Turtl's NW.js / Cordova shells | — | Replace with a modern stack. |

---

## 7. Risks and open questions

- **License compatibility (must verify first).** Turtl `core-rs` is **GPL-3.0**. Zim is
  **GPL v2**. If Zim is "**v2 only**," GPLv2 and GPLv3 code **cannot** be legally combined in
  one binary. If Zim is "**v2 or later**," it can be upgraded to v3 and combined. Since you
  are reimplementing Zim's *format* (an idea, not copyrightable) rather than copying Zim's
  source, this risk is largely avoided — but confirm before copying any Zim code.
- **Turtl is dormant** and pinned to old dependencies. Budget real time just to get it
  building and updated before you add anything.
- **Crypto is unforgiving.** Reusing Turtl's audited-ish, libsodium-based core is far safer
  than inventing your own. Do not write new crypto.
- **Data-model translation** (Zim's tree/links vs. Turtl's board/note blobs) is the largest
  design task and where most effort will go.
- **Scope discipline.** Zim's plugins (tasks, equations, version control) are out of scope
  for v1; treat them as later additions.

---

## 8. Suggested phased roadmap

1. **Proof of concept (small):** Reimplement the Zim wiki parser/renderer in JavaScript and
   confirm you can read/round-trip existing Zim notebooks.
2. **Revive the core:** Get Turtl `core-rs` building on current toolchains; confirm
   encrypt/decrypt and local SQLite storage work.
3. **Bridge the model:** Define how a Zim page tree maps to core objects; implement the
   "open vs. encrypted notebook" split from §5.
4. **One UI, two platforms:** Build a minimal desktop UI (Tauri/Electron) over the core,
   then prove the *same* core runs on Android.
5. **Sync (optional):** Bring up Turtl's server (or a replacement) for encrypted-notebook
   sync and sharing.

---

## 9. Final recommendation

Your instinct is correct that Turtl supplies what Zim lacks (encryption, sync, mobile) and
Zim supplies a clean, open note format. But the right realization is **not** a merge of two
programs and **not** Option A. It is **Option C: a new cross-platform app built on Turtl's
Rust core, using the Zim file format, with encryption chosen per notebook.** That is
ambitious — closer to a focused rewrite than a merge — but it is the only path that actually
delivers a multiplatform app holding both encrypted and plain Zim notes.

If your real priority is just "Zim notes that sync and can be encrypted, on desktop," a far
cheaper path is Zim + Syncthing/git + an encryption plugin or encrypted volume. The full
build only pays off if **mobile** and **built-in end-to-end encryption** are non-negotiable.
