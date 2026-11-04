#!/usr/bin/env bash
# Puts Turtlzim's staging on a machine that updates itself by pull (docs/zim-delivery.md). Run ONCE, by a person, with sudo, after reading it (`--dry-run` says everything it would do and does nothing); run
# again when something here changes (it is idempotent: what is as it should be is left as it is). The machine is shared with other applications, so it makes only what is named `turtlzim`, and never reset or change
# what is not.
#
#   sudo bash provision-turtlzim.sh --signer-pub FILE --base-url URL --name ADDRESS [--name ADDRESS ...] [options]
#   sudo bash provision-turtlzim.sh --check                      what is in place (changes nothing)
#   sudo bash provision-turtlzim.sh --remove [--purge-data] [--purge-account]
#
#   --signer-pub FILE   the PUBLIC half of the key that CI signs the releases with (a private key is refused). It is the only thing that this machine will install what is published on trust of.
#   --base-url URL      the address that people type for this server (ZIM_BASE_URL), e.g. https://YOUR_PUBLIC_ADDRESS:8244
#   --name ADDRESS      an address or a host name that the server's certificate is for; as many as needed. Fix them once: the certificate is made again when they change, and every app that trusted it asks again.
#   --port N            https (default 8244)          --redirect-port N   the http port that only redirects to https (default 8281)
#   --repo OWNER/NAME   (default bbhedia/turtlzim)    --channel NAME      the release that is followed (default beta)         --memory 512M   the unit's memory ceiling
#   --rewrite-env       write /etc/turtlzim/env again from these options (otherwise a file that is there is kept: it is yours to edit)
#   --dry-run           say what would be done, and do nothing
#
# What it makes, and nothing else:
#   the account `turtlzim` (no sudo, no login shell, in no group but its own); /opt/turtlzim (the versions), /var/lib/turtlzim (the data, 700), /etc/turtlzim (its settings and the public key), /usr/local/lib/turtlzim
#   (Node, which is checked against a SHA-256 that is written in this file, and the updater: root's, so that the account cannot change what it runs with); the account's USER units turtlzim.service,
#   turtlzim-update.service and turtlzim-update.timer, with `loginctl enable-linger` (the one setting of the system that is not in a folder of ours); and, only if ufw is active, two rules, `turtlzim: ...`.
#   It does not install a package, touch another account, sshd, fail2ban, Docker, the time zone, the other rules of ufw, or switch ufw on.
set -euo pipefail

P="${TURTLZIM_PREFIX:-}" # (a folder that every path is put under: for the tests; empty on a machine)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNT=turtlzim
NODE_VERSION=24.21.0
# (node-v24.21.0-linux-x64.tar.xz: the same sum is in nodejs.org's SHASUMS256.txt and is the one of the download that was made to put it here; the node inside is byte for byte the one that was in use when this was written)
NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
NODE_URL="${TURTLZIM_NODE_URL:-https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz}"
LIB="$P/usr/local/lib/turtlzim"
OPT="$P/opt/turtlzim"
DATA="$P/var/lib/turtlzim"
ETC="$P/etc/turtlzim"

DRY=0
MODE=install
SIGNER_PUB=""
BASE_URL=""
NAMES=()
PORT=8244
REDIRECT_PORT=8281
REPO=bbhedia/turtlzim
CHANNEL=beta
MEMORY=512M
REWRITE_ENV=0
PURGE_DATA=0
PURGE_ACCOUNT=0

