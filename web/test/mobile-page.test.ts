// The page of the app in the shell (mobile/scripts/page.mjs): the web server's content policy in the page, and the shell's script before the app's.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../scripts/serve.mjs";
import { metaPolicy, shellPage } from "../../mobile/scripts/page.mjs";

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body><div id="app"></div></body>
</html>`;

describe("the policy for the page of the shell", () => {
  it("is the web server's, without the one directive that a <meta> can't carry", () => {
    const policy = metaPolicy(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("frame-ancestors");
    expect(policy.split("; ")).toEqual(CONTENT_SECURITY_POLICY.split("; ").filter((d) => !d.startsWith("frame-ancestors")));
    // (and what keeps the app from running anything that is not its own is still there)
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("object-src 'none'");
  });
});

describe("the page of the app as the shell's", () => {
  it("has the policy right after the charset, and the shell's script before the app's", () => {
    const made = shellPage(page, CONTENT_SECURITY_POLICY);
    const at = (text: string) => made.indexOf(text);
    expect(at('<meta charset="utf-8" />')).toBeGreaterThan(0);
    expect(at('<meta http-equiv="Content-Security-Policy"')).toBeGreaterThan(at('<meta charset="utf-8" />'));
    expect(at('<meta http-equiv="Content-Security-Policy"')).toBeLessThan(at("<script"));
    expect(at('<script type="module" src="./shell.js"></script>')).toBeLessThan(at('<script type="module" crossorigin src="./assets/index-abc.js">'));
    expect(made.match(/<script/g)).toHaveLength(2);
    expect(made.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(made).toContain(`content="${metaPolicy(CONTENT_SECURITY_POLICY)}"`);
    // nothing else of the page changed
    expect(made.replace(/\n    <meta http-equiv="Content-Security-Policy"[^>]*>/, "").replace('<script type="module" src="./shell.js"></script>\n    ', "")).toBe(page);
  });

  it("refuses a page that it can't put them in", () => {
    expect(() => shellPage(page.replace('<meta charset="utf-8" />', ""), "default-src 'self'")).toThrow(/charset/);
    expect(() => shellPage(page.replace(/<script[^>]*><\/script>/, ""), "default-src 'self'")).toThrow(/script/);
  });

  const built = new URL("../dist/index.html", import.meta.url);
  it.skipIf(!existsSync(built))("works on the page of the real build", () => {
    const made = shellPage(readFileSync(built, "utf8"), CONTENT_SECURITY_POLICY);
    expect(made.indexOf('src="./shell.js"')).toBeLessThan(made.indexOf('src="./assets/'));
    expect(made.match(/Content-Security-Policy/g)).toHaveLength(1);
  });
});
