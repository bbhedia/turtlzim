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
    // every command that the program has is one it answers to (a command that is written and not listed is a call that fails only when a person makes it)
    const listed = [...(/generate_handler!\[([^\]]*)\]/s.exec(program)?.[1] ?? "").split(",")].map((name) => name.trim()).filter(Boolean);
    const written = [...program.matchAll(/#\[tauri::command\]\s*(?:async )?fn (\w+)/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...written].sort());
    for (const command of ["save_file", "debug_log", "fs_roots", "fs_pick", "fs_forget", "fs_list", "fs_read", "fs_stage", "fs_commit"]) expect(listed, command).toContain(command);
    // and the program puts the script in the page before the app's own
    expect(program).toContain(".initialization_script(shell_script())");
  });

  it("gives the app the folder hooks that notebooks in folders ask of a shell, each over the command of the program that does it", () => {
    const script = read("../../desktop/src-tauri/shell.js");
    const program = read("../../desktop/src-tauri/src/main.rs");
    for (const [hook, command] of [["roots", "fs_roots"], ["pick", "fs_pick"], ["forget", "fs_forget"], ["list", "fs_list"], ["read", "fs_read"]]) {
      expect(script, hook).toMatch(new RegExp(`${hook}[:(].*invoke\\("${command}"`, "s"));
      expect(program, command).toContain(`async fn ${command}(`);
    }
    // a change is staged file by file, with the headers that the command reads, and then made as a whole
    for (const header of ["x-root", "x-txn", "x-n", "x-modified"]) {
      expect(script, header).toContain(`"${header}"`);
      expect(program, header).toContain(`"${header}"`);
    }
    expect(script).toContain('invoke("fs_stage", write.bytes, { headers })');
    expect(script).toContain('invoke("fs_commit", { id, txn, plan: { writes, deletes: change.deletes, moves: change.moves } })');
    expect(program).toContain("async fn fs_stage(");
    expect(program).toContain("async fn fs_commit(");
    // and the page names a folder by an id: no command takes a path from the page but a path inside a folder
    expect(program).not.toMatch(/async fn fs_\w+\([^)]*root_path|PathBuf>?,? path/);
  });

  it("gives the app the account hooks (the program makes the requests, opens the person's browser, keeps the token), each over the command of the program that does it", () => {
    const script = read("../../desktop/src-tauri/shell.js");
    const program = read("../../desktop/src-tauri/src/main.rs");
    expect(script).toMatch(/window\.__zimShell = \{[^}]*account,/s);
    for (const [hook, command] of [["request", "account_request"], ["begin", "account_sign_in_begin"], ["wait", "account_sign_in_wait"], ["cancel", "account_sign_in_cancel"], ["get", "account_secret_get"], ["set", "account_secret_set"], ["remove", "account_secret_remove"]]) {
      expect(script, hook).toMatch(new RegExp(`${hook}:.*invoke\\("${command}"`));
      expect(program, command).toMatch(new RegExp(`fn ${command}\\(`));
    }
    // the page asks for nothing by name that the program has not got: the address that a sign-in opens is checked by the program, and the token is kept by the program only
    expect(program).toContain("account::check_browser_url(&url)?");
    expect(program).toContain("secrets::SystemKeychain");
    // and the page's own policy still allows no network at all: what it asks of the server goes by the program's channel
    const connect: string = config.app.security.csp.split("; ").find((directive: string) => directive.startsWith("connect-src"));
    expect(connect).toBe("connect-src 'self' ipc: http://ipc.localhost");
  });

  it("fills in every placeholder of the script before it goes to the page (a placeholder left in it is a script that fails to run)", () => {
    const script = read("../../desktop/src-tauri/shell.js");
    const program = read("../../desktop/src-tauri/src/main.rs");
    const placeholders = [...new Set(script.match(/__ZIM_[A-Z_]+__/g))];
    expect(placeholders.length).toBeGreaterThanOrEqual(3);
    for (const placeholder of placeholders) expect(program, placeholder).toContain(`.replace("${placeholder}"`);
  });

  it("switches on, in WebKitGTK, the web storage features that it is built without (OPFS, which the vault needs)", () => {
    const program = read("../../desktop/src-tauri/src/main.rs");
    for (const feature of ["StorageAPI", "StorageAPIEstimate", "FileSystem", "FileSystemWritableStream", "AccessHandle"]) expect(program, feature).toContain(`"${feature}"`);
    expect(program).toContain("webkit_settings_set_feature_enabled");
    expect(read("../../desktop/src-tauri/Cargo.toml")).toMatch(/cfg\(target_os = "linux"\)'\.dependencies\]\s+webkit2gtk = /);
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