say() { printf '   %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'ERREUR : %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

# act "what it does" command args... : says it, and does it unless it is a dry run
act() {
  local why="$1"
  shift
  if [ "$DRY" = 1 ]; then
    say "[dry run] $why"
  else
    say "$why"
    "$@"
  fi
}

# put MODE OWNER DEST, the content on the standard input: written if it is not already so
put() {
  local mode="$1" owner="$2" dest="$3" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    say "$dest is as it should be"
  elif [ "$DRY" = 1 ]; then
    say "[dry run] write $dest ($mode $owner):"
    sed 's/^/          | /' "$tmp"
  else
    say "write $dest ($mode $owner)"
    mkdir -p "$(dirname "$dest")"
    cp "$tmp" "$dest"
    chmod "$mode" "$dest"
    chown "$owner" "$dest"
  fi
  rm -f "$tmp"
}

make_dir() { mkdir -p "$1" && chmod "$2" "$1" && chown "$3" "$1"; }
# (they may be stopped already, or never have been started)
stop_units() { as_account systemctl --user disable --now turtlzim-update.timer turtlzim.service || true; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --signer-pub) SIGNER_PUB="${2:?--signer-pub needs a file}"; shift 2 ;;
    --base-url) BASE_URL="${2:?--base-url needs an address}"; shift 2 ;;
    --name) NAMES+=("${2:?--name needs an address}"); shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --redirect-port) REDIRECT_PORT="${2:?--redirect-port needs a number}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    --channel) CHANNEL="${2:?--channel needs a name}"; shift 2 ;;
    --memory) MEMORY="${2:?--memory needs a size}"; shift 2 ;;
    --rewrite-env) REWRITE_ENV=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --check) MODE=check; shift ;;
    --remove) MODE=remove; shift ;;
    --purge-data) PURGE_DATA=1; shift ;;
    --purge-account) PURGE_ACCOUNT=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "I do not know $1 (--help says what I know)" ;;
  esac
done

if [ -z "$P" ] && [ "$(id -u)" -ne 0 ] && [ "$DRY" = 0 ] && [ "$MODE" != check ]; then die "this has to be run with sudo (or with --dry-run, which changes nothing)"; fi

# Another setup of this shared machine (HubManager's) changes ufw and sshd too, and the numbers of ufw's rules move while one of them adds or deletes: only one at a time, by a lock that both take (`flock` on file
# descriptor 9, the same file in both: serveur-partage-mise-en-place.lock). Not for --check nor --dry-run, which change nothing. Nothing that this script starts and leaves running keeps the descriptor.
LOCK="$P/run/lock/serveur-partage-mise-en-place.lock"
take_lock() {
  [ "$DRY" = 0 ] || return 0
  command -v flock >/dev/null 2>&1 || die "flock is missing (it is in util-linux)"
  mkdir -p "$P/run/lock"
  exec 9>"$LOCK"
  flock -n 9 || die "another setup of this shared machine is going on (it holds $LOCK): wait until it is over, then run this again"
}

account_home() { if getent passwd "$ACCOUNT" >/dev/null 2>&1; then getent passwd "$ACCOUNT" | cut -d: -f6; else echo "$P/home/$ACCOUNT"; fi; }
account_uid() { if getent passwd "$ACCOUNT" >/dev/null 2>&1; then id -u "$ACCOUNT"; else echo "<uid>"; fi; }
# the account's own systemd, as the account: its runtime folder is where its user manager is
as_account() { runuser -u "$ACCOUNT" -- env "XDG_RUNTIME_DIR=/run/user/$(account_uid)" "$@"; }

