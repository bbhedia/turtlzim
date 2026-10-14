// The installers of this system, from the web app's build: `npm run package` here (add `--web` to build ../web first).
//   Linux:   .deb, .rpm, .AppImage        Windows: .exe (NSIS) and .msi
// They are collected in out/ with a SHA256SUMS file. The program's own code is a few lines; what it carries is web/dist, so a new web build
// and this are all that a new version of the web app needs (.github/workflows/desktop.yml does it for both systems on every change).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = resolve(root, "../web");
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (process.argv.includes("--web")) run("npm", ["run", "build"], web);
if (!existsSync(join(web, "dist/index.html"))) {
  console.error("There is no build of the web app: `npm run build` in ../web (or `npm run package -- --web`).");
  process.exit(1);
}
run("npx", ["tauri", "build"], root);

const bundles = join(root, "src-tauri/target/release/bundle");
const out = join(root, "out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sums = [];
for (const kind of ["deb", "rpm", "appimage", "nsis", "msi"]) {
  const dir = join(bundles, kind);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    if (!statSync(path).isFile() || !/\.(deb|rpm|AppImage|exe|msi)$/.test(file)) continue;
    copyFileSync(path, join(out, file));
    sums.push(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${file}`);
    console.log(`${join("out", file)} (${(statSync(path).size / 1048576).toFixed(1)} MB)`);
  }
}
if (sums.length === 0) {
  console.error("tauri build made no installer.");
  process.exit(1);
}
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
