// The script that a person runs once, with sudo, to put the staging on a machine (scripts/deploy/provision-turtlzim.sh, docs/zim-delivery.md), tried in a pretend system: every path is put under a folder of the test
// (TURTLZIM_PREFIX), and the commands that would change a machine (useradd, loginctl, systemctl, runuser, ufw, chown, curl) are stand-ins that say what they were asked and keep a little state. What is tried is
// the script's own logic: what it refuses, what it does and in what way, that it can be run again, that it leaves alone what is not its, and that it can take its own things away and nothing else.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/deploy/provision-turtlzim.sh", import.meta.url));
const updater = fileURLToPath(new URL("../../scripts/deploy/turtlzim-update.mjs", import.meta.url));
const folders = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

/** The stand-ins, as small shell scripts. FAKE_STATE is where they keep what they know (is there an account, what does ufw hold) and what they were asked. */
const STUBS = {
  getent: `[ "$1" = passwd ] && [ -f "$FAKE_STATE/user" ] && { echo "turtlzim:x:1234:1234:Turtlzim:$TURTLZIM_PREFIX/home/turtlzim:/usr/sbin/nologin"; exit 0; }; exit 2`,
  id: `case "$*" in "-u turtlzim") [ -f "$FAKE_STATE/user" ] && echo 1234 || exit 1 ;; "-nG turtlzim") cat "$FAKE_STATE/groups" 2>/dev/null || echo turtlzim ;; *) exec /usr/bin/id "$@" ;; esac`,
  useradd: `echo "useradd $*" >> "$FAKE_STATE/calls.log"; touch "$FAKE_STATE/user"; mkdir -p "$TURTLZIM_PREFIX/home/turtlzim"`,
  userdel: `echo "userdel $*" >> "$FAKE_STATE/calls.log"; rm -f "$FAKE_STATE/user"`,
  loginctl: `echo "loginctl $*" >> "$FAKE_STATE/calls.log"; case "$1" in enable-linger) touch "$FAKE_STATE/linger"; mkdir -p "$TURTLZIM_PREFIX/run/user/1234" ;; disable-linger) rm -f "$FAKE_STATE/linger" ;; show-user) echo "Linger=$([ -f "$FAKE_STATE/linger" ] && echo yes || echo no)" ;; esac`,
  systemctl: `echo "systemctl $*" >> "$FAKE_STATE/calls.log"; case "$*" in *is-active*) echo active ;; esac`,
  runuser: `echo "runuser $*" >> "$FAKE_STATE/calls.log"; shift 3; exec "$@"`,
  chown: `echo "chown $*" >> "$FAKE_STATE/calls.log"`,
  uname: `[ "$1" = -m ] && echo x86_64 || exec /usr/bin/uname "$@"`,
  curl: `echo "curl $*" >> "$FAKE_STATE/calls.log"; while [ "$#" -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done; cp "$FAKE_NODE_TARBALL" "$out"`,
  sha256sum: `[ "$1" = -c ] && { [ "\${FAKE_SUM_OK:-1}" = 1 ]; exit $?; }; exec /usr/bin/sha256sum "$@"`,
  ufw: `echo "ufw $*" >> "$FAKE_STATE/calls.log"; rules="$FAKE_STATE/ufw.rules"; touch "$rules"; status="$(cat "$FAKE_STATE/ufw.status" 2>/dev/null || echo inactive)"
case "$1 \${2:-}" in
  "status numbered") echo "Status: $status"; echo; n=0; while IFS= read -r l; do n=$((n+1)); printf '[%2d] %s\\n' "$n" "$l"; done < "$rules" ;;
  "status ") echo "Status: $status"; echo; cat "$rules" ;;
  "allow "*) comment=""; [ "\${3:-}" = comment ] && comment="  # $4"; printf '%-27s ALLOW IN    Anywhere%s\\n' "$2" "$comment" >> "$rules" ;;
  "--force delete") sed -i "\${3}d" "$rules" ;;
esac`,
};

