// The desktop program (desktop/, Tauri) must stay what the web app expects of a shell, and carry the same policy as the web server gives:
// these are the places where the two can drift apart without anything failing until someone installs the program.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../scripts/serve.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const config = JSON.parse(read("../../desktop/src-tauri/tauri.conf.json"));

describe("the desktop program", () => {
  it("carries web/dist as it is built, and has the version of the web app", () => {
    expect(config.build.frontendDist).toBe("../../web/dist");
    expect(config.version).toBe("../../web/package.json");
    expect(JSON.parse(read("../package.json")).version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("gives its pages the web server's content policy, and only what the program's own channel needs more", () => {
    const policy: string[] = config.app.security.csp.split("; ");
    const web = CONTENT_SECURITY_POLICY.split("; ").filter((directive) => !directive.startsWith("frame-ancestors") && !directive.startsWith("connect-src"));
    for (const directive of web) expect(policy, directive).toContain(directive);
    expect(policy).toContain("connect-src 'self' ipc: http://ipc.localhost");
    expect(policy.filter((directive) => !web.includes(directive))).toEqual(["connect-src 'self' ipc: http://ipc.localhost"]);
  });

  it("gives the app the hooks that the web app asks of a shell, under the names it asks", () => {
    const script = read("../../desktop/src-tauri/shell.js");
    expect(script).toContain("window.__zimShell = {");
    expect(script).toMatch(/version: "__ZIM_VERSION__"/);
    expect(script).toMatch(/async saveFile\(fileName, blob\)/);
    // the command that saves is the one the program has, and it is asked for the way the program reads it
    const program = read("../../desktop/src-tauri/src/main.rs");
    expect(script).toContain('invoke("save_file", bytes, { headers: { "x-file-name"');
    expect(program).toContain("async fn save_file(");
    expect(program).toContain('.get("x-file-name")');
    expect(program).toContain("generate_handler![save_file]");
    // and the program puts the script in the page before the app's own
    expect(program).toContain(".initialization_script(shell_script())");
  });

  it("asks the system for nothing that its pages do not need: no remote page, no permission but the basics", () => {
    const capability = JSON.parse(read("../../desktop/src-tauri/capabilities/default.json"));
    expect(capability.windows).toEqual(["main"]);
    expect(capability.permissions).toEqual(["core:default"]);
    expect(capability.remote).toBeUndefined();
    expect(config.app.windows).toEqual([]); // (the one window is made in main.rs, with the script)
    expect(config.app.withGlobalTauri).toBe(false);
  });
});
