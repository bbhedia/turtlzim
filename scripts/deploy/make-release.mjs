// Makes what a machine that updates itself by pull takes (docs/zim-delivery.md): the server (its production dependencies only), the one file of web/scripts that the server imports, and the web app
// exactly as it was built, in one archive; a small manifest that says which commit that is, which Node it needs, and the archive's SHA-256; and a signature of that manifest. CI runs it on every
// green push to master (`.github/workflows/cd-beta.yml`) and publishes the three files in the GitHub pre-release `beta`; the machine's `turtlzim-update.mjs` checks all three before it installs anything.
//
//   node scripts/deploy/make-release.mjs --out DIR --commit SHA [--channel beta] [--sign-key FILE] [--install npm|copy] [--epoch SECONDS]
//
// --sign-key: an unencrypted OpenSSH private key; the manifest is signed with `ssh-keygen -Y sign` in the namespace `turtlzim-<channel>`, and the signature is checked at once with the key's own public half
// (a secret that is not a key, or not the one that was meant, stops the build here and not on the machine). --install copy takes server/node_modules as it is (tests); npm makes them with `npm ci --omit=dev`.
// The archive is the same bytes for the same files and the same --epoch (sorted, no owner, no names of the maker, no time in the gzip header).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** What a manifest says it is. The machine refuses a manifest of another format. */
export const FORMAT = 1;
/** The files of a channel, as the pre-release holds them: the archive, the manifest, the manifest's signature. */
export const assetsOf = (channel) => ({ archive: `turtlzim-${channel}.tar.gz`, manifest: `turtlzim-${channel}.json`, signature: `turtlzim-${channel}.json.sig` });
/** What a signature is made for: a signature made for the staging channel is not good for any other use. */
export const namespaceOf = (channel) => `turtlzim-${channel}`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const here = dirname(fileURLToPath(import.meta.url));

/** The files that the machine cannot do without: a tree that lacks one of them is not a release. */
const NEEDED = ["server/src/main.mjs", "server/package.json", "server/node_modules/nodemailer/package.json", "web/dist/index.html", "web/scripts/serve.mjs", "RELEASE.json"];