# ---------------------------------------------------------------------------------------------------------------------------------------------------------
if [ "$MODE" = check ]; then
  step "what is in place"
  getent passwd "$ACCOUNT" >/dev/null 2>&1 && say "account $ACCOUNT: yes (uid $(id -u "$ACCOUNT"), groups: $(id -nG "$ACCOUNT"))" || say "account $ACCOUNT: no"
  for d in "$OPT" "$DATA" "$ETC" "$LIB"; do [ -d "$d" ] && say "$d: yes" || say "$d: no"; done
  [ -x "$LIB/node/bin/node" ] && say "Node: $("$LIB/node/bin/node" -v)" || say "Node: not installed"
  [ -f "$ETC/allowed_signers" ] && say "key to check releases against: yes ($(ssh-keygen -l -f "$ETC/allowed_signers" 2>/dev/null | head -n 1 || echo "unreadable"))" || say "key to check releases against: no"
  [ -L "$OPT/current" ] && say "version that runs: $(readlink "$OPT/current")" || say "version that runs: none yet"
  [ -f "$OPT/status.json" ] && { say "last look:"; sed 's/^/          | /' "$OPT/status.json"; }
  [ -e "$ETC/pause" ] && say "UPDATES ARE PAUSED ($ETC/pause)"
  if getent passwd "$ACCOUNT" >/dev/null 2>&1; then
    as_account systemctl --user is-active turtlzim.service turtlzim-update.timer 2>&1 | sed 's/^/   unit: /' || true
    loginctl show-user "$ACCOUNT" -p Linger 2>/dev/null | sed 's/^/   /' || true
  fi
  command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -i "turtlzim" | sed 's/^/   ufw: /' || true
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------------------------------------------------
if [ "$MODE" = remove ]; then
  take_lock
  step "removing what is named turtlzim (the data and the account stay unless --purge-data and --purge-account say so)"
  if getent passwd "$ACCOUNT" >/dev/null 2>&1; then
    act "stop and disable the account's units" stop_units
    act "stop the account's services running without a login" loginctl disable-linger "$ACCOUNT"
    for unit in turtlzim.service turtlzim-update.service turtlzim-update.timer; do
      act "remove the unit $unit" rm -f "$(account_home)/.config/systemd/user/$unit"
    done
  fi
  if command -v ufw >/dev/null 2>&1; then
    # (only the rules that carry our comment, and no other is looked at. The list is read again before each deletion: a number that was read a moment ago may not be the same rule now.)
    ours() { ufw status numbered 2>/dev/null | grep -E '# turtlzim:' | sed -E 's/^\[ *([0-9]+)\].*/\1/' || true; }
    if [ "$DRY" = 1 ]; then
      for number in $(ours); do say "[dry run] ufw: remove our rule number $number"; done
    else
      for _ in $(seq 1 20); do
        number="$(ours | head -n 1)"
        [ -n "$number" ] || break
        act "ufw: remove our rule number $number" ufw --force delete "$number"
      done
    fi
  fi
  for d in "$OPT" "$LIB" "$ETC"; do
    case "$d" in
      "$P/opt/turtlzim" | "$P/usr/local/lib/turtlzim" | "$P/etc/turtlzim") act "remove $d" rm -rf -- "$d" ;;
      *) die "refusing to remove $d" ;;
    esac
  done
  if [ "$PURGE_DATA" = 1 ]; then
    act "REMOVE THE DATA $DATA (the database, the key, the backups)" rm -rf -- "$P/var/lib/turtlzim"
  else
    say "the data is kept: $DATA"
  fi
  if [ "$PURGE_ACCOUNT" = 1 ] && getent passwd "$ACCOUNT" >/dev/null 2>&1; then act "remove the account $ACCOUNT and its home" userdel -r "$ACCOUNT"; else say "the account is kept"; fi
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------------------------------------------------
step "what was asked for"
[ -n "$SIGNER_PUB" ] || die "--signer-pub FILE is needed: the public half of the key that CI signs the releases with (see docs/zim-delivery.md)"
[ -n "$BASE_URL" ] || die "--base-url is needed: the address that people type, e.g. https://YOUR_PUBLIC_ADDRESS:$PORT"
[ "${#NAMES[@]}" -gt 0 ] || die "at least one --name is needed: an address or a host name that the certificate is for"
base_re='^https://[][A-Za-z0-9.:-]+$'
[[ "$BASE_URL" =~ $base_re ]] || die "--base-url is https://host or https://host:port (it is '$BASE_URL')"
for n in "${NAMES[@]}"; do [[ "$n" =~ ^[A-Za-z0-9.:-]+$ ]] || die "--name '$n' is not an address or a host name"; done
[[ "$PORT" =~ ^[0-9]+$ && "$REDIRECT_PORT" =~ ^[0-9]+$ ]] || die "the ports are numbers"
[ "$PORT" != "$REDIRECT_PORT" ] || die "the two ports are the same"
[[ "$MEMORY" =~ ^[0-9]+[KMG]$ ]] || die "--memory is like 512M"
[[ "$CHANNEL" =~ ^[a-z][a-z0-9-]*$ ]] || die "--channel is a lower-case name"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo is owner/name"
[ -f "$SIGNER_PUB" ] || die "$SIGNER_PUB is not a file"
if grep -q 'PRIVATE KEY' "$SIGNER_PUB"; then die "$SIGNER_PUB is a PRIVATE key. Never put it on this machine: give the .pub file (the public half), and keep the private one in GitHub's secrets only"; fi
read -r KEY_TYPE KEY_DATA _ <"$SIGNER_PUB" || true
[[ "${KEY_TYPE:-}" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh.com)$ && -n "${KEY_DATA:-}" ]] || die "$SIGNER_PUB does not look like a public key (ssh-ed25519 AAAA...)"
ssh-keygen -l -f "$SIGNER_PUB" >/dev/null 2>&1 || die "ssh-keygen does not read $SIGNER_PUB as a public key"
say "the key that releases are checked against: $(ssh-keygen -l -f "$SIGNER_PUB")"
say "compare it with the key that was made for GitHub's secret BETA_SIGNING_KEY (ssh-keygen -l -f its .pub)"
[ "$(uname -m)" = x86_64 ] || die "this is for x86_64 (the Node that is installed is the linux-x64 one); this machine is $(uname -m)"
missing=()
for c in ssh-keygen tar curl sha256sum xz openssl systemctl loginctl runuser useradd getent id; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
[ "${#missing[@]}" -eq 0 ] || die "these are missing on this machine, and this does not install packages: ${missing[*]}"
take_lock
if [ "$DRY" = 0 ]; then
  pending="$(systemctl list-units --type=timer --state=active --no-legend '*-ufw-undo.timer' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
  [ -z "${pending// /}" ] || die "another setup of this shared machine has a firewall rollback pending (${pending}): it would switch ufw off after this one. Confirm it or cancel it first (systemctl stop ...), then run this again"
