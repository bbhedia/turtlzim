# The account server

`server/`: a Node 24 program (no framework; `node:sqlite`, `node:crypto`, and `nodemailer` for SMTP) that serves the web app **and** `/api/`, in one
process. It exists so that a person can have an **account**; an account is optional, and without one nothing changes: notebooks stay on the device.
**Today an account only exists** (sign-up, sign-in, sign-out, export, delete). Keeping notebooks on the server (1 MB per user), encrypted or not, and
the connectors (Dropbox, Google Drive, …) are later steps (`docs/zim-cloud-feasibility.md`, roadmap lots 3 to 6). Decided 2026-10-15: Google and GitHub
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

## Run it

```bash
cd web && npm run build                      # the files of the app (server/ serves web/dist)
cd ../server && npm install                  # nodemailer
ZIM_BASE_URL=https://localhost:8443 scripts/run.sh start --host :: --port 8443 --tls --name ADDRESS [--download /zim-notebook.apk=../mobile/out/zim-notebook-debug.apk]
scripts/run.sh status | log | stop | restart
npm test                                     # 41 tests: accounts, OAuth against fake Google/GitHub, the HTTP layer
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

- `server/test`: 41 tests with a real HTTP server, cookies, a clock the test moves, and stand-ins for Google and GitHub; mutants of the HTTP layer (a check removed, `HttpOnly` dropped, the body limit off, a session not replaced, …) are caught.
- The browser scenario "with an account server…" (`npm run test:browser`): the real server serves the real app; an account is made with the code read from the mailer, a wrong code and a wrong password are refused, the session survives a reload and is not readable by script, sign out and in, a GitHub round trip (stand-in service) and a failed one that echoes nothing of the address.
- **Not verified**: a real Google or GitHub sign-in (needs your apps), real SMTP delivery, more than one process, any load. The server has had no outside review.

## Not yet

Sync of notebooks (and the 1 MB quota, now only a number), encrypted copies with a passphrase, connectors, login from the native apps, Facebook / LinkedIn / Microsoft / GitLab sign-in, an admin view, a "sign out everywhere" button, changing the password from the account dialog (the server has it).
