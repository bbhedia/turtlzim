# The account server

`server/`: a Node 24 program (no framework; `node:sqlite`, `node:crypto`, and `nodemailer` for SMTP) that serves the web app **and** `/api/`, in one
process. It exists so that a person can have an **account**; an account is optional, and without one nothing changes: notebooks stay on the device.
Accounts can keep **open notebooks on the server, in clear**, in step with other devices (below; 1 MB per user). **Encrypted notebooks** are kept sealed, page by page, in the same way (E16d, below), and the vault's own sealed backup (below) is a separate thing. And
connected services (Nextcloud / WebDAV, a GitHub repository, a GitLab project, Dropbox and Google Drive; `docs/zim-cloud-feasibility.md`, roadmap lots 3 to 6). Decided 2026-10-15: Google and GitHub
first, a mailed code **only at sign-up**, and run on this server (a VPS later if the project succeeds; the shared hosting idea is dropped).

## What it does

| | |
|---|---|
| Sign up | e-mail + password, then a 6-digit code mailed to the address (10 minutes, 5 tries, one use, a new one at most once a minute). Signing in afterwards needs only the password. |
| Sign in with Google or GitHub | the server is the OAuth client (it holds the secret); the browser goes to the service and back. Only an address the service **has itself confirmed** makes or finds an account. |
| Forgot the password | a mailed code, then a new password; every session ends. |
| Account | who is signed in, sign out, *download my data* (everything the server holds about the person), delete (asks for the password; an account with no password asks for a sign-in of the last 10 minutes). |

Safeguards (each has a test that fails without it; the mutants were tried):

- Passwords: scrypt (N=32768, r=8, p=1), at least 10 characters, a list of common ones refused, not the e-mail's first part. A wrong password and an unknown address
  answer the same, in the same time. Registering an address that already has an account answers the same and mails the owner instead (no way to find who has one).
