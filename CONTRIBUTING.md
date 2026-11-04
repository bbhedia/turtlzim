# Contributing: the day-to-day

One developer, Git trunk-based. **`master`** is the trunk: it holds what is stable and ready to be tried. The rest of the rules of the house (what a UI change needs before it is done, how a new test is checked, what must never be weakened, the follow-up document) are in `CLAUDE.md`; this page is the weekly rhythm. How the machines are fed, and what verifies each step: `docs/zim-delivery.md`.

## A change

1. **A short branch**, `feature/what-it-is` or `fix/what-it-is`: `git switch -c feature/what-it-is`. A micro-fix, or the end of a milestone, may go straight on `master`, as it has so far.
2. **Work, and run what your change concerns** (each package has its own commands, listed in `CLAUDE.md`): `cd web && npm run typecheck && npm test`, `cd server && npm test`, `cargo test -p zim-format -p zim-notebook -p zim-wasm`, `cd web && npm run test:browser` (and `test:browser:webkit`). A change to what is on the screen is not done until it has been looked at (`npm run screenshots`) and driven in the real browser tests.
3. **A pull request to `master`.** `ci.yml` runs: the web app type-checks, passes its tests and builds, and the server passes its own. Merge when it is green.
4. **A push to `master` that touches `web/`, `core/` or `server/`** runs `cd-beta.yml`: the same checks, then the signed release is put in the pre-release `beta`. The staging machine looks every five minutes and installs it (a backup first, a trial on a copy of its data, a way back): count about ten minutes for the checks and five for the machine.
5. **Check it on staging.** `node scripts/deploy/smoke-test.mjs https://YOUR_PUBLIC_ADDRESS:8244 --insecure --redirect http://YOUR_PUBLIC_ADDRESS:8281/` says whether it answers, serves the right build and redirects, and tells the certificate it shows. What the machine did last: `cat /opt/turtlzim/status.json` there. A broken `master` does not reach the machine as a broken server: a version that does not start on a copy of the data, or does not answer, is refused or put back.

## A release

```bash
git tag -a v1.2.3 -m "what this version is"
GIT_SSH_COMMAND="..." git push origin v1.2.3        # the push is done with the project's own key
```

A tag `vX.Y.Z` (nothing else matches) makes the installers and a draft release (`desktop.yml`), and `cd-production.yml` (the checks again, the release of that version kept as an artifact, and a last job for the hoster that does not run until the repository variable `PRODUCTION_TARGET` is set). Production is not chosen yet (Railway, or an alternative in the EU), so for now a tag delivers the installers and nothing else. Look at the draft release before publishing it.

## Going back

On staging, the machine goes back by itself when a new version does not answer. To go back on purpose, pause the updates (`sudo touch /etc/turtlzim/pause` on the machine) and point `current` at the older version; `docs/zim-delivery.md`, *Going back by hand*, has the commands, and the rule about the backup: an older server refuses a database that a newer one made. In the code, `git revert` the change on `master`, as any other.

## The delivery's own settings

- **The key that signs the staging's releases**: a secret `BETA_SIGNING_KEY` in the GitHub environment `beta`, limited to the branch `master`. How to make it, and the public half that the machine holds: `docs/zim-delivery.md`. Until it is set, `cd-beta.yml` stops at its publish step and says so.
- **Secrets of the server** (OAuth apps, SMTP) are never in the repository, and not in GitHub either: on the machine, in `/etc/turtlzim/env` or `/var/lib/turtlzim/oauth.json`; `server/.env.example` lists what the server reads.
- The delivery of the server never waits for a macOS, Windows or Tauri job, and `web/dist` is built once and shipped as it was built: do not change either without reading *The workflows* in `docs/zim-delivery.md`.
