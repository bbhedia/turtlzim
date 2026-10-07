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
* **Lock** (a button in the top bar, the notebook menu, automatically after 30 minutes of nobody
  touching the app, or when a page that the browser kept comes back to the screen) ends the engine
  that holds the keys first, and then shows a notebook that is not encrypted instead (one is made if
  there is none). A question that was open is closed. What was typed is saved first, for a few seconds
  at most: if it can't be, pressing Lock asks whether to lose it, and a lock that nobody asked for goes
  ahead and says what it cost. After that the menu lists no encrypted notebook at all, and offers
  *Unlock encrypted notebooks…*.
* **I forgot it…** in the unlock dialog is the only way out of a lost passphrase: it erases every
  encrypted notebook of the browser, after saying so.
* Exporting an encrypted notebook says first that the zip is **not** encrypted; downloading a page
  or an attachment says, in the status line, that the copy is not.
* A browser that won't promise to keep the data says so once, when the browser has answered (which
  can be after it asked the person); the notebooks are stored all the same.
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
| The client | `web/src/vault/core-client.ts` | requests as promises, `CoreError`, events, text made fit for the engine's parser (half of a character can't be sent), and the watchdog: "the engine was lost" when it dies loudly, or has been waited for and has said nothing for 45 s |
| The Worker's network cut-off | `web/src/vault/cut-off.ts` | after boot, `fetch`, `XMLHttpRequest`, `WebSocket` and the other ways a Worker has of reaching out refuse, for good |
| The vault | `web/src/vault/vault.ts` | one account that a passphrase unlocks: `create`, `unlock`, `lock`, `erase`; one tab at a time; says when it is lost; locking never waits for an unlock that is under way (it ends that engine) |
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
  the account (`LocalAccount.kdf`) and a login uses what is stored, so accounts can be made at a
  higher cost later without locking anyone out; moving an existing account to a new cost needs a
  re-key, which is not built. A stored cost that no device could pay (more than 1 GiB of memory or
  2^25 operations) is refused without trying, so a damaged or planted record can't make a login run
  for ever. The salt is made from the account's name, which is random.
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
  every decrypted page, is released at once. If the engine does not answer within five seconds it is
  terminated all the same, and a lock does not wait for an unlock that is under way: that engine is
  ended and the unlock fails. The keys go before the screen is switched to another notebook (the app
  is hidden meanwhile). The page's own
  thread held the decrypted pages while the notebook was open (the editor, the notebook model, the
  strings of the pages) and lets go of them at the lock: the model is freed, the editor's state
  replaced, the store's index of page names forgotten, and what is left is for the garbage collector,
  which is not a wipe (a JavaScript string can't be wiped). The passphrase is the one secret the page
  holds in the same way (see Limits).

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
  reads the passphrase. The installed app (`docs/zim-pwa.md`) is a mitigation: it checks every file
  against a list, runs the version that was approved and offers a new one, and `scripts/pwa.mjs
  --remote` shows what a server serves. It is not a proof: the worker script comes from the host
  too, and a changed one is installed by the browser by itself. The packaged desktop build, whose
  code does not come from a server, is the strongest answer, and is not built yet. Serve it
  yourself, or use it from a copy you trust.
* **Someone who can write the files, not only read them**: they can delete the vault, put an older
  copy of it back, or put one note's ciphertext in place of another's in the same notebook. The core
  notices what it can't decrypt, but nothing here authenticates the database as a whole: this is
  confidentiality, not integrity.
* **A script on the page**, as far as the app can help it: nothing offers one a handle on the app
  (`window.__zim` is there only for the tests, which ask for it before the page loads), but a script
  that runs in the page can read what the page shows.
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
| Status line, notices, search results | whatever was said | cleared when the notebooks lock (a failed save names a page, a search box holds what was typed) |
| Questions (dialogs) | stay until answered | closed when the notebooks lock; each one acts only on the notebook it was opened on |
| Copies saved to the computer (a page, an attachment, an export) | a file | a plain file: the app says so, and an export asks first |
| A page the browser keeps and shows again (Back) | as it was | hidden when it is put away, and the notebooks lock when it is shown |

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
* **Evidence.** A browser test writes 1,200 pages and ends the Worker at five different moments
  (5, 60, 250, 800 and 2,500 ms in), as a closing tab would: after a reload and an unlock the
  notebook has every page of the write or none of them, is still usable, and is listed once (the
  four earliest moments are checked to really cut the write off: it takes seconds). The same test
  with batching turned off leaves pages behind at the four moments that fall late enough for any to
  have been written (2, 9, 26 and 81 of them in the run that was measured; the number depends on the
  machine), so the test can fail.
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
* **Big imports get slower per page as they grow.** Measured in Chromium (one batch of notes of about
  1 KB each): 500 take 1.8 s, 1,000 take 3.1 s, 2,000 take 6.5 s and 4,000 take 14.6 s; the cost of
  one write rose from 2.7 ms to 4.2 ms across the 4,000, and the commit at the end is linear (about
  a third of a millisecond a note). Nothing larger was measured.
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
* **A Worker that dies without a word** (killed by the browser for memory) says nothing, so it is
  noticed by its silence: it says it is alive every five seconds, and an engine that has a request
  waiting and has said nothing for 45 seconds is taken to be dead, ended, and the vault is locked with
  a message. A request can wait that long for such a death to be noticed. (An engine that fails loudly
  locks the vault at once. Both are tested.)
* **Natively** (a future desktop build of the same core), a note's attachment is a file beside the
  database. A file that a batch deletes is removed when the batch commits, not before, so a rollback
  keeps it; a file that a rolled-back batch added is left behind as an orphan (still ciphertext). Not
  an issue in the browser, where attachments are rows of the database.

## What verifies what

| Claim | Checked by |
|---|---|
| A local account is made, refused for a wrong passphrase or a taken name, survives restarts, queues nothing and asks no server for anything; **no name, text, file name or file byte of a notebook is in any file the core writes**, and the files hold the ids (positive control) | `core/turtl-core-rs/src/flow_tests.rs`: `local_only_flow`, `local_only_on_disk_flow` (the second reads every file of a real on-disk run), natively; `local_only_flow` on wasm32 too. With mutation checks (an account made at the server's cost, a login ignoring the stored cost, queuing for sync restored, etc. all fail the tests) |
| The core in this mode can't be made to reach a server: every command of the dispatcher but the short list in `dispatch::LOCAL_COMMANDS` is refused (the list of commands is read from the dispatcher's own source, so a new one is refused until it is added on purpose), the API refuses to build a request, a host can't send it events, messages it can't read are answered, the page is not handed the private key | `local_only_flow`, `unreadable_messages_flow`, and the `::ev` assertion in the wasm `host_api` test |
| A stored account that asks for more than a device can do is refused without trying; a user record that the key does not open is not left logged in; a notebook of 33,000 notes is read; attachments follow their notes (deleted when the batch commits, for any user) | `local_account_tampered_flow`, dumpy's chunked-read test, `local_files_follow_their_notes_flow`, `local_files_in_batches_flow` |
| The key derivation is what is claimed | `crypto::low::tests::can_generate_keys_at_the_local_cost` (key from Python's scrypt), native and wasm |
| Writes are atomic; batches commit or roll back whole, memory included | dumpy tests (`a_failed_store_leaves_nothing_behind`, `writes_join_the_transaction_that_is_open`), `storage::tests::batches_are_whole_or_nothing`, `flow_tests::local_batches`; native and wasm |
| The engine runs in a Worker, data survives reloads, one tab at a time, an insecure page is refused, a write cut off at five different moments leaves the notebook whole or as it was, nothing is readable in the browser's files, a Worker that was cut off from the network can't use it or get it back (a probe in a real Worker, with a control that shows it could before), and the engine asks the network for nothing but its own files (the browser's own request log) | `web/test/vault-browser.mjs` (`npm run test:vault`), real Chromium, served under the app's CSP |
| The store keeps the notebook-store contract, with files, moves, atomicity under failure; the vault's states and its client; an engine that goes silent is declared dead and one that keeps saying it is alive is not; a lock does not wait for an unlock and is not undone by one that finishes just after; the store forgets at a lock; text the engine could not read is never sent | `web/test/store.test.ts` (the same contract as the other stores), `turtl-store.test.ts`, `routed-store.test.ts`, `vault.test.ts`, `engine-failures.test.ts`, `cut-off.test.ts` |
| In the interface: made, written in, locked, unlocked; Back/Forward and the address say nothing; no draft; export warns; import and rename and delete; a lost passphrase is erased; a short passphrase is refused; an insecure page says so; auto-lock; **IndexedDB, localStorage, sessionStorage, the Cache API and every OPFS file hold none of a notebook's name, page names, text (accented, Chinese and emoji too: looked for as UTF-8 and as UTF-16, with a control file that shows the scan finds UTF-8), tags, attachment name, type or bytes, nor what was typed in the search box or a dialog that was given up**, nor the passphrase | `web/test/browser.mjs`, the scenarios after "an encrypted notebook is made…" |
| A question that was asked on one notebook can't change another; a lock closes questions and leaves the notebook shown instead untouched, and Back does not lead into the locked one; a lock asks before it loses typing and an idle one says what it lost, and none of that is anywhere the browser keeps things; a page the browser kept is hidden and then locks; a lock that can't switch the screen starts the page again; a dead engine locks the vault with a message and leaves nothing on the screen; a list of notebooks that can't be got is said so; Escape does not give up an unlock; a late answer from the browser about keeping the data is waited for; a plain copy is said to be plain; a page nobody asked to test has no `window.__zim` | `web/test/browser.mjs`, the scenarios under "What the review of the encrypted notebooks found" |

The tests that can fail were checked to: each was run with the thing it tests broken (see the commit
messages), and the ones that did not notice were tightened.

## What the review found

When the work was done, a reviewer with no part in building it went through the core, the web host,
the app and these claims, looking for ways they fail. They found real problems in every layer. Each
was fixed and given a test that fails without the fix (the mutation checks that showed it are in the
commit messages). The ones that mattered most:

| Found | What was done |
|---|---|
| The core in local mode could still be made to talk to a server: its API was only unused, the dispatcher answered every command (feedback, sync, ...), and a host could send it events | The API refuses to build a request in local mode. The dispatcher answers a short list of commands and refuses the rest; the test reads the dispatcher's own list, so a new command is refused until it is added on purpose. Events from a host are refused. The page is not handed the account's private key |
| Locking depended on the screen: a save that never finished, a store that failed to list notebooks, or a question that was open (and was then answered about whatever notebook was shown) could keep the keys in memory or act on the wrong notebook | The keys go first (the engine is ended), then the screen. Waiting for a save is bounded, a lock does not wait for an unlock, questions are closed at a lock and each acts only on the notebook it was asked on, and if the screen can't be switched the page starts again instead of going on showing the notebook |
| A page that the browser kept and showed again was unlocked, with the notebook on the screen | Hidden when it is put away, locked when it comes back |
| Locking over typing that could not be saved lost it without a word | A lock that is asked for asks first; one that nobody asked for says what it cost |
| An engine killed without a word was waited on for ever; so was a request with half of a character in it (JSON can't carry one, and the core's parser refused it unanswered) | A heartbeat and a watchdog (45 s of silence with a request waiting); text is made fit before it is sent |
| The engine's Worker had `fetch` and the other ways out | They are taken away after boot, for good. This is a second lock, not a sandbox: only a policy stops a script being imported, and the app's own headers send one (`connect-src 'self'`) |
| The page offered a handle on the whole app on `window` | Only a test, which asks before the page loads, gets one |
| Page names lingered after a lock: in the store's index, in the status line (a failed save names a page), in a notice, in the search results, in the history's numbers | All are let go at a lock |
| A read of more than 32,766 notes failed (SQLite's limit on the values of one statement); the attachments of a deleted note were removed only for some users; a stored account could ask for a cost that would hang a login | Reads in chunks (tested with 33,000); files follow their notes for every user, and go when the batch that deleted them commits; a cost beyond what a device can pay is refused |
| The passphrase was counted before it was normalised: ten fullwidth digits passed for a ten-character passphrase, and were `1234567890` as a key | Counted as it becomes a key |
| Some claims here were stronger than the code ("nothing secret is held by the page's own thread", "a Worker that dies without a word can't be seen", a cost that "can be raised later without locking anyone out", what a rolled-back batch does to files, what the crash test showed) | Corrected in this document |

What the review also said that is **not fixed**, and is in Limits or below: unlocking decrypts and
indexes everything; someone who can write the files can roll them back or swap ciphertexts; an
existing account can't be moved to a new cost; the account record's own `id` is not authenticated;
a browser that asks the person about keeping the data gets its answer waited for, however long that
takes.

## Not done

* Changing the passphrase (the core refuses `user:change-password` without a server; it re-encrypts
  the keychain with a new key and is doable offline).
* Sync of encrypted notebooks to the Turtl server (the data model is Turtl's own, so the server
  would store ciphertext only; it needs the server revived and a decision about accounts: CLAUDE.md,
  Open issue 5).
* Lazy indexing (above), per-notebook passphrases (today one vault, one passphrase), a setting for
  the auto-lock time.
* Moving an existing account to a new scrypt cost (a re-key), and authenticating the account record
  (its `id` and `kdf` are checked only by a login that must then decrypt the user record).