/** Whether `signature` is a good signature of `manifest` by a key in `signers` (an `allowed_signers` file), in this namespace: `ssh-keygen -Y verify`, which says nothing and exits 0 only for a good one. */
export function signatureHolds({ manifest, signature, signers, namespace }) {
  try {
    execFileSync("ssh-keygen", ["-Y", "verify", "-f", signers, "-I", namespace, "-n", namespace, "-s", signature], { input: readFileSync(manifest), stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make the release of `commit` for `channel` in `out`: the three files of `assetsOf(channel)`. `repoRoot` is a checkout with web/dist built; with `signKey` the manifest is signed (and the signature is tried).
 * @returns {{ archive: string, manifest: string, signature: string | null, data: object }}
 */
export function makeRelease({ repoRoot = resolve(here, "../.."), out, commit, channel = "beta", signKey, install = "npm", epoch = Math.floor(Date.now() / 1000) }) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit has to be the 40 hexadecimal characters of a commit");
  if (!/^[a-z][a-z0-9-]*$/.test(channel)) throw new Error("--channel has to be a lower-case name (beta, production)");
  if (!["npm", "copy"].includes(install)) throw new Error("--install is npm or copy");
  for (const need of ["server/src/main.mjs", "server/package.json", "server/package-lock.json", "web/dist/index.html", "web/scripts/serve.mjs"]) {
    if (!existsSync(join(repoRoot, need))) throw new Error(`${need} is missing from ${repoRoot}${need.startsWith("web/dist") ? ": build the web app first (npm run build in web/)" : ""}`);
  }
  const names = assetsOf(channel);
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "zim-release-"));
  try {
    const tree = join(work, "tree");
    mkdirSync(join(tree, "server"), { recursive: true });
    mkdirSync(join(tree, "web/scripts"), { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) cpSync(join(repoRoot, "server", file), join(tree, "server", file));
    cpSync(join(repoRoot, "server/src"), join(tree, "server/src"), { recursive: true });
    cpSync(join(repoRoot, "web/scripts/serve.mjs"), join(tree, "web/scripts/serve.mjs"));
    cpSync(join(repoRoot, "web/dist"), join(tree, "web/dist"), { recursive: true });
    if (install === "copy") cpSync(join(repoRoot, "server/node_modules"), join(tree, "server/node_modules"), { recursive: true });
    else execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: join(tree, "server"), stdio: "inherit" });
    const built = new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(join(tree, "RELEASE.json"), `${JSON.stringify({ format: FORMAT, channel, commit, built }, null, 2)}\n`);
    for (const need of NEEDED) if (!existsSync(join(tree, need))) throw new Error(`the release lacks ${need}`);

    // (sorted, no owner, a time that is given: the same files make the same archive)
    const tar = join(work, "release.tar");
    execFileSync("tar", ["--sort=name", `--mtime=@${epoch}`, "--owner=0", "--group=0", "--numeric-owner", "--format=gnu", "-cf", tar, "-C", tree, "."]);
    const archiveBytes = gzipSync(readFileSync(tar), { level: 9 });
    const archive = join(out, names.archive);
    writeFileSync(archive, archiveBytes);

    const engines = JSON.parse(readFileSync(join(repoRoot, "server/package.json"), "utf8")).engines?.node ?? "";
    const major = Number(/(\d+)/.exec(engines)?.[1]);
    if (!Number.isInteger(major)) throw new Error("server/package.json does not say which Node it needs (engines.node)");
    const serviceWorker = join(repoRoot, "web/dist/sw.js");
    const data = {
      format: FORMAT,
      channel,
      commit,
      built,
      node: { major },
      ...(existsSync(serviceWorker) ? { web: { sw: sha256(readFileSync(serviceWorker)) } } : {}),
      archive: { name: names.archive, sha256: sha256(archiveBytes), size: archiveBytes.length },
    };
    const manifest = join(out, names.manifest);
    writeFileSync(manifest, `${JSON.stringify(data, null, 2)}\n`);

    let signature = null;
    if (signKey) {
      const namespace = namespaceOf(channel);
      signature = `${manifest}.sig`;
      rmSync(signature, { force: true });
      execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-f", signKey, "-n", namespace, manifest], { stdio: ["ignore", "ignore", "pipe"] });
      // (tried at once with the public half of that very key: what is signed here is what a machine that trusts that key accepts)
      const publicKey = execFileSync("ssh-keygen", ["-y", "-f", signKey], { encoding: "utf8" }).trim().split(" ").slice(0, 2).join(" ");
      const signers = join(work, "allowed_signers");
      writeFileSync(signers, `${namespace} ${publicKey}\n`);
      if (!signatureHolds({ manifest, signature, signers, namespace })) throw new Error("the signature that was just made does not verify with the key's own public half");
    }
    return { archive, manifest, signature, data };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  const options = { install: "npm" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--out", "--commit", "--channel", "--sign-key", "--install", "--epoch", "--repo-root"].includes(flag)) throw new Error(`unknown option ${flag}`);
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    options[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  if (!options.out) throw new Error("--out DIR is needed");
  const made = makeRelease({
    repoRoot: options.repoRoot ? resolve(options.repoRoot) : undefined,
    out: resolve(options.out),
    commit: options.commit,
    channel: options.channel,
    signKey: options.signKey ? resolve(options.signKey) : undefined,
    install: options.install,
    epoch: options.epoch === undefined ? undefined : Number(options.epoch),
  });
  console.log(`archive   ${made.archive} (${statSync(made.archive).size} bytes, SHA-256 ${made.data.archive.sha256})`);
  console.log(`manifest  ${made.manifest}`);
  console.log(made.signature ? `signature ${made.signature} (checked with the key's own public half)` : "signature none: --sign-key was not given");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`make-release: ${error.message}`);
    process.exit(1);
  }
}
