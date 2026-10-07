# Encrypted notebooks (`core/turtl-core-rs`, `web/src/vault`, `web/src/app`)

A notebook in the app is either **open** (plain Zim pages, kept in the browser's IndexedDB) or
**encrypted** (kept as ciphertext by the Turtl core, unlocked with a passphrase). This is the
per-notebook choice of CLAUDE.md, built for the web app; the same core will give the desktop and
mobile shells the same thing. It does not sync yet.

The rest of this document is what it is, how it works, what it protects and what it does not, and how
each claim is checked.

## What a person sees

* **New notebook… › Kind: Encrypted**, or **Import › A new encrypted notebook**. The first time, the
  app asks for a passphrase: at least ten characters, typed twice, with a box to tick that says
  *nobody can recover it for you*. One passphrase protects every encrypted notebook in the browser.
* Encrypted notebooks are in the notebook menu beside the open ones, with an *encrypted* mark, and
  the same editor, links, search, attachments, rename, import and export work in them.
* **Lock** (a button in the top bar, the notebook menu, or automatically after 30 minutes of nobody
  touching the app) leaves the encrypted notebook and ends the engine that holds the keys. After
  that the menu lists no encrypted notebook at all, and offers *Unlock encrypted notebooks…*.
* **I forgot it…** in the unlock dialog is the only way out of a lost passphrase: it erases every
  encrypted notebook of the browser, after saying so.
* Exporting an encrypted notebook says first that the zip is **not** encrypted.
* A browser that won't promise to keep the data says so once (the notebooks are stored all the same).
* Encrypted notebooks need a **secure page** (https, or `localhost`): the file system they live in
  exists only there. On any other address the app still works, and says why when one is asked for.

## How it is built

```
 page (main thread)                        Worker (one, while unlocked)
 ──────────────────                        ─────────────────────────────
 App ── RoutedStore ─┬─ IndexedDbStore     core-worker.ts
                     └─ TurtlStore ──┐        │  libsodium.js (injected)
                         Vault ── CoreClient ──┼─ turtl_core (Rust, wasm)
                          lock/unlock  postMessage │     scrypt, XChaCha20-Poly1305 via libsodium
                                                   │     SQLite (sqlite-wasm-rs) ── OPFS "turtl-core/"
```

| Piece | Where | Does |
|---|---|---|
| The core, `local_only` | `core/turtl-core-rs/src` | accounts on one device (`models/user.rs`: `join_local`, `login_local`), no sync, atomic writes and batches (`storage.rs`, `dumpy`), notes with a private `props` field |
| The engine's host | `web/src/vault/core-boot.ts`, `core-worker.ts` | starts the core in a module Worker the way `wasm_host.rs` prescribes: wasm, libsodium injected, databases in OPFS, config |
| The client | `web/src/vault/core-client.ts` | requests as promises, `CoreError`, events, "the engine was lost" |
| The vault | `web/src/vault/vault.ts` | one account that a passphrase unlocks: `create`, `unlock`, `lock`, `erase`; one tab at a time; says when it is lost |
| The store | `web/src/vault/turtl-store.ts` | a `NotebookStore` over the core (below) |
| The router | `web/src/notebook/routed-store.ts` | open and encrypted notebooks in one list; encrypted ids carry the prefix `vault:` |
| The app | `web/src/app/app.ts` | the dialogs, the Lock button, and the **private mode** that keeps an open encrypted notebook out of every place the browser keeps things |

**One crypto codebase.** Nothing here encrypts anything itself. The core encrypts with libsodium
(as Turtl does); in the browser the host injects libsodium.js (`libsodium-wrappers-sumo`, the real C
source built with Emscripten) into the core, so the browser and native builds are byte-identical by
construction (`docs/wasm-port-plan.md`). The TypeScript here only decides *what* is saved.

### The mapping

| Zim | In the core | Encrypted? |
|---|---|---|
| a notebook | a **space** | its title and colour: yes. Its key is its own. |
| a notebook's settings (home page, creation time) | one note of type `zim-notebook` | yes (in `props`) |
| a page | a note of type `zim-page`: **title = the page's name**, **text = the Zim text** | yes |
| the page's BOM, line endings, modified time | the note's `props` (a private JSON object added to Turtl's `Note`) | yes |
| an attachment | a note of type `zim-file`: title and `file.name` = its path, `file.type` its media type, the bytes its file | yes (the file is encrypted with the note's key) |

Moving an attachment is an edit of its note's title: the bytes stay where they are. A rename of a
page is one **batch**: the pages that move and the links that are rewritten and the files that move
arrive together or not at all.

## The crypto, in one place

* **Key from passphrase.** scrypt (libsodium's `crypto_pwhash_scryptsalsa208sha256`) with
  **N = 2^17, r = 8, p = 1: 128 MiB** of memory and about half a second per guess (measured: a new
  account takes ~0.55 s in the wasm core under Node), eight times the work of a Turtl server
  account (N = 2^14). There is no server to slow guessing down and the data is within reach of
  whoever has the browser's files, so the passphrase's cost is all there is. The cost is stored with
  the account (`LocalAccount.kdf`), so it can be raised later without locking anyone out. The salt
  is made from the account's name, which is random.
  *Checked:* the known-answer test for this cost uses a key made by Python's `hashlib.scrypt`
  (OpenSSL), not libsodium, and runs natively and on wasm32 (`crypto::low::tests`).
* **The passphrase is normalised first** (Unicode NFKC, in `Vault`, `normalizePassphrase`): an
  accent can be typed as one character or as a letter and a combining mark, depending on the
  keyboard and the system, and those are different bytes, so a vault made on one computer would
  not open on another. After NFKC they are the same key. ASCII passphrases are unchanged, and
  nothing is trimmed (a space at the end is part of what was typed). It can never change while
  vaults exist: it is part of how every key is made.
* **What the key protects.** The account's private part (its keypair and settings) is encrypted with
  the key; the key encrypts the **keychain**, which holds one random key per space (notebook); each
  note has a random key of its own, kept in the note, encrypted with its space's key. Titles, texts,
  properties and attachment bytes are encrypted with the note's key (Turtl's scheme, unchanged).
* **Checking the passphrase.** Logging in makes the key and the `auth` string again and compares it
  with the account's; the user record then has to decrypt (`login_local`). A wrong passphrase and a
  missing account are the same answer (`Unauthorized`).
* **Locking.** `lock()` sends `user:logout` (the core drops the profile, search index and keys and
  closes its databases) and then **terminates the Worker**: its whole memory, with every key and
  every decrypted page, is released at once. Nothing secret is held by the page's own thread, except
  the passphrase while it is being typed and sent (see Limits).

## What is stored, and what a thief of the browser's files learns

The core's databases are SQLite files in the origin-private file system (`turtl-core/`). Everything
below was read off `protected_field(public)` in `core/turtl-core-rs/src/models/` and then checked by
scanning the real files.

**Encrypted** (a thief gets ciphertext): the notebooks' titles; every page's name, text and
properties; every attachment's name, media type and bytes; the account's keypair and settings; the
keys of notebooks and notes.

**Not encrypted** (a thief sees it):

| What | Why it is there |
|---|---|
| That the browser has a vault; its account's name (random 128 bits, no meaning), a random client id | the key-value store; the name is how the account is found |
| The scrypt cost and the `auth` string | the `auth` is an encryption of a hash of the passphrase under the key: it lets someone *test* a passphrase guess, but so does trying to decrypt the user record, so a guess costs the same either way |
| How many notebooks there are, how many notes each holds, which note is in which notebook | `space_id` is a public field of a note |
| When each notebook and note was created, to the millisecond | the first 12 hex digits of every id are the time |
| When each note was last saved, to the second | the public `mod` field |
| About how long every title and text is (the length of its ciphertext), and which notes are attachments, and the **size** of each attachment | ciphertext lengths; an attachment's note has a public `file` with its `size` |
| That an item is a page, a notebook's settings or an attachment | *not* visible by type (the type is encrypted); an attachment is told apart by having a `file` |

None of it says what is in them. If the number of pages or the moment you last wrote matters to you,
it is visible.

Deleted notes' ciphertext may stay in the database's free pages until overwritten (only ciphertext was
ever written, so there is no plaintext to wipe).

## What it protects against, and what it does not

**Protects:** someone who gets the browser profile's stored data while the vault is locked or the
browser is closed (a stolen or copied disk, a backup of the profile, another person's account on the
computer): they have ciphertext, and a passphrase to guess at 128 MiB and about half a second a try.
How long that takes is the passphrase's business: a few unrelated words (five random words is about
64 bits) is out of reach; a short or common one is not. The app refuses fewer than ten characters,
one character repeated, and a short list of the first passphrases a stranger would try.

**Does not protect:**

* **Anything running in the page or on the machine while the vault is unlocked**: malware, a
  malicious browser extension, a compromised page. The keys and plaintext are in the Worker's
  memory and the pages in the editor. Lock when you step away (it also locks itself after 30 minutes).
* **A web server that serves different code** (CLAUDE.md, Open issue 6, "host-proof hosting"). The
  app's code is fetched from wherever it is hosted; a server that wanted to could send code that
  reads the passphrase. The installed app (a pinned service worker, subresource integrity) and the
  packaged desktop build are the mitigations; this build has neither yet. Serve it yourself, or
  use it from a copy you trust.
* **A weak passphrase**, **a lost passphrase** (nothing recovers the data), **a copy you exported**
  (the zip is plain), **the browser deciding to delete the data** when the disk is full (it was asked
  not to: `navigator.storage.persist()`, and the app says if it would not promise).
* **The metadata above**, and **what the browser does outside the app**: the password manager may
  offer to remember the passphrase (that is the person's choice to make), the clipboard, screenshots.

## The page keeps quiet about an encrypted notebook

The editor used to put things where the browser keeps them: the page's name in the address
(`#/Projects%3AGarden`) and in the tab's title (the browser's history and session restore keep
both), unsaved typing in `localStorage` (a draft for the next start), and which sections are folded
(page names). While an encrypted notebook is open the app (`app.ts`, `isPrivate`) does none of it:

| Channel | In an open notebook | In an encrypted one |
|---|---|---|
| Address | `#/Page%20Name` | `#/` always; Back/Forward work through a number in `history.state`, and the names stay in memory |
| Tab title | `Page — Notebook` | `Encrypted notebook` |
| Typing on its way to the store | also a draft in `localStorage` | none (saved after 250 ms instead of 700; abruptly closing the tab can lose up to that much) |
| Folded sections | remembered by name | not remembered |
| Browser translation | offered | `translate=no` on the document (the editor itself is never offered: CodeMirror marks it so) |
| Last notebook to reopen | its id | its id, in a separate key, used only to go back to it after an unlock |

The ids kept are the notebooks' random ids, which are visible in the databases anyway.

## Writes are atomic, and so is a crash

* **Per object.** `dumpy` wrote an object and its index rows as separate autocommitted statements,
  so a failure or a crash between them left an object without its indexes (and each write paid for
  several commits). Every write and delete now runs in a savepoint: one commit, whole or not at all,
  nested inside a transaction the caller has open. (This changes server-mode behaviour only by being
  safer.)
* **Per change.** A core without a server can group changes: `profile:batch:begin`, `commit`,
  `rollback`. What is saved between begin and commit is one change. Closing the database, logging
  out or dying before the commit undoes it, and a **rollback also rebuilds what the core holds in
  memory** (profile, search index) from the database. A core with a server refuses to batch (a sync
  could send what a rollback then takes back). `TurtlStore` runs every change as one batch, which is
  also what makes importing a notebook of thousands of pages a single commit (2,000 pages in ~7 s in
  Chromium; opening them takes half a second).
* **Evidence.** A browser test writes 600 pages and ends the Worker 150 ms in, as a closing tab
  would: after a reload and an unlock the notebook is exactly as it was and still usable. The same
  test with batching turned off leaves five of the pages behind, so the test can fail.
  Unit tests: a change that fails halfway (the core refusing the fourth write of a rename) changes
  nothing and is retried as if it had never been tried; a failed undo makes the store refuse to be
  trusted until the vault is locked and unlocked.

## Limits and known issues

* **Secure page, one tab.** OPFS's fast files exist only in a dedicated Worker on a secure page
  (https or localhost), and one Worker at a time can use a directory: a second tab is told the vault
  is in use. (`http://192.168.10.10:8080` is not secure: use an SSH tunnel, `ssh -L
  8080:127.0.0.1:8080 you@server`, and open `http://localhost:8080`; or serve over https with
  `scripts/serve.sh start --host :: --port 8443 --tls`, which makes a self-signed certificate: the
  browser warns once and then the page is secure. A test creates an encrypted notebook that way.)
* **Unlocking costs the whole vault.** `local_start` decrypts and indexes *every* note of *every*
  encrypted notebook when the vault is unlocked: 2.1 s for 2,700 notes (1.4 s of it is the key). A
  vault of tens of thousands of notes will be slow to open. The fix is to index lazily (list a
  notebook from the database's own indexes and decrypt only that notebook's notes); not done.
* **No passphrase change**, no recovery, no second device: sync with the Turtl server is the next
  step and needs the server revived (CLAUDE.md, Open issues 3 and 5).
* **Attachments are at most 50 MB** each in an encrypted notebook: a file goes through the engine
  whole, as base64 text (several copies of it exist for a moment). Larger files are refused up
  front, with the reason, and nothing is changed.
* **Memory.** The key derivation needs 128 MiB of wasm memory in the Worker. Desktop browsers have it;
  a phone's browser may not (untested). The mobile shell is planned to use the native core.
* **The passphrase** is a string in the page's memory while it is typed and until the dialog is
  garbage collected; a JavaScript string can't be wiped.
* **Unlock time and the engine's start-up** (~1.5 s for the key and the engine, more with a big
  vault) is a spinner in the dialog ("Unlocking…").
* **A Worker that dies without a word** (killed by the browser for memory) can't be seen: the app
  learns of an engine's death only when the Worker reports an error. Requests then wait until the
  page is reloaded. (An engine that fails loudly locks the vault and says so; that is tested.)
* **Natively** (a future desktop build of the same core), a note's attachment is a file beside the
  database, which a rolled-back batch does not remove: it is left behind as an orphan (still
  ciphertext). Not an issue in the browser, where attachments are rows of the database.

## What verifies what

| Claim | Checked by |
|---|---|
| A local account is made, refused for a wrong passphrase or a taken name, survives restarts, queues nothing and asks no server for anything; **no name, text, file name or file byte of a notebook is in any file the core writes**, and the files hold the ids (positive control) | `core/turtl-core-rs/src/flow_tests.rs`: `local_only_flow`, `local_only_on_disk_flow` (the second reads every file of a real on-disk run), natively; `local_only_flow` on wasm32 too. With mutation checks (an account made at the server's cost, a login ignoring the stored cost, queuing for sync restored, etc. all fail the tests) |
| The key derivation is what is claimed | `crypto::low::tests::can_generate_keys_at_the_local_cost` (key from Python's scrypt), native and wasm |
| Writes are atomic; batches commit or roll back whole, memory included | dumpy tests (`a_failed_store_leaves_nothing_behind`, `writes_join_the_transaction_that_is_open`), `storage::tests::batches_are_whole_or_nothing`, `flow_tests::local_batches`; native and wasm |
| The engine runs in a Worker, data survives reloads, one tab at a time, an insecure page is refused, a cut-off write leaves the notebook as it was, and nothing is readable in the browser's files | `web/test/vault-browser.mjs` (`npm run test:vault`), real Chromium, served under the app's CSP |
| The store keeps the notebook-store contract, with files, moves, atomicity under failure; the vault's states and its client | `web/test/store.test.ts` (the same contract as the other stores), `turtl-store.test.ts`, `vault.test.ts` |
| In the interface: made, written in, locked, unlocked; Back/Forward and the address say nothing; no draft; export warns; import and rename and delete; a lost passphrase is erased; a short passphrase is refused; an insecure page says so; auto-lock; **IndexedDB, localStorage, sessionStorage, the Cache API and every OPFS file hold none of a notebook's name, page names, text, tags, attachment name, type or bytes**, nor the passphrase | `web/test/browser.mjs`, the scenarios after "an encrypted notebook is made…" |

The tests that can fail were checked to: each was run with the thing it tests broken (see the commit
messages), and the ones that did not notice were tightened.

## Not done

* Changing the passphrase (the core refuses `user:change-password` without a server; it re-encrypts
  the keychain with a new key and is doable offline).
* Sync of encrypted notebooks to the Turtl server (the data model is Turtl's own, so the server
  would store ciphertext only; it needs the server revived and a decision about accounts: CLAUDE.md,
  Open issue 5).
* Lazy indexing (above), per-notebook passphrases (today one vault, one passphrase), a setting for
  the auto-lock time, a service worker with pinned code (Open issue 6).
