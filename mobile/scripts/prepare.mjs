// The web app's build (../web/dist) as the web files of the shell (www/): the same files, plus the shell's own script, which is put
// in front of the app's so that what it gives (window.__zimShell) is there when the app starts. Run `npm run build` in ../web first.
import { build } from "esbuild";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionOf } from "../../web/scripts/pwa.mjs";
import { CONTENT_SECURITY_POLICY } from "../../web/scripts/serve.mjs";
import { shellPage } from "./page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "../web/dist");
const www = join(root, "www");

if (!existsSync(join(dist, "index.html"))) {
  console.error("There is no build of the web app: run `npm run build` in ../web first.");
  process.exit(1);
}

// what the About dialog says this is: this app's version, and the version (the fingerprint) of the web build inside it
const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const web = versionOf(readFileSync(join(dist, "sw.js"), "utf8"));
const version = `${app.version} · web build ${web.id}`;

rmSync(www, { recursive: true, force: true });
cpSync(dist, www, { recursive: true });
// (the worker is for a browser: the shell registers none, and the app does not ask for it)
for (const unused of ["sw.js"]) rmSync(join(www, unused), { force: true });

await build({
  entryPoints: [join(root, "shell/shell.ts")],
  outfile: join(www, "shell.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  define: { __SHELL_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});

writeFileSync(join(www, "index.html"), shellPage(readFileSync(join(www, "index.html"), "utf8"), CONTENT_SECURITY_POLICY));
console.log(`www/ made from the web build ${web.id} (${app.version})`);
