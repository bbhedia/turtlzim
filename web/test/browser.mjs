// Runs the built app (dist/) in a real browser, headless Chromium, and uses it the way a person
// does: keystrokes, mouse clicks, dialogs, files going in and out. What the Vitest tests can't show:
// that CodeMirror accepts every decoration while rendering, that widgets respond to the mouse,
// that notebooks survive a reload through the browser's own IndexedDB, and that a notebook goes
// through import, editing and export with every byte it was not edited in still where it was.
//
//   cd web
//   npm run wasm && npm run build
//   scripts/setup-browser.sh                                  # once: Chromium, libraries and a font, no root
//   ZIM_GOLDEN_DIR=~/.cache/turtlzim-labs/zim-desktop-wiki npm run test:browser
//
// ZIM_GOLDEN_DIR is optional: with it, every real Zim page is also loaded into the editor, and the
// Zim manual (a notebook, found under that directory) is imported and exported through the app.
// Environment: CHROME_PATH, CHROME_LIB_PATH (see browser-launch.mjs); SCREENSHOTS (a directory: a
// failing scenario leaves a screenshot of the page in it); ONLY (run the scenarios whose name
// contains this text). Needs python3 (its zipfile module reads and writes the zips this test checks).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";
import { launchBrowser } from "./browser-launch.mjs";
import { png } from "./pictures.mjs";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
if (!existsSync(join(dist, "index.html"))) {
  console.error("web/dist is missing: run `npm run wasm && npm run build` first");
  process.exit(2);
}

// The same server that `npm run serve` runs, so the app is tested under the headers it ships
// with: any Content-Security-Policy violation is a console error here, and fails the scenario.
const server = createStaticServer({ dir: dist });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const work = mkdtempSync(join(tmpdir(), "zim-browser-test-"));

// The sample notebook's pages, from the source the app was built from (Node reads TypeScript that
// has only erasable types), so that what the app writes out is compared with what went in.
const { SAMPLE_PAGES } = await import("../src/notebook/sample.ts");
const samplePages = Object.fromEntries(SAMPLE_PAGES.map((p) => [p.name, p.text]));

// --- a very small test runner ---------------------------------------------------------------

const results = [];
let problems = []; // page errors and console errors seen during the current scenario
let currentScenario = "";
let livePage = null; // the page a scenario is using, for a screenshot if it fails

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

async function failureShot() {
  if (!process.env.SCREENSHOTS || !livePage) return;
  mkdirSync(process.env.SCREENSHOTS, { recursive: true });
  const file = `failed-${currentScenario.replace(/[^a-z0-9]+/gi, "-").slice(0, 70)}.png`;
  await livePage.screenshot({ path: join(process.env.SCREENSHOTS, file) }).catch(() => {});
}

async function scenario(name, run) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  currentScenario = name;
  problems = [];
  const started = Date.now();
  try {
    await run();
    if (problems.length) throw new Error(`the page reported errors:\n    ${problems.join("\n    ")}`);
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (error) {
    await failureShot();
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

let browser;

/**
 * A fresh browser profile (so a fresh IndexedDB: the sample notebook, nothing else) with the app
 * open. `beforeLoad`, if given, is a function that runs in the page before any of its own scripts.
 */
async function openApp({ beforeLoad, ...options } = {}) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 900 }, ...options });
  context.setDefaultTimeout(10_000);
  if (beforeLoad) await context.addInitScript(beforeLoad);
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`[page error] ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`[console error] ${message.text()}`);
  });
  await page.goto(`${origin}/`);
  await ready(page);
  livePage = page;
  return { context, ui: driver(page, context) };
}

const ready = (page) => page.waitForFunction(() => window.__zim !== undefined, null, { timeout: 30_000 });

/** One scenario in a browser of its own. */
function app(name, options, body) {
  return scenario(name, async () => {
    const { context, ui } = await openApp(options);
    try {
      await body(ui);
    } catch (error) {
      await failureShot();
      throw error;
    } finally {
      livePage = null;
      await context.close();
    }
  });
}

/** What a scenario does with the page, as short functions. */
function driver(page, context) {
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const d = {
    page,
    context,
    settle,
    dialog: () => page.locator("dialog.dialog"),
    // the editor
    text: () => page.evaluate(() => window.__zim.editor.getText()),
    // (as opening a page does, from the top)
    setText: (text) =>
      page.evaluate((t) => {
        window.__zim.editor.setText(t);
        document.querySelector(".page").scrollTop = 0;
      }, text),
    // Put the caret there, in view, and let the editor finish scrolling and drawing before anything
    // is typed: keys sent with no pause (as a program does) while the editor scrolls the caret into
    // view can land in the middle of it, which no person typing can.
    caretTo: async (pos) => {
      await page.evaluate((pos) => {
        const { view } = window.__zim.editor;
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        view.focus();
      }, pos);
      await settle();
    },
    select: async (from, to) => {
      await page.evaluate(
        ([from, to]) => {
          const { view } = window.__zim.editor;
          view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
          view.focus();
        },
        [from, to],
      );
      await settle();
    },
    /** Move the caret without scrolling or waiting (for visiting many positions quickly). */
    jumpTo: (pos) =>
      page.evaluate((pos) => {
        const { view } = window.__zim.editor;
        view.dispatch({ selection: { anchor: pos } });
      }, pos),
    typeAtEnd: async (text) => {
      await d.caretTo((await d.text()).length);
      await page.keyboard.type(text);
    },
    inEditor: () => page.evaluate(() => document.activeElement?.closest(".cm-editor") != null),
    // the app
    current: () => page.evaluate(() => window.__zim.app.current?.name ?? null),
    waitCurrent: (name) => page.waitForFunction((n) => window.__zim.app.current?.name === n, name),
    goto: async (name) => {
      await page.evaluate((n) => window.__zim.app.openPage(n, { push: true }), name);
      await settle();
    },
    flush: () => page.evaluate(() => window.__zim.app.flush()),
    names: () => page.evaluate(() => window.__zim.app.session.names().sort()),
    pageText: (name) => page.evaluate((n) => window.__zim.app.session.text(n) ?? null, name),
    allPages: () =>
      page.evaluate(() => {
        const session = window.__zim.app.session;
        return Object.fromEntries(session.names().map((n) => [n, session.text(n)]));
      }),
    pageCount: () => page.evaluate(() => window.__zim.app.session.pageCount),
    status: () => page.locator("#status").innerText(),
    saveState: () => page.locator(".save-state").innerText(),
    rows: () => page.locator(".tree .row").evaluateAll((rows) => rows.map((r) => r.dataset.name)),
    focusedRow: () => page.evaluate(() => document.activeElement?.dataset?.name ?? null),
    backlinks: () => page.locator(".backlink-list .link-button").allInnerTexts(),
    notebookTitle: () => page.locator(".notebook-title").innerText(),
    attachInput: () => page.locator('input[aria-label^="Choose files to attach"]'),
    /** Wait until the picture drawn for `{{...}}` number `index` (0 is the first) has loaded, and say how big it is drawn and in itself. */
    picture: async (index = 0) => {
      const image = page.locator("img.cm-zim-image").nth(index);
      await image.waitFor();
      await page.waitForFunction((i) => {
        const img = document.querySelectorAll("img.cm-zim-image")[i];
        return img && img.complete && img.naturalWidth > 0;
      }, index);
      return image.evaluate((img) => ({ drawn: [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)], natural: [img.naturalWidth, img.naturalHeight], alt: img.alt, src: img.src }));
    },
    attachmentNames: () => page.locator(".attachment-list .name").allInnerTexts(),
    reload: async () => {
      await page.reload();
      await ready(page);
    },
    // the notebook menu
    menu: () => page.locator(".notebook-menu .menu"),
    openMenu: async () => {
      await page.locator(".notebook-button").click();
      await d.menu().waitFor();
    },
    chooseFromMenu: async (name) => {
      await d.openMenu();
      await d.menu().getByRole("menuitem", { name }).click();
    },
    /** Click something that makes the browser download a file, and get that file. */
    download: async (trigger) => {
      const [download] = await Promise.all([page.waitForEvent("download"), trigger()]);
      return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
    },
    /** Fill in and confirm the dialog that is open (or about to be). */
    confirmDialog: async (button, fill = {}) => {
      const dialog = d.dialog();
      await dialog.waitFor();
      for (const [label, value] of Object.entries(fill)) await dialog.getByLabel(label).fill(value);
      await dialog.getByRole("button", { name: button, exact: true }).click();
      await dialog.waitFor({ state: "detached" });
    },
  };
  return d;
}

// --- files: folders and zips, read by programs other than the one under test ------------------

const PYTHON_UNZIP = `
import json, sys, zipfile
archive = zipfile.ZipFile(sys.argv[1])
bad = archive.testzip()
if bad is not None:
    sys.exit("corrupt entry: " + bad)
archive.extractall(sys.argv[2])
print(json.dumps(archive.namelist()))
`;
const PYTHON_ZIP = `
import os, sys, zipfile
folder = os.path.abspath(sys.argv[2])
parent = os.path.dirname(folder)
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for root, _, files in os.walk(folder):
        for name in sorted(files):
            path = os.path.join(root, name)
            archive.write(path, os.path.relpath(path, parent))
