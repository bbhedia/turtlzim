# The account server

`server/`: a Node 24 program (no framework; `node:sqlite`, `node:crypto`, and `nodemailer` for SMTP) that serves the web app **and** `/api/`, in one
process. It exists so that a person can have an **account**; an account is optional, and without one nothing changes: notebooks stay on the device.
Accounts can keep **open notebooks on the server, in clear**, in step with other devices (below; 1 MB per user). A sealed copy of the encrypted notebooks (below) and
connected services (Nextcloud / WebDAV; Dropbox, Google Drive, GitHub, GitLab are later steps (`docs/zim-cloud-feasibility.md`, roadmap lots 3 to 6). Decided 2026-10-15: Google and GitHub
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
| `PUT /api/sync/notebooks/<id>` | replace its files; `{title, baseRevision, files}`; `baseRevision` is the revision the copy was made from (0 for a new notebook) |
| `DELETE /api/sync/notebooks/<id>` | remove it |

A write made from an old revision is refused (`409`, with the current revision): nothing is overwritten, the client has to merge. Over the quota (1 MB for the notebooks together; a notebook may use all of it when it
replaces its own files) is `413`. Paths are checked (relative, no `..`, nothing hidden, no two that differ only by case) and ids are `[A-Za-z0-9_-]{8,64}`. The files are stored **in clear**: encryption with a passphrase is the next
lot, and until then an account's notebooks are readable by whoever runs the server. Each person only ever sees their own (a test with two accounts and the same id), and deleting the account deletes them.

## Keeping a notebook in step (the app's side: `web/src/account/sync.ts`, `sync-ui.ts`)

With an account, the notebook menu has **Keep this notebook on the server…** (an open notebook only: an encrypted one is never offered, a test checks the menu), **Sync this notebook now**,
**Stop keeping this notebook on the server…** (with the choice to delete the server's copy) and **Open a notebook from the server…** (copies it to this device and links it).

- What is kept is the notebook as its **files** (the same ones the zip export makes: `notebook.zim`, pages with their byte-order mark and line endings, attachments). The dialog says that it is stored in clear.
- A linked notebook remembers, in this browser (`zim:sync:<notebook id>`: two ids, a revision, a digest and the account's address, nothing of the content), the revision it last agreed with the server on and a SHA-256 of its files then.
  From that and the server's revision now there is one answer: nothing to do, **send** (only this device changed), **fetch** (only the server did), or **both changed**.
- Sending is automatic 6 s after the last change; fetching happens at start (for a linked notebook) and on *Sync now* — never while typing is unsaved. Both changed: a question (*Use the server's copy* / *Keep this device's copy* / Cancel),
  and nothing is touched until it is answered; the server also refuses a write made from an old revision (409), so a race between two devices can't overwrite either.
- A link belongs to the account that made it (a different account signed in on the same browser does not see it); a notebook that the server no longer has is unlinked, not recreated.
- Not there: merging two versions of a page (one copy replaces the other, and the dialog says the other's pages are lost), per-page sync (a notebook is sent whole, so 1 MB is the whole account), several destinations, and sync for folder notebooks of the desktop program or the phone shell (no account there yet).
- Verified by the browser scenario "with an account server a notebook is kept on it…": two browsers, one account, the real server: keep, open on the second, write on each way, both changed (each of the two answers), sending by itself, an encrypted notebook has no line about the server, stop keeping. Mutants (conflicts overwriting, an encrypted notebook offered, no automatic send) are caught.
  Not tried: a flaky network half way through a send, two tabs of one browser on one notebook, a real phone.

## The encrypted notebooks on the server (`web/src/account/sealed.ts`)

Encrypted notebooks are **never** sent as pages (the notebook menu has no *Keep on the server* for them). What an account can do with them is keep **the vault's own backup**
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
- **Not done**, from the study (§6): sealing each file separately with a key hierarchy (master key wrapped by the passphrase, a recovery key, hidden names) so that encrypted notebooks could **sync** page by page between devices, and a vault-wide passphrase for an account that is not the account's password. That needs new commands in the Rust core (`LOCAL_COMMANDS`), shared test vectors for native and wasm, and a merge rule; it is the next step if sync of encrypted notebooks is wanted.

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
- Verified by `server/test/connectors.test.mjs` (a WebDAV server in memory; 13 tests, 10 mutants of the guards, the sealing, the version check and the ownership all caught) and the browser scenario "…a connected WebDAV service…" (connect with a wrong
  password refused, then right; keep; open on a second device; only the changed page written; a new page and a deleted page reach the service; a conflict is asked about; stop deletes its files; disconnect from a linked device unlinks it).
  **Not tried against a real Nextcloud or ownCloud** (only the protocol as the fake speaks it: PROPFIND, MKCOL, GET, PUT, DELETE, basic authentication; a real server may answer details differently).
- Not done: Dropbox, Google Drive, GitHub, GitLab (each needs OAuth apps of yours, or a token, and its own driver: the `Connectors` registry, `driver.list/read/write/folders/test` and the client's `Remote` are what they plug into), connecting a service
  for the encrypted notebooks' sealed copy, and a sync of connected services from the native apps.

## Run it

```bash
cd web && npm run build                      # the files of the app (server/ serves web/dist)
cd ../server && npm install                  # nodemailer
ZIM_BASE_URL=https://localhost:8443 scripts/run.sh start --host :: --port 8443 --tls --name ADDRESS [--download /zim-notebook.apk=../mobile/out/zim-notebook-debug.apk]
scripts/run.sh status | log | stop | restart
npm test                                     # 49 tests: accounts, OAuth against fake Google/GitHub, the HTTP layer, notebook storage
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

- `server/test`: 49 tests with a real HTTP server, cookies, a clock the test moves, and stand-ins for Google and GitHub; mutants of the HTTP layer (a check removed, `HttpOnly` dropped, the body limit off, a session not replaced, …) are caught.
- The browser scenario "with an account server…" (`npm run test:browser`): the real server serves the real app; an account is made with the code read from the mailer, a wrong code and a wrong password are refused, the session survives a reload and is not readable by script, sign out and in, a GitHub round trip (stand-in service) and a failed one that echoes nothing of the address.
- **Not verified**: a real Google or GitHub sign-in (needs your apps), real SMTP delivery, more than one process, any load. The server has had no outside review.

## Not yet

Merging two versions of a page (today one copy replaces the other), the Dropbox / Google Drive / GitHub / GitLab connectors, login from the native apps, Facebook / LinkedIn / Microsoft / GitLab sign-in, an admin view, a "sign out everywhere" button, changing the password from the account dialog (the server has it).
