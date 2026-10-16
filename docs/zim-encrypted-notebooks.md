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
* **Change the passphrase…** (notebook menu, while unlocked) asks for the current passphrase and a new
  one, typed twice, with the same box to tick as when it was chosen. It takes a couple of seconds and
  the notebooks stay unlocked. If the page is closed in the middle, the next unlock settles it and
  says how: the passphrase typed is the one the vault has (see *Changing the passphrase*).
* **Back up the encrypted notebooks…** (unlocked) saves one file, `encrypted-notebooks-<date>.zimvault`,
  with everything in them, still encrypted. **Restore encrypted notebooks from a backup…** (the notebook
  menu of a browser that has none) puts it back, locked, and asks for its passphrase (see *Backup and
  restore*).
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
| The vault | `web/src/vault/vault.ts` | one account that a passphrase unlocks: `create`, `unlock`, `lock`, `erase`, `changePassphrase`, `exportBackup`, `restoreBackup`; one tab at a time; says when it is lost, and when unlocking settled a change that had been stopped; locking never waits for an unlock that is under way (it ends that engine) |
| The backup | `core/turtl-core-rs/src/vault_backup.rs` | the backup file's format, how one is made from the vault and checked and put back; the commands that hand it to the host in pieces (`vault:backup:*`, `vault:restore:*`) |
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
  higher cost later without locking anyone out; an account made at another cost is moved to the
  current one when its passphrase is changed. A stored cost that no device could pay (more than 1 GiB of memory or
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

## Changing the passphrase

What the passphrase makes is the user's key. The keys of the notebooks are sealed with it (the
keychain), and so is the private part of the user's own record. Changing the passphrase makes a new key
from the new passphrase and seals those again with it. **The notebooks' own keys, and so the notes and
files themselves, do not change**, which is why it costs two key derivations (about 1.3 s in Chromium)
and nothing more, however much the vault holds.

What that does and does not do:

* After it, the old passphrase opens nothing that is kept: the keychain's rows, the user's record and
  the account's `auth` are sealed with the new key, and the old ones are written over (below). A person
  who learns the old passphrase later, and gets the files, has to guess the new one.
* It can't take back what was copied before: **a copy of the files, or a backup, made before the change
  still opens with the old passphrase**, and with it the notebooks' keys, which did not change. That is
  the price of not re-encrypting everything; replacing the notebooks' keys (a re-encryption of every note
  and file) is not built.
* It asks for the current passphrase first, as a person who walked up to an unlocked computer should
  not be able to change it.