/** A pretend machine: the stand-ins first on the PATH, a folder that all paths go under, a public key to give, and a tarball for the Node that is "downloaded". */
function machine() {
  const folder = mkdtempSync(join(tmpdir(), "zim-provision-"));
  folders.push(folder);
  const bin = join(folder, "bin");
  const state = join(folder, "state");
  const prefix = join(folder, "root");
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(prefix);
  mkdirSync(join(folder, "tmp"));
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const key = join(folder, "signer");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "signer", "-f", key]);
  const node = join(folder, "node-v24.21.0-linux-x64");
  mkdirSync(join(node, "bin"), { recursive: true });
  writeFileSync(join(node, "bin/node"), "#!/bin/sh\necho v24.21.0\n", { mode: 0o755 });
  const tarball = join(folder, "node.tar.xz");
  execFileSync("tar", ["-cJf", tarball, "-C", folder, "node-v24.21.0-linux-x64"]);
  const m = { folder, state, prefix, pub: `${key}.pub`, private: key, env: {} };
  m.write = (path, text) => (mkdirSync(join(path, ".."), { recursive: true }), writeFileSync(path, text));
  m.run = (args, env = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TURTLZIM_PREFIX: prefix, TMPDIR: join(folder, "tmp"), FAKE_STATE: state, FAKE_NODE_TARBALL: tarball, TURTLZIM_NODE_URL: "https://example.invalid/node.tar.xz", ...m.env, ...env },
    });
  m.install = (extra = [], env = {}) => m.run(["--signer-pub", m.pub, "--base-url", "https://example.org:8244", "--name", "192.168.10.11", "--name", "example.org", ...extra], env);
  m.calls = () => (existsSync(join(state, "calls.log")) ? readFileSync(join(state, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
  m.rules = () => (existsSync(join(state, "ufw.rules")) ? readFileSync(join(state, "ufw.rules"), "utf8").split("\n").filter(Boolean) : []);
  m.path = (...parts) => join(prefix, ...parts);
  m.mode = (path) => (statSync(path).mode & 0o777).toString(8);
  return m;
}

describe("what the script will not do", () => {
  it("goes on with nothing that it was not given: a key, an address that people type, a name for the certificate", () => {
    const m = machine();
    assert.match(m.run([]).stderr, /--signer-pub FILE is needed/);
    assert.match(m.run(["--signer-pub", m.pub]).stderr, /--base-url is needed/);
    assert.match(m.run(["--signer-pub", m.pub, "--base-url", "https://example.org:8244"]).stderr, /at least one --name is needed/);
    assert.match(m.run(["--signer-pub", m.pub, "--base-url", "http://example.org", "--name", "x.org"]).stderr, /--base-url is https/);
    assert.match(m.run(["--signer-pub", m.pub, "--base-url", "https://example.org", "--name", "x y"]).stderr, /--name 'x y' is not an address/);
    assert.match(m.install(["--redirect-port", "8244"]).stderr, /the two ports are the same/);
    assert.match(m.install(["--memory", "lots"]).stderr, /--memory is like 512M/);
    assert.match(m.run(["--frobnicate"]).stderr, /I do not know --frobnicate/);
    assert.deepEqual(m.calls(), [], "nothing was asked of the system");
    assert.deepEqual(readdirSync(m.prefix), [], "and nothing was made");
  });

  it("refuses a PRIVATE key, whatever it is called, and a file that is not a key", () => {
    const m = machine();
    const refused = m.run(["--signer-pub", m.private, "--base-url", "https://example.org:8244", "--name", "example.org"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /is a PRIVATE key. Never put it on this machine/);
    m.write(join(m.folder, "not-a-key.pub"), "hello world\n");
    assert.match(m.run(["--signer-pub", join(m.folder, "not-a-key.pub"), "--base-url", "https://example.org:8244", "--name", "example.org"]).stderr, /does not look like a public key/);
    assert.deepEqual(readdirSync(m.prefix), []);
  });

  it("refuses an account that is in a group that it must not be in", () => {
    const m = machine();
    m.write(join(m.state, "user"), "");
    m.write(join(m.state, "groups"), "turtlzim sudo\n");
    const refused = m.install();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /in group\(s\) it must not be in: sudo/);
  });

  it("installs nothing of a Node whose SHA-256 is not the one that is written in it", () => {
    const m = machine();
    const refused = m.install([], { FAKE_SUM_OK: "0" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /not the one whose SHA-256 is written in this file: nothing was installed/);
    assert.ok(!existsSync(m.path("usr/local/lib/turtlzim/node-v24.21.0")));
    assert.deepEqual(readdirSync(m.path("usr/local/lib/turtlzim")).filter((name) => name.startsWith(".node.")), [], "what was downloaded is removed");
    assert.ok(!m.calls().some((call) => call.startsWith("loginctl") || call.startsWith("ufw")), "and nothing after it was done");
  });
});

describe("a dry run", () => {
  it("says everything that it would do, shows what it would write, and changes nothing", () => {
    const m = machine();
    const done = m.install(["--dry-run"]);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /\[dry run\] make the account turtlzim/);
    assert.match(done.stdout, /\[dry run\] write .*etc\/turtlzim\/env/);
    assert.match(done.stdout, /TURTLZIM_ARGS="--host :: --port 8244 --tls --name 192\.168\.10\.11 --name example\.org --redirect-port 8281 --pid-file \/var\/lib\/turtlzim\/serve\.pid --dir \.\.\/web\/dist"/);
    assert.match(done.stdout, /\[dry run\] let the account's services run without a login/);
    assert.deepEqual(m.calls().filter((call) => /^(useradd|loginctl|ufw allow|systemctl|runuser)/.test(call)), []);
    assert.deepEqual(readdirSync(m.prefix), []);
  });
});

describe("the installation", () => {
  it("makes the account, the folders with the modes that they need, root's Node and updater, the key, the settings and the units; then starts them and looks once", () => {
    const m = machine();
    const done = m.install(["--memory", "256M"]);
    assert.equal(done.status, 0, `${done.stdout}\n${done.stderr}`);
    const calls = m.calls();
    assert.ok(calls.some((call) => /^useradd --create-home --shell \/usr\/sbin\/nologin .* turtlzim$/.test(call)), calls.join("\n"));
    assert.equal(calls.filter((call) => call.startsWith("useradd")).length, 1);
    for (const [path, mode] of [["usr/local/lib/turtlzim", "755"], ["opt/turtlzim", "755"], ["var/lib/turtlzim", "700"], ["etc/turtlzim", "750"]]) assert.equal(m.mode(m.path(path)), mode, path);
    // Node, and the updater: where the account cannot write
    assert.ok(existsSync(m.path("usr/local/lib/turtlzim/node-v24.21.0/bin/node")));
    assert.equal(readFileSync(m.path("usr/local/lib/turtlzim/turtlzim-update.mjs"), "utf8"), readFileSync(updater, "utf8"));
    assert.equal(m.mode(m.path("usr/local/lib/turtlzim/turtlzim-update.mjs")), "644");
    assert.ok(calls.some((call) => /^chown -R root:root .*node-v24\.21\.0$/.test(call)));
    assert.ok(calls.some((call) => /^chown root:turtlzim .*allowed_signers$/.test(call)) && calls.some((call) => /^chown root:turtlzim .*etc\/turtlzim\/env$/.test(call)));
    // the key it will check releases against: the public half, in the namespace of the channel
    const signers = readFileSync(m.path("etc/turtlzim/allowed_signers"), "utf8");
    assert.match(signers, /^turtlzim-beta ssh-ed25519 AAAA[0-9A-Za-z+/]+\n$/);
    assert.equal(signers.trim().split(" ")[2], readFileSync(m.pub, "utf8").split(" ")[1]);
    assert.equal(m.mode(m.path("etc/turtlzim/allowed_signers")), "640");
    const env = readFileSync(m.path("etc/turtlzim/env"), "utf8");
    assert.match(env, /^ZIM_BASE_URL=https:\/\/example\.org:8244$/m);
    assert.match(env, /^ZIM_SERVER_DATA=\/var\/lib\/turtlzim$/m);
    assert.match(env, /^TURTLZIM_ARGS="--host :: --port 8244 --tls --name 192\.168\.10\.11 --name example\.org --redirect-port 8281 --pid-file \/var\/lib\/turtlzim\/serve\.pid --dir \.\.\/web\/dist"$/m);
    assert.match(env, /^TURTLZIM_REPO=bbhedia\/turtlzim$/m);
    assert.match(env, /^TURTLZIM_CHANNEL=beta$/m);
    assert.equal(m.mode(m.path("etc/turtlzim/env")), "640");
    // the units are the account's, with the ceiling that was asked for
    const units = m.path("home/turtlzim/.config/systemd/user");
    assert.deepEqual(readdirSync(units).sort(), ["turtlzim-update.service", "turtlzim-update.timer", "turtlzim.service"]);
    assert.match(readFileSync(join(units, "turtlzim.service"), "utf8"), /^MemoryMax=256M$/m);
    // and started: lingering, enabled, the timer, and a first look now
    for (const call of ["loginctl enable-linger turtlzim"]) assert.ok(calls.includes(call), call);
    assert.ok(calls.some((call) => /^runuser -u turtlzim -- env XDG_RUNTIME_DIR=\/run\/user\/1234 systemctl --user daemon-reload$/.test(call)), calls.join("\n"));
    assert.ok(calls.includes("systemctl --user enable turtlzim.service turtlzim-update.timer"));
    assert.ok(calls.includes("systemctl --user start turtlzim-update.timer"));
    assert.ok(calls.includes("systemctl --user start turtlzim-update.service"));
    assert.ok(calls.indexOf("systemctl --user start turtlzim-update.timer") < calls.indexOf("systemctl --user start turtlzim-update.service"));
    // it never installed a package, touched sshd, another account, or the system's own folders
    assert.ok(!calls.some((call) => /apt|dpkg|sshd|usermod|passwd|visudo|sudoers/.test(call)), calls.join("\n"));
    assert.deepEqual(readdirSync(m.prefix).sort(), ["etc", "home", "opt", "run", "usr", "var"]);
  });

  it("can be run again: what is as it should be is left as it is, the account is not made twice, and the settings that the person edited are kept", () => {
    const m = machine();
    m.install();
    const first = m.calls().length;
    const again = m.install();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(m.calls().filter((call) => call.startsWith("useradd")).length, 1);
    assert.match(again.stdout, /the account turtlzim is there/);
    assert.match(again.stdout, /Node v24\.21\.0 is there/);
    assert.match(again.stdout, /turtlzim-update\.mjs is as it should be/);
    assert.match(again.stdout, /etc\/turtlzim\/env is as it should be/);
    assert.ok(!m.calls().slice(first).some((call) => call.startsWith("curl")), "Node is not downloaded again");
    const edited = `${readFileSync(m.path("etc/turtlzim/env"), "utf8")}ZIM_HASH_SLOTS=1\n`;
    writeFileSync(m.path("etc/turtlzim/env"), edited);
    const kept = m.install();
    assert.match(kept.stdout, /etc\/turtlzim\/env is kept as it is/);
    assert.equal(readFileSync(m.path("etc/turtlzim/env"), "utf8"), edited);
    const rewritten = m.install(["--rewrite-env"]);
    assert.ok(!/^ZIM_HASH_SLOTS=/m.test(readFileSync(m.path("etc/turtlzim/env"), "utf8")), rewritten.stdout);
  });

  it("with ufw active, opens its two ports with a comment that says whose they are, leaves the other rules and a port that is already open alone, and never switches anything on", () => {
    const m = machine();
    m.write(join(m.state, "ufw.status"), "active");
    m.write(join(m.state, "ufw.rules"), "22/tcp                      ALLOW IN    Anywhere\n8243/tcp                    ALLOW IN    Anywhere                   # hubmanager: HTTPS staging\n8281/tcp                    ALLOW IN    Anywhere\n");
    const done = m.install();
    assert.equal(done.status, 0, done.stderr);
    const allows = m.calls().filter((call) => call.startsWith("ufw allow"));
    assert.deepEqual(allows, ["ufw allow 8244/tcp comment turtlzim: https"], "8281 was open already: not added, not changed");
    assert.match(done.stdout, /ufw already allows 8281\/tcp \(not changed\)/);
    const rules = m.rules();
    assert.equal(rules.length, 4);
    assert.ok(rules[0].startsWith("22/tcp") && rules[1].includes("# hubmanager: HTTPS staging") && rules[2].startsWith("8281/tcp"), "the others are as they were");
    assert.match(rules[3], /^8244\/tcp\s+ALLOW IN\s+Anywhere\s+# turtlzim: https$/);
    assert.ok(!m.calls().some((call) => /^ufw (enable|disable|reset|default|--force enable|--force reset)/.test(call)), "no reset, no default, no enable");
  });

  it("with ufw not active, adds nothing and does not switch it on, and says which ports there are", () => {
    const m = machine();
    m.write(join(m.state, "ufw.status"), "inactive");
    const done = m.install();
    assert.match(done.stdout, /ufw is not active: nothing added, and it is not switched on\. The ports are 8244\/tcp and 8281\/tcp/);
    assert.deepEqual(m.calls().filter((call) => call.startsWith("ufw allow") || call.startsWith("ufw enable")), []);
  });
});

describe("looking, and taking away", () => {
  it("--check says what is in place and changes nothing", () => {
    const m = machine();
    m.install();
    const before = m.calls().length;
    const said = m.run(["--check"]);
    assert.equal(said.status, 0, said.stderr);
    assert.match(said.stdout, /account turtlzim: yes/);
    assert.match(said.stdout, /Node: v24\.21\.0/);
    assert.match(said.stdout, /key to check releases against: yes/);
    assert.match(said.stdout, /version that runs: none yet/);
    assert.ok(!m.calls().slice(before).some((call) => /^(useradd|userdel|loginctl (enable|disable)|ufw allow|ufw --force)/.test(call)));
    m.write(m.path("etc/turtlzim/pause"), "");
    assert.match(m.run(["--check"]).stdout, /UPDATES ARE PAUSED/);
  });

  it("--remove takes away what is named turtlzim, the units, our ufw rules and nothing else of ufw's, and keeps the data and the account", () => {
    const m = machine();
    m.write(join(m.state, "ufw.status"), "active");
    m.write(join(m.state, "ufw.rules"), "22/tcp                      ALLOW IN    Anywhere\n8243/tcp                    ALLOW IN    Anywhere                   # hubmanager: HTTPS staging\n");
    m.install();
    m.write(join(m.path("var/lib/turtlzim"), "zim.sqlite"), "the data");
    assert.equal(m.rules().length, 4);
    const done = m.run(["--remove"]);
    assert.equal(done.status, 0, `${done.stdout}\n${done.stderr}`);
    assert.equal(m.rules().length, 2);
    assert.ok(m.rules()[0].startsWith("22/tcp") && m.rules()[1].includes("# hubmanager:"), "the others are as they were");
    assert.ok(m.calls().includes("loginctl disable-linger turtlzim"));
    assert.ok(m.calls().some((call) => /^systemctl --user disable --now turtlzim-update\.timer turtlzim\.service$/.test(call)));
    for (const path of ["opt/turtlzim", "usr/local/lib/turtlzim", "etc/turtlzim"]) assert.ok(!existsSync(m.path(path)), path);
    assert.deepEqual(readdirSync(m.path("home/turtlzim/.config/systemd/user")), []);
    assert.equal(readFileSync(m.path("var/lib/turtlzim/zim.sqlite"), "utf8"), "the data", "the data is kept");
    assert.ok(!m.calls().some((call) => call.startsWith("userdel")), "and the account");
    // asked to, it takes the data and the account too
    const all = m.run(["--remove", "--purge-data", "--purge-account"]);
    assert.equal(all.status, 0, all.stderr);
    assert.ok(!existsSync(m.path("var/lib/turtlzim")));
    assert.ok(m.calls().includes("userdel -r turtlzim"));
  });
});