fi
[ "$DRY" = 1 ] && say "(dry run: nothing below is done)"

step "the account $ACCOUNT"
if getent passwd "$ACCOUNT" >/dev/null 2>&1; then
  say "the account $ACCOUNT is there"
  extra="$(id -nG "$ACCOUNT" | tr ' ' '\n' | grep -Ex 'sudo|docker|adm|root|wheel|admin' || true)"
  [ -z "$extra" ] || die "the account $ACCOUNT is in group(s) it must not be in: $(echo "$extra" | tr '\n' ' ')"
else
  act "make the account $ACCOUNT (no sudo, no login shell, no group but its own)" useradd --create-home --shell /usr/sbin/nologin --comment "Turtlzim staging (no sudo, no login)" "$ACCOUNT"
fi

step "folders"
act "make $LIB (root's: Node and the updater)" make_dir "$LIB" 0755 root:root
act "make $OPT (the versions: the account's)" make_dir "$OPT" 0755 "$ACCOUNT:$ACCOUNT"
act "make $DATA (the data: the account's only)" make_dir "$DATA" 0700 "$ACCOUNT:$ACCOUNT"
act "make $ETC (the settings: root's, readable by the account)" make_dir "$ETC" 0750 "root:$ACCOUNT"

install_node() {
  local tmp
  tmp="$(mktemp -d "$LIB/.node.XXXXXX")"
  case "$tmp" in "$LIB"/.node.*) ;; *) die "mktemp made $tmp, which is not where it should be" ;; esac
  # (what is removed here is what was just made here, and nothing else)
  gone() { rm -rf -- "$tmp"; die "$1: nothing was installed"; }
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/node.tar.xz" "$NODE_URL" || gone "Node could not be downloaded from $NODE_URL"
  echo "$NODE_SHA256  $tmp/node.tar.xz" | sha256sum -c --quiet - || gone "the Node that was downloaded is not the one whose SHA-256 is written in this file"
  tar -xJf "$tmp/node.tar.xz" -C "$tmp" --no-same-owner || gone "the Node that was downloaded could not be unpacked"
  [ -x "$tmp/node-v$NODE_VERSION-linux-x64/bin/node" ] || gone "there is no node in what was unpacked"
  rm -rf -- "$LIB/node-v$NODE_VERSION"
  mv "$tmp/node-v$NODE_VERSION-linux-x64" "$LIB/node-v$NODE_VERSION"
  chown -R root:root "$LIB/node-v$NODE_VERSION"
  rm -rf -- "$tmp"
}
step "Node $NODE_VERSION (root's, checked against a SHA-256 that is written in this file)"
if [ -x "$LIB/node-v$NODE_VERSION/bin/node" ] && [ "$("$LIB/node-v$NODE_VERSION/bin/node" -v 2>/dev/null || true)" = "v$NODE_VERSION" ]; then
  say "Node v$NODE_VERSION is there"
