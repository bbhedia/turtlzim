# Running the account server: backups, checks, load, and what to do when it goes wrong

(E20a. The server itself, its API and its connectors are in `docs/zim-server.md`; this is what a person who *runs* it needs. Everything here is in `server/`.)

## What the server keeps

All of it is in one folder: `ZIM_SERVER_DATA`, else `~/.local/state/zim-server`. **For its owner only**: the server makes the folder 700 and the database and its journal files 600 every time it starts, whatever mode it finds them with, and `scripts/run.sh` does the same for its state folder (that is where the log is). This was added after the live server's data was found on 22 October with the folder at 775 and the database at 644 (SQLite makes a file readable by everyone, and a folder made by a script has its umask's mode): any other user of the computer could have read every account and every notebook kept in clear. A folder that the server is not the owner of is left as it is, and then who may read it is the owner's to say.

| File | What it holds | Is it in a backup |
|---|---|---|
| `zim.sqlite` (`-wal`, `-shm` while it runs) | the accounts (addresses, scrypt hashes of passwords), sessions and apps' tokens (only their hashes), the open notebooks kept on the server **in clear**, the encrypted notebooks kept sealed (ciphertext and the account's wrapped master key), the connected services' settings (sealed), codes, counters of the limits | yes |
| `secret.key` | the key the codes are made with, **and** the key (derived from it) that seals the connected services' settings | yes |
| `config.json`, `oauth.json` | what it was told: its address, SMTP settings, the ids and secrets of the sign-in apps | yes (the ones that exist) |
| `outbox.jsonl` | the codes that would have been mailed, when no SMTP server is set up | no (it is a mailbox, not state) |
| `serve.log`, `serve.log.1` to `.3`, `serve.pid`, `serve.args` | the log, and what `scripts/run.sh` needs to restart the server as it was | no |
| `backups/`, `replaced-<date>/` | the copies, and what a restore put aside | no |

The TLS certificate that `--tls` makes is not here (it is `web/scripts/serve.mjs`'s, in `~/.local/state/zim-web/tls`): a new one is made if it is lost, and the apps that pinned the old one ask the person again (`docs/zim-server.md`, *A server that the apps don't know the certificate of*).

## Backups

```bash
cd server
scripts/run.sh backup [--to DIR] [--keep N]   # a copy now; the server may be running; the oldest beyond N (14) are removed
scripts/run.sh backups                         # the copies there are, and whether each is whole
scripts/run.sh verify BACKUP-FOLDER            # is this copy whole?
```

(The same as `node src/backup.mjs backup|list|verify|restore …`; `scripts/run.sh` adds the data folder, and for a restore it stops and starts the server.)

What a backup is:

- **A folder** `zim-backup-<UTC date>` (`zim-backup-20261022T031700Z`, so the names sort by date) in `backups/` of the data folder, or in `--to`, with a copy of the database, of the key and of the settings, and a `manifest.json`.
- **The database is copied while the server runs.** `VACUUM INTO` reads it in one transaction, so what is copied is one moment: no write can half change it (a test has another process write accounts, notebooks and files as fast as it can while eight copies are made, and every copy has each table at the same moment). The copy is compacted too (free pages are not copied).
- **The manifest says what the copy is**: for each file its size and SHA-256, the version of the tables, and how many rows each table holds. `verify` reads it back: every file there with that size and that SHA-256, nothing listed that is not one of the server's own files (a manifest does not get to name a path), SQLite's own `integrity_check`, no row that points at a row that is not there, and the same version and counts as the manifest.
- **A copy is checked before it counts.** A copy that does not pass is removed and the command fails (exit 1, the reason on the output), and **the older copies are removed only after the new one passed**, so a bad night does not push out a good copy. Only folders named as a backup is, that have a manifest, are ever removed: anything else in `backups/` is yours.
- **For its owner only**: folders 700, files 600, even if `backups/` was there before with another mode.