- An account begun with a password and never confirmed loses that password when the real owner signs in with Google or GitHub (it can't have been the owner who chose it).
- Sessions: a random token in an `HttpOnly`, `SameSite=Lax` cookie (`__Host-zim`, `Secure`, under https); only its SHA-256 is stored; 30 days; signing in again replaces the one held.
- Requests that change something need the header `X-Requested-With: zim`, a same-site `Origin` and a same-origin `Sec-Fetch-Site`; JSON only, 16 KB at most; answers are `no-store`.
- OAuth: a one-use `state` (stored hashed), PKCE (S256, the verifier stays on the server), and a cookie that binds the answer to the browser that started it.
- Rate limits kept in the database (per address and per client): sign-ups, sign-ins, codes, resets, deletions → `429` with `Retry-After`.
- The page's content policy is unchanged (`connect-src 'self'`); the service worker lets `/api/` through to the network; a native shell (Android, desktop) shows nothing of accounts (no `INTERNET`).

## Notebooks on the server (the storage side)

`server/src/sync.mjs`, under `/api/sync/notebooks` (signed in, and a write needs the same header and origin as everything else):

| | |
|---|---|
| `GET /api/sync/notebooks` | the person's notebooks (id, title, revision, size), what is used and the quota |
| `GET /api/sync/notebooks/<id>` | one notebook: its files (path, base64 bytes) and its revision |
| `GET /api/sync/notebooks/<id>/manifest` | what it holds without the bytes: each file's path, size and mark (the SHA-256 of its bytes) |
| `POST /api/sync/notebooks/<id>/read` | some of its files (`{paths}`; a path it does not have is left out) |
| `PATCH /api/sync/notebooks/<id>` | change some of its files: `{title, baseRevision, put, remove}`, refused for an old revision, counted against the quota by what is kept after the change |
| `PUT /api/sync/notebooks/<id>` | replace its files; `{title, baseRevision, files}`; `baseRevision` is the revision the copy was made from (0 for a new notebook) |
| `DELETE /api/sync/notebooks/<id>` | remove it |

A write made from an old revision is refused (`409`, with the current revision): nothing is overwritten, the client has to merge. Over the quota (1 MB for the notebooks together; a notebook may use all of it when it
replaces its own files) is `413`. Paths are checked (relative, no `..`, nothing hidden, no two that differ only by case) and ids are `[A-Za-z0-9_-]{8,64}`. The files are stored **in clear**: encryption with a passphrase is the next
lot, and until then an account's notebooks are readable by whoever runs the server. Each person only ever sees their own (a test with two accounts and the same id), and deleting the account deletes them.

## Keeping a notebook in step (the app's side: `web/src/account/sync.ts`, `sync-ui.ts`)

With an account, the notebook menu has **Keep this notebook on the server…** (an open notebook only: an encrypted one is never offered, a test checks the menu), **Sync this notebook now**,
**Stop keeping this notebook on the server…** (with the choice to delete the server's copy) and **Open a notebook from the server…** (copies it to this device and links it).

- What is kept is the notebook as its **files** (the same ones the zip export makes: `notebook.zim`, pages with their byte-order mark and line endings, attachments). The dialog says that it is stored in clear.
- **Page by page** (since 2026-10-16). A linked notebook remembers, in this browser (`zim:sync:<notebook id>`, nothing of the content), the revision it last agreed on and, for each file, **this side's digest** and **the other copy's mark** at that moment.
  A sync tells, for each file, what changed on each side since then (`planMerge`, a three-way comparison): changed here only → sent; changed there only → brought here; deleted on one side → deleted on the other; changed on **both** → asked, unless the two
  versions are the same (checked by content: a page both devices wrote the same way is not a conflict). Pages changed on the two devices that are *different pages* merge by themselves, with no question.
- **A page changed on both sides** is asked about: *Keep both* (the default: this device's page stays, and the other version is saved beside it as “Name (conflict copy)” and goes to everyone), *Use this device's versions*, *Use the other versions*, or leave it for
  later (nothing is sent or replaced until a choice; automatic sending is paused for that notebook meanwhile). A page deleted on one side and changed on the other is asked about the same way (keeping both restores the changed page).
- Only the changed files travel: the account's space has `manifest`, `read` (some files) and `PATCH` (write some, delete some); a connected service is told the same through its own file listing. The notebook's own file (`notebook.zim`: name and home page) is this
  device's when both sides changed it. A file the other side has that the app never took in (a hidden file) is left alone and never deleted.
- What is brought here is applied **before** what is sent, so that what is sent is this side as it then is; what is remembered afterwards is what was sent as it was sent, what was brought as it is here, and everything else as it was when the sync began, so typing
  during a sync shows as a change at the next one. A write refused for an old revision (409) is looked at again at once.
- Sending is automatic 6 s after the last change; fetching happens at start (for a linked notebook) and on *Sync now* — never while typing is unsaved. A link made before pages were told apart works out its base (`baseOf`): a copy that has not changed since is its own base, and one that has has none, so every file that differs is asked about once.
- A link belongs to the account that made it; a notebook that the server no longer has is unlinked, not recreated.
- **Limits**: the list of digests and marks is kept in `localStorage` (about 150 bytes a page: a few thousand pages is the most it should hold; moving it to IndexedDB is a later step); merging is by page, not by line (two edits to one page are a conflict, with the other version kept beside it);
  the carnets of the desktop's folders and of the phone shell do not sync yet.
- Verified by `web/test/account-sync.test.ts` (the plan for every combination of change on the two sides, the base for an old link, the names of conflict copies) and the browser scenarios with two browsers on the real server: *keep, open on the second, write both ways, different
  pages merging with no question, a delete passing across, a page changed on both sides (each of the three answers, and the copy reaching the other device), the same page made the same way on both sides, sending by itself, an encrypted notebook with no line about the server, stop keeping*,
  and the same through a Nextcloud's own marks. Mutants (identical pages asked about, no copy made, the notebook not reopened after a pull, deletes not applied or not sent) are caught. Not tried: a flaky network half way through a sync, two tabs of one browser on one notebook, a real phone.

## How a notebook says where it is (E16c, `web/src/app/app.ts`, `web/src/account/sync-ui.ts`)

The rule (`CLAUDE.md`, *How notebooks are organised*): a notebook is **encrypted or not**, and **only on this device or kept elsewhere**: two independent facts, shown as two badges with a word (a word, not only an icon, so that it is read out and needs no font).

- **In the list of notebooks** (the notebook menu), one row for each, whatever it is, with its badges on the right: **Encrypted**; and **This device only**, **Folder of this computer** (the desktop program), or **Synced · where · state**: *server*, or the name of the connected service.
  The state, once it is known in this session: *up to date*, *waiting to be sent* (typed, not sent yet), *syncing…*, *needs you* (the same page was changed on both sides and the question was left for later), *problem*, *offline*. A notebook that was just made is up to date; one that was not synced yet in this session says only “Synced · server”.
- **Next to the title** (the button of the notebook that is open): *encrypted* when it is, and a small badge *synced* with a dot that shows the state (green: up to date; blue: waiting or sending, pulsing while it sends; red: needs you or a problem; dashed: offline). A notebook that is only here says nothing there (the usual case; the list says it for each).
  On a narrow screen the badge shrinks to the dot, and shows the word of the state only for what needs the person; the button's tooltip and the list say it all.
- **The dialog *New notebook*** asks the two things apart: **Encryption** (not encrypted / encrypted) and **Where** (on this device only; in a folder of this computer, in the desktop program; for someone who is signed in, on the server or on each connected service), then *Start with*. A notebook made on the server or on a service is made here and **sent for the first time at once**
  (the one moment when it is in both places; if the send fails the notebook stays here and the status line says so). An encrypted notebook made on the server or on a service is **kept sealed** (E16d, below; the first one asks for the passphrase once). A folder of Zim files can't be encrypted, and says so.
- A server that **can't be reached** does not make a synced notebook look like a local one: what the page knew of the account stays, the badge says *offline*, and the way to sync is still offered for when the network is back.
- Verified by the browser scenario “…every notebook says whether it is encrypted and where it is kept…” (Chromium and WebKit): the list before and after signing in, the places the dialog offers (this device only when signed out), a notebook made on the server (it is there, and says up to date), typing that waits and is then sent, a page changed on both sides with the question left for later (*needs you*) and then settled, the server taken away
  (*offline*, the typed text still there, the sync still offered), and by the scenarios of an encrypted notebook (*Encrypted · This device only*) and of a folder notebook (*Folder of this computer*). Seven mutants (a notebook made on the server not sent, a badge missing, a state not shown, offline looking like local, …) are caught (an eighth, an encrypted notebook offered to the server, is gone: since E16d it is allowed, and sealed).

## The encrypted notebooks on the server (`web/src/account/sealed.ts`)

An encrypted notebook is **never** sent as pages. It is either kept sealed object by object and synced (the next section), or the whole vault is backed up as one file (this section): **the vault's own backup**
(`Vault.exportBackup`, `docs/zim-encrypted-notebooks.md` *Backup and restore*) on the server: one file of everything in the encrypted notebooks, sealed by the vault's keys exactly as they are
kept on the device, which only the notebooks' passphrase opens. No new way of encrypting was written: the engine, the format and the passphrase are the ones that exist.

- **Back up the encrypted notebooks to the server…** (vault unlocked): sends the file as the account's one sealed copy, replacing the one before (the dialog says there is one and when it was sent; the server is told the revision
  that was shown, so a copy sent from another computer meanwhile is not replaced unseen). The dialog also offers *Delete the copy on the server*.
- **Restore the encrypted notebooks from the server…** (a browser that has no vault): fetches it and runs the app's usual restore (confirm, put back locked, ask for the passphrase). It never replaces a vault.
- The server holds an opaque file named by a generic title and knows its size and when it was sent. The browser keeps nothing about it (no link, no state), the status line and dialogs name no notebook, and the
  list of notebooks that can be opened from the server leaves the sealed copy out.
- **What this is not**: it is a copy of one moment that you send, not a sync: nothing is sent by itself, two computers do not merge (the copy that is restored becomes that browser's vault and the two go their own ways), and a restore needs a browser with no vault.
- **What the server's operator can do**: nothing with the contents, but they can keep every copy ever sent and try passphrases offline at 128 MiB of memory a try, so the strength of the passphrase is the whole defence; a forgotten passphrase loses
  the copy and the notebooks for good (the dialog says so). A changed passphrase does not change a copy sent earlier (the old passphrase still opens it): send a new one and delete the old.
- Verified by the browser scenario "with an account server the encrypted notebooks are sent sealed…": a page with a marker text is written in an encrypted notebook, and neither any request the browser made, nor the file the server stored, nor
  the browser's own storage contains the marker or the notebook's name; the file begins as a vault backup does; another browser with no vault restores it, refuses a wrong passphrase, opens it with the right one and has the page; sending again replaces
  (revision 2), delete empties the server; locked, a browser that has the vault is offered neither line. Mutants (revision not sent, the lines offered where they should not be, the sealed copy listed as a notebook) are caught.
- **Done since** (E16b to E16d, next section): sealing each file separately under a key hierarchy (a master key wrapped by the passphrase, hidden names), with sync page by page between devices. **Decided against**: a recovery key (a forgotten passphrase loses the sealed copies, as it loses the vault), and a passphrase of its own for sealed copies (the vault's is reused).

## Encrypted notebooks kept sealed, page by page (E16d: `web/src/account/sealed-remote.ts`, `sync-ui.ts`, `server/src/sync.mjs`)

An encrypted notebook can be kept on the account's own space or in a folder of a connected service, and synced between the person's devices like any other notebook (the page-by-page, three-way sync of E16a; the same badges, *Encrypted* and *Synced · where · state*). What the other place holds is **objects it cannot read**.

- **How a person does it.** *Keep this notebook on the server…* (an encrypted notebook that is open, vault unlocked, signed in), or *New notebook…* with Encryption = encrypted and Where = the server or a service. The first time, a dialog (*Seal your encrypted notebooks for the server*) asks for **the passphrase of the encrypted notebooks** (the engine checks that it is the vault's: there is not a second passphrase), and not again. On another device,
  *Open a notebook from the server…* lists it as “Encrypted notebook, sealed (the server, 3 KB)”; opening it makes that browser's vault if it has none, then asks once (*Open the key for sealed copies*) for the passphrase that sealed it, and the notebook comes back under its own name. Locking the vault stops all of it (nothing is sent or asked while it is locked), and unlocking brings the notebook up to date.
- **What is kept.** In the account's space, a notebook whose id is `zsl-<random>` and whose title is “Encrypted notebook”; in a service, a folder of that name. In it: one object for each page and attachment, named by a hash (`<32 hex digits>.zseal`), and `index.zseal`, a sealed index that holds the title, the real file names, sizes and SHA-256 sums, and a counter that goes up with each version. Sealing is the engine's (`docs/zim-encrypted-notebooks.md`, *Sealed copies*): ChaCha20-Poly1305 with a key made from the account's master key and the notebook's id. The browser seals before it sends (`SealedRemote`
  is a `Remote`, like the account's and the services', so the sync does not know the difference) and opens what it reads; a connector never sees anything but the objects.
- **Order of writes.** The objects first, the index last, then what is deleted: a reader never finds an index that lists an object that is not there yet (the services do their changes in the order they are given; the account's space and git do them all at once). A page's mark is the SHA-256 of what it says, which is also what the sync makes of its own files, so two devices that wrote the same page agree without being asked.
- **The account's key.** The master key is made by the engine (`seal:master:make`, which checks the vault's passphrase and keeps nothing), sent wrapped by that passphrase (104 bytes: `ZSW1`, the cost, a salt, a nonce, the key under scrypt), and only after the server accepted it does the vault take it in (`seal:master:unwrap`). `GET /api/sync/keychain` answers `{ wrapped, check, updatedAt }` (or `{ wrapped: null }`); `PUT` takes `{ wrapped, check, expect }`, where `expect` is `"none"` (the first key) or the SHA-256 of the key that is replaced:
  a **compare-and-swap**, so that two devices that make a first key at the same moment end with one (the later gets `409` with the key that is there, and takes it with the same passphrase). `check` is 16 bytes of a one-way function of the key (not the key): it lets a device tell that its key is not the account's. The table is `cloud_keys` (one row for each account; deleted with it; in *Download my data* as `sealedKey`);
  60 calls in 10 minutes. A changed vault passphrase wraps the key again, with the same compare-and-swap, when the person is signed in; if it was changed while signed out, a message says so and the menu offers *Update the passphrase of the sealed copies…* (it asks for the new passphrase and the vault checks it).
- **Where the link is.** What says that an encrypted notebook is kept somewhere (the id, the account, the marks, the highest index counter seen) is a hidden note **in the vault**, in the notebook's own space: not in `localStorage` or anywhere else the browser keeps things, read when the vault is unlocked and dropped from memory when it is locked. It is a note like the others, so a backup of the vault carries it (a restored vault would know where its notebooks are kept, for the same account: **not tried**).
- **What the server, or the service, learns.** That the account has a sealed notebook, how many objects and how big each is (a page's exact size plus 32 bytes, so a notebook's shape), when they change, from which address; and the wrapped key. Not a page's name, text or tags, a notebook's title, its layout, or how many pages a section has.
- **What it can do.** Delete or withhold objects (the sync says the copy is missing a page, and stops). Put an older copy back: a device that has seen a newer index says so (“older than one this device has seen”, tested); one that never saw the newer cannot tell. Change an object or put one under another's name: it does not open (the name is part of what is sealed), and an old version of the same page is not the one the index lists (tested, all
  three). Keep every version ever sent (git services keep their history; the account's space and the others keep what they keep), and **try passphrases offline** against the wrapped key at 128 MiB of memory a try: **the strength of the passphrase is the whole defence**, as for the vault.
- **Limits.** The whole index is sealed and sent with each change (about 170 bytes a page: 170 KB at a thousand pages, which is a good part of the account's 1 MB; the quota counts the sealed bytes, a little more than the pages); a WebDAV folder is listed up to 3000 files; the engine seals and opens at most 2000 objects and 64 MiB in a call, so the app goes through a big notebook in groups of 1000 objects and about 16 MiB (a bigger attachment alone), and a sealed notebook can have at most 20,000 files. The master key does not change with the passphrase (it is wrapped again, not replaced), so someone who once had the old wrapped key and the old passphrase can still open it:
  replacing the key (sealing everything again) is not built. **A forgotten passphrase** loses the sealed copies, and this version has no way to start over on an account that has a key nobody can open (a new vault would be asked for the old passphrase): the account's copies can only be deleted by deleting the account. The apps built on Tauri and Capacitor do not sync yet (E17), so their encrypted notebooks are not kept anywhere.
- **Verified.** Browser scenarios, each with a real server and real browsers: the first (two browsers, same account) checks that nothing readable is in the server's database, in any request the browsers made (also as base64), or in either browser's storage, that every object is named by a hash, the notebook by `zsl-…` and “Encrypted notebook”, that the second browser is refused the vault's own passphrase and takes the key with the one that sealed it, pages merge both ways and a page changed on both sides is asked about;
  the second: a lock names nothing and sends nothing, an unlock brings the link back from the vault, a change of passphrase wraps the key again (same key, new wrapping; the old passphrase no longer opens it), a whole old copy put back, an index changed by one bit, a missing object, an old object of the same page, a damaged object and an object under another's name are each refused, and stopping deletes the copy; the third: the same on a WebDAV service, with the index written last; the fourth: typing is sent by itself, an unlock brings in the other device's change, a deleted page deletes its object,
  the second notebook (made from the dialog) asks for no passphrase, a notebook already on the device is not copied twice; the fifth: a passphrase changed while signed out, then updated from the menu; the sixth: a vault with another account's key is told so, and a vault with a key gives it to a new account, wrapped; the seventh: two browsers that make the first key at the same moment end with one; the eighth: a lock in the middle of a change of passphrase leaves the account's key wrapped by the old one, says so without naming anything, and the menu line wraps it again. Server tests (`server/test/sync.test.mjs`) check the key's endpoints, and mutants of the key's code, the sealing remote and the sync UI were run (results in the follow-up document).
  **Not tried against the real thing**: a real Nextcloud, GitHub, GitLab, Dropbox or Google Drive holding sealed objects (only in-memory stand-ins), a phone, Windows, Safari on a Mac (WebKit on Linux was), and any notebook of more than a few hundred pages.

## Connected services (Nextcloud, ownCloud, any WebDAV server) — `server/src/connectors/`

A browser page can't talk to a service of yours (the page's content policy lets it ask only its own server, and those services do not allow it), so **the server does it for the person**.
*Connected services…* in the menu connects one (`POST /api/connectors`): the address of a folder, a user name, an app password. The server **tests them against the service before keeping anything**,
and keeps the settings **sealed** (AES-256-GCM, a key derived from the server's own `secret.key`, never sent back to a page, deleted with the account or with the connection).
Then *Keep this notebook on the server…* offers the account's space (1 MB) or any connected service as **Where**, and *Open a notebook from the server…* lists the notebooks found on each.

- A notebook is a folder of Zim files on the service (`<title>-<random>/Page.txt`, `notebook.zim`, attachments at their paths): Zim itself, or Nextcloud's own sync, can open it. It is stored **in clear**: the dialog says so.
  Unlike the account's space, a service has no 1 MB limit of ours (up to 8 MB a notebook can be fetched, 3000 files).
- Only what changed is written (a digest of each file at the last agreement is kept in the browser's link, next to the service's own version mark of the folder), and a page deleted here is deleted there. The same decision as for the
  account's space applies (send / fetch / both changed → asked), and the server refuses a change made from a version of the folder that is not the service's now (409). *Not atomic*: WebDAV has no way to say “only if nobody wrote”, so two
  devices that write in the same instant can still interleave; the version check shortens that window to the length of one sync.
- **The server calls an address that a person typed**, which is the most dangerous thing it does. So (`safe-fetch.mjs`): https only; the address a name resolves to is checked **when connecting** (and a literal address is judged too: Node
  does not look those up), private, loopback, link-local and reserved ranges refused in both IP versions; no redirect is followed; no password in the address; a time limit, and limits on the size of an answer and of what is sent; folder
  and file names are checked (no `..`, nothing hidden, no more than four levels) before the service is called; connections belong to their owner (another account gets “no such connection”); limits per account. An operator who runs the server inside
  their own network can allow private addresses (`connectorOptions.allowPrivate`, in code or tests only: there is no setting for it in `config.json` on purpose).
- The password is the service's, so a server that is hacked gives it away: **use an app password** (Nextcloud: Settings → Security), revocable without touching the main one.
- Verified by `server/test/connectors.test.mjs` (a WebDAV server in memory; 14 tests, 10 mutants of the guards, the sealing, the version check and the ownership all caught) and the browser scenario "…a connected WebDAV service…" (connect with a wrong
  password refused, then right; keep; open on a second device; only the changed page written; a new page and a deleted page reach the service; a conflict is asked about; stop deletes its files; disconnect from a linked device unlinks it).
  **Not tried against a real Nextcloud or ownCloud** (only the protocol as the fake speaks it: PROPFIND, MKCOL, GET, PUT, DELETE, basic authentication; a real server may answer details differently).
### A GitHub repository (`server/src/connectors/github.mjs`)

*Connect GitHub repository…* takes `owner/name`, a branch (default `main`), a folder of the repository for the notebooks (default `notebooks`, or empty for the top) and a **personal access token**
(best: fine-grained, for that one repository, “Contents: Read and write”; the repository should be **private**, the notebooks are stored in clear). The server checks the repository, the branch and that the token can write before keeping anything,
and keeps the token sealed like a WebDAV password. A notebook is `<folder>/<title>-<random>/…` in the branch.

- **A send is one commit**, made with the Git Data API (the changed files as blobs, a tree on top of the branch's own tree, a commit, then the branch moved *without force*): the rest of the repository is untouched, the history shows one commit
  for each send (“Zim Notebook: Garden-ab12cd (2 written, 1 deleted)”), and **if the branch moved meanwhile GitHub refuses the move**, which is reported as a conflict: unlike plain WebDAV, two devices can't overwrite each other here.
- A change made in the repository itself (editing a page on github.com, a pull) is **fetched at the next sync**, since the folder's version is the content hashes of its files.
- The repository must already have a commit on that branch (a README does); the API's address is `api.github.com`, changeable only by the operator (`connectorOptions.githubApi`, for GitHub Enterprise or tests), never by a user.
- Verified by `server/test/github.test.mjs` (a GitHub in memory with real blobs, trees, commits and a branch that only moves forward; 8 tests; 9 mutants — force push, no read-only check, wrong parent, base tree dropped, conflict not reported, removals dropped, folder ignored,
  branch not checked, token not validated — all caught, a push at the worst moment is not overwritten) and the browser scenario “…kept in a GitHub repository…” (wrong token refused; one commit for the first send; B opens it; one commit for one change; a push made elsewhere
  is fetched by A; stop deletes only the notebook's files, the README stays; disconnect forgets the token). **Not tried against the real GitHub**: rate limits (5000 requests an hour; a send makes one request for each changed file plus five), repositories with
  branch protection or required signed commits (the move would be refused), files over 100 MB, a repository that is empty.

### A GitLab project (`server/src/connectors/gitlab.mjs`)

*Connect GitLab project…* takes the host (`gitlab.com`, or a GitLab of the person's own: only a public https address passes the guard above), `group/name`, a branch, a folder and an access token (scope `api`, Developer role; a project
access token is best). Same model as GitHub: the settings are tested first (project, branch, the role needed to write), the token is sealed, and a send is **one commit** (`POST /repository/commits` with create / update / delete actions, chosen from what
the branch has) that names the commit it was made on top of (`last_commit_id`), so if the branch moved meanwhile GitLab refuses it and the app asks. Long listings are read page by page; a folder that is not there yet is empty; a file already
deleted is not deleted twice. The API's address is `https://<host>/api/v4`, changeable only by the operator (`connectorOptions.gitlabApi`).
Verified by `server/test/gitlab.test.mjs` (a GitLab in memory, listings in pages of two; 8 tests; 11 mutants all caught) and the browser scenario “…kept in a GitLab project…”. **Not tried against a real GitLab** (rate limits, protected
branches, a project with no commit, the exact words GitLab uses to refuse a stale commit: the conflict is recognised from them, so a GitLab that words it differently would show as an error instead of a question).
A review of the validators for this found that a repository named `../..` passed for GitHub and GitLab: a dot segment is now refused in both (a test each).

### Dropbox and Google Drive (`server/src/connectors/dropbox.mjs`, `gdrive.mjs`, `oauth.mjs`, `oauth-token.mjs`)

These two are **allowed in the service's own window**: *Connect Dropbox…* / *Connect Google Drive…* (shown only where this server has an app for them) leaves for Dropbox's or Google's page, the person allows the access there, and the browser
comes back to the app, which says how it went. The server never sees the person's password; it keeps the **refresh token**, sealed like every other connection's settings, trades it for an access token (kept only in memory, renewed when it ends or is
refused) and, when the connection is removed, **tells the service that the access is over** (best effort).

- The window's flow is the authorisation-code flow with PKCE. It is begun by someone who is signed in and finished by the same person in the same browser: a one-use state kept hashed and **bound to the user**, a nonce cookie (`zim-connect`),
  ten minutes. A return that is not the one begun here (another person's state, another browser's cookie, a state used twice) is refused with fixed words and connects nothing (a test makes “Bob begins, Ada's browser finishes”: it would have put
  Bob's Dropbox in Ada's account).
- **Dropbox**: an *app folder* app, so it can see only `/Apps/<the app>`; a notebook is a folder of it. There is no commit across files: a send is a series of uploads, each replacing a file **by the revision that was listed** (`update`) or adding it only if
  absent (`add`), so a file that changed meanwhile is refused as a conflict instead of overwritten — but the files sent before it stay sent. The folder's version is Dropbox's own content hashes.
- **Google Drive**: the narrowest scope there is, `drive.file` (only files and folders **this app** made, never the rest of the Drive). Everything is under a folder "Zim Notebooks" that the app makes; sub-folders are real Drive folders, so the files can be opened
  in Drive. Drive allows two files of one name in a folder: the first is used. A send is a series of calls guarded by the version check (a shorter window than none, not airtight).
- Verified by `server/test/dropbox.test.mjs` and `gdrive.test.mjs` (a Dropbox and a Drive in memory, with listing in pages of two, ids, revisions, multipart uploads, token endpoints that check PKCE and the client's secret, tokens that end and are revoked; 18 tests;
  21 mutants of the drivers, the token cache, the window's checks and the sealing, all caught but one that changes nothing a person could see) and the browser scenarios “…kept on Dropbox…” and “…kept on Google Drive…” (out to the stand-in's window and back,
  an address that is cleaned, a failure that says fixed words, one file written for one changed page, a change made on the service itself fetched, stop deletes only the notebook's files, disconnect tells the service). **Not tried against the real Dropbox or Google**.
- **What you do once, to turn each on** (then restart the server; the buttons appear):
  - *Dropbox*: dropbox.com/developers/apps → **Create app** → *Scoped access* → **App folder** → a name that is not taken. *Permissions*: tick `files.metadata.read`, `files.content.read`, `files.content.write` and submit. *Settings*: copy the **App key** and **App secret**, and
    add the redirect URI `<ZIM_BASE_URL>/api/connectors/oauth/dropbox/callback` (Dropbox accepts `http://` only for `localhost`). An app left in *Development* status can be linked by up to 50 accounts, yours included.
  - *Google Drive*: console.cloud.google.com → a project → **Enable** the *Google Drive API* → *OAuth consent screen* (External) → add the scope `…/auth/drive.file` → *Credentials* → **Create OAuth client ID** → *Web application* → the redirect URI
    `<ZIM_BASE_URL>/api/connectors/oauth/gdrive/callback`. **Careful**: while the consent screen is in *Testing*, Google ends a refresh token after 7 days (the connection then says “connect it again”); `drive.file` is, to my knowledge, a scope that does not need Google's
    review, so the app can be moved to *In production* — check that on Google's own page before relying on it.
  - Then, in `~/.local/state/zim-server/oauth.json` (or `ZIM_DROPBOX_CLIENT_ID` / `ZIM_DROPBOX_CLIENT_SECRET`, `ZIM_GDRIVE_CLIENT_ID` / `ZIM_GDRIVE_CLIENT_SECRET`): `{ "dropbox": { "clientId": "…", "clientSecret": "…" }, "gdrive": { … } }` beside the sign-in apps' entries
    (these are separate apps, with their own ids, from the Google and GitHub sign-in ones).

- Not done: a connected service for the encrypted notebooks' sealed copy, a sync of connected services from the native apps, and other services (the `Connectors` registry, `driver.list/read/write/folders/test` and the client's `Remote` are what a new one plugs into).

## Run it

```bash
cd web && npm run build                      # the files of the app (server/ serves web/dist)
cd ../server && npm install                  # nodemailer
ZIM_BASE_URL=https://localhost:8443 scripts/run.sh start --host :: --port 8443 --tls --name ADDRESS [--download /zim-notebook.apk=../mobile/out/zim-notebook-debug.apk]
scripts/run.sh status | log | stop | restart
npm test                                     # 108 tests: accounts, OAuth against fake Google/GitHub, the HTTP layer, notebook storage
```

`ZIM_BASE_URL` is the address people **type**: the services send the browser back to it, and it decides `Secure` cookies. From your own computer to this
server, use an SSH tunnel (`ssh -L 8443:127.0.0.1:8443 you@this-server`, then `https://localhost:8443`): Google accepts `localhost` as a redirect address,
a bare IP it does not. The data (SQLite file, the key for codes, `outbox.jsonl`) is in `~/.local/state/zim-server` (`ZIM_SERVER_DATA`).

### Mail

With no SMTP settings the codes that would be mailed are **written to `~/.local/state/zim-server/outbox.jsonl`** (to try it: `tail -n1 outbox.jsonl`). To send them for real set
`ZIM_SMTP_HOST`, `ZIM_SMTP_PORT`, `ZIM_SMTP_SECURE=1` (port 465), `ZIM_SMTP_USER`, `ZIM_SMTP_PASS`, `ZIM_MAIL_FROM`, or the same in `config.json`'s `smtp` and `mail.from`.
Sending e-mail from a home or VPS address without SPF/DKIM lands in spam; use a relay (the provider's SMTP, Brevo, …) once this is for other people.

### Register the sign-in apps (you do this once; the secrets stay in this folder)

Callback address for each: `<ZIM_BASE_URL>/api/oauth/<provider>/callback`, e.g. `https://localhost:8443/api/oauth/github/callback`.

- **GitHub**: Settings → Developer settings → OAuth Apps → *New OAuth App*. Homepage `https://localhost:8443`, callback as above. Copy the Client ID, generate a Client secret. (GitHub allows one callback per app: make another app for another address.)
- **Google**: Google Cloud console → *APIs & Services* → *OAuth consent screen* (External, testing is enough for a handful of people you add as test users) → *Credentials* → *Create OAuth client ID* → Web application, *Authorised redirect URI* = the callback above. Scopes asked: `openid email profile`.

Then `~/.local/state/zim-server/oauth.json` (mode 600), or the environment (`ZIM_GITHUB_CLIENT_ID`/`ZIM_GITHUB_CLIENT_SECRET`, `ZIM_GOOGLE_…`):

```json
{ "github": { "clientId": "…", "clientSecret": "…" }, "google": { "clientId": "…", "clientSecret": "…" } }
```

A button appears in the sign-in dialog only for a service that is set up.

## What verifies it, and what does not

- `server/test`: 108 tests with a real HTTP server, cookies, a clock the test moves, and stand-ins for Google and GitHub; mutants of the HTTP layer (a check removed, `HttpOnly` dropped, the body limit off, a session not replaced, …) are caught.
- The browser scenario "with an account server…" (`npm run test:browser`): the real server serves the real app; an account is made with the code read from the mailer, a wrong code and a wrong password are refused, the session survives a reload and is not readable by script, sign out and in, a GitHub round trip (stand-in service) and a failed one that echoes nothing of the address.
- **Not verified**: a real Google or GitHub sign-in (needs your apps), real SMTP delivery, more than one process, any load. The server has had no outside review.

## Not yet

A way to start over when the passphrase of the sealed copies is forgotten (E16i), a recovery that does not need the passphrase (decided against), login from the native apps, Facebook / LinkedIn / Microsoft / GitLab sign-in, an admin view, a "sign out everywhere" button, changing the password from the account dialog (the server has it).