else
  act "download Node v$NODE_VERSION from $NODE_URL, check it, unpack it" install_node
fi
act "point $LIB/node at it" ln -sfn "node-v$NODE_VERSION" "$LIB/node"

step "the updater"
if [ -f "$LIB/turtlzim-update.mjs" ] && cmp -s "$HERE/turtlzim-update.mjs" "$LIB/turtlzim-update.mjs"; then
  say "$LIB/turtlzim-update.mjs is as it should be"
else
  act "put $LIB/turtlzim-update.mjs (root's, not writable by the account)" bash -c 'cp "$1" "$2" && chmod 0644 "$2" && chown root:root "$2"' _ "$HERE/turtlzim-update.mjs" "$LIB/turtlzim-update.mjs"
fi

step "settings"
printf 'turtlzim-%s %s %s\n' "$CHANNEL" "$KEY_TYPE" "$KEY_DATA" | put 0640 "root:$ACCOUNT" "$ETC/allowed_signers"
name_args=""
for n in "${NAMES[@]}"; do name_args="$name_args --name $n"; done
env_text="$(cat <<EOF
# Turtlzim on a machine that updates itself by pull (docs/zim-delivery.md): the environment of the server and of the updater. Made by provision-turtlzim.sh; it is yours to edit
# (the server's own arguments are TURTLZIM_ARGS: the names that the certificate is made for are best not changed, or every app that trusted it asks again).
ZIM_BASE_URL=$BASE_URL
ZIM_SERVER_DATA=/var/lib/turtlzim
TURTLZIM_ARGS="--host :: --port $PORT --tls$name_args --redirect-port $REDIRECT_PORT --pid-file /var/lib/turtlzim/serve.pid --dir ../web/dist"
TURTLZIM_REPO=$REPO
TURTLZIM_CHANNEL=$CHANNEL
# Not set, and read from here if you add them: ZIM_HASH_SLOTS, ZIM_HASH_QUEUE, ZIM_SMTP_HOST, ZIM_SMTP_PORT, ZIM_SMTP_USER, ZIM_SMTP_PASS, ZIM_SMTP_SECURE, ZIM_MAIL_FROM, and the apps' ids and secrets
# (ZIM_GOOGLE_CLIENT_ID, ZIM_GITHUB_CLIENT_SECRET, ...: docs/zim-server.md). The secrets can also be in /var/lib/turtlzim/oauth.json (mode 600), which the backups hold.
EOF
)"
if [ -f "$ETC/env" ] && [ "$REWRITE_ENV" = 0 ]; then
  if [ "$(cat "$ETC/env")" = "$env_text" ]; then say "$ETC/env is as it should be"; else say "$ETC/env is kept as it is (what was asked for differs from it: edit it, or give --rewrite-env)"; fi