**The two places that hold what the key seals are separate files**: the account's record (in the
key-value store) and the keychain (in the user's database). No single write can change both, so it
goes in steps that a crash can stop between (`User::change_local_passphrase`):

1. the new key, auth and user record are worked out (nothing is written);
2. they are written into the account's record next to what is there (`pending`), together with each of
   the two keys sealed with the other: **from now on either passphrase opens the vault**;
3. the keys in the user's database are sealed with the new key, in one transaction (all of them or none);
4. the new auth and user record become the account's, and `pending` goes.

An unlock settles whatever is left (`User::settle_local_change`, before anything is read): a new
passphrase finishes the change, an old one undoes it, from any of the states a crash can leave
(nothing sealed yet, all of it, or, should it ever happen, some), and the passphrase that was typed is
the one the vault has afterwards. The host is told which (`user:passphrase:settled`) and the app says
so. A change can't be begun while one is unfinished. If a damaged `pending` can't give the key that the
passphrase typed needs, nothing is written and the person is told to try the other one.

**What is written over.** SQLite leaves a deleted or replaced row in its page until something is
written over it, and a change of passphrase replaces exactly what must be gone: the record (made bigger
by `pending` and smaller again, so that it does not go back where it was) and the keys. A real Chromium
run, reading every byte of the browser's file system and trying every sealed thing in it with the old
key, found **two sealed things still there after a change: the old user record and the old `auth`**.
Every database of the core now runs with `PRAGMA secure_delete = ON`, which writes deleted and replaced
content over with zeros, and the same scan finds none. (This also means a deleted page's ciphertext is
zeros after the delete, where the section below used to say it might linger. What the browser or the
operating system does with the storage below SQLite, flash that remaps blocks, a snapshot of the disk,
is not the app's to wipe.)

## Sealed copies of a notebook (the engine's side: `core/turtl-core-rs/src/seal.rs`, `web/src/vault/seal.ts`)

A notebook that is kept somewhere that must not be able to read it (the account's server, a folder of a cloud service) is kept **page by page**, every page and attachment as one *sealed object*, plus a sealed index. This is the engine's part (step E16b of the plan):
the keys, the objects, the index and the commands. What uses them (keeping an encrypted notebook on the account's server or a connected service, opening one on another device) is E16d, in the next section. It is made on the same libsodium primitives as the rest of the core, so a copy sealed in a
browser opens in the desktop program and the other way round.

```text
master (32 random bytes)     one for the account: made once, kept in the vault's keychain (item "zim-cloud-master", type "cloud"), so it is sealed there by the vault's key,
                             goes with a backup of the vault, and is never given out unwrapped
  notebook key  = HMAC-SHA-512/256(master, "zim-seal v1 notebook" 0 notebook id)     nothing is stored per notebook: its key is made from the master and its id
    names key   = HMAC(notebook key, "zim-seal v1 names")      an object's name is hex(HMAC(names key, path))[0..32] + ".zseal": the path does not show
    content key = HMAC(notebook key, "zim-seal v1 content")
an object  "ZSO1"  nonce (12, random)  ChaCha20-Poly1305-IETF(content key, nonce, ad = "zim-seal v1 object" 0 name, plaintext)
the index  an object named "index.zseal": JSON { v, counter, title, files: [{ path, name, size, sha256 }] }, sealed like any other
the master wrapped by a passphrase   "ZSW1"  ops (u32)  mem (u32)  salt (32)  nonce (12)  ChaCha20-Poly1305(scrypt(passphrase, salt, ops, mem), nonce, ad = the 44 bytes before the nonce, master)   (104 bytes)
```

- **Why this shape**: the study asked for a master key wrapped by the passphrase, so that a changed passphrase wraps again without sealing anything again, and for hidden names and a sealed index, so that the other place sees only that objects exist, their sizes and when they
  changed. The title of a notebook, its pages' names and its layout are all inside the sealed index.
- **One passphrase** (decided 2026-10-16): the vault's. The wrapped master is made with the vault's cost (128 MiB of memory a try; the tests make vaults at a cheaper cost, and say so). On a device that has no key yet, `seal:master:unwrap` takes it out of the wrapped one
  with the passphrase that wrapped it (the app asks for it once, and not again: the key is then in that device's vault). A device whose vault has another passphrase is asked for the one that wrapped the key, and its dialog says when what was typed is not that one. A changed vault passphrase
  is followed by `seal:master:wrap` with the new one (the app does it, E16d), to put the new wrapping where the old one was (nothing sealed is touched). **Both `make` and `wrap` check that the passphrase is the vault's** (the check the passphrase change makes of the current one): wrapping hands the key out, and a key wrapped by another passphrase would not open with the one that opens everything else. **No recovery key** (decided 2026-10-16): a lost passphrase loses the notebooks, as for the vault.
- **The cipher**: the study named XChaCha20-Poly1305; what the core has, on both targets, is ChaCha20-Poly1305 (IETF), so that is what is used, with a random 96-bit nonce for each object. One key is made to seal fewer than 2^32 objects, which is billions of edits; a notebook's key is the only key that
  seals its objects. (A different nonce per object, not a counter, so that two devices that seal with one key do not have to agree on anything.)
- **The commands** (all of a core without a server, and in `LOCAL_COMMANDS`; each needs the vault unlocked): `seal:master:status` (→ `{has, check}`: whether the vault has a key, and its check value), `seal:master:make` (passphrase → `{wrapped, check}`: a new key, wrapped, **kept nowhere**: it is taken into the vault by `unwrap` once the place that keeps the wrapped one has accepted it, so that two devices that make a key at the same moment do not end up with two),
  `seal:master:wrap` (passphrase → `{wrapped, check}`), `seal:master:unwrap` (wrapped key, passphrase → `{kept, check}`; a vault that has *another* master is refused). The **check value** is the first 16 bytes of `HMAC(master, "zim-seal v1 check")`, in hex: it says whether two keys are the same without saying anything about the key. `seal:objects:seal` (notebook id, files → names, sealed objects, sizes, SHA-256 sums), `seal:objects:open` (objects → files; one that does not open fails the whole call), `seal:index:seal` / `seal:index:open`. At most 2000 objects and 64 MiB at a time. A path that
  leaves the notebook, an id that is not 8 to 64 of letters, digits, `_`, `-`, an index that lists a name twice: refused.
- **What is checked on an object**: an object's *name* is its additional data, so an object put under another name does not open (nor with another key, nor with a changed byte: the test changes every byte, one at a time, and cuts at every length); the index holds each page's SHA-256, so an old version
  of a page put back is noticed once the index is newer; the index's `counter` goes up with each version, so a device that remembers the highest it has seen can tell that a whole old copy was put back (E16d keeps it, in the notebook's link, in the vault).
- **What it does not defend against**: whoever keeps the objects keeps every version that was ever sent, and can try passphrases at the cost of the wrapped master; a whole old copy that is consistent is believable to a device that has never seen a newer one; and the sizes and times of the objects are visible.
- **Verified**: known answers (the keys, the names, an object with a fixed nonce, a wrapped master) are asserted on **native and wasm32** (`crypto_test!`; 79 tests on wasm32, 121 native), and were **reproduced byte for byte by a second implementation** (Python's `hmac`, `hashlib.scrypt` and `cryptography`'s ChaCha20-Poly1305,
  written from the description above, not from the Rust). Flow tests drive the commands through the dispatcher: the key made once, sealed objects that name nothing and show nothing, every refusal, a second vault that takes the key from the wrapped one with the passphrase that wrapped it (and not its own), a third that takes
  the re-wrapped one with the new passphrase and not the old, a vault that has a key of its own that is not given another, the key still there after the vault is locked and unlocked **on disk**, and **with a backup restored on another computer**; nothing asked of a server. In a real browser (`npm run test:vault`,
  "sealed copies…"): the engine's Worker seals, the key is there after a reload, another browser takes it, and **Node, with only the passphrase and the wrapped key, derives the same names and opens what the browser sealed** (a third implementation, on the shipped wasm). 16 mutants of the code are all caught:
  the name not in the additional data, the magic not checked, the wrap's header not authenticated, a cost too high or too low run, a notebook key that ignores the notebook, one key for names and content, an index with a name twice, another master overwriting, a path that leaves, `make` or `wrap` not checking the vault's passphrase, `make` keeping the key, a taken key said to be kept when it was there, a check value that is a constant, and `unwrap` keeping nothing.
- **Used by** the sync of encrypted notebooks (E16d, next section): the app asks for these commands, and nothing else seals.

## Encrypted notebooks kept on a server or a service (E16d: `web/src/account/sealed-remote.ts`, `web/src/account/sync-ui.ts`)

The product side (what a person does, the endpoints, the limits, what the server learns) is in `docs/zim-server.md`, *Encrypted notebooks kept sealed, page by page*. This is the part that decides what leaves the browser and what it is protected by.

- **What leaves the browser** for an encrypted notebook that is kept elsewhere: objects `ZSO1 ‖ nonce ‖ ciphertext` under hashed names, the sealed index, and the master key **wrapped by the vault's passphrase** (once, to the account). Never a page's name or text, a tag, the notebook's real title (the place is told “Encrypted notebook”) or its local id. The place is told an id made for the copy, `zsl-<random>`; the notebook's keys are made from the master key and **that** id,
  which every device that opens the copy learns from the place itself, so the vault's own ids need not be the same on two devices.
- **One remote among the others.** `SealedRemote` implements the same `Remote` interface as the account's space and each service (`manifest`, `read`, `write`, `remove`); `SyncUi.remoteFor` wraps the remote whenever the notebook's link says `sealed`, so every path that reaches a remote for an encrypted notebook goes through the sealing, and there is no code that sends a page of an encrypted notebook unsealed. Its marks are the SHA-256 of what each page says (the sync's own digest), so a
  page that two devices wrote the same is not asked about.
- **What it checks.** Opening the index proves whose it is and that it was not changed (an AEAD under the notebook's key); its `counter` must not be lower than the highest this device has seen (kept in the link): a whole old copy put back is refused, one that this device never saw a newer version of is not noticed; every object the index lists must be there; each opened page must have the SHA-256 the index gives, so an old version of a page put back under its own name,
  an object damaged, an object under another's name and a missing object are each refused with a message, and nothing of the page reaches the notebook. A sync that is refused leaves the notebook and the link as they were, and the state of the notebook says *problem*.
- **Big notebooks.** The engine seals and opens at most 2000 objects and 64 MiB in one call and an index lists at most 20,000 files; `SealedRemote` goes through a notebook in groups (1000 objects, about 16 MiB, an attachment bigger than that alone), in order. Tested with a stand-in that has the engine's limits (thousands of pages; attachments of 8 MiB and 16 MiB); a notebook of that size was not synced for real.
- **The order of writes.** Objects, then the index, then what is deleted; a reader that comes between two of them finds either the old index with all its objects or the new one with all of its. (Not a transaction: a crash between the objects and the index leaves objects that no index lists, which the next send writes over or leaves; what is deleted is deleted last, so an old index never lists what is gone.)
- **Where the link is kept.** An encrypted notebook's link (that it is kept somewhere, the id, the account, the marks, the counter seen) is a hidden `zim-link` note in the notebook's space: **in the vault**, sealed like any note, read when the vault is unlocked, dropped from memory when it is locked, and carried by a backup of the vault as any note is (not tried on its own). It is never in `localStorage` (the open notebooks' links are, as before, and name nothing of an encrypted one), and the state dot, the status line and the
  list say nothing of an encrypted notebook once the vault is locked: a sync that fails because the vault was locked meanwhile says nothing.
- **The key, and two devices at once.** `seal:master:make` makes the key and hands it back wrapped, **keeping nothing**; the account's server keeps the wrapped key if no other is there (compare-and-swap on the SHA-256 of what is replaced); only then does the vault take it in. Two devices that make a first key in the same moment end with the first one's: the later is told (409, with the key that is there) and takes that one with the passphrase it typed, which has to be the one that wrapped it.
  A device whose key is not the account's (its check value differs: another account made it) is told so and sends nothing.
- **What was tried and what it showed.** Mutants of the sealing remote (the index written first, a page's sum not checked, the counter not checked or not raised or not remembered, a missing object not noticed, the real title sent, the index forgetting the files that did not change, deleted pages leaving their objects), of the link (also kept in the browser's storage, not written to the vault, not dropped at a lock, not read at an unlock), of the key's flow (another key
  accepted, a lost race made an error, the key not wrapped again after a change of passphrase, an existing key not taken) and of the rest of the sync (a sealed notebook copied twice, no state after a copy, no catching up after an unlock, a title that ignores a change of account) were run against the browser scenarios: **all 21 are caught** (one only after a scenario was added: unlocking in a page loaded with a slow account server).
  Of the server's key code, 12 mutants (the compare-and-swap, the size, the magic, the check value, another account's key read or written, the export, the session, the same-site check) were run: two were not caught (the size check alone, another account's key in the comparison), and the tests were tightened until they were.
- **What it does not protect against** (besides what the vault does not): the place deleting or holding back objects; it keeping every version and trying passphrases offline (a good passphrase is the whole defence, and a **forgotten one has no recovery** (decided), nor yet a way to start over on an account whose key nobody can open); a rollback that no device could notice; and sizes, times and the number of notebooks, which the place sees.
  The master key is **wrapped again, not replaced**, when the passphrase changes: someone who once had the old wrapped key and the old passphrase can still open the key. A real rotation (a new key and every notebook sealed again) is not built.

## Backup and restore

**Back up the encrypted notebooks…** saves one file with everything in the vault, **still encrypted**, as
it is kept: the account's record, the rows of the user's database (the keychain with the notebooks'
keys, the notebooks, the pages) and the files of the pages. Nothing is opened or sealed again to make
it, so it holds no more than the browser's own files hold (the list in the next section), and it opens
with the passphrase the vault had when it was made: a passphrase changed since opens the vault, not the
backup. It is a copy of one moment, taken whole (the core makes it in one command, and the dialog that
asks for it is modal): what is written afterwards is not in it. Whoever has the file can't read it,
but can guess its passphrase at 128 MiB a try, so it is to be kept as safely as the notebooks.

It is also how a vault is moved to another computer until there is sync: restored there it is the
vault, and the two go their own ways from then on. Nothing is merged.

**Restore encrypted notebooks from a backup…** (the notebook menu of a browser that has none) puts it
back, locked, and then asks for its passphrase. It never replaces a vault that is there (an unlocked
one, or a locked one: erase it first, from the unlock window's *I forgot it…*). The whole file is checked
before anything is written; the user's database is written in one transaction and the account's record
last, since it is the record that makes a vault exist: a restore that is stopped, by anything, leaves
no vault, and the same file restores afterwards. What is at the place of the vault's database when a restore
starts (and the files of that user) can only be what a restore left that was stopped after its database was
written and before the account was, and belongs to no vault: it is deleted first, so that a vault restored
afterwards is the backup that was restored and not that and what the stopped one wrote (a review found the
older of two backups bringing the newer one's notebooks with it).

```text
"ZIMVAULT"  the format (u16, now 1)
then records, each one: kind (u8)  length (u32)  that many bytes     (numbers are big endian)
  1    account   JSON {"name": ..., "record": ...}          one, the first
  2    row       JSON {"table": ..., "row": {...}}          one for each row of keychain, spaces, boards, notes, invites, users
  3    file      length of the note's id (u16)  the id  the file as it is kept (sealed)
  255  end       SHA-256 of every byte before this record   the last, with nothing after it
```

What is checked when one is read (`Backup::read`, `checked_account`): how it begins; that every record
starts and ends where it says; the sum at the end (a file cut short, or with one byte changed, is
refused: the test changes every byte of a good file, one at a time, and every one is caught); known
tables only; an id for every row, no row or file twice, a file only for a note that is there and whose
id is safe to be part of a file's name; and the account: a name and an id that can't be a path (and a name that logging in can find: it makes names
lower case, so an account kept under one with capitals could never be opened, nor restored over: a review found
that a file could make one), costs that a device can bear (the cost of an unfinished change of passphrase too), a record
that is a record. The sum is for accidents. It can't tell a file made
on purpose from a real one, and does not need to: a vault opens only with its own passphrase and
everything in it is sealed.

A signed-in account can keep this same file on the account server (*Back up the encrypted notebooks to the server…*, `docs/zim-server.md`): the server holds the sealed file and nothing it can read.

Limits: a backup may be up to 1 GiB, the engine holds all of it in memory while it makes or restores
one (about twice its size at the peak), and it crosses between the page and the engine as text, 2 MiB
at a time. A backup does not follow a passphrase change, and does not include what a browser keeps
outside the vault. The backup being made and the one being received share one place in the core, so a
host that made one and then sent another before reading the first would read the second back: the app
does one at a time (the dialogs are modal, and a vault is one tab's).

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

Deleted and replaced rows are written over with zeros (`secure_delete`), so a deleted note's ciphertext,
and its keys, are not left in the database's free pages (and only ciphertext was ever written, so there
is no plaintext to wipe).

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
| Where the notebook is kept (E16d: its link, its marks, the counter seen) | in `localStorage`, by the notebook's id | **in the vault**, as a hidden note of the notebook's space; held in memory only while unlocked |
| What reaches the account's server or a service | the pages, in clear (the person was told) | sealed objects under hashed names, the sealed index and the wrapped key, and nothing else: no name, no title, no text |
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
  `scripts/serve.sh start --host :: --port 8443 --tls --name ADDRESS`, which makes a certificate for
  that address: the browser warns once and then the page is secure, and an encrypted notebook can be made
  (checked in a real Chromium that proceeds past the warning). That page can't be saved for offline use
  unless the computer trusts the server's authority: `docs/zim-pwa.md`.)
* **Unlocking costs the whole vault.** `local_start` decrypts and indexes *every* note of *every*
  encrypted notebook when the vault is unlocked. Measured in Chromium with `npm run measure:unlock`
  (pages of about 1.5 KB, each vault made, locked and unlocked after a reload): the key takes about
  1 s of every unlock whatever the vault holds, and then

  | pages | text | unlock | then opening the notebook reads it |
  |---|---|---|---|
  | 1 | 0 | 0.97 s | 0.02 s |
  | 301 | 0.4 MB | 1.2 s | 0.19 s |
  | 1,501 | 2.1 MB | 1.7 s | 0.45 s |
  | 6,001 | 8.6 MB | 7.1 s | 1.9 s |

  so a thousand pages add about 0.5 to 1 s, and a vault of tens of thousands of pages would take
  half a minute or more to open. (Attachments are not read at unlock.) The fix would be to index lazily
  (list a notebook from the database's own indexes and decrypt only the notebooks that are opened); it
  would only help a vault of several big notebooks of which one is opened, since the app reads a whole
  notebook when it opens it, and it changes what the engine's search and tag commands see. Not done:
  at the sizes measured the cost is a few seconds behind a spinner, and the change is not worth its risk
  yet. Nothing larger than 6,000 pages was measured.
* **Big imports get slower per page as they grow.** Measured in Chromium (one batch of notes of about
  1 KB each): 500 take 1.8 s, 1,000 take 3.1 s, 2,000 take 6.5 s and 4,000 take 14.6 s; the cost of
  one write rose from 2.7 ms to 4.2 ms across the 4,000, and the commit at the end is linear (about
  a third of a millisecond a note). Written in groups of 250 pages of 1.5 KB with `secure_delete` on:
  1,500 pages took 5.4 s and 6,000 took 30 s (about 5 ms a page at the end).
* **No recovery.** A lost passphrase can't be recovered. A vault moves between computers by a backup, by hand, or
  its notebooks by being kept sealed on an account (E16d, above): the second device makes a vault of its own and takes
  the key with the passphrase that sealed the copy. The desktop and phone apps do not sync yet.
* **Changing the passphrase does not replace the notebooks' keys.** A copy of the files, or a backup,
  made before the change still opens with the old passphrase, with the keys that did not change (see
  *Changing the passphrase*).
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
| A stored account that asks for more than a device can do is refused without trying; a user record that the key does not open is not left logged in; a notebook of 33,000 notes is read; attachments follow their notes (deleted when the batch commits, for any user); the cost of an unfinished change of passphrase is held to the same limit, whichever passphrase is typed | `local_account_tampered_flow`, `local_pending_cost_is_held_flow`, dumpy's chunked-read test, `local_files_follow_their_notes_flow`, `local_files_in_batches_flow` |
| The key derivation is what is claimed | `crypto::low::tests::can_generate_keys_at_the_local_cost` (key from Python's scrypt), native and wasm |
| Writes are atomic; batches commit or roll back whole, memory included | dumpy tests (`a_failed_store_leaves_nothing_behind`, `writes_join_the_transaction_that_is_open`), `storage::tests::batches_are_whole_or_nothing`, `flow_tests::local_batches`; native and wasm |
| The engine runs in a Worker, data survives reloads, one tab at a time, an insecure page is refused, a write cut off at five different moments leaves the notebook whole or as it was, nothing is readable in the browser's files, a Worker that was cut off from the network can't use it or get it back (a probe in a real Worker, with a control that shows it could before), and the engine asks the network for nothing but its own files (the browser's own request log) | `web/test/vault-browser.mjs` (`npm run test:vault`), real Chromium, served under the app's CSP |
| The store keeps the notebook-store contract, with files, moves, atomicity under failure; the vault's states and its client; an engine that goes silent is declared dead and one that keeps saying it is alive is not; a lock does not wait for an unlock and is not undone by one that finishes just after; the store forgets at a lock; text the engine could not read is never sent | `web/test/store.test.ts` (the same contract as the other stores), `turtl-store.test.ts`, `routed-store.test.ts`, `vault.test.ts`, `engine-failures.test.ts`, `cut-off.test.ts` |
| In the interface: made, written in, locked, unlocked; Back/Forward and the address say nothing; no draft; export warns; import and rename and delete; a lost passphrase is erased; a short passphrase is refused; an insecure page says so; auto-lock; **IndexedDB, localStorage, sessionStorage, the Cache API and every OPFS file hold none of a notebook's name, page names, text (accented, Chinese and emoji too: looked for as UTF-8 and as UTF-16, with a control file that shows the scan finds UTF-8), tags, attachment name, type or bytes, nor what was typed in the search box or a dialog that was given up**, nor the passphrase | `web/test/browser.mjs`, the scenarios after "an encrypted notebook is made…" |
| A question that was asked on one notebook can't change another; a lock closes questions and leaves the notebook shown instead untouched, and Back does not lead into the locked one; a lock asks before it loses typing and an idle one says what it lost, and none of that is anywhere the browser keeps things; a page the browser kept is hidden and then locks; a lock that can't switch the screen starts the page again; a dead engine locks the vault with a message and leaves nothing on the screen; a list of notebooks that can't be got is said so; Escape does not give up an unlock; a late answer from the browser about keeping the data is waited for; a plain copy is said to be plain; a page nobody asked to test has no `window.__zim` | `web/test/browser.mjs`, the scenarios under "What the review of the encrypted notebooks found" |

| A passphrase is changed: a wrong current one, a weak or unchanged new one, an open batch and a core with no vault are refused and change nothing; the notebooks' keys, the user's record and the user's own row are then sealed with the new key and none with the old; the vault goes on (a notebook made afterwards has its key under the new one); only the new passphrase opens it; an account made at another cost moves to the current one; a key that nothing opens is counted and left alone; a change can be made again; a change that fails half way is dropped whole (the account is as it was to the byte, the new passphrase opens nothing) | `flow_tests::local_passphrase_change_flow`, `local_passphrase_change_of_an_old_account_flow`, `local_passphrase_change_with_a_dead_key_flow`, `local_passphrase_change_that_fails_flow`, natively and on wasm32 |
| A change that is stopped after any of its writes is settled by either passphrase (the new finishes it, the old undoes it, to the byte), the host is told which, a second change on top is refused, and a damaged `pending` is never the end of the vault: what can be done is, and what can't is refused whole and leaves the other passphrase working; with the files on disk and the core started again, the same through `user:login`, and no file holds a passphrase or anything the old key sealed | `local_passphrase_change_interrupted_flow` (written/sealed × old/new, four damages), `local_passphrase_change_on_disk_flow` |
| Mutation checks of the above: 24 mutants (the pending write dropped, the keys not sealed, the key in memory not replaced, the record not promoted, the settle going the wrong way or without the other key, the login ignoring `pending` or reusing a key across costs, the current passphrase not checked, the same passphrase allowed, a change on top allowed, an open batch missed, the old cost kept, the user's row skipped, a login that does not settle or does not log out after failing, the command not allowed, the algorithm byte trusted) | 23 are caught; the one that was not showed that code was dead (the in-memory keychain entries are re-keyed by `save_key` when used) and it was removed |
| A damaged envelope header is an error and never a panic: every byte of a good one changed to every value, and every cut | `crypto::tests::damaged_envelopes_are_errors` (found because a test planted a key that nothing opens: the algorithm byte was used to index an array) |
| What is replaced or deleted is not left in the file; after a change **no sealed thing in any file of the browser's file system opens with the old key** (found two: the old record and the old `auth`), and neither passphrase is in any file | `storage::tests::what_is_replaced_or_deleted_is_not_left_in_the_file` (fails with `secure_delete` off), `vault-browser.mjs`: "the passphrase can be changed…" |
| A change in the page: the old passphrase is refused afterwards, the new one opens everything, a page written after is kept, what is wrong with the dialog's fields is said as it is typed, a lock that comes in the middle of a change does not hide that it was made, what unlocking settled is told, and nothing of either passphrase or of the notebook is where the browser keeps things | `web/test/browser.mjs`: "the passphrase is changed from the menu…", "a lock that comes while the passphrase is being changed…", "a change of passphrase that unlocking settled is told…"; `vault.test.ts` (plumbing, normalisation, errors, one at a time, the real core) |
| A change cut off in a real browser, at twenty moments spread over the time it takes, leaves a vault that one of the two passphrases opens, whole, with the passphrase typed as the vault's (the moments rarely fall in the few milliseconds when something is half done: those states are the core's tests above, which stop the change between its writes) | `vault-browser.mjs`: "a change of passphrase that is cut off at any moment…" |
| A backup is a file that reads back as it was written, refuses everything that is wrong with one (every cut, every changed byte, each way a made file can be wrong), restores in a core that has none, and not over a vault or an unlocked one; it holds nothing that can be read, comes in pieces of any size, and a restore moves a vault to another computer with its keys, pages, files and user row, under the passphrase it had when the backup was made | `vault_backup::tests`, `flow_tests::vault_backup_in_pieces_flow` (both targets), `vault_backup_moves_a_vault_to_another_computer_flow` (native, files on disk, the file folder emptied between), `vault_restore_refuses_accounts_that_cannot_be_made_flow` (a name with capitals or that is a path, an id that is not a number, a cost no device can bear, in the account's or in an unfinished change's, no user record: refused whole), `vault_restore_that_fails_leaves_no_vault_flow` and `vault_restore_replaces_what_a_stopped_restore_left_flow` (native: a database that can't be made leaves no account; the older backup restored after the newer was stopped is the older one, files too); 24 mutants of the backup code (the sum not checked, anything allowed after the end, an unknown table, a file for no note or for a note whose id is a path, a row twice, any cost, id or name, restoring over a vault or an unlocked one, files or rows or the user's row not backed up or not put back, a batch cut in two, pieces out of order or too big, the commands not allowed) are all caught |
| In the browser: a backup of a vault restores in another browser profile and opens there, nothing in it or in what the browser keeps there can be read, a damaged, cut or foreign file is refused and leaves no vault, one made after a passphrase change needs the new passphrase and one made before the old, and a restore cut off at four moments leaves a whole vault or none and can be tried again; in the app: the menu offers each only where it can be done, the file is named, downloaded and unreadable, the other browser restores it through the file chooser and unlocks it | `vault-browser.mjs` (the three scenarios and four moments), `browser.mjs`: "the encrypted notebooks are backed up from the menu…" |

| **Sealed copies kept on a server or a service (E16d)**: nothing readable is in the server's database, in any request a browser made (also as base64), in a service's files or in either browser's storage (a page's text, a page's name, the notebook's title: looked for as UTF-8, and in the browsers' storage as UTF-16 too); every object is named by a hash, the notebook by `zsl-…` and “Encrypted notebook”; a second browser is refused the vault's own passphrase and takes the key with the one that sealed it; pages merge both ways, a page changed on both sides is asked about; a lock names nothing and sends nothing and an unlock brings the link back from the vault; a change of passphrase wraps the key again (same key, new wrapping); a whole old copy put back, an index changed by one bit, a missing object, an old object of the same page, a damaged object and an object under another's name are each refused; stopping deletes the copy; the index goes last on a service; typing is sent by itself; a notebook already on the device is not copied twice; a vault with another account's key is told so; two browsers that make the first key at once end with one | `web/test/browser.mjs`, the eight scenarios built on `sealedRig` (*an encrypted notebook is kept sealed on the server…*, *a sealed notebook survives a lock and a change of passphrase…*, *…kept sealed in a folder of a connected WebDAV service…*, *a sealed notebook is kept in step by itself…*, *a passphrase changed while signed out…*, *the key for sealed copies belongs to one account…*, *two browsers that make the account's first key…*, *a lock that comes in the middle of a change of passphrase…*): real server, real browsers, a stand-in WebDAV service |
| The sealing remote's rules (order of writes, title, marks, counter, kept and dropped pages, each refusal), the link note in the vault (replaced in place, not a page or a file, gone with the notebook, locked with the vault), the keychain calls | `web/test/sealed-remote.test.ts` (a stand-in for the engine's sealing: binds objects to notebook and name, not secret), `routed-store.test.ts`, `turtl-store.test.ts` (the real core), `account-client.test.ts` |
| The account's key: first key, compare-and-swap, a refusal that says which key is there, size, magic, check value, one account's key apart from another's, in the export, gone with the account, same-site header, no session | `server/test/sync.test.mjs`, *the key for sealed copies* |
| The engine's `make`/`wrap`/`unwrap` and the passphrase check | `seal.rs` known answers (the check value too) and `flow_tests::sealed_copies_flow`, `sealed_key_is_kept_in_the_vault_flow` (native and wasm32); `vault-browser.mjs` *sealed copies…* (a passphrase that is not the vault's is refused by `make` and `wrap`; after the vault's passphrase is changed the old one wraps nothing and the new one opens in Node) |
| Mutation checks of E16d: **16** in `seal.rs`, **12** in the server's key code (two survived at first: the size check alone, and another account's key in the comparison; the tests were tightened), **21** in the client against the browser scenarios (one survived at first: unlocking in a page loaded with a slow account server, now a step of a scenario), **19** in the sealing remote (with its grouping), **8** in the routed store and client, **4** in the vault store, against the unit tests (one survived at first, a read of an open notebook's link while locked, and a test was added) | all caught in the end |

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
indexes everything; someone who can write the files can roll them back or swap ciphertexts; the
account record's own `id` is not authenticated (an existing account can be moved to a new cost since:
by changing its passphrase);
a browser that asks the person about keeping the data gets its answer waited for, however long that
takes.

## What finishing them found

Building the passphrase change, the backup and their tests turned up four things in code that was
already there. Each was fixed and has a test that fails without the fix.

| Found | What was done |
|---|---|
| **Old records stayed in the files.** After a change of passphrase, reading every byte of the browser's file system and trying every sealed thing with the *old* key opened two: the old user record and the old `auth`. SQLite does not write over what is replaced or deleted, and the change makes the record bigger (`pending`) and then smaller, so the new one never lands where the old was. The same holds for every replaced or deleted row of every notebook | Every database runs with `PRAGMA secure_delete = ON`. The core test fails without it (a value replaced by a bigger, then a smaller one is found in the file); the browser scan finds nothing sealed with the old key with it |
| **A damaged ciphertext could panic the core.** `crypto::decrypt` indexed its list of algorithms with a byte of the data being decrypted: a key row whose bytes were damaged (or made) with a large value there crashed the engine instead of being an error | It is looked up and refused. The test changes every byte of the header of a good envelope to every value, and cuts it at every length |
| The test that reads every command of the dispatcher to check that each is refused unless allowed did not see an arm written `"a" \| "b" =>` (and would have skipped it) | It reads alternatives |
| Events are one queue for the whole process, and the tests run side by side: a test that read them took another test's | The outcome of settling a change is also what `local_start` returns, and the one test that reads events looks only at its own account's |

## Not done

* Replacing the notebooks' own keys when the passphrase changes (re-encrypting every note and file:
  heavy, and it must survive a crash half way as the change of the passphrase does).
* A backup that is sealed with a passphrase of its own, or that can be restored over a vault, or merged
  into one.
* Sync of encrypted notebooks **to the Turtl server** (its data model is Turtl's own): not wanted any more; the encrypted
  notebooks are kept sealed on the account server and on connected services instead (E16d, above).
* A way to start over when the passphrase of the sealed copies is forgotten and no device has the vault open
  (E16i), a rotation of the master key, and sync for the desktop and phone apps (E17).
* Lazy indexing (above), per-notebook passphrases (today one vault, one passphrase), a setting for
  the auto-lock time.
* Authenticating the account record (its `id` and `kdf` are checked only by a login that must then
  decrypt the user record).
