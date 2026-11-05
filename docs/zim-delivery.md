# Delivery: dev, staging, production

How a change gets from the working tree to the machines that run it, and what verifies each step. One developer, Git trunk-based on `master`, three environments:

| environment | where | ports: https, then http that only redirects | what triggers it |
|---|---|---|---|
| **dev** | the developer's computer (the working tree; a durable instance of the account server serves it, for looking at the interface) | **8144**, **8181** | by hand |
| **staging** (beta) | a test machine on the local network (`alchemyserver`), shared with other applications | **8244**, **8281** | a green push to `master`, **pulled** by the machine |
| **production** | not chosen yet: Railway, or an alternative in the EU | with the host | a tag `vX.Y.Z` |

The ports are fixed on purpose: the origin of the web app includes its port, and a browser keeps local notebooks and the vault per origin, so a port that changes is a place that changes (and the native apps pin the certificate again and sign in again). The second port of each is the plain-http one that only redirects to https (`--redirect-port`, `docs/zim-server.md`). On the developer's computer other projects have ports of their own (8081 to 8084, and some on the loopback: `ss -ltn` says which are taken): none of them is used here (8081 in particular is taken). There is no beta of this project on the developer's computer: staging is `alchemyserver`.

What is delivered is the account server and the web app it serves. The installers (Linux, Windows), the APK and the iPhone app are *published*, not deployed: `desktop.yml` makes them on every change of `web/`, `core/` or `desktop/`, and a draft release on a tag `v*`.

## The workflows (`.github/workflows/`)