else
  printf '%s\n' "$env_text" | put 0640 "root:$ACCOUNT" "$ETC/env"
fi

step "the account's units (user units: nothing runs as root)"
home="$(account_home)"
units_dir="$home/.config/systemd/user"
act "make $units_dir" bash -c 'mkdir -p "$1" && chown -R "$2:$2" "$3/.config"' _ "$units_dir" "$ACCOUNT" "$home"
for unit in turtlzim.service turtlzim-update.service turtlzim-update.timer; do
  sed "s/^MemoryMax=.*/MemoryMax=$MEMORY/" "$HERE/units/$unit" | put 0644 "$ACCOUNT:$ACCOUNT" "$units_dir/$unit"
done

step "starting them"
act "let the account's services run without a login (loginctl enable-linger)" loginctl enable-linger "$ACCOUNT"
if [ "$DRY" = 0 ]; then
  for _ in $(seq 1 "${TURTLZIM_WAIT_SECONDS:-30}"); do [ -d "$P/run/user/$(account_uid)" ] && break; sleep 1; done
  [ -d "$P/run/user/$(account_uid)" ] || die "the account's systemd did not start (no /run/user/$(account_uid)): is systemd-logind running?"
fi
act "reload the account's units" as_account systemctl --user daemon-reload
act "enable the server and the timer" as_account systemctl --user enable turtlzim.service turtlzim-update.timer
act "start the timer" as_account systemctl --user start turtlzim-update.timer
if [ "$DRY" = 0 ]; then
  say "the first look, now (it installs what is published, if something is; it can take a few minutes)"
  as_account systemctl --user start turtlzim-update.service || say "the first look did not end well: see below; the timer will look again"
  [ -f "$OPT/status.json" ] && sed 's/^/          | /' "$OPT/status.json"
else
  say "[dry run] the first look, now"
fi

step "the firewall"
if command -v ufw >/dev/null 2>&1; then
  state="$(ufw status 2>&1 || true)"
  if grep -q '^Status: active' <<<"$state"; then
    for p in "$PORT:https" "$REDIRECT_PORT:http that redirects to https"; do
      number="${p%%:*}"
      # (any rule for that port, whatever its action: `ufw allow` would replace it in silence, its action and its comment)
      if grep -qE "^$number(/tcp)?[[:space:]]" <<<"$state"; then say "ufw already has a rule for $number/tcp (not changed)"; else act "ufw: allow $number/tcp" ufw allow "$number/tcp" comment "turtlzim: ${p#*:}"; fi
    done
  elif grep -q '^Status: inactive' <<<"$state"; then
    say "ufw is not active: nothing added, and it is not switched on. The ports are $PORT/tcp and $REDIRECT_PORT/tcp."
  else
    say "ufw's state could not be read ($(head -n 1 <<<"$state")): nothing added. The ports to open are $PORT/tcp and $REDIRECT_PORT/tcp."
  fi
else
  say "there is no ufw on this machine: nothing to open here. The ports are $PORT/tcp and $REDIRECT_PORT/tcp."
fi

step "done"
uid="$(account_uid)"
cat <<EOF
   the server    user unit turtlzim.service of the account $ACCOUNT: https on :$PORT, and the http port :$REDIRECT_PORT that only redirects to it
   the updater   turtlzim-update.timer, every five minutes; what it did last: $OPT/status.json
   to look       sudo runuser -u $ACCOUNT -- env XDG_RUNTIME_DIR=/run/user/$uid systemctl --user status turtlzim.service turtlzim-update.timer
                 sudo journalctl _UID=$uid -n 80 --no-pager
   to pause      sudo touch $ETC/pause        (to go on: sudo rm $ETC/pause)
   still yours   the router (what comes in on $PORT and $REDIRECT_PORT goes to this machine), and the secret BETA_SIGNING_KEY of GitHub's environment "$CHANNEL"
   to undo       sudo bash $0 --remove        (the data stays unless --purge-data)
EOF