To make it happen every night, a cron line (`scripts/run.sh` finds Node itself when cron's shell has none, as `ssh host command` does not load nvm either):

```cron
17 3 * * *  cd /home/USER/projects/turtlzim/server && scripts/run.sh backup >> ~/.local/state/zim-server/backup.log 2>&1
```

A backup in the data folder's own disk is **not** a backup against losing the disk: copy `backups/` somewhere else, and read the next section before doing it. (Not set up: that copy, a scheduler that tells someone when `backup` exits 1. Both are yours to add; nothing here does them.)

### What a backup holds, and so how secret it is

As secret as the data folder is, and it is the whole of it: the addresses of everyone, the scrypt hashes of their passwords (slow to guess, not impossible for a weak password), **the notebooks kept in clear on the server**, the sealed notebooks (ciphertext, and a master key wrapped by each person's passphrase: useless without it, and guessable only as far as the passphrase is weak: the wrapping is the core's scrypt at 128 MiB), and **the connected services' tokens and app passwords together with the key that opens them**. So a copy that leaves the machine leaves encrypted (`age`, `gpg`, a disk that is encrypted: your choice), and a copy that is lost is an incident (below).

### A restore drill

A backup that was never put back is a hope. The commands never touch the live data unless they are told to: to try a copy out, restore it **into a folder of its own** and start a second server on it:

```bash
drill=$(mktemp -d)
node src/backup.mjs restore ~/.local/state/zim-server/backups/zim-backup-… --data "$drill"
ZIM_SERVER_DATA="$drill" ZIM_BASE_URL=http://127.0.0.1:9000 node src/main.mjs --host 127.0.0.1 --port 9000 &
curl -s http://127.0.0.1:9000/api/health          # {"ok":true}
```

## Restore

```bash
scripts/run.sh restore BACKUP-FOLDER     # looks at the copy first; stops the server; puts the copy back; starts it again (if it was running)
```

In that order, and each step is a reason that nothing is lost:

1. **The copy is verified first.** A copy that is not whole is refused **before the server is stopped** (`NOT whole: …`, exit 1).
2. The server is stopped. (`node src/backup.mjs restore` on its own refuses while the pid file in the data folder names a running server; if `ZIM_SERVER_DATA` points somewhere other than the state folder, the pid file is not beside the data and that check cannot see the server: use `scripts/run.sh restore`, which stops it first.)
3. **What is there now is not deleted**: the database (and its `-wal` and `-shm`, which belong to the old database and are not to be applied to the new one), the key and the settings are *moved* to `replaced-<date>/` in the data folder (two restores in one second do not write over each other's). Delete those folders by hand when you are sure; nothing does.
4. The copy's files are put in place (each written beside its place and renamed, so a cut short copy never has the name of a whole one), the restored database is checked, and the server is started.
5. **If anything fails after step 3**, what was moved is put back, the restored files are taken away, and the server is started again on what it had. The message says so.

What a restore means for the people: everything since the copy is gone (accounts made, notebooks sent, a changed password), and a person's notebook that has since changed on their device is *newer than the server's*. **What the apps do about a server that goes back in time was not tried.** The sync asks when both sides changed and never overwrites, so the expectation is a question about the pages that differ; it is an expectation, not an observation.

## Is it up?

```bash
scripts/run.sh check      # exit 0: it answers, and so does its database; 1: it does not (and the end of the log); 3: it is not running
```

`check` asks `/api/health` at the first address that the server printed when it started (`curl -k`: the question is whether it answers, not whether its certificate is trusted). `/api/health` answers `200 {"ok":true}` only if the database answers a query, and `503 {"ok":false}` if it does not: that is what a monitor outside should ask (it does not ask for a session and says nothing about anyone). It does not say that the database is *sound* (that is what `verify` says of a copy). **Nothing watches it yet**: a monitor that calls `check` or the address and tells someone is not set up.

## Updating, and going back

```bash
cd server
scripts/run.sh backup                                  # first: a newer server changes the tables when it starts
git pull && (cd ../web && npm ci && npm run build) && npm ci && npm test
scripts/run.sh restart && scripts/run.sh check
```

The server brings its database up to date when it starts, **in one direction**: an older server refuses a database that a newer one made (`the database was made by a newer server`). So going back is two things: the code (`git checkout` the version that was running) **and** `scripts/run.sh restore` of the copy made just before the update.

One server process per data folder. Two on the same folder is not supported (it was never tried).

## The log

`serve.log`: one line per request (the time, the address the request came from, the method, the path, the status) and what the server says when it starts and when something fails (a stack for an error that was not the person's). For `/api/` requests **the query is not logged** (a sign-in's return carries a code and a state), and the names of pages are in the *bodies* of the sync's requests, not its addresses (`/api/sync/notebooks/<id>/…`), so they are not in the log; the log does hold the addresses that people come from, which is personal data (`docs/zim-cloud-feasibility.md`, on what a public service has to say about it). Behind a proxy it is the proxy's address (the log does not read the proxy's header; the limits do, with `ZIM_TRUST_PROXY`).

At every start of `scripts/run.sh`, a log over 5 MiB (`ZIM_LOG_MAX_BYTES`) is moved to `serve.log.1`, the older ones to `.2` and `.3`, and the oldest is dropped: about 20 MiB at most. (Only at a start: the running server holds the file open. A server that runs for months grows its log until the next start.)

## Passwords are hashed a few at a time

A password costs the server on purpose (scrypt: 32 MiB and tens of milliseconds), and a crowd of strangers signing in with passwords that are wrong still has the server pay for every one. Left to Node's thread pool (four at a time) that fills every processor, and the people who are only keeping their notebooks in step wait behind it. So (`server/src/passwords.mjs`):

- **half of the processors do it** (one at least; on the 2-processor machine this was measured on, one), and the next ones wait their turn in order;
- when **64 are waiting**, the next is turned away at once with `503`, `Retry-After: 5` and `{ "code": "busy", "retryAfter": 5 }`, instead of being answered a long time late.

Both are settings: `ZIM_HASH_SLOTS` and `ZIM_HASH_QUEUE` (or `hashSlots` and `hashQueue` in `config.json`; the environment wins), each a whole number of at least 1, else the server does not start and says which. What is in force is the line *Passwords are hashed N at a time, and M may wait for their turn* that the server prints at its start. A place holds about 32 MiB while it hashes, so on a host with little memory the first is the one to keep low; on a host with many processors it can be raised, and then more people can sign in at once. A check of a password never turns a busy server into a wrong password: the server says it is busy. The web app shows the server's sentence (*The server is busy: try again in a moment.*) as it shows any refusal; the desktop program and the Android app carry the same answer, and **neither was tried with a busy server**.

That is a limit on how many people can sign in *at once*; what keeps one person (or one address) from trying too often is the per-address and per-account limits that were already there (`src/limits.mjs`).

## What it costs: measured

`scripts/load.mjs` starts the server as a program on a data folder of its own (never the live one) and drives it over HTTP with virtual people who each sign up, sign in, and keep a notebook in step the way the app does; `--storm N` adds N sign-ins from N strangers, all at once. It is how the limiter above was found to be needed.

```bash
node scripts/load.mjs --users 20 --files 60 --bytes 2000 --seconds 20 [--storm 100] [--ramp 16] [--json]
```

The numbers below were taken on 22 October 2026 (a request is one of the five in a round; each person's round is *who am I, list, manifest, send three files, read three files*, then 50 ms of rest):

| People | Rounds per second | Median request | 95th percentile | The server's peak memory |
|---|---|---|---|---|
| 6 (60 files each) | 92 (the rest between rounds is what limits it) | 1.7 to 3.0 ms | 6 to 7 ms | 99 MiB |
| 20 (60 files each) | 176 | 10 to 11.5 ms | 24 to 27 ms | 114 MiB |
| 100 (20 files each) | 229 (about 1,150 requests per second: the server's one processor is full) | 66 to 68 ms | 124 to 134 ms | 103 MiB |

People who never rest for more than 50 ms are far more than 100 real ones. **Signing up and signing in cost one password each, and that is the slow part**: about 7 per second here (one place; each is about 135 ms of a processor), and the first request of a person that follows it is as quick as any other.

**A storm** (`--storm 100`: a hundred strangers sign in at the same moment, each from an address of their own and with a password that is wrong; twenty people are keeping notebooks in step meanwhile). The request that is watched is *who am I*, from the people who were there:

| | before the storm | during it | 95th percentile during | worst during | the storm itself | peak memory |
|---|---|---|---|---|---|---|
| four at a time and nobody turned away (`ZIM_HASH_SLOTS=4 ZIM_HASH_QUEUE=1000`: what Node's thread pool did, before the limiter) | 11.0 ms | **45.7 ms** | 93 ms | 133 ms | 11.0 s, all 100 answered 401 | 227 MiB |
| the defaults (one at a time, 64 may wait) | 10.6 ms | **19.9 ms** | 45 ms | 180 ms | 12.9 s: 65 answered 401, **35 turned away 503** | 139 MiB |

A second run of each gave the same picture (about 16 to 20 ms with the limiter, 35 to 46 ms without). So the middle and the bad end of what the people already there feel are about halved and the memory is lower; the single worst request is not better (it is noise at that size), and **35 of the 100 strangers were turned away**, which is the point. A person who signs in during a storm may be told to try again.

The load tool lets people in a few at a time (`--ramp`, 16 by default): a hundred at the same instant is more than the limiter accepts (one place and 64 waiting), and the tool used to fail for that reason, which is how it was found that a crowd of 100 sign-ups at one instant is partly turned away.

**What these numbers are and are not.** One machine with 2 processors and 7 GB of memory, **the load tool on the same processors as the server** (so they are worse than a server alone would show), one server process, a disk that is a plain file system, HTTP over this computer's loopback, no TLS, no proxy, requests that arrive when the previous one is answered. They say how the *code* behaves when it is pushed (the memory stays between 100 and 140 MiB with the limiter's defaults, and was 227 MiB with four hashes at a time; a crowd of sign-ins slows the others by half, not to a stop), and they are what to run again after a change that could make it slower. They are **not** the numbers of the shared hosting this is meant to run on (`docs/zim-cloud-feasibility.md`): that host has its own processors, its own disk, its own limits on processes and memory, and a proxy in front, and has not been measured.

## If a backup or the data folder leaks

A plan on paper: **it was never rehearsed**, and there is no admin view to do it with, so most of it is asked of the people.

1. **What the thief has**: everything in the first table that is not sealed by a passphrase they don't have. That is the clear notebooks, the addresses, the hashes of the passwords, the ciphertext of the sealed notebooks (and what a weak passphrase gives away), and the connected services' tokens and app passwords **with the key that opens them**.
2. **Tell the people**: their open notebooks kept on the server were exposed; they should change their password (and their passphrase, for a vault whose passphrase was weak).
3. **The connected services**: the thief can use their tokens and app passwords. A person who removes a connection in the app makes the server forget its settings, and, for **Dropbox and Google Drive**, also end the access at the service (it opens the settings that it holds to do it): so **have people disconnect those while the server still has its key**. A **GitHub or GitLab token** and a **WebDAV or Nextcloud app password** are only forgotten by the server, never ended: each has to be revoked at the service itself.
4. **Then change the key**: stop the server, move `secret.key` aside, start it (a new key is made). Codes in flight stop working, and **every connection that was left stops working** (it answers an error, the person removes it and connects again): the old key is the only thing that opens their settings, and the access at the service is **not** ended by this. So do it after step 3, not instead of it.
5. A leak of **a backup** is a leak of the data folder (the same files); the sign-in apps' secrets in `oauth.json` are in it too, so also make new ones at Google and GitHub and put them in `oauth.json`.

## What verifies it, and what does not

- `server/test/backup.test.mjs` (23 tests): a copy that opens and says what the original says while a second process writes; every way of not being whole (a byte changed, cut short, a file gone, a manifest that is not what it was or names a path, a table and its index that disagree, a row that points at nothing); only a backup's own folders are removed; a restore keeps what it replaces, refuses while the server runs, and puts back what it moved when it fails; the command line.
- `server/test/run-script.test.mjs`: `scripts/run.sh` as a person uses it, on a state folder of its own: start, `check`, a backup while it runs, a restore that stops and starts it (and one that refuses a copy that is not whole before stopping anything), and the log moved aside.
- `server/test/hashing.test.mjs`: at most the places, in order, a failed hashing gives its place back, the turned-away request is answered 503 with its time and takes no place, the defaults are what a server has when it starts (a process of its own), and the API says so. `config.test.mjs` and `startup.test.mjs`: the settings (a wrong one stops the start and says which) and the line the server prints.
- `server/test/load.test.mjs`: the load tool runs a small round and reports, and lets people in a few at a time.
- `server/test/db.test.mjs`: the database file and its journal files are 600, new or found at 644 (with the journal of a server that was killed, which holds rows that are not in the file yet); the data folder and the state folder of `scripts/run.sh` are 700 (in `config.test.mjs` and `run-script.test.mjs`).
- **Mutants** (75, each a small change to the code that a test has to notice): 32 in the backup code, 12 in the limiter, 2 in the health route, 9 in `scripts/run.sh`, 14 in the settings, the start and the load tool, and 6 in the modes of the files. **All are caught.** The first runs found four that were not (the database's own check, a folder that only looks like a backup, a folder of backups that was there before and not private, and a default written in two places of which the test reached one); each is now a test or one definition.
- **Not verified**: a restore on the real OVH host; a backup copied off the machine and restored from there; what the apps do when the server goes back in time; the busy answer in the desktop program and the Android app; any real traffic; alerts; an outside review of the server (still to do before other people are given accounts).