| file | when | what |
|---|---|---|
| `ci.yml` | a pull request to `master`; and called by the two below | the web app (wasm, type-check, Vitest, build, the service worker's list) and the server's tests; keeps `web/dist` as an artifact |
| `cd-beta.yml` | a push to `master` that touches `web/`, `core/`, `server/` or the release's own script | `ci.yml`, then the signed release put in the GitHub pre-release `beta` |
| `cd-production.yml` | a tag `vX.Y.Z` | `ci.yml`, the release of that version kept as an artifact, and a last job for the hoster that does not run until the repository variable `PRODUCTION_TARGET` is set |
| `desktop.yml` | as before | the installers, the iPhone app, the draft release on a tag |

Two rules that come from experience, not from taste: **the delivery of the server never waits for a macOS, Windows or Tauri job** (on 2 November the iPhone job did not get a macOS machine and was cancelled; had it guarded the delivery, nothing would have been delivered), and **`web/dist` is built once and shipped as it was built**, because the app's service worker lists every file with its SHA-256 (`docs/zim-pwa.md`): a rebuild elsewhere would not give the same bytes. The cost is that a push to `master` builds the web app twice, once in `desktop.yml` and once in `cd-beta.yml`; they run side by side, and it is free for a public repository.

## How the staging machine is updated (pull)

Nothing is sent to the machine: no SSH from GitHub, no port opened for it, no secret of the machine in GitHub. It comes and looks.

1. **CI publishes.** `cd-beta.yml` makes the release (`scripts/deploy/make-release.mjs`): `turtlzim-beta.tar.gz` (the server with its production dependencies, the one file of `web/scripts` that it imports, `web/dist`, and a `RELEASE.json`), `turtlzim-beta.json` (the manifest: format, channel, commit, build time, the Node it needs, the service worker's SHA-256, the archive's name, SHA-256 and size) and `turtlzim-beta.json.sig` (the manifest's signature). They go into the pre-release `beta` of the repository, replaced on every green push: the archive first, then the signature, then the manifest. For the second or two that takes, a machine that looks finds files that do not agree, refuses them, and looks again at its next look.
2. **The machine looks** every five minutes (`turtlzim-update.timer`, with up to a minute of random delay: another application of the machine does the same). `scripts/deploy/turtlzim-update.mjs` (one file, Node's own modules only) reads the manifest and the signature from `github.com/<repo>/releases/download/beta/` (a public repository: no token, and never the API, whose unauthenticated limit is 60 calls an hour per address), and, in this order, stops at the first thing that is not right, with nothing changed up to there:
   - the pause file (`/etc/turtlzim/pause`);
   - **the signature**: `ssh-keygen -Y verify` with the public key in `/etc/turtlzim/allowed_signers`, in the namespace `turtlzim-beta`. A manifest that was changed by one byte, signed by another key, or signed for another use is not installed (exit 3);
   - the manifest's contents (format, channel, commit, the Node it needs, the archive's description: exit 4 if it is signed but not understood);
   - whether it is already the version that is here, or one that already failed here (it is not tried every five minutes: it waits for a newer one);
   - **the archive**: its size and SHA-256 are those that the *signed* manifest gives (exit 3 otherwise);
   - the archive unpacked beside the others (`/opt/turtlzim/releases/<12 characters of the commit>`), and checked for what the server cannot do without;
   - **a backup** of the real data (`server/src/backup.mjs`, the running version's own tool, checked before it counts);
   - **the new version started on a copy of that backup**, in a clean environment (none of the real settings or secrets), on ports that nobody has, over https as it will be: if it comes up, answers, and its http port redirects, it can go on. A database that its migrations cannot take, a file missing from the archive, a Node that is too old stop the update here, **with no downtime**;
   - then `current` is pointed at it (in one step), the unit is restarted, and the server is asked: `/api/health`, the service worker that it serves (the very build that the manifest names), and the http port that redirects;
   - if the server does not answer as it should: `current` is pointed at the old version again; if that does not answer either, **the backup is put back** (what a new version's migrations changed in the database is what the old one may refuse) and the old version is started on it; if even that fails, a person is needed (exit 5, and the backup's path is in the status).
3. **What it did** is in `/opt/turtlzim/status.json` (outcome, commit, detail) and in the journal. Exit status: 0 nothing to do or done; 1 it failed and the machine was put back; 3 what was found is not ours; 4 refused, nothing changed; 5 a person is needed. The three newest versions are kept.

An update is not free of cost to the data: if the new version fails *after* its migrations ran, restoring the backup loses what was written in between (a minute or so of a test machine's life). It is the price of a way back that always works. `docs/zim-operations.md` has the same rule for a machine updated by hand.

## The key that signs

The machine installs only what a key says is ours. The key is an ed25519 pair made for this and for nothing else; the private half is in GitHub, the public half is on the machine, and no other copy of the private half should exist.

```bash
ssh-keygen -t ed25519 -N '' -C turtlzim-beta -f turtlzim-beta-signing   # on any computer
```

1. In the repository's settings, **Environments > New environment: `beta`**; under *Deployment branches*, choose *Selected branches* and add `master` (then no other branch's workflow can read the secret). Add the secret **`BETA_SIGNING_KEY`** with the whole content of the file `turtlzim-beta-signing` (the private one).
2. Give the machine the **public** file, `turtlzim-beta-signing.pub`, as `--signer-pub` (below). The provisioning script refuses a private key.
3. Delete the private file from the computer where it was made.

To change the key: make another pair, change the secret, run the provisioning script again with the new `.pub`. Until the secret is set, `cd-beta.yml` stops at its publish step with an error that says so, and publishes nothing.

| where | name | kind | what | read by |
|---|---|---|---|---|
| environment `beta` | `BETA_SIGNING_KEY` | secret | the private half of the signing key | the publish job of `cd-beta.yml` |
| repository | `PRODUCTION_TARGET` | variable | which hoster production goes to (empty: nothing is delivered) | the last job of `cd-production.yml` |
| environment `production` | to be defined | | what the hoster's step needs, once it is chosen | that step |

Nothing of the staging machine (its address, a port, an account) is in GitHub: nothing connects to it.

## Putting the staging machine in place

Once, by a person, with `sudo`, after reading the script. The machine is shared (another project's staging lives on it), so the script makes only what is named `turtlzim` and never changes what is not: it installs no package, and does not touch sshd, fail2ban, Docker, the time zone, the other rules of ufw, or switch ufw on.

```bash
# copy scripts/deploy/ to the machine, then there:
sudo bash provision-turtlzim.sh --dry-run --signer-pub turtlzim-beta-signing.pub \
     --base-url https://YOUR_PUBLIC_ADDRESS:8244 --name YOUR_LAN_ADDRESS --name YOUR_PUBLIC_ADDRESS    # says everything, changes nothing
sudo bash provision-turtlzim.sh ...the same without --dry-run
sudo bash provision-turtlzim.sh --check                     # what is in place
```

Two setups of the machine cannot run at the same time. For an installation or a removal (not for `--check` or `--dry-run`) this script takes the lock that the other project's setup takes (`/run/lock/serveur-partage-mise-en-place.lock`, `flock` on descriptor 9), because the numbers of ufw's rules move while one of them adds or deletes; and it refuses to go on while a firewall rollback of another setup is pending (a timer whose name ends in `-ufw-undo.timer`: it would switch ufw off after this one). The order that was agreed with the other project's session: its setup first, then this one, one script at a time, each after being read. If this one runs while ufw is still switched off, it adds no rule (it says so) and the two ports are blocked as soon as ufw is switched on: run it again then, it is idempotent. It leaves alone a port that already has a rule of any kind (`ufw allow` would replace it in silence, its action and its comment), and takes away only the rules that carry its comment, looking at ufw's list again before each deletion.

It makes: the account `turtlzim` (no sudo, no login shell, in no group but its own); `/opt/turtlzim` (the versions), `/var/lib/turtlzim` (the data, mode 700), `/etc/turtlzim` (the settings and the public key); `/usr/local/lib/turtlzim` (**root's**: Node, checked against a SHA-256 written in the script, and the updater, so that the account cannot change what it runs with); the account's **user units** `turtlzim.service`, `turtlzim-update.service` and `turtlzim-update.timer` (nothing runs as root), with `loginctl enable-linger`; and, only if ufw is active, two rules, `8244/tcp` and `8281/tcp`, with the comment `turtlzim: ...`. It then asks for a first look at once. The server is `--host :: --port 8244 --tls --redirect-port 8281`: https on 8244, and the http port 8281 that only redirects to it (`docs/zim-server.md`, *A plain-http port that only sends people to https*), with a memory ceiling (`MemoryMax=512M`) because the machine is shared.

**Fix the names of the certificate once** (`--name`, the addresses that people type): the self-signed certificate lives in the account's `~/.local/state/zim-web/tls` and is made again when the names change or after about 300 days, and every app that had pinned it asks again (`docs/zim-server.md`, *A server that the apps don't know the certificate of*). Use the addresses, not a host name that does not resolve.

The machine's settings are in `/etc/turtlzim/env` (made once; it is yours to edit: `server/.env.example` lists what the server reads). To see, pause, undo:

```bash
sudo runuser -u turtlzim -- env XDG_RUNTIME_DIR=/run/user/$(id -u turtlzim) systemctl --user status turtlzim.service turtlzim-update.timer
sudo journalctl _UID=$(id -u turtlzim) -n 80 --no-pager      # what the server and the updater said
cat /opt/turtlzim/status.json                                # what the last look did
sudo touch /etc/turtlzim/pause                               # no update until you remove it (sudo rm /etc/turtlzim/pause)
sudo bash provision-turtlzim.sh --remove                     # takes away what is named turtlzim; the data and the account stay (--purge-data, --purge-account)
node scripts/deploy/smoke-test.mjs https://YOUR_PUBLIC_ADDRESS:8244 --insecure --redirect http://YOUR_PUBLIC_ADDRESS:8281/    # from outside: answers, serves the right build, redirects; tells the certificate it shows
```

### Going back by hand

The updater already goes back when a version does not answer. To go back to the version before, on purpose: pause the updates, point `current` at the older folder in `/opt/turtlzim/releases/`, restart the unit. If the old version then refuses the database (an older server refuses a database that a newer one made), put the backup back first: stop the unit, `node /opt/turtlzim/current/server/src/backup.mjs restore /var/lib/turtlzim/backups/<the backup> --data /var/lib/turtlzim`, start it (`docs/zim-operations.md`).

## First deployment, in order

The order matters for one reason: the machine's first look, at the end of the provisioning script, installs what is *published*. With no release yet it finds nothing and waits for its next look (five minutes): harmless, but the machine stays empty until then. So: a key, GitHub, one publication, then the machine.

1. **A key**, on any computer, in a folder *outside* the checkout (a private key must never be inside a repository):
   ```bash
   (umask 077; mkdir turtlzim-key && cd turtlzim-key && ssh-keygen -t ed25519 -N '' -C turtlzim-beta -f turtlzim-beta-signing && ssh-keygen -l -f turtlzim-beta-signing.pub)
   ```
   Keep the fingerprint it prints: the provisioning script prints the one of the `.pub` it is given, and the two must be the same.
2. **GitHub.** The environment `beta` already exists once `cd-beta` has run once (the first run creates it, with no restriction); otherwise create it. *Settings > Environments > `beta`*: *Deployment branches and tags* > *Selected branches and tags* > add the branch `master`; *Environment secrets* > add `BETA_SIGNING_KEY`, with the whole content of the file `turtlzim-beta-signing` (or `gh secret set BETA_SIGNING_KEY --env beta < turtlzim-beta-signing`, for a `gh` that is signed in). The repository's option that makes releases immutable, if your settings have it, must stay off: the workflow replaces the files of the pre-release `beta` on every push. Then delete the private file (`shred -u turtlzim-beta-signing`); the `.pub` stays.
3. **Publish once.** *Actions > cd-beta > Run workflow* on `master` (about ten minutes: the checks, then the signed release). It must end green, with a pre-release `beta` that holds `turtlzim-beta.tar.gz`, `turtlzim-beta.json` and `turtlzim-beta.json.sig`. Check the signature from here before the machine is involved (it takes the public half and the two files, nothing else):
   ```bash
   curl -fsSLO https://github.com/<repo>/releases/download/beta/turtlzim-beta.json
   curl -fsSLO https://github.com/<repo>/releases/download/beta/turtlzim-beta.json.sig
   printf 'turtlzim-beta %s\n' "$(cut -d' ' -f1,2 turtlzim-beta-signing.pub)" > allowed_signers
   ssh-keygen -Y verify -f allowed_signers -I turtlzim-beta -n turtlzim-beta -s turtlzim-beta.json.sig < turtlzim-beta.json
   ```
   It must say `Good "turtlzim-beta" signature … SHA256:…` with the fingerprint of step 1 (a manifest changed by one byte gives `incorrect signature`, exit 255), and `cat turtlzim-beta.json` names the commit that was published.
4. **The machine, before the script.** None of this needs the other application's setup to be over, and none of it changes the machine but a folder in your home directory.
   - The tools the script needs (it installs no package, and refuses if one is missing; `flock` is in util-linux): `command -v ssh-keygen tar curl sha256sum xz openssl systemctl loginctl runuser useradd getent id flock` must print a path for each of them, and `ss -ltn | grep -E ':(8244|8281)\b'` nothing.
   - The folder `scripts/deploy/` and the `.pub` file on the machine: `scp -r scripts/deploy USER@HOST:turtlzim-deploy` from a checkout, or on the machine, in an empty folder, the same bytes straight from GitHub (`<COMMIT>` is the commit that was reviewed):
     ```bash
     curl -fsSL https://github.com/<repo>/archive/<COMMIT>.tar.gz | tar -xz --strip-components=3 --wildcards '*/scripts/deploy/*'
     ```
     then the one line of `turtlzim-beta-signing.pub` in a file beside it.
   - The machine reaches the two sites it needs (Node comes from the first, the releases from the second): `curl -fsSI https://nodejs.org/dist/v$(sed -n 's/^NODE_VERSION=//p' provision-turtlzim.sh)/SHASUMS256.txt | head -n 1` and `curl -sSI https://github.com/<repo>/releases/download/beta/turtlzim-beta.json | head -n 1` (`200` for the first and `302` for the second once step 3 is done, `404` before it: in every case the site is reached).
   - Read `provision-turtlzim.sh`, then the dry run, with `sudo` so that it can read ufw (it changes nothing and takes no lock, so it can run while another setup is going on): `sudo bash provision-turtlzim.sh --dry-run --signer-pub turtlzim-beta-signing.pub --base-url https://YOUR_PUBLIC_ADDRESS:8244 --name YOUR_LAN_ADDRESS --name YOUR_PUBLIC_ADDRESS`. Compare the fingerprint it prints with step 1.
5. **The setup**, once the other application's is over (one script at a time: this one takes its lock): the same command without `--dry-run`; then `sudo bash provision-turtlzim.sh --check` and `cat /opt/turtlzim/status.json` (what the first look did: the outcome and the commit).
6. **From outside.** The router sends `8244` and `8281` to the machine; then, from a computer that is not on its network, `node scripts/deploy/smoke-test.mjs https://YOUR_PUBLIC_ADDRESS:8244 --insecure --redirect http://YOUR_PUBLIC_ADDRESS:8281/` (a router often does not send a request for its own public address back in: from inside use the machine's own address). A browser warns once about the certificate, which is self-signed: the fingerprint to compare is in the journal (`sudo journalctl _UID=$(id -u turtlzim) --no-pager | grep -i -m1 'own certificate'`), or fetch `/ca.pem` from the server and trust that.
7. **Using it.** Without an SMTP server the code of a sign-up is written to the data folder: `sudo tail -n 1 /var/lib/turtlzim/outbox.jsonl`. The web app's storage (local notebooks, the vault) is per origin: the machine's own address and the public one are two different apps, so choose one address to type (the one in `--base-url`).

If the updater or the units change later (`scripts/deploy/turtlzim-update.mjs`, `units/`), they are **not** in the release: copy the folder again and run the provisioning script again (it is idempotent). The server and the web app update themselves; the updater does not.

## What this was tried against, and what it was not

- **Tried**: the release builder (the archive is enough to run the server by itself, and is the same bytes for the same files; a signature holds only for its manifest, namespace and key); the updater against a stand-in GitHub that serves the files through a redirect, with the real releases, the real `ssh-keygen`, the real server started and stopped by a stand-in `systemctl`, and the server's own backups and restores (first version, an update, pruning, the pause, a release not there, a GitHub that cannot be reached, a wrong key, a changed manifest, a changed archive, a manifest that is not understood, a Node that is too old, a version that does not start on a copy of the data, one that starts for real and does not answer, one that serves another build, an http port that does not redirect, a backup that has to be put back, nothing that answers, a first version that does not, no backup possible, two looks at once); the provisioning script in a pretend system (what it refuses, a dry run, the installation, running it twice, ufw active and not, `--check`, `--remove`); the smoke test against the real server and against wrong ones. The provisioning script was also **read by the other project's session** (it ran nothing): it found a bug (back quotes in an error message, which would have run `systemd-logind`) and what to harden (the shared lock, the pending rollback, rules of any kind, a removal that looks again, `--no-same-owner`); all of it is done and tried. **The units were run for real** with the user manager of a machine of the same Ubuntu release (26.04.1) as the staging machine: the condition that keeps the server from starting before a first version is not a failure, the updater as a `Type=oneshot` unit installs a version and restarts the server unit from inside, `$TURTLZIM_ARGS` is split into arguments, the memory ceiling is in the cgroup, `Restart=always` brings the server back in about three seconds after a `kill -9`, an update with a backup, and the timer is valid.
- **Not tried**: anything on the staging machine itself (nothing is installed there); the workflows after the point where a secret is needed (on 4 November the first run, commit `d19e81e`, went through the reusable `ci.yml`, the actions pinned by commit, the artifact and the environment for real, and the publish job of `cd-beta.yml` stopped at the missing `BETA_SIGNING_KEY` with the error that says so; `make-release.mjs` with the real key, `gh release create` and `upload`, and the move of the tag are not tried); the Node download and its SHA-256 check on the real machine (the sum was checked against nodejs.org's list and against the Node in use when it was written; the list's PGP signature was not checked); `ufw` and `loginctl enable-linger` as root; the router; and whether `systemd-oomd` on the staging machine would kill the account's control group under memory pressure (`MemoryMax=512M` protects the machine from the server, not the server from the machine: it happened to the dev instance on 24 October, which is why it runs in a scope that oomd is asked to leave for last; look at `oomctl` on the real machine before deciding the same here, which would move the victims onto the other applications).

## Production

Not chosen: Railway, or an alternative hosted in the EU. Everything that does not depend on the hoster is in place (`ci.yml`, the release of a tag, the smoke test); the step that belongs to the hoster is the last job of `cd-production.yml`, which does not run until `PRODUCTION_TARGET` is set and, if it is set before the step is written, fails and says so rather than letting a tag look delivered. What was read in Railway's documentation on 2 November: a service with a volume has a short downtime at every redeploy, even with a healthcheck, and no replicas; the Amsterdam region exists but the documentation does not say that volumes exist there for every plan; a project token is limited to one environment; volume backups exist and are said to be still under development. The choice is open; a VPS in the EU on the same Ubuntu would make the staging a replica of production, and the same updater could serve both.
