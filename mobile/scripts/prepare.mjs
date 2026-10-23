// The web app's build (../web/dist) as the web files of the shell (www/): the same files, plus the shell's own script, which is put
// in front of the app's so that what it gives (window.__zimShell) is there when the app starts. Run `npm run build` in ../web first.
import { build } from "esbuild";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionOf } from "../../web/scripts/pwa.mjs";
import { CONTENT_SECURITY_POLICY } from "../../web/scripts/serve.mjs";
import { shellPage } from "./page.mjs";

/** What a build for the test of the app from the inside has before the app: the flag that gives the app to a test, and a note of what goes wrong before the test can see it. */
const E2E_FLAG = `window.__ZIM_TEST__ = true;
window.__e2eErrors = [];
const note = (kind, text) => {
  if (window.__e2eErrors.length < 50) window.__e2eErrors.push(kind + ": " + String(text).slice(0, 300));
};
window.addEventListener("error", (e) => note("error", e.message + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : "")));
window.addEventListener("unhandledrejection", (e) => note("rejection", (e.reason && e.reason.message) || e.reason));
document.addEventListener("securitypolicyviolation", (e) => note("csp", e.violatedDirective + " " + e.blockedURI));
const show = (a) => {
  if (a instanceof Error) return a.name + ": " + a.message;
  if (a && typeof a === "object") {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
};
const original = console.error;
console.error = (...args) => {
  note("console.error", args.map(show).join(" "));
  original.apply(console, args);
};
`;

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

let page = shellPage(readFileSync(join(www, "index.html"), "utf8"), CONTENT_SECURITY_POLICY);
if (process.env.ZIM_E2E === "1") {
  // a build made to be tried from the inside (test/ios-e2e.ts): the app is given to the test (before the app's own scripts, with a note of the errors that come), and the test runs after the app
  writeFileSync(join(www, "e2e-flag.js"), E2E_FLAG);
  await build({ entryPoints: [join(root, "test/ios-e2e.ts")], outfile: join(www, "e2e.js"), bundle: true, format: "esm", target: "es2022", logLevel: "warning" });
  const shellScript = '<script type="module" src="./shell.js"></script>';
  if (!page.includes(shellScript) || !page.includes("</body>")) throw new Error("The page of the shell has no place for the test.");
  page = page.replace(shellScript, `<script src="./e2e-flag.js"></script>\n    ${shellScript}`).replace("</body>", '  <script type="module" src="./e2e.js"></script>\n  </body>');
}
writeFileSync(join(www, "index.html"), page);
console.log(`www/ made from the web build ${web.id} (${app.version})`);
