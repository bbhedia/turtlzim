// Runs the built editor (dist/) in a real browser, headless Chromium, and drives it the way a user
// does: keystrokes, mouse clicks, opening and saving files. What the Vitest tests can't show:
// that CodeMirror accepts every decoration while rendering, that widgets respond to the mouse,
// and that a page survives the whole path through the UI byte for byte.
//
//   cd web
//   npm run wasm && npm run build
//   scripts/setup-browser.sh                                  # once: Chromium, libraries and a font, no root
//   ZIM_GOLDEN_DIR=~/.cache/turtlzim-labs/zim-desktop-wiki npm run test:browser
//
// ZIM_GOLDEN_DIR is optional: with it, every real Zim page is also loaded into the editor.
// Environment: CHROME_PATH (the Chromium binary; default: where Playwright puts it),
// CHROME_LIB_PATH (libraries Chromium needs that the system lacks; default:
// ~/.cache/turtlzim-browser-libs/root/usr/lib/x86_64-linux-gnu if that exists),
// SCREENSHOTS (a directory to write screenshots of the editor into).
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
if (!existsSync(join(dist, "index.html"))) {
  console.error("web/dist is missing: run `npm run wasm && npm run build` first");
  process.exit(2);
}

// The full Chromium (new headless mode), installed by scripts/setup-browser.sh. The old-style headless
// shell the core's tests use is not good enough for an editor: it mishandles keyboard input.
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(base)) {
    for (const dir of readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      const candidate = join(base, dir, "chrome-linux64", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("no Chromium found: run scripts/setup-browser.sh (or set CHROME_PATH)");
}

function libraryPath() {
  const extra =
    process.env.CHROME_LIB_PATH || join(homedir(), ".cache", "turtlzim-browser-libs", "root", "usr", "lib", "x86_64-linux-gnu");
  return existsSync(extra) ? [extra, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") : process.env.LD_LIBRARY_PATH;
}

// A font configuration that includes the fonts scripts/setup-browser.sh installed. Without any font
// a browser cannot edit text (see that script), so tests always run with it when it exists.
function fontConfig() {
  const file = join(homedir(), ".cache", "turtlzim-browser-libs", "fonts.conf");
  return existsSync(file) ? { FONTCONFIG_FILE: file } : {};
}

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = normalize(join(dist, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- a very small test runner ---------------------------------------------------------------

const results = [];
let problems = []; // page errors and console errors seen during the current scenario

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

async function scenario(name, run) {
  problems = [];
  const started = Date.now();
  try {
    await run();
    if (problems.length) throw new Error(`the page reported errors:\n    ${problems.join("\n    ")}`);
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

let browser;
let failed = true;
try {
  browser = await chromium.launch({
    executablePath: findChrome(),
    args: ["--no-sandbox"],
    env: { ...process.env, LD_LIBRARY_PATH: libraryPath(), ...fontConfig() },
  });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 900, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`[page error] ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`[console error] ${message.text()}`);
  });

  const text = () => page.evaluate(() => window.__zim.editor.getText());
  const setText = (t) => page.evaluate((t) => window.__zim.editor.setText(t), t);
  const caretTo = (pos) =>
    page.evaluate((pos) => {
      const { view } = window.__zim.editor;
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    }, pos);
  const status = () => page.locator("#status").innerText();
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  await page.goto(`${origin}/`);
  await page.waitForFunction(() => window.__zim !== undefined, null, { timeout: 30000 });
  const sample = await text();

  if (process.env.SCREENSHOTS) {
    mkdirSync(process.env.SCREENSHOTS, { recursive: true });
  }
  const screenshot = async (name) => {
    if (process.env.SCREENSHOTS) await page.screenshot({ path: join(process.env.SCREENSHOTS, `${name}.png`), fullPage: true });
  };

  await scenario("loads the sample page without changing a byte", async () => {
    assert(sample.startsWith("Content-Type: text/x-zim-wiki"), "the sample page is loaded");
    assert(sample.includes("**Zim wiki format**"), "the sample has its markup");
    assertEqual(await status(), "Ready. Edit the sample page, or open one of your own.", "status line");
    await settle();
    await screenshot("sample");
  });

  await scenario("renders constructs and hides their markup", async () => {
    await caretTo(0);
    await settle();
    const heading = await page.locator(".cm-zim-h1").first().innerText();
    assertEqual(heading, "Welcome to the Zim editor", "the title, without its = signs");
    assertEqual(await page.locator(".cm-zim-bold").first().innerText(), "Zim wiki format", "bold text, without **");
    assertEqual(await page.locator(".cm-zim-italic").first().innerText(), "Show markup", "italic text, without //");
    const link = await page.locator(".cm-zim-link").first().innerText();
    assertEqual(link, "page in the notebook", "a link shows its display text, not its target");
    assert((await page.locator(".cm-zim-bullet").count()) >= 3, "bullets are widgets");
    assert((await page.locator(".cm-zim-checkbox").count()) >= 4, "checkboxes are widgets");
    assert((await page.locator(".cm-zim-rule").count()) === 1, "the rule is a widget");
    assert((await page.locator(".cm-zim-chip-image").count()) === 1, "the image is a chip");
    const visible = await page.locator(".cm-content").innerText();
    assert(!visible.includes("======"), "no heading markers are visible");
    assert(!visible.includes("[["), "no link brackets are visible");
    assert(!visible.includes("**Bold**"), "no bold markers are visible");
  });

  await scenario("brings the markup back where the caret is", async () => {
    const at = sample.indexOf("Bold") + 2;
    await caretTo(at);
    await settle();
    // The caret is in "**Bold**" of the styles section: that construct shows its markers, while
    // the bold in the intro paragraph and the italics elsewhere stay tidy.
    const bolds = await page.locator(".cm-zim-bold").allInnerTexts();
    assert(bolds.includes("**Bold**"), `the bold under the caret shows its markers (saw ${JSON.stringify(bolds)})`);
    assert(bolds.includes("Zim wiki format"), "other bold text stays tidy");
    assert((await page.locator(".cm-zim-italic").allInnerTexts()).includes("Show markup"), "italics elsewhere stay tidy");
  });

  await scenario("show-markup reveals every syntax character", async () => {
    await caretTo(0);
    await page.check("#markup");
    await settle();
    const visible = await page.locator(".cm-content").innerText();
    assert(visible.includes("====== Welcome to the Zim editor ======"), "heading markers are shown");
    assert(visible.includes("[[Projects:Garden|page in the notebook]]"), "the whole link source is shown");
    await screenshot("sample-markup");
    await page.uncheck("#markup");
    await settle();
  });

  await scenario("typing goes into the document and nowhere else", async () => {
    const at = sample.indexOf("A bullet") + "A bullet".length;
    await caretTo(at);
    await page.keyboard.type(" typed");
    assertEqual(await text(), sample.slice(0, at) + " typed" + sample.slice(at), "the typed text is inserted in place");
    await page.keyboard.press("Control+z");
    assertEqual(await text(), sample, "undo restores the page");
  });

  await scenario("clicking a checkbox toggles it, and undo reverts it", async () => {
    await caretTo(0);
    await settle();
    const before = await text();
    await page.locator(".cm-zim-checkbox-open").first().click();
    const after = await text();
    assertEqual(after, before.replace("[ ] A task that is open", "[*] A task that is open"), "only the box changed");
    await page.keyboard.press("Control+z");
    assertEqual(await text(), before, "undo reverts the toggle");
  });

  await scenario("Ctrl-click follows a link, a plain click only places the caret", async () => {
    await caretTo(0);
    await settle();
    await page.locator(".cm-zim-link").first().click();
    assert(!(await status()).startsWith("Would follow"), "a plain click does not follow the link");
    await caretTo(0);
    await settle();
    await page.locator(".cm-zim-link").first().click({ modifiers: ["Control"] });
    assertEqual(await status(), "Would follow a page link to Projects:Garden", "Ctrl-click reports the link");
  });

  await scenario("formatting shortcuts, headings and list editing work with real key presses", async () => {
    const select = (from, to) =>
      page.evaluate(
        ([from, to]) => {
          const { view } = window.__zim.editor;
          view.dispatch({ selection: { anchor: from, head: to } });
          view.focus();
        },
        [from, to],
      );

    // Ctrl+B wraps the selection in bold; with the caret inside, it takes the bold off again.
    await setText("hello world\n");
    await select(0, 5);
    await page.keyboard.press("Control+b");
    assertEqual(await text(), "**hello** world\n", "Ctrl+B makes the selection bold");
    await caretTo(4);
    await page.keyboard.press("Control+b");
    assertEqual(await text(), "hello world\n", "Ctrl+B inside the bold takes it off");
    await page.keyboard.press("Control+i");
    assertEqual(await text(), "//hello// world\n", "Ctrl+I italicizes the word under the caret");
    await page.keyboard.press("Control+z");
    assertEqual(await text(), "hello world\n", "undo takes the formatting back");

    // Ctrl+Alt+1 makes the line a heading, again it makes it plain.
    await setText("Title\n");
    await caretTo(2);
    await page.keyboard.press("Control+Alt+1");
    assertEqual(await text(), "====== Title ======\n", "Ctrl+Alt+1 makes a level-1 heading");
    await page.keyboard.press("Control+Alt+2");
    assertEqual(await text(), "===== Title =====\n", "Ctrl+Alt+2 changes the level");
    await page.keyboard.press("Control+Alt+0");
    assertEqual(await text(), "Title\n", "Ctrl+Alt+0 makes it plain text again");

    // Enter continues a list, Tab nests it, Enter on an empty item goes out, then off the list.
    await setText("* one");
    await caretTo(5);
    await page.keyboard.press("Enter");
    await page.keyboard.type("two");
    assertEqual(await text(), "* one\n* two", "Enter continues the list");
    await page.keyboard.press("Tab");
    assertEqual(await text(), "* one\n\t* two", "Tab nests the item");
    await page.keyboard.press("Enter");
    assertEqual(await text(), "* one\n\t* two\n\t* ", "Enter continues at the same depth");
    await page.keyboard.press("Enter");
    assertEqual(await text(), "* one\n\t* two\n* ", "Enter on an empty item goes out a level");
    await page.keyboard.press("Enter");
    assertEqual(await text(), "* one\n\t* two\n", "Enter on an empty top-level item ends the list");

    // Numbers count up, and Backspace right after a marker takes the item off the list.
    await setText("1. first");
    await caretTo(8);
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    assertEqual(await text(), "1. first\n2. second", "numbers count up");
    await caretTo(12); // just after "2. "
    await page.keyboard.press("Backspace");
    assertEqual(await text(), "1. first\nsecond", "Backspace after the marker removes the marker");

    // Ctrl+Enter ticks the box on the caret's line.
    await setText("[ ] task\n");
    await caretTo(6);
    await page.keyboard.press("Control+Enter");
    assertEqual(await text(), "[*] task\n", "Ctrl+Enter ticks the box");
    await page.keyboard.press("Control+Enter");
    assertEqual(await text(), "[ ] task\n", "and unticks it");
  });

  await scenario("a CRLF page with a byte-order mark is shown as a clean page and saved back in its own dialect", async () => {
    const original = Buffer.from(
      "﻿Content-Type: text/x-zim-wiki\r\n\r\n====== Windows page ======\r\nSome **bold** text  \r\n\r\n[ ] a task\r\n",
      "utf8",
    );
    await page.setInputFiles("#open", { name: "crlf.txt", mimeType: "text/plain", buffer: original });
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Opened crlf.txt"));
    assert(
      (await status()).includes("byte-order mark, CRLF line endings, kept on save"),
      `the status says what the file was (${await status()})`,
    );
    assertEqual(
      await text(),
      "Content-Type: text/x-zim-wiki\n\n====== Windows page ======\nSome **bold** text  \n\n[ ] a task\n",
      "the editor holds clean text: no mark, plain line breaks",
    );
    await caretTo(0);
    await settle();
    assertEqual(await page.locator(".cm-zim-h1").innerText(), "Windows page", "the heading is recognized");
    assert((await page.locator(".cm-zim-header").count()) === 1, "the header block is recognized");
    assertEqual(await page.locator(".cm-specialChar").count(), 0, "no stray control-character glyphs");
    await screenshot("crlf");

    const [unchanged] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
    assert(readFileSync(await unchanged.path()).equals(original), "saving without edits gives back the same bytes");

    // Tick the task (one byte changes), then add a line: its break is written as CRLF like the rest.
    await page.locator(".cm-zim-checkbox-open").first().click();
    await page.evaluate(() => {
      const { view } = window.__zim.editor;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    });
    await page.keyboard.type("new line");
    const [edited] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
    const expected = Buffer.from(original.toString("utf8").replace("[ ] a task", "[*] a task") + "new line", "utf8");
    assert(readFileSync(await edited.path()).equals(expected), "exactly the tick and the new text differ");
  });

  await scenario("a file with mixed line endings is kept exactly, carriage returns and all", async () => {
    const original = Buffer.from("====== Mixed ======\r\nfirst\nsecond\r\n", "utf8");
    await page.setInputFiles("#open", { name: "mixed.txt", mimeType: "text/plain", buffer: original });
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Opened mixed.txt"));
    assertEqual(await text(), original.toString("utf8"), "no line ending is normalized");
    await settle();
    assert((await page.locator(".cm-specialChar").count()) >= 1, "the carriage returns are visible");
    const [saved] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
    assert(readFileSync(await saved.path()).equals(original), "saving gives back the same bytes");
  });

  await scenario("a file that is not UTF-8 is refused, not mangled", async () => {
    const before = await text();
    await page.setInputFiles("#open", { name: "latin1.txt", mimeType: "text/plain", buffer: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) });
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("not valid UTF-8"));
    assertEqual(await text(), before, "the editor still holds the previous page");
  });

  const corpus = (process.env.ZIM_GOLDEN_DIR ?? "").split(delimiter).filter(Boolean);
  if (corpus.length) {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) walk(join(dir, entry.name));
        else if (entry.isFile() && entry.name.endsWith(".txt")) files.push(join(dir, entry.name));
      }
    };
    corpus.forEach(walk);

    await scenario(`every real Zim page (${files.length} files) loads, renders and comes back byte for byte`, async () => {
      let loaded = 0;
      for (const file of files) {
        let content;
        try {
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
        } catch {
          continue; // not UTF-8: not a page
        }
        await setText(content);
        // Visit a handful of positions so the live-preview rules run against the real renderer.
        const length = content.length;
        for (const pos of [0, Math.floor(length / 3), Math.floor(length / 2), length]) await caretTo(pos);
        await settle();
        assertEqual(await text(), content, `${file} is unchanged in the editor`);
        if (problems.length) throw new Error(`while showing ${file}:\n    ${problems.join("\n    ")}`);
        loaded++;
      }
      assert(loaded > 50, `loaded ${loaded} pages`);
      console.log(`  (${loaded} real pages loaded)`);
    });
  }
  await page.close();

  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? ` (${r.ms} ms)` : `\n    ${r.error}`}`);
  failed = results.length === 0 || results.some((r) => !r.ok);
} finally {
  if (browser) await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