`;

/** Unzip with Python (which also checks every checksum): the names in the zip, and the files in `dir`. */
function unzip(bytes, dir) {
  const zipPath = `${dir}.zip`;
  writeFileSync(zipPath, bytes);
  const names = JSON.parse(execFileSync("python3", ["-c", PYTHON_UNZIP, zipPath, dir], { encoding: "utf8" }));
  return names.sort();
}

/** Zip a folder (deflate-compressed, the way other programs do), with the folder itself as the top. */
function zipFolder(folder, zipPath) {
  execFileSync("python3", ["-c", PYTHON_ZIP, zipPath, folder]);
}

function listFiles(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, base));
    else if (entry.isFile()) found.push(relative(base, full).split(sep).join("/"));
  }
  return found.sort();
}

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** Where Zim keeps a page: `Help:Reading List` is `Help/Reading_List.txt`. */
const pathOfName = (name) => `${name.split(":").map((part) => part.replaceAll(" ", "_")).join("/")}.txt`;
const nameOfPath = (path) => path.slice(0, -".txt".length).split("/").map((part) => part.replaceAll("_", " ")).join(":");

const utf8 = (text) => Buffer.from(text, "utf8");


try {
  browser = await launchBrowser();

  // ==========================================================================================
  // The editor, in the app's page (an unsaved scratch page, so that nothing here touches a notebook)
  // ==========================================================================================
  {
    const { context, ui } = await openApp({ viewport: { width: 900, height: 1000 } });
    const { page } = ui;
    const sample = await page.evaluate(() => window.__zim.editorSample);
    await ui.goto("Scratch");
    await ui.setText(sample);

    await scenario("renders constructs and hides their markup", async () => {
      await ui.setText(sample);
      await ui.caretTo(0);
      await ui.settle();
      assertEqual(await page.locator(".cm-zim-h1").first().innerText(), "Welcome to the Zim editor", "the title, without its = signs");
      assertEqual(await page.locator(".cm-zim-bold").first().innerText(), "Zim wiki format", "bold text, without **");
      assertEqual(await page.locator(".cm-zim-italic").first().innerText(), "Show markup", "italic text, without //");
      assertEqual(await page.locator(".cm-zim-link").first().innerText(), "page in the notebook", "a link shows its display text, not its target");
      assert((await page.locator(".cm-zim-bullet").count()) >= 3, "bullets are widgets");
      assert((await page.locator(".cm-zim-checkbox").count()) >= 4, "checkboxes are widgets");
      assert((await page.locator(".cm-zim-chip-image").count()) === 1, "the image is a chip");
      const visible = await page.locator(".cm-content").innerText();
      assert(!visible.includes("======"), "no heading markers are visible");
      assert(!visible.includes("[["), "no link brackets are visible");
      assert(!visible.includes("**Bold**"), "no bold markers are visible");
      // the rule is near the end of the page, and the editor draws only the lines near the window
      await page.evaluate(() => {
        const scroller = document.querySelector(".page");
        scroller.scrollTop = scroller.scrollHeight;
      });
      await page.locator(".cm-zim-rule").waitFor();
      assertEqual(await page.locator(".cm-zim-rule").count(), 1, "the rule is a widget");
    });

    await scenario("brings the markup back where the caret is", async () => {
      await ui.setText(sample);
      await ui.caretTo(sample.indexOf("Bold") + 2);
      await ui.settle();
      // The caret is in "**Bold**" of the styles section: that construct shows its markers, while
      // the bold in the intro paragraph and the italics elsewhere stay tidy.
      const bolds = await page.locator(".cm-zim-bold").allInnerTexts();
      assert(bolds.includes("**Bold**"), `the bold under the caret shows its markers (saw ${JSON.stringify(bolds)})`);
      assert(bolds.includes("Zim wiki format"), "other bold text stays tidy");
      assert((await page.locator(".cm-zim-italic").allInnerTexts()).includes("Show markup"), "italics elsewhere stay tidy");
    });

    await scenario("show-markup reveals every syntax character", async () => {
      await ui.setText(sample);
      await ui.caretTo(0);
      await page.check("#markup");
      try {
        await ui.settle();
        const visible = await page.locator(".cm-content").innerText();
        assert(visible.includes("====== Welcome to the Zim editor ======"), "heading markers are shown");
        assert(visible.includes("[[Projects:Garden|page in the notebook]]"), "the whole link source is shown");
      } finally {
        await page.uncheck("#markup");
      }
      await ui.settle();
      assert(!(await page.locator(".cm-content").innerText()).includes("======"), "and hidden again");
    });

    await scenario("typing goes into the document and nowhere else", async () => {
      await ui.setText(sample);
      const at = sample.indexOf("A bullet") + "A bullet".length;
      await ui.caretTo(at);
      await page.keyboard.type(" typed");
      assertEqual(await ui.text(), sample.slice(0, at) + " typed" + sample.slice(at), "the typed text is inserted in place");
      await page.keyboard.press("Control+z");
      assertEqual(await ui.text(), sample, "undo restores the page");
    });

    await scenario("clicking a checkbox toggles it, and undo reverts it", async () => {
      await ui.setText(sample);
      await ui.caretTo(0);
      await ui.settle();
      await page.locator(".cm-zim-checkbox-open").first().click();
      assertEqual(await ui.text(), sample.replace("[ ] A task that is open", "[*] A task that is open"), "only the box changed");
      await page.keyboard.press("Control+z");
      assertEqual(await ui.text(), sample, "undo reverts the toggle");
    });

    await scenario("formatting shortcuts, headings and list editing work with real key presses", async () => {
      // Ctrl+B wraps the selection in bold; with the caret inside, it takes the bold off again.
      await ui.setText("hello world\n");
      await ui.select(0, 5);
      await page.keyboard.press("Control+b");
      assertEqual(await ui.text(), "**hello** world\n", "Ctrl+B makes the selection bold");
      await ui.caretTo(4);
      await page.keyboard.press("Control+b");
      assertEqual(await ui.text(), "hello world\n", "Ctrl+B inside the bold takes it off");
      await page.keyboard.press("Control+i");
      assertEqual(await ui.text(), "//hello// world\n", "Ctrl+I italicizes the word under the caret");
      await page.keyboard.press("Control+z");
      assertEqual(await ui.text(), "hello world\n", "undo takes the formatting back");

      // Ctrl+Alt+1 makes the line a heading, again it makes it plain.
      await ui.setText("Title\n");
      await ui.caretTo(2);
      await page.keyboard.press("Control+Alt+1");
      assertEqual(await ui.text(), "====== Title ======\n", "Ctrl+Alt+1 makes a level-1 heading");
      await page.keyboard.press("Control+Alt+2");
      assertEqual(await ui.text(), "===== Title =====\n", "Ctrl+Alt+2 changes the level");
      await page.keyboard.press("Control+Alt+0");
      assertEqual(await ui.text(), "Title\n", "Ctrl+Alt+0 makes it plain text again");

      // Enter continues a list, Tab nests it, Enter on an empty item goes out, then off the list.
      await ui.setText("* one");
      await ui.caretTo(5);
      await page.keyboard.press("Enter");
      await page.keyboard.type("two");
      assertEqual(await ui.text(), "* one\n* two", "Enter continues the list");
      await page.keyboard.press("Tab");
      assertEqual(await ui.text(), "* one\n\t* two", "Tab nests the item");
      await page.keyboard.press("Enter");
      assertEqual(await ui.text(), "* one\n\t* two\n\t* ", "Enter continues at the same depth");
      await page.keyboard.press("Enter");
      assertEqual(await ui.text(), "* one\n\t* two\n* ", "Enter on an empty item goes out a level");
      await page.keyboard.press("Enter");
      assertEqual(await ui.text(), "* one\n\t* two\n", "Enter on an empty top-level item ends the list");

      // Numbers count up, and Backspace right after a marker takes the item off the list.
      await ui.setText("1. first");
      await ui.caretTo(8);
      await page.keyboard.press("Enter");
      await page.keyboard.type("second");
      assertEqual(await ui.text(), "1. first\n2. second", "numbers count up");
      await ui.caretTo(12); // just after "2. "
      await page.keyboard.press("Backspace");
      assertEqual(await ui.text(), "1. first\nsecond", "Backspace after the marker removes the marker");

      // Ctrl+Enter ticks the box on the caret's line.
      await ui.setText("[ ] task\n");
      await ui.caretTo(6);
      await page.keyboard.press("Control+Enter");
      assertEqual(await ui.text(), "[*] task\n", "Ctrl+Enter ticks the box");
      await page.keyboard.press("Control+Enter");
      assertEqual(await ui.text(), "[ ] task\n", "and unticks it");
    });

    await scenario("a page with carriage returns in it shows them, and keeps them", async () => {
      const mixed = "====== Mixed ======\r\nfirst\nsecond\r\n";
      await ui.setText(mixed);
      await ui.settle();
      assertEqual(await ui.text(), mixed, "no line ending is normalized");
      assert((await page.locator(".cm-specialChar").count()) >= 1, "the carriage returns are visible");
      await ui.setText("Content-Type: text/x-zim-wiki\n\n====== Plain ======\n");
      await ui.settle();
      assertEqual(await page.locator(".cm-specialChar").count(), 0, "no stray control-character glyphs on an ordinary page");
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
          await ui.setText(content);
          // Visit a handful of positions so the live-preview rules run against the real renderer.
          const length = content.length;
          for (const pos of [0, Math.floor(length / 3), Math.floor(length / 2), length]) await ui.jumpTo(pos);
          await ui.settle();
          assertEqual(await ui.text(), content, `${file} is unchanged in the editor`);
          if (problems.length) throw new Error(`while showing ${file}:\n    ${problems.join("\n    ")}`);
          loaded++;
        }
        assert(loaded > 50, `loaded ${loaded} pages`);
        console.log(`  (${loaded} real pages loaded)`);
      });
    }
    livePage = null;
    await context.close();
  }

  // ==========================================================================================
  // The notebook app
  // ==========================================================================================

  await app("starts on the home page of the sample notebook", {}, async (ui) => {
    const { page } = ui;
    assertEqual(await ui.current(), "Home", "the home page is open");
    assertEqual(await ui.notebookTitle(), "Sample notebook", "the notebook's name is shown");
    assertEqual(await page.title(), "Home — Sample notebook", "the tab says where you are");
    assertEqual(new URL(page.url()).hash, "#/Home", "the address names the page");
    assertEqual(await page.locator(".cm-zim-h1").first().innerText(), "Welcome", "the page is shown");
    assertDeepEqual(await ui.rows(), ["Help", "Home", "Ideas", "Journal", "Projects"], "the top of the tree, with sections folded");
    assertDeepEqual(await page.locator(".row.section").evaluateAll((rows) => rows.map((r) => r.dataset.name)), ["Help", "Journal"], "sections without a page of their own are marked");
    assertEqual(await page.locator('.row[data-name="Home"]').getAttribute("aria-selected"), "true", "the open page is marked in the tree");
    assert(await page.locator(".notice").isHidden(), "no notice on an ordinary page");
    assertEqual(await ui.pageCount(), SAMPLE_PAGES.length, "every page of the sample is there");
    assertEqual(await ui.pageText("Home"), samplePages.Home, "and the text of a page is what was written");
  });

  await app("the tree opens pages and folds sections; breadcrumb, Back and Forward agree with it", {}, async (ui) => {
    const { page } = ui;
    await page.locator('.row[data-name="Projects"] .chevron').click();
    assertDeepEqual(await ui.rows(), ["Help", "Home", "Ideas", "Journal", "Projects", "Projects:Garden", "Projects:Reading List"], "Projects unfolded: its pages show, Garden (with a page below) stays folded");
    await page.locator('.row[data-name="Projects:Garden"] .label').click();
    await ui.waitCurrent("Projects:Garden");
    assertEqual(new URL(page.url()).hash, "#/Projects%3AGarden", "the address follows");
    assertDeepEqual(await page.locator(".breadcrumb .crumb").allInnerTexts(), ["Projects", "Garden"], "the breadcrumb is the page's path");
    assertEqual(await page.locator('.row[data-name="Projects:Garden"]').getAttribute("aria-selected"), "true", "the tree marks the page");
    assertEqual(await page.locator(".cm-zim-h1").first().innerText(), "Garden", "the page is shown");
    await page.locator("button.crumb", { hasText: "Projects" }).click();
    await ui.waitCurrent("Projects");
    await page.goBack();
    await ui.waitCurrent("Projects:Garden");
    await page.goBack();
    await ui.waitCurrent("Home");
    await page.goForward();
    await ui.waitCurrent("Projects:Garden");
    // what was folded or unfolded is remembered
    await ui.reload();
    assertEqual(await ui.current(), "Projects:Garden", "a reload comes back to the page in the address");
    assert((await ui.rows()).includes("Projects:Reading List"), "and Projects is still unfolded");
    await page.getByRole("button", { name: "Fold all", exact: true }).click();
    assertDeepEqual(await ui.rows(), ["Help", "Home", "Ideas", "Journal", "Projects"], "Fold all folds every section");
    await page.getByRole("button", { name: "Unfold all", exact: true }).click();
    assert((await ui.rows()).includes("Projects:Garden:Plan"), "Unfold all unfolds them");
  });

  await app("the tree can be used from the keyboard, and keeps the focus where it was", {}, async (ui) => {
    const { page } = ui;
    await page.locator('.row[data-name="Home"]').focus();
    await page.keyboard.press("ArrowDown");
    assertEqual(await ui.focusedRow(), "Ideas", "Down moves to the next row");
    await page.keyboard.press("ArrowDown");
    assertEqual(await ui.focusedRow(), "Journal", "Down again");
    await page.keyboard.press("ArrowRight");
    assert((await ui.rows()).includes("Journal:2026-10-06"), "Right unfolds a section");
    assertEqual(await ui.focusedRow(), "Journal", "and stays on it");
    await page.keyboard.press("ArrowRight");
    assertEqual(await ui.focusedRow(), "Journal:2026-10-06", "Right on an unfolded section goes into it");
    await page.keyboard.press("Enter");
    await ui.waitCurrent("Journal:2026-10-06");
    assertEqual(await ui.focusedRow(), "Journal:2026-10-06", "the page opened, and the focus is still in the tree");
    await page.keyboard.press("ArrowLeft");
    assertEqual(await ui.focusedRow(), "Journal", "Left goes to the section above");
    await page.keyboard.press("ArrowLeft");
    assert(!(await ui.rows()).includes("Journal:2026-10-06"), "Left on an unfolded section folds it");
    await page.keyboard.press("End");
    assertEqual(await ui.focusedRow(), "Projects", "End goes to the last row");
    await page.keyboard.press("Home");
    assertEqual(await ui.focusedRow(), "Help", "Home to the first");
  });

  await app("Ctrl-click follows a link, and a plain click only places the caret", {}, async (ui) => {
    const { page } = ui;
    const link = page.locator(".cm-zim-link", { hasText: "Help:Editor" }).first();
    await link.click();
    assertEqual(await ui.current(), "Home", "a plain click does not follow the link");
    await link.click({ modifiers: ["Control"] });
    await ui.waitCurrent("Help:Editor");
    assertEqual(await page.locator(".cm-zim-h1").first().innerText(), "The editor", "the page it leads to is shown");
    assert(await ui.inEditor(), "and the cursor is in it, ready to write");
    await ui.goto("Home");
    await page.locator(".cm-zim-link", { hasText: "Today's journal" }).click({ modifiers: ["Control"] });
    await ui.waitCurrent("Journal:2026-10-06");
    // a link to a place on the page it is on moves there instead
    await ui.goto("Help:Links");
    await page.locator(".cm-zim-link", { hasText: "A link to a heading on this page" }).click({ modifiers: ["Control"] });
    assertEqual(await ui.current(), "Help:Links", "the page does not change");
    const line = await page.evaluate(() => {
      const { state } = window.__zim.editor.view;
      return state.doc.lineAt(state.selection.main.head).text;
    });
    assertEqual(line, "===== A place on this page =====", "the cursor is on the heading");
    // a plain name is looked up beside the page, then in the sections above it
    await ui.goto("Help:Links:Examples");
    await page.locator(".cm-zim-link", { hasText: "Links" }).first().click({ modifiers: ["Control"] });
    await ui.waitCurrent("Help:Links");
  });

  await app("a link to a page that doesn't exist is drawn differently; following it starts the page once something is typed", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Ideas");
    assertDeepEqual(await page.locator(".cm-zim-link-missing").allInnerTexts(), ["Beekeeping"], "only the link to the missing page is marked");
    assertEqual(await page.locator(".cm-zim-link").count(), 2, "and the other link is an ordinary one");
    await page.locator(".cm-zim-link-missing").click({ modifiers: ["Control"] });
    await ui.waitCurrent("Beekeeping");
    assert(!(await ui.names()).includes("Beekeeping"), "looking at a page doesn't make it");
    assert((await page.locator(".notice").innerText()).includes("doesn't exist yet"), "the page says so");
    assert(!(await ui.rows()).includes("Beekeeping"), "it is not in the tree");
    assert(await page.getByRole("button", { name: "Delete", exact: true }).isDisabled(), "there is nothing to delete");
    assert(await page.getByRole("button", { name: "Download", exact: true }).isDisabled(), "or to download");
    const template = await ui.text();
    assert(template.startsWith("Content-Type: text/x-zim-wiki") && template.includes("====== Beekeeping ======"), "it starts the way Zim starts a page");
    assert(await ui.inEditor(), "the cursor is in it");
    await page.keyboard.type("Bees!");
    await ui.flush();
    assertEqual(await ui.pageText("Beekeeping"), `${template}Bees!`, "typing made the page, with what was typed");
    assert((await ui.rows()).includes("Beekeeping"), "it is in the tree now");
    assert(await page.locator(".notice").isHidden(), "and the notice is gone");
    assertDeepEqual(await ui.backlinks(), ["Ideas"], "Ideas links to it");
    await ui.goto("Ideas");
    assertEqual(await page.locator(".cm-zim-link-missing").count(), 0, "the link on Ideas is an ordinary one now");
  });

  await app("backlinks list the pages that link here, with the line each link is on", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Projects:Garden");
    const names = await ui.backlinks();
    for (const expected of ["Home", "Journal:2026-10-06", "Projects", "Projects:Garden:Plan", "Help:Links"]) {
      assert(names.includes(expected), `${expected} links to the garden (saw ${JSON.stringify(names)})`);
    }
    for (const unexpected of ["Ideas", "Help:Editor", "Projects:Garden"]) assert(!names.includes(unexpected), `${unexpected} does not link to the garden`);
    assertEqual(await page.locator(".backlinks summary .count").innerText(), `(${names.length})`, "the count agrees with the list");
    const journal = page.locator(".backlink-list li", { hasText: "Journal:2026-10-06" });
    assertEqual(await journal.locator(".context").innerText(), "Morning: cleared the beds (Projects:Garden). Wrote down some thoughts in Ideas.", "the line is plain prose, without markup");
    await journal.locator(".link-button").click();
    await ui.waitCurrent("Journal:2026-10-06");
    assertEqual(await page.locator(".backlinks summary .count").innerText(), "(2)", "a page's own links count too: Home and the garden link to the journal");
    // a page that nothing links to
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await ui.confirmDialog("Create", { "Page name": "Journal:Lonely" });
    await ui.waitCurrent("Journal:Lonely");
    assertEqual(await page.locator(".backlink-list .none").innerText(), "No other page links here.", "an unlinked page says so");
  });

  await app("New page asks for a name, checks it, and makes the page where it was asked", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Projects:Garden");
    await page.getByRole("button", { name: "New page", exact: true }).click();
    const dialog = ui.dialog();
    await dialog.waitFor();
    const field = dialog.getByLabel("Page name");
    const create = dialog.getByRole("button", { name: "Create", exact: true });
    assertEqual(await field.inputValue(), "Projects:", "it starts in the section of the page you are on");
    assert(await create.isDisabled(), "a section without a page name is not enough");
    await page.keyboard.type("Compost");
    assertEqual(await field.inputValue(), "Projects:Compost", "typing continues where the name is");
    assert(await create.isEnabled(), "now it can be created");
    await field.fill("projects:garden");
    assert((await dialog.locator(".field-problem").innerText()).includes("already exists"), "a name that is taken (ignoring case) is refused");
    assert(await create.isDisabled(), "and can't be confirmed");
    await field.fill("Projects:Bad/name");
    assert((await dialog.locator(".field-problem").innerText()) !== "", "a name with a character a page can't have is refused");
    assert(await create.isDisabled(), "and can't be confirmed");
    await field.fill("Projects:Compost");
    await create.click();
    await dialog.waitFor({ state: "detached" });
    await ui.waitCurrent("Projects:Compost");
    assert((await ui.names()).includes("Projects:Compost"), "the page exists");
    assert((await ui.rows()).includes("Projects:Compost"), "and is in the tree");
    const text = await ui.pageText("Projects:Compost");
    assert(text.startsWith("Content-Type: text/x-zim-wiki\n") && text.includes("====== Compost ======"), "it starts the way Zim starts a page");
    assert(await ui.inEditor(), "the cursor is in it, at the end");
    await page.keyboard.type("Turn it weekly.");
    await ui.flush();
    assert((await ui.pageText("Projects:Compost")).endsWith("Turn it weekly."), "what is typed goes in");

    // a sub-page of the page you are on, confirmed with Enter
    await ui.goto("Projects:Garden");
    await page.getByRole("button", { name: "New sub-page", exact: true }).click();
    await dialog.waitFor();
    assertEqual(await field.inputValue(), "Projects:Garden:", "a sub-page starts below the page");
    await page.keyboard.type("Notes");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    await ui.waitCurrent("Projects:Garden:Notes");
    assert((await ui.names()).includes("Projects:Garden:Notes"), "the sub-page exists");
  });

  await app("Rename moves a page with everything below it, and the links to it follow", {}, async (ui) => {
    const { page } = ui;
    const before = await ui.allPages();
    await ui.goto("Projects:Garden");
    const linkingBefore = (await ui.backlinks()).sort();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const dialog = ui.dialog();
    await dialog.waitFor();
    const field = dialog.getByLabel("New name");
    assertEqual(await field.inputValue(), "Projects:Garden", "it starts from the page's name");
    assert((await dialog.innerText()).includes("The 1 page below it moves with it."), "the dialog says what moves");
    await page.keyboard.type("Allotment");
    assertEqual(await field.inputValue(), "Projects:Allotment", "the last part of the name is selected, so typing replaces it");
    assert(await dialog.getByLabel("Update the links to this page").isChecked(), "links are updated unless you say otherwise");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await dialog.waitFor({ state: "detached" });

    assertEqual(await ui.current(), "Projects:Allotment", "the page shown is the renamed one");
    assertEqual(new URL(page.url()).hash, "#/Projects%3AAllotment", "so is the address");
    assertDeepEqual(await page.locator(".breadcrumb .crumb").allInnerTexts(), ["Projects", "Allotment"], "and the breadcrumb");
    assert((await ui.status()).startsWith("Renamed Projects:Garden to Projects:Allotment; "), `the status says what happened (${await ui.status()})`);
    const after = await ui.allPages();
    assertDeepEqual(Object.keys(after).sort(), Object.keys(before).map((n) => n.replace(/^Projects:Garden/, "Projects:Allotment")).sort(), "the page and its sub-page moved, and no other page came or went");
    assertEqual(after.Home, before.Home.replace("[[Projects:Garden]]", "[[Projects:Allotment]]"), "Home's link follows the page, and nothing else on Home changed");
    assertEqual(after["Journal:2026-10-06"], before["Journal:2026-10-06"].replace("[[Projects:Garden]]", "[[Projects:Allotment]]"), "so does the journal's");
    for (const name of ["Ideas", "Help:Editor", "Projects:Reading List"]) assertEqual(after[name], before[name], `${name} didn't link to it and wasn't touched`);
    assertDeepEqual((await ui.backlinks()).sort(), linkingBefore.map((n) => n.replace(/^Projects:Garden/, "Projects:Allotment")).sort(), "the same pages link to it as did before (the sub-page having moved too)");
    assertEqual(await page.locator(".cm-zim-link-missing").count(), 0, "and none of the links on this page leads nowhere");
    await ui.goto("Home");
    assertEqual(await page.locator(".cm-zim-link-missing").count(), 0, "nor on Home");
    await page.locator(".cm-zim-link", { hasText: "Projects:Allotment" }).click({ modifiers: ["Control"] });
    await ui.waitCurrent("Projects:Allotment");

    // the notebook in the browser's storage is the renamed one
    await ui.reload();
    assertEqual(await ui.current(), "Projects:Allotment", "after a reload");
    assertDeepEqual(await ui.allPages(), after, "every page is as it was after the rename");

    // without updating links, the links are left alone (and now lead nowhere)
    await ui.goto("Ideas");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await dialog.waitFor();
    await dialog.getByLabel("New name").fill("Notes");
    await dialog.getByLabel("Update the links to this page").uncheck();
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await ui.waitCurrent("Notes");
    assertEqual(await ui.pageText("Home"), after.Home, "Home was not rewritten");
    await ui.goto("Home");
    assertDeepEqual(await page.locator(".cm-zim-link-missing").allInnerTexts(), ["Ideas"], "its link to Ideas now leads nowhere");

    // a name that is taken, or inside the page itself, is refused with the reason, and nothing moves
    await ui.goto("Notes");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await dialog.waitFor();
    for (const wanted of ["home", "Notes:Inside"]) {
      await dialog.getByLabel("New name").fill(wanted);
      await dialog.getByRole("button", { name: "Rename", exact: true }).click();
      await page.locator(".dialog-error:not(:empty)").waitFor();
      assert(await dialog.isVisible(), `the dialog stays open for ${wanted}`);
      assert((await dialog.locator(".dialog-error").innerText()) !== "", `and says why (${wanted})`);
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assertEqual(await ui.current(), "Notes", "nothing moved");
    assert((await ui.names()).includes("Home") && !(await ui.names()).includes("Notes:Inside"), "and nothing was made");
  });

  await app("Delete asks first, then removes a page and everything below it", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Projects:Garden");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = ui.dialog();
    await dialog.waitFor();
    const text = await dialog.innerText();
    assert(text.includes("Delete Projects:Garden and the 1 page below it? This can't be undone."), `the dialog says what goes (${text})`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert((await ui.names()).includes("Projects:Garden:Plan"), "cancelling deletes nothing");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog.getByRole("button", { name: "Delete 2 pages", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await ui.waitCurrent("Projects");
    assertDeepEqual((await ui.names()).filter((n) => n.startsWith("Projects:Garden")), [], "the page and the page below it are gone");
    assertEqual(await ui.status(), "Deleted 2 pages.", "the status says so");
    assert(!(await ui.rows()).includes("Projects:Garden"), "and the tree");
    await ui.goto("Home");
    assert((await page.locator(".cm-zim-link-missing").allInnerTexts()).includes("Projects:Garden"), "a link to a deleted page leads nowhere");
    await ui.reload();
    assertDeepEqual((await ui.names()).filter((n) => n.startsWith("Projects:Garden")), [], "and after a reload they are still gone");
  });

  await app("a section that has pages below it but no text can be opened, and given some", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Help");
    assert((await page.locator(".notice").innerText()).startsWith("This is a section"), "the page says what it is");
    assert(await page.getByRole("button", { name: "Rename", exact: true }).isEnabled(), "a section can be renamed");
    assert(await page.getByRole("button", { name: "Download", exact: true }).isDisabled(), "but there is no file to download yet");
    await ui.typeAtEnd("Everything about using the notebook.");
    await ui.flush();
    assert((await ui.names()).includes("Help"), "typing made the page");
    assertDeepEqual(await page.locator(".row.section").evaluateAll((rows) => rows.map((r) => r.dataset.name)), ["Journal"], "Help is no longer a bare section in the tree");
    assert(await page.locator(".notice").isHidden(), "and the notice is gone");
  });

  await app("search finds pages by what they say, and shows the words, not the markup", {}, async (ui) => {
    const { page } = ui;
    const search = page.locator("#search");
    await page.keyboard.press("/");
    assertEqual(await page.evaluate(() => document.activeElement?.id), "search", "the / key goes to the search box");
    await page.keyboard.type("beans");
    const names = await page.locator("#search-results .result-name").allInnerTexts();
    assert(names.includes("Projects:Garden") && names.includes("Projects:Garden:Plan"), `both garden pages mention beans (saw ${JSON.stringify(names)})`);
    const marks = await page.locator("#search-results mark").allInnerTexts();
    assert(marks.length > 0 && marks.every((m) => m.toLowerCase() === "beans"), `the words found are marked (saw ${JSON.stringify(marks)})`);
    for (const snippet of await page.locator("#search-results .result-snippet").allInnerTexts()) {
      assert(!/\*\*|\[\[|\]\]|======|\/\//.test(snippet), `a snippet is prose, without markup (saw ${JSON.stringify(snippet)})`);
    }
    await search.fill("======");
    assertEqual(await page.locator("#search-results .search-none").innerText(), "No page has all of: ======", "markup characters are not text: nothing has them");
    await search.fill("~~");
    assertEqual(await page.locator("#search-results .result").count(), 0, "nor is the strikethrough sign");
    await search.fill("[[not a link]]");
    assertDeepEqual(await page.locator("#search-results .result-name").allInnerTexts(), ["Help:Editor"], "but a code block is shown as written, brackets and all, so it is searched as written");
    await search.fill("plant beans");
    assertDeepEqual(await page.locator("#search-results .result-name").allInnerTexts(), ["Projects:Garden"], "every word has to be on the page");
    await search.fill("BEANS plant");
    assertDeepEqual(await page.locator("#search-results .result-name").allInnerTexts(), ["Projects:Garden"], "in any order, and any case");
    // pick with the keyboard
    await search.fill("garden");
    const found = await page.locator("#search-results .result-name").allInnerTexts();
    assert(found.length >= 3, `several pages mention the garden (saw ${found.length})`);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await ui.waitCurrent(found[1]);
    assert(await page.locator("#search-results").isHidden(), "choosing closes the results");
    assert(await ui.inEditor(), "and puts the cursor in the page");
    // Escape clears the box. (The / key is for when you're not typing in a page: in the editor it is a slash.)
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("/");
    await page.keyboard.type("xyz");
    await page.keyboard.press("Escape");
    assertEqual(await search.inputValue(), "", "Escape empties the box");
    assert(await page.locator("#search-results").isHidden(), "and closes the results");
  });

  await app("what is typed is saved by itself, or at once with Ctrl+S, and is there after a reload", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Ideas");
    const original = await ui.text();
    await ui.typeAtEnd("* Saved by itself");
    assertEqual(await ui.saveState(), "Editing…", "while typing, the page is waiting to be saved");
    await page.waitForFunction(() => document.querySelector(".save-state")?.textContent === "Saved");
    await ui.typeAtEnd(" and by Ctrl+S");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => document.getElementById("status")?.textContent === "Saved.");
    assertEqual(await ui.saveState(), "Saved", "it is saved");
    await ui.reload();
    assertEqual(await ui.current(), "Ideas", "the address brought the page back");
    assertEqual(await ui.text(), `${original}* Saved by itself and by Ctrl+S`, "with what was typed");
    // the show-markup choice is remembered too
    await page.check("#markup");
    await ui.reload();
    assert(await page.locator("#markup").isChecked(), "Show markup stays on");
    assert((await page.locator(".cm-content").innerText()).includes("====== Ideas ======"), "and the markup is shown");
  });

  await app("leaving the page right after typing keeps what was typed", {}, async (ui) => {
    const { page } = ui;
    page.on("dialog", (dialog) => void dialog.accept()); // the browser's "leave this page?" question
    await ui.goto("Ideas");
    await ui.typeAtEnd("quick");
    await page.reload(); // well inside the 700 ms the page waits before saving
    await ready(page);
    assert((await ui.text()).endsWith("quick"), `the last words survived the reload (the page ends ${JSON.stringify((await ui.text()).slice(-30))})`);
    assert((await ui.pageText("Ideas")).endsWith("quick"), "and are in the notebook, not only on the screen");
    assertEqual(await page.evaluate(() => localStorage.getItem("zim:draft")), null, "the safety copy is gone once they are in the notebook");
    await ui.reload();
    assert((await ui.text()).endsWith("quick"), "and stay there");
  });

  await app("typing is kept when the page closes while the store is still writing, and an old copy never replaces a newer page", {}, async (ui) => {
    const { page } = ui;
    page.on("dialog", (dialog) => void dialog.accept());
    await ui.goto("Ideas");
    const stored = await ui.pageText("Ideas");
    // a write that never finishes, as when the page is closed in the middle of one
    await page.evaluate(() => {
      window.__zim.app.session.store.replacePages = () => new Promise(() => {});
    });
    await ui.typeAtEnd("stuck");
    await page.evaluate(() => void window.__zim.app.flush());
    const inStore = () =>
      page.evaluate(async () => {
        const { session } = window.__zim.app;
        return (await session.store.loadPages(session.info.id)).find((p) => p.name === "Ideas").text;
      });
    assertEqual(await inStore(), stored, "the store does not have it yet");
    await ui.reload();
    assert((await ui.text()).endsWith("stuck"), "the page that comes back has what was typed");
    assert((await inStore()).endsWith("stuck"), "and the store has it");
    assert((await ui.status()).startsWith("Kept what you were typing in Ideas"), `the status says so (${await ui.status()})`);
    assertEqual(await page.evaluate(() => localStorage.getItem("zim:draft")), null, "the safety copy is gone");

    // a copy older than the page in the notebook is not put over it
    const kept = await ui.pageText("Ideas");
    await page.evaluate(() => {
      const draft = { notebook: window.__zim.app.session.info.id, name: "Ideas", text: "AN OLD COPY", at: 1 };
      localStorage.setItem("zim:draft", JSON.stringify(draft));
    });
    await ui.reload();
    assertEqual(await ui.pageText("Ideas"), kept, "the page is as it was");
    assertEqual(await page.evaluate(() => localStorage.getItem("zim:draft")), null, "and the old copy is dropped");
    // nor is a copy that isn't a copy
    await page.evaluate(() => localStorage.setItem("zim:draft", '{"notebook":1}'));
    await ui.reload();
    assertEqual(await ui.pageText("Ideas"), kept, "something that isn't a draft is ignored");
  });

  await app(
    "a browser that keeps nothing: the app runs from memory, says so, and the sample is still usable",
    {
      beforeLoad: () => {
        // what a browser that refuses site storage looks like to a page: there is no database to open
        Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true });
      },
    },
    async (ui) => {
      const { page } = ui;
      assert((await page.locator(".notice").innerText()).includes("won't keep notebooks"), "a notice says what you write is lost when the tab closes");
      assertEqual(await ui.current(), "Home", "the sample notebook opens as usual");
      await ui.goto("Ideas");
      assert((await page.locator(".notice").innerText()).includes("won't keep notebooks"), "and the notice stays on every page");
      await ui.typeAtEnd("written anyway");
      await ui.flush();
      assertEqual(await ui.saveState(), "Saved", "writing works");
      assert((await ui.pageText("Ideas")).endsWith("written anyway"), "and the notebook has it for as long as the tab lives");
      const zip = await ui.download(async () => {
        await ui.openMenu();
        await ui.menu().getByRole("menuitem", { name: "Export notebook (zip)" }).click();
      });
      const names = unzip(zip.bytes, join(work, "export-memory"));
      assert(names.includes("Ideas.txt"), "export still gets the notebook out");
      assert(readFileSync(join(work, "export-memory", "Ideas.txt"), "utf8").endsWith("written anyway"), "with what was written");
    },
  );

  await app("a save that fails is reported, the text stays in the editor, and the next save works", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Ideas");
    const stored = await ui.pageText("Ideas");
    await page.evaluate(() => {
      window.__zim.app.session.store.replacePages = async () => {
        throw new Error("disk full");
      };
    });
    await ui.typeAtEnd("one");
    await ui.flush();
    assertEqual(await ui.saveState(), "Not saved", "the page says so");
    assert((await ui.status()).includes("Couldn't save Ideas: disk full"), `and why (${await ui.status()})`);
    assert((await ui.text()).endsWith("one"), "what was typed is still in the editor");
    assertEqual(await ui.pageText("Ideas"), stored, "the notebook holds what the store holds");
    await page.evaluate(() => delete window.__zim.app.session.store.replacePages);
    await ui.typeAtEnd("two");
    await ui.flush();
    assertEqual(await ui.saveState(), "Saved", "the next save works");
    await ui.reload();
    assert((await ui.text()).endsWith("onetwo"), "and everything typed is there after a reload");
  });

  await app("notebooks: make one, switch between them, rename one, delete one", {}, async (ui) => {
    const { page } = ui;
    await ui.chooseFromMenu("New notebook…");
    const dialog = ui.dialog();
    await dialog.waitFor();
    assertEqual(await dialog.getByLabel("Start with").inputValue(), "empty", "a new notebook starts empty unless asked otherwise");
    await ui.confirmDialog("Create", { Name: "Garden notes" });
    assertEqual(await ui.notebookTitle(), "Garden notes", "it is open");
    assertDeepEqual(await ui.rows(), ["Home"], "with a home page and nothing else");
    assert((await ui.text()).includes("This notebook is empty."), "which says so");
    await ui.openMenu();
    const listed = await ui.menu().getByRole("menuitemradio").evaluateAll((items) => items.map((i) => [i.textContent, i.getAttribute("aria-checked")]).sort());
    assertDeepEqual(listed, [["Garden notes", "true"], ["Sample notebook", "false"]], "the menu lists both, with the open one checked");
    await ui.menu().getByRole("menuitemradio", { name: "Sample notebook" }).click();
    await page.waitForFunction(() => document.querySelector(".notebook-title")?.textContent === "Sample notebook");
    assertDeepEqual(await ui.rows(), ["Help", "Home", "Ideas", "Journal", "Projects"], "the sample notebook is as it was");
    assertEqual(await ui.pageCount(), SAMPLE_PAGES.length, "with all its pages");

    await ui.chooseFromMenu("Rename notebook…");
    await ui.confirmDialog("Rename", { Name: "Sample (renamed)" });
    assertEqual(await ui.notebookTitle(), "Sample (renamed)", "the name changed");
    await ui.reload();
    assertEqual(await ui.notebookTitle(), "Sample (renamed)", "and a reload comes back to this notebook, under its new name");

    await ui.openMenu();
    await ui.menu().getByRole("menuitemradio", { name: "Garden notes" }).click();
    await page.waitForFunction(() => document.querySelector(".notebook-title")?.textContent === "Garden notes");
    await ui.chooseFromMenu("Delete notebook…");
    await ui.dialog().waitFor();
    assert((await ui.dialog().innerText()).includes("Delete Garden notes and its 1 pages"), "the dialog names what goes");
    await ui.confirmDialog("Delete notebook");
    assertEqual(await ui.notebookTitle(), "Sample (renamed)", "the other notebook is open again");
    assertEqual(await ui.status(), "Deleted the notebook Garden notes.", "the status says so");
    await ui.openMenu();
    assertEqual(await ui.menu().getByRole("menuitemradio").count(), 1, "one notebook is left");
    await page.keyboard.press("Escape");

    // deleting the last notebook leaves an empty one, not nothing
    await ui.chooseFromMenu("Delete notebook…");
    await ui.confirmDialog("Delete notebook");
    assertEqual(await ui.notebookTitle(), "My notebook", "there is always a notebook to write in");
    assertDeepEqual(await ui.rows(), ["Home"], "an empty one");
  });

  await app("a page downloads as the file it is, and the notebook as a zip that other programs can read", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Projects:Garden");
    const file = await ui.download(() => page.getByRole("button", { name: "Download", exact: true }).click());
    assertEqual(file.name, "Garden.txt", "the file is named for the page");
    assert(file.bytes.equals(utf8(samplePages["Projects:Garden"])), "and holds the page, byte for byte");

    const zip = await ui.download(async () => {
      await ui.openMenu();
      await ui.menu().getByRole("menuitem", { name: "Export notebook (zip)" }).click();
    });
    assertEqual(zip.name, "Sample_notebook.zip", "the zip is named for the notebook");
    const dir = join(work, "export-sample");
    const names = unzip(zip.bytes, dir);
    assertDeepEqual(names, ["notebook.zim", ...SAMPLE_PAGES.map((p) => pathOfName(p.name))].sort(), "it holds a notebook.zim and each page at the path Zim gives it");
    for (const p of SAMPLE_PAGES) assert(readFileSync(join(dir, pathOfName(p.name))).equals(utf8(p.text)), `${p.name} is unchanged`);
    const config = readFileSync(join(dir, "notebook.zim"), "utf8");
    assert(/^name=Sample notebook$/m.test(config) && /^home=Home$/m.test(config), `notebook.zim names the notebook and its home page (${config})`);
  });

  // the files of a notebook as Windows tools write them: byte-order marks, CRLF, a mix, files that aren't pages
  const windowsFolder = join(work, "Windows notebook");
  const startFile = "﻿Content-Type: text/x-zim-wiki\r\nWiki-Format: zim 0.6\r\n\r\n====== Start ======\r\nSome **bold** text  \r\n\r\n[ ] a task\r\n[[Mixed]] and [[Sub:Page]]\r\n";
  const mixedFile = "====== Mixed ======\r\nfirst\nsecond\r\n";
  const subFile = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\n\n====== Page ======\nin a section\n";
  writeFiles(windowsFolder, {
    "notebook.zim": "[Notebook]\nversion=0.4\nname=Windows notebook\nhome=Start\n",
    "Start.txt": utf8(startFile),
    "Mixed.txt": utf8(mixedFile),
    "Sub/Page.txt": utf8(subFile),
    "Latin1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    "Dup.txt": "one\n",
    "dup.txt": "two\n",
    "a?b.txt": "not a page name\n",
    "picture.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ".hidden/Secret.txt": "nobody asked\n",
  });

  await app("importing a folder: what can't be a page is listed, the rest keeps its file dialect through editing and export", {}, async (ui) => {
    const { page } = ui;
    await page.locator("input[webkitdirectory]").setInputFiles(windowsFolder);
    const dialog = ui.dialog();
    await dialog.waitFor();
    const text = await dialog.innerText();
    assert(text.includes("4 pages and 1 attachment (the files that go with pages"), `the dialog counts what comes in (${text})`);
    assert(text.includes("3 files were skipped:"), `and what doesn't (${text})`);
    assert(text.includes("Latin1.txt: not valid UTF-8"), "a file that isn't UTF-8 is named, with the reason");
    assert(/a\?b\.txt: /.test(text), "so is a name that is not a page name");
    assert(/has the same name as (Dup|dup)\.txt/.test(text), "and the second of two names that differ only in case");
    assert(!text.includes("Secret"), "hidden files are not mentioned");
    assertEqual(await dialog.getByLabel("Notebook name").inputValue(), "Windows notebook", "the notebook's own name is suggested");
    await ui.confirmDialog("Import");
    assertEqual(await ui.notebookTitle(), "Windows notebook", "the new notebook is open");
    assertEqual(await ui.current(), "Start", "at the home page its notebook.zim names");
    assertEqual(await ui.status(), "Imported 4 pages and 1 attachment as Windows notebook.", "the status says so");
    assertEqual(await ui.pageCount(), 4, "four pages (Start, Mixed, Sub:Page and one of Dup and dup)");

    // the file is shown as a clean page; its byte-order mark and CRLF are the file's business
    assertEqual(await ui.text(), startFile.slice(1).replaceAll("\r\n", "\n"), "no mark, plain line breaks");
    await ui.settle();
    assertEqual(await page.locator(".cm-specialChar").count(), 0, "no stray control-character glyphs");
    assertEqual(await page.locator(".cm-zim-h1").innerText(), "Start", "the heading is recognized");
    // edit it: tick the task
    await page.locator(".cm-zim-checkbox-open").first().click();
    await ui.flush();
    // look at the page with the carriage returns in it
    await ui.goto("Mixed");
    assertEqual(await ui.text(), mixedFile, "a file of mixed line endings is shown exactly");
    await ui.settle();
    assert((await page.locator(".cm-specialChar").count()) >= 1, "its carriage returns are visible");

    // out again: only the tick differs
    const single = await ui.download(async () => {
      await ui.goto("Start");
      await page.getByRole("button", { name: "Download", exact: true }).click();
    });
    assertEqual(single.name, "Start.txt", "a single page downloads under its name");
    assert(single.bytes.equals(utf8(startFile.replace("[ ] a task", "[*] a task"))), "with its byte-order mark and CRLF, and the tick");
    const zip = await ui.download(async () => {
      await ui.openMenu();
      await ui.menu().getByRole("menuitem", { name: "Export notebook (zip)" }).click();
    });
    const dir = join(work, "export-windows");
    const exported = unzip(zip.bytes, dir);
    assertEqual(exported.filter((n) => /^dup\.txt$/i.test(n)).length, 1, "of the two files whose names differ only in case, one came in");
    assertDeepEqual(exported.filter((n) => !/^dup\.txt$/i.test(n)), ["Mixed.txt", "Start.txt", "Sub/Page.txt", "notebook.zim", "picture.png"].sort(), "the zip holds the pages and the attachment that came in");
    assert(readFileSync(join(dir, "picture.png")).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), "picture.png: unchanged");
    assert(readFileSync(join(dir, "Start.txt")).equals(utf8(startFile.replace("[ ] a task", "[*] a task"))), "Start.txt: the tick is the only change, and the dialect is kept");
    assert(readFileSync(join(dir, "Mixed.txt")).equals(utf8(mixedFile)), "Mixed.txt: unchanged");
    assert(readFileSync(join(dir, "Sub/Page.txt")).equals(utf8(subFile)), "Sub/Page.txt: unchanged");
  });

  await app("importing a folder into the notebook that is open adds its pages, and replaces the ones it shares a name with", {}, async (ui) => {
    const { page } = ui;
    const importHere = async (expectedLabel) => {
      await page.locator("input[webkitdirectory]").setInputFiles(windowsFolder);
      const dialog = ui.dialog();
      await dialog.waitFor();
      const into = dialog.getByLabel("Import as");
      const label = await into.locator("option").nth(1).innerText();
      assertEqual(label, expectedLabel, "the dialog says what would be replaced");
      await into.selectOption("here");
      await dialog.getByRole("button", { name: "Import", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
    };
    await importHere("More pages in Sample notebook");
    assertEqual(await ui.pageCount(), SAMPLE_PAGES.length + 4, "four pages were added");
    assertEqual(await ui.notebookTitle(), "Sample notebook", "to the notebook that was open");
    assertEqual(await ui.status(), "Imported 4 pages and 1 attachment into Sample notebook.", "the status says so");
    assert((await ui.rows()).includes("Start") && (await ui.rows()).includes("Mixed"), "they are in the tree");
    // write on one of them, then bring the folder in again: the page shown is replaced by the file's
    await ui.goto("Start");
    await ui.typeAtEnd("my own words");
    await ui.flush();
    assert((await ui.text()).endsWith("my own words"), "the page has been written on");
    await importHere("More pages in Sample notebook (replaces 4 pages and 1 file with the same names)");
    assertEqual(await ui.text(), startFile.slice(1).replaceAll("\r\n", "\n"), "the page shown is the file's again");
    assertEqual(await ui.pageCount(), SAMPLE_PAGES.length + 4, "and nothing was added");
  });

  const corpusDirs = (process.env.ZIM_GOLDEN_DIR ?? "").split(delimiter).filter(Boolean);
  const manualDir = corpusDirs.flatMap((root) => [root, join(root, "data", "manual")]).find((dir) => existsSync(join(dir, "notebook.zim")));
  if (manualDir) {
    const files = listFiles(manualDir);
    const pageFiles = files.filter((f) => f.endsWith(".txt"));
    const attachments = files.filter((f) => !f.endsWith(".txt") && f !== "notebook.zim").length;

    await app(`importing the Zim manual (${pageFiles.length} pages): every page arrives, links work, and exporting gives back the same bytes`, {}, async (ui) => {
      const { page } = ui;
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), (async () => { await ui.openMenu(); await ui.menu().getByRole("menuitem", { name: "Import a folder…" }).click(); })()]);
      await chooser.setFiles(manualDir);
      const dialog = ui.dialog();
      await dialog.waitFor();
      const text = await dialog.innerText();
      assert(text.includes(`${pageFiles.length} pages and ${attachments} attachments`), `the dialog counts the pages and the attachments (${text.slice(0, 300)})`);
      assertEqual(await dialog.getByLabel("Notebook name").inputValue(), "manual", "the notebook is called what its notebook.zim says");
      await ui.confirmDialog("Import");
      assertEqual(await ui.notebookTitle(), "manual", "the notebook is open");
      assertEqual(await ui.current(), "Start", "at the home page notebook.zim names");
      assertEqual(await ui.pageCount(), pageFiles.length, "every page came in");
      assertEqual(await ui.status(), `Imported ${pageFiles.length} pages and ${attachments} attachments as manual.`, "the status says so");
      assertEqual(await page.evaluate(() => window.__zim.app.session.fileCount), attachments, "every attachment came in");

      const pages = await ui.allPages();
      let compared = 0;
      for (const file of pageFiles) {
        const bytes = readFileSync(join(manualDir, file));
        if (bytes.includes(0x0d) || (bytes[0] === 0xef && bytes[1] === 0xbb)) continue; // a dialect: checked on the way out
        assertEqual(pages[nameOfPath(file)], bytes.toString("utf8"), `${file} is the page ${nameOfPath(file)}`);
        compared++;
      }
      assert(compared > 50, `${compared} pages compared`);

      // follow a link, search, look at who links to a page
      await page.locator(".cm-zim-link", { hasText: "Getting Started" }).first().click({ modifiers: ["Control"] });
      await ui.waitCurrent("Usage:Getting Started");
      assert((await ui.backlinks()).includes("Start"), "the start page links to Getting Started");
      await page.locator("#search").fill("checkbox");
      assert((await page.locator("#search-results .result").count()) > 1, "search finds the pages that mention checkboxes");
      await page.keyboard.press("Escape");

      // out again: the notebook folder comes back, every page byte for byte
      const zip = await ui.download(async () => {
        await ui.openMenu();
        await ui.menu().getByRole("menuitem", { name: "Export notebook (zip)" }).click();
      });
      assertEqual(zip.name, "manual.zip", "the zip is named for the notebook");
      const dir = join(work, "export-manual");
      const names = unzip(zip.bytes, dir);
      assertDeepEqual(names.filter((n) => n !== "notebook.zim"), files.filter((f) => f !== "notebook.zim"), "the same files, at the same paths: the pages and the attachments");
      for (const file of files.filter((f) => f !== "notebook.zim")) assert(readFileSync(join(dir, file)).equals(readFileSync(join(manualDir, file))), `${file} comes back unchanged`);
      const config = readFileSync(join(dir, "notebook.zim"), "utf8");
      assert(/^name=manual$/m.test(config) && /^home=Start$/m.test(config), `notebook.zim names the notebook and its home (${config})`);

      // and that zip, and one made by another program (deflate-compressed, the way zips usually are), come in again
      const again = join(work, "manual-again.zip");
      writeFileSync(again, zip.bytes);
      const deflated = join(work, "manual-deflated.zip");
      zipFolder(dir, deflated);
      for (const [label, zipFile, title] of [["our own zip", again, "from our zip"], ["a deflate-compressed zip", deflated, "from a deflated zip"]]) {
        await page.locator('input[type="file"][accept*="zip"]').setInputFiles(zipFile);
        await ui.dialog().waitFor();
        await ui.confirmDialog("Import", { "Notebook name": title });
        assertEqual(await ui.notebookTitle(), title, `${label}: the notebook is open`);
        assertEqual(await ui.pageCount(), pageFiles.length, `${label}: every page is in it`);
        assertEqual(await page.evaluate(() => window.__zim.app.session.fileCount), attachments, `${label}: and every attachment`);
        assertDeepEqual(await ui.allPages(), pages, `${label}: and each one is what it was`);
      }
    });
  } else {
    console.log("  (ZIM_GOLDEN_DIR has no notebook: the Zim manual is not imported)");
  }

  // ==========================================================================================
  // Attachments and pictures
  // ==========================================================================================

  const green = png(320, 180, [80, 160, 90]);
  const gardenText = () => samplePages["Projects:Garden"];

  await app("Attach… stores files in the page's folder, refers to them from the page, and shows the picture", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Projects:Garden");
    await ui.attachInput().setInputFiles([
      { name: "Bed 1.png", mimeType: "image/png", buffer: green },
      { name: "Seed list.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 not really a pdf") },
    ]);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Attached 2 files"));
    assertEqual(await ui.status(), "Attached 2 files to Projects:Garden.", "the status says so");
    const text = await ui.text();
    assert(text.startsWith(gardenText()), "the page is as it was, and what was added comes after it (not above its header)");
    assertEqual(text.slice(gardenText().length), "{{./Bed 1.png}}\n[[./Seed list.pdf|Seed list.pdf]]\n", "a picture is referred to as a picture and another file as a link");
    const paths = await page.evaluate(() => window.__zim.app.session.attachments("Projects:Garden").map((f) => f.path).sort());
    assertDeepEqual(paths, ["Projects/Garden/Bed 1.png", "Projects/Garden/Seed list.pdf"], "the files are in the folder named like the page");
    const shown = await ui.picture();
    assertDeepEqual(shown.natural, [320, 180], "the picture is the one that was attached");
    assertDeepEqual(shown.drawn, [320, 180], "drawn at its own size");
    assert(shown.src.startsWith("blob:"), "from an object URL, not the network");
    assertDeepEqual(await ui.attachmentNames(), ["Bed 1.png", "Seed list.pdf"], "the panel lists them");
    assertEqual(await page.locator(".attachments summary .count").innerText(), "(2)", "with a count");
    assertEqual(await page.locator(".attachment-list li").first().locator(".meta").innerText(), `${green.length} B · image/png`, "and their sizes and types");
    assertEqual(await page.locator(".attachment-list li").first().locator(".thumb img").count(), 1, "a picture has a thumbnail");
    // the same name again gets a free one
    await ui.attachInput().setInputFiles([{ name: "Bed 1.png", mimeType: "image/png", buffer: green }]);
    await page.waitForFunction(() => document.querySelectorAll(".attachment-list li").length === 3);
    assertDeepEqual(await ui.attachmentNames(), ["Bed 1 2.png", "Bed 1.png", "Seed list.pdf"], "a second file of the same name is kept beside the first");
    // it all survives a reload
    await ui.flush();
    await ui.reload();
    const again = await ui.picture();
    assertDeepEqual(again.natural, [320, 180], "the picture is still there after a reload");
    assertEqual((await ui.attachmentNames()).length, 3, "and so are the attachments");
  });

  await app("a picture pasted from the clipboard is attached, unless the clipboard holds text", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Ideas");
    const text = await ui.text();
    const at = text.indexOf("* A rain barrel");
    await ui.caretTo(at);
    const paste = (withText) =>
      page.evaluate(
        ({ b64, withText }) => {
          const data = new DataTransfer();
          data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
          if (withText) data.setData("text/plain", "just text");
          const target = document.querySelector(".cm-content");
          target.focus();
          target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        },
        { b64: png(60, 40, [200, 80, 80]).toString("base64"), withText },
      );
    await paste(false);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Attached Pasted image"));
    const attached = await ui.text();
    const name = (await ui.status()).match(/Attached (Pasted image [\d-]+ [\d.]+\.png) to Ideas\./)?.[1];
    assert(name, `the picture was given a name from the time (${await ui.status()})`);
    assertEqual(attached, text.slice(0, at) + `{{./${name}}}` + text.slice(at), "it is where the caret was");
    await paste(true);
    await ui.settle();
    assert((await ui.text()).includes("just text"), "text on the clipboard is pasted as text");
    assertEqual((await ui.attachmentNames()).length, 1, "and the picture beside it is not attached");
  });

  await app("files dropped on the page are attached where they were dropped, or at the end if dropped on the page beside the text", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Ideas");
    const original = await ui.text();
    const pointAt = (pos) =>
      page.evaluate((pos) => {
        const rect = window.__zim.editor.view.coordsAtPos(pos);
        return { x: Math.round(rect.left) + 1, y: Math.round((rect.top + rect.bottom) / 2) };
      }, pos);
    /** Send one drag event for a file to whatever is at `point`; say whether the page shows that it takes files, and whether the event was left to the browser. */
    const drag = (type, point, name = "dropped.png") =>
      page.evaluate(
        ({ type, x, y, b64, name }) => {
          const data = new DataTransfer();
          data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: "image/png" }));
          const target = document.elementFromPoint(x, y);
          const event = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, clientX: x, clientY: y });
          target.dispatchEvent(event);
          return { showing: document.querySelector(".page").classList.contains("dropping"), prevented: event.defaultPrevented };
        },
        { type, ...point, b64: png(50, 50, [20, 20, 200]).toString("base64"), name },
      );
    const attachedFrom = async (name) => {
      await page.waitForFunction((n) => document.getElementById("status").textContent.startsWith(`Attached ${n}`), name);
    };

    // in the middle of a line
    const middle = original.indexOf("barrel");
    const there = await pointAt(middle);
    assertEqual((await drag("dragenter", there)).showing, true, "the page shows that it takes files while they are over it");
    const over = await drag("dragover", there);
    assertEqual(over.prevented, true, "and says that they may be dropped");
    assertEqual((await drag("drop", there)).showing, false, "it stops showing it once they are dropped");
    await attachedFrom("dropped.png");
    assertEqual(await ui.text(), original.slice(0, middle) + "{{./dropped.png}}" + original.slice(middle), "the reference is where they were dropped");
    assertEqual((await ui.picture()).natural.join("x"), "50x50", "and the picture is shown there");

    // on a bullet (a widget stands where its characters are): the same
    const text = await ui.text();
    const bullet = text.indexOf("* A compost");
    await ui.caretTo(text.length);
    const onBullet = await pointAt(bullet);
    await drag("drop", onBullet, "second.png");
    await attachedFrom("second.png");
    assertEqual((await ui.text()).slice(bullet, bullet + 18), "{{./second.png}}* ", "a drop on a bullet goes where the bullet is");

    // on the page beside the text (below the editor): at the end of the page
    const before = await ui.text();
    const below = await page.evaluate(() => {
      const rect = document.querySelector(".backlinks").getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 4) };
    });
    await drag("drop", below, "third.png");
    await attachedFrom("third.png");
    assertEqual(await ui.text(), `${before}{{./third.png}}\n`, "a drop on the page, away from the text, puts the reference at the end");

    // and a file dropped outside the page (on the tree) is not shown by the browser: the app stays
    const url = page.url();
    const onTree = await page.evaluate(() => {
      const rect = document.querySelector("#sidebar").getBoundingClientRect();
      return { x: Math.round(rect.left + 20), y: Math.round(rect.bottom - 20) };
    });
    const dropped = await drag("drop", onTree, "stray.png");
    assertEqual(dropped.prevented, true, "the browser is told not to open it");
    await ui.settle();
    assertEqual(page.url(), url, "the app is still where it was");
    assertEqual(await page.evaluate(() => window.__zim.app.session.fileCount), 3, "and nothing else was attached");
  });

  await app("the attachments panel inserts references, downloads files and deletes them", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Ideas");
    const pdf = Buffer.from("%PDF-1.4 " + "x".repeat(2000));
    await ui.attachInput().setInputFiles([{ name: "plan.pdf", mimeType: "application/pdf", buffer: pdf }, { name: "pic.png", mimeType: "image/png", buffer: png(30, 30, [0, 0, 0]) }]);
    await page.waitForFunction(() => document.querySelectorAll(".attachment-list li").length === 2);
    assertEqual(await page.locator(".attachment-list li").nth(1).locator(".meta").innerText(), "2.0 KB · application/pdf", "sizes are written for people");
    // Insert puts a reference at the caret
    const before = await ui.text();
    const at = before.indexOf("* A compost bin");
    await ui.caretTo(at);
    await page.locator(".attachment-list li", { hasText: "plan.pdf" }).getByRole("button", { name: "Insert" }).click();
    assertEqual(await ui.text(), before.slice(0, at) + "[[./plan.pdf|plan.pdf]]" + before.slice(at), "Insert puts a reference where the caret is");
    // the name opens it: a file is downloaded
    const opened = await ui.download(() => page.locator(".attachment-list li", { hasText: "plan.pdf" }).locator(".name").click());
    assertEqual(opened.name, "plan.pdf", "a click on a file's name downloads it, under its name");
    assert(opened.bytes.equals(pdf), "byte for byte");
    const downloaded = await ui.download(() => page.locator(".attachment-list li", { hasText: "plan.pdf" }).getByRole("button", { name: "Download" }).click());
    assert(downloaded.bytes.equals(pdf), "as does Download");
    // Ctrl-click on the link in the page does the same
    const viaLink = await ui.download(() => page.locator(".cm-zim-link", { hasText: "plan.pdf" }).first().click({ modifiers: ["Control"] }));
    assert(viaLink.bytes.equals(pdf), "and so does following the link");
    // Delete asks first
    await page.locator(".attachment-list li", { hasText: "plan.pdf" }).getByRole("button", { name: "Delete" }).click();
    const dialog = ui.dialog();
    await dialog.waitFor();
    assert((await dialog.innerText()).includes("Delete plan.pdf from this notebook?"), "the dialog says what goes");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assertEqual((await ui.attachmentNames()).length, 2, "cancelling deletes nothing");
    await page.locator(".attachment-list li", { hasText: "plan.pdf" }).getByRole("button", { name: "Delete" }).click();
    await ui.confirmDialog("Delete attachment");
    assertDeepEqual(await ui.attachmentNames(), ["pic.png"], "it is gone from the panel");
    assertEqual(await page.evaluate(() => window.__zim.app.session.fileCount), 1, "and from the notebook");
    assertEqual(await page.locator(".cm-zim-link-missing", { hasText: "plan.pdf" }).count(), 2, "the links to it (the one attached, the one inserted) now lead nowhere, and are drawn that way");
    assert((await ui.status()).includes("Deleted plan.pdf"), "the status says so");
  });

  await app("pictures are drawn at their own size or the one asked for, viewed large with Ctrl-click, and give their source on double-click", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Ideas");
    await ui.attachInput().setInputFiles([{ name: "pic.png", mimeType: "image/png", buffer: png(200, 100, [10, 120, 200]) }]);
    await page.waitForFunction(() => document.querySelectorAll(".attachment-list li").length === 1);
    await ui.setText("{{./pic.png}}\n\n{{./pic.png?width=50}}\n\n{{./pic.png?height=40}}\n\n{{./pic.png?width=60&height=30}}\n\n{{./pic.png|Alt text}}\n\n{{./pic.png?href=Help:Links|goes to the links page}}\n");
    await ui.caretTo(0);
    await ui.settle();
    const sizes = [];
    for (let i = 0; i < 6; i++) sizes.push((await ui.picture(i)).drawn.join("x"));
    assertDeepEqual(sizes, ["200x100", "50x25", "80x40", "60x30", "200x100", "200x100"], "its own size, or the width or height asked for (the other keeping the shape), or both");
    assertEqual((await ui.picture(4)).alt, "Alt text", "the alt text is the picture's");
    // Ctrl-click shows it large, in a dialog that holds a picture and nothing else
    await page.locator("img.cm-zim-image").first().click({ modifiers: ["Control"] });
    const viewer = ui.dialog();
    await viewer.waitFor();
    assertEqual(await viewer.locator("h2").innerText(), "pic.png", "the dialog is named for the file");
    await page.waitForFunction(() => document.querySelector(".viewer-image")?.naturalWidth === 200);
    assertEqual(await viewer.locator(".viewer-image").count(), 1, "it shows the picture");
    const saved = await ui.download(() => viewer.getByRole("button", { name: "Download" }).click());
    assertEqual(saved.name, "pic.png", "and offers it for download");
    await viewer.getByRole("button", { name: "Close", exact: true }).click();
    await viewer.waitFor({ state: "detached" });
    // a plain click only puts the caret beside it
    await page.locator("img.cm-zim-image").nth(1).click();
    assertEqual(await page.locator(".viewer-image").count(), 0, "a plain click does not open it");
    assertEqual(await page.locator("img.cm-zim-image").count(), 6, "and the pictures stay pictures while the caret is beside one");
    // double-click selects the source, which shows
    await page.locator("img.cm-zim-image").nth(1).dblclick();
    const selected = await page.evaluate(() => {
      const { state } = window.__zim.editor.view;
      const range = state.selection.main;
      return state.sliceDoc(range.from, range.to);
    });
    assertEqual(selected, "{{./pic.png?width=50}}", "double-click selects a picture's source");
    assertEqual(await page.locator("img.cm-zim-image").count(), 5, "which is shown instead of the picture");
    assertEqual(await page.locator(".cm-zim-image-source").innerText(), "{{./pic.png?width=50}}");
    await ui.caretTo(0);
    assertEqual(await page.locator("img.cm-zim-image").count(), 6, "and it is a picture again when the caret goes elsewhere");
    // a picture with an href goes there
    await page.locator("img.cm-zim-image").nth(5).click({ modifiers: ["Control"] });
    await ui.waitCurrent("Help:Links");
  });

  await app("a picture that can't be shown says why, and nothing outside the notebook is fetched", {}, async (ui) => {
    const { page } = ui;
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await ui.goto("Ideas");
    await ui.attachInput().setInputFiles([{ name: "doc.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") }]);
    await page.waitForFunction(() => document.querySelectorAll(".attachment-list li").length === 1);
    await ui.setText("{{./nope.png|gone}}\n\n{{https://example.org/x.png|from the web}}\n\n{{./doc.pdf|not a picture}}\n\n{{/etc/hosts}}\n");
    await ui.caretTo(0);
    await ui.settle();
    const chips = await page.locator(".cm-zim-chip-image").evaluateAll((els) => els.map((e) => [e.textContent, [...e.classList].find((c) => /^cm-zim-chip-(missing|outside|unsupported|loading|failed)$/.test(c)), e.title]));
    assertDeepEqual(chips.map(([text, state]) => [text, state]), [["gone", "cm-zim-chip-missing"], ["from the web", "cm-zim-chip-outside"], ["not a picture", "cm-zim-chip-unsupported"], ["hosts", "cm-zim-chip-outside"]], "each says what it is");
    assert(chips[0][2].includes("no such file") && chips[1][2].includes("not loaded") && chips[2][2].includes("not a picture"), "and why, on hover");
    assertEqual(await page.locator("img.cm-zim-image").count(), 0, "none is drawn as a picture");
    assert(!requests.some((url) => url.includes("example.org")), "an address outside the notebook is never fetched");
  });

  await app("files stay with their page when it is renamed, and go when it is deleted", {}, async (ui) => {
    const { page } = ui;
    await ui.goto("Projects:Garden");
    await ui.attachInput().setInputFiles([{ name: "Bed 1.png", mimeType: "image/png", buffer: green }, { name: "notes.txt", mimeType: "text/plain", buffer: utf8("remember the beans") }]);
    await page.waitForFunction(() => document.querySelectorAll(".attachment-list li").length === 2);
    await ui.flush();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const dialog = ui.dialog();
    await dialog.waitFor();
    assert((await dialog.innerText()).includes("The 1 page below it and its 2 attachments move with it."), `the dialog says what moves (${await dialog.innerText()})`);
    await page.keyboard.type("Allotment");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await ui.waitCurrent("Projects:Allotment");
    assertDeepEqual(await ui.attachmentNames(), ["Bed 1.png", "notes.txt"], "the page still has its attachments");
    assertDeepEqual((await ui.picture()).natural, [320, 180], "and still shows the picture");
    assertDeepEqual(await page.evaluate(() => window.__zim.app.session.attachments("Projects:Allotment").map((f) => f.path)), ["Projects/Allotment/Bed 1.png", "Projects/Allotment/notes.txt"], "they are in the folder of the new name");
    assertEqual(await page.evaluate(() => window.__zim.app.session.attachments("Projects:Garden").length), 0, "and not in the old one");
    // after a reload, still
    await ui.reload();
    assertDeepEqual((await ui.picture()).natural, [320, 180], "after a reload too");
    // in the zip, at the new paths
    const zip = await ui.download(async () => {
      await ui.openMenu();
      await ui.menu().getByRole("menuitem", { name: "Export notebook (zip)" }).click();
    });
    const dir = join(work, "export-attached");
    const names = unzip(zip.bytes, dir);
    assert(names.includes("Projects/Allotment/Bed 1.png") && names.includes("Projects/Allotment/notes.txt"), `the export has them at those paths (${names.filter((n) => !n.endsWith(".txt") || n.includes("notes")).join(", ")})`);
    assert(readFileSync(join(dir, "Projects/Allotment/Bed 1.png")).equals(green), "byte for byte");
    // deleting the page deletes them, and the dialog says so
    await page.locator(".page-actions").getByRole("button", { name: "Delete", exact: true }).click();
    await dialog.waitFor();
    assert((await dialog.innerText()).includes("Delete Projects:Allotment and the 1 page below it, and their 2 attachments?"), `the dialog says what goes (${await dialog.innerText()})`);
    await dialog.getByRole("button", { name: "Delete 2 pages", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assertEqual(await page.evaluate(() => window.__zim.app.session.fileCount), 0, "no attachment is left");
    assertDeepEqual(await page.evaluate(async () => (await window.__zim.app.session.store.listFiles(window.__zim.app.session.info.id)).map((f) => f.path)), [], "in the store either");
  });

  await app("an attached picture or file cannot run anything: it is drawn as an image, or downloaded, never opened as a page", {}, async (ui) => {
    const { page, context } = ui;
    await page.evaluate(() => {
      window.__pwned = 0;
    });
    await ui.goto("Ideas");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="window.__pwned=1"><script>window.__pwned=2</script><rect width="40" height="20" fill="red"/></svg>';
    const html = "<!doctype html><script>window.__pwned = 3</script><h1>hello</h1>";
    await ui.attachInput().setInputFiles([
      { name: "evil.svg", mimeType: "image/svg+xml", buffer: utf8(svg) },
      { name: "evil.html", mimeType: "text/html", buffer: utf8(html) },
    ]);
    await page.waitForFunction(() => document.querySelectorAll(".attachment-list li").length === 2);
    const pagesBefore = context.pages().length;
    const shown = await ui.picture();
    assertDeepEqual(shown.natural, [40, 20], "the SVG is drawn, as a picture");
    await page.locator("img.cm-zim-image").first().click({ modifiers: ["Control"] });
    const viewer = ui.dialog();
    await viewer.waitFor();
    await page.waitForFunction(() => document.querySelector(".viewer-image")?.naturalWidth === 40);
    await viewer.getByRole("button", { name: "Close", exact: true }).click();
    await viewer.waitFor({ state: "detached" });
    const downloaded = await ui.download(() => page.locator(".cm-zim-link", { hasText: "evil.html" }).click({ modifiers: ["Control"] }));
    assertEqual(downloaded.name, "evil.html", "an HTML file is downloaded");
    assert(downloaded.bytes.equals(utf8(html)), "as it is");
    await ui.settle();
    assertEqual(await page.evaluate(() => window.__pwned), 0, "nothing in either of them ran");
    assertEqual(context.pages().length, pagesBefore, "and no window was opened for them");
  });

  await app("a link that could run code is not followed; a web address opens in a window that can't reach this one", {}, async (ui) => {
    const { page, context } = ui;
    await ui.goto("Links test");
    await ui.setText(`[[javascript://alert(1)]]\n\n[[${origin}/?opened-from-a-link]]\n\n[[file:///etc/passwd]]\n`);
    await ui.settle();
    const pagesBefore = context.pages().length;
    await page.locator(".cm-zim-link", { hasText: "javascript:" }).click({ modifiers: ["Control"] });
    assert((await ui.status()).startsWith("Not opening javascript://alert(1)"), `the status says it was not opened (${await ui.status()})`);
    await page.locator(".cm-zim-link", { hasText: "file:" }).click({ modifiers: ["Control"] });
    assert((await ui.status()).includes("outside this notebook"), `a path outside the notebook isn't opened either (${await ui.status()})`);
    assertEqual(context.pages().length, pagesBefore, "no window was opened");
    const [popup] = await Promise.all([context.waitForEvent("page"), page.locator(".cm-zim-link", { hasText: "opened-from-a-link" }).click({ modifiers: ["Control"] })]);
    await popup.waitForLoadState();
    assert(popup.url().startsWith(`${origin}/?opened-from-a-link`), `a web address opens (${popup.url()})`);
    assertEqual(await popup.evaluate(() => window.opener), null, "in a window with no way back to this one");
    await popup.close();
    assertEqual(await ui.current(), "Links test", "and the page stays where it was");
  });

  await app("a link to an address opens straight to its page, and a wrong address falls back to the home page", {}, async (ui) => {
    const { page } = ui;
    await page.goto(`${origin}/#/Help%3ALinks`);
    await ui.reload();
    assertEqual(await ui.current(), "Help:Links", "an address with a page opens that page");
    assert((await ui.rows()).includes("Help:Links"), "with the tree unfolded down to it");
    await page.goto(`${origin}/#/No%3Asuch%20page`);
    await ui.reload();
    assertEqual(await ui.current(), "Home", "a page that is not in the notebook opens the home page");
  });

  await app("on a phone-sized screen the tree is a drawer, and the page fits", { viewport: { width: 390, height: 800 } }, async (ui) => {
    const { page } = ui;
    assertEqual(await page.locator(".app").getAttribute("data-sidebar"), "closed", "the tree starts closed");
    assert(await page.locator("#sidebar").isHidden(), "and is out of the way");
    assertEqual(await page.locator(".icon-button").getAttribute("aria-expanded"), "false", "the button says so");
    await page.locator(".icon-button").click();
    assert(await page.locator("#sidebar").isVisible(), "the button opens it");
    assertEqual(await page.locator(".icon-button").getAttribute("aria-expanded"), "true", "and says so");
    await page.locator('.row[data-name="Help"] .chevron').click();
    await page.locator('.row[data-name="Help:Links"] .label').click();
    await ui.waitCurrent("Help:Links");
    assert(await page.locator("#sidebar").isHidden(), "choosing a page closes the drawer");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `the page does not scroll sideways (${overflow}px too wide)`);
    for (const name of ["New page", "Rename", "Attach…", "Delete"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 390, `the ${name} button is on the screen`);
    }
  });

  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? ` (${r.ms} ms)` : `\n    ${r.error}`}`);
  const failed = results.length === 0 || results.some((r) => !r.ok);
  console.log(`\n${results.filter((r) => r.ok).length} of ${results.length} scenarios passed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  if (browser) await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
