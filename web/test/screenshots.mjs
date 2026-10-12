// Takes screenshots of the built app in its main states, so that how it looks can be seen (and
// compared from one change to the next), not just asserted on: light and dark, wide and phone-sized.
//
//   npm run build && node test/screenshots.mjs <directory>
//
// Needs the browser that scripts/setup-browser.sh installs.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeServiceWorker } from "../scripts/pwa.mjs";
import { createStaticServer } from "../scripts/serve.mjs";
import { launchBrowser } from "./browser-launch.mjs";
import { png } from "./pictures.mjs";

const out = process.argv[2] ?? process.env.SCREENSHOTS;
if (!out) {
  console.error("usage: node test/screenshots.mjs <directory to put the screenshots in>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

// (ZIM_DIST: another build of the app to take the pictures of, as in browser.mjs)
const dist = process.env.ZIM_DIST ?? fileURLToPath(new URL("../dist/", import.meta.url));
const server = createStaticServer({ dir: dist });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();

async function open(viewport, colorScheme = "light") {
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true, serviceWorkers: "block" });
  await context.addInitScript(() => { window.__ZIM_TEST__ = true; });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("[console error]", m.text()));
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => window.__zim !== undefined, null, { timeout: 30000 });
  await settle(page);
  return page;
}
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)))));
/** A touch screen like a phone's. Its on-screen keyboard is made up: `window.__keyboard(height)` shrinks the visible area (what the real one does), and 0 takes it away. */
async function openPhone(colorScheme = "light") {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme, serviceWorkers: "block" });
  await context.addInitScript(() => {
    window.__ZIM_TEST__ = true;
    const listeners = { resize: [], scroll: [] };
    let covered = 0;
    const area = { get height() { return window.innerHeight - covered; }, get width() { return window.innerWidth; }, scale: 1, offsetTop: 0, addEventListener: (type, fn) => listeners[type]?.push(fn), removeEventListener: (type, fn) => { const at = listeners[type]?.indexOf(fn) ?? -1; if (at >= 0) listeners[type].splice(at, 1); } };
    Object.defineProperty(window, "visualViewport", { value: area, configurable: true });
    window.__keyboard = (height) => { covered = height; for (const fn of listeners.resize) fn(); };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("[console error]", m.text()));
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => window.__zim !== undefined, null, { timeout: 30000 });
  await settle(page);
  return page;
}
const tap = async (page, locator) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
};

const shot = async (page, name) => {
  await settle(page);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  ${name}.png`);
};
const goTo = async (page, name) => {
  await page.evaluate((n) => window.__zim.app.openPage(n, { push: true }), name);
  await settle(page);
};

console.log("desktop, light");
let page = await open({ width: 1280, height: 820 });
await shot(page, "1-home");
await page.locator('.row[data-name="Projects"] .chevron').click();
await goTo(page, "Projects:Garden");
await shot(page, "2-garden-with-tree-and-backlinks");
await goTo(page, "Ideas");
await shot(page, "3-ideas-missing-link");
await page.locator("#search").fill("garden");
await settle(page);
await shot(page, "4-search");
await page.keyboard.press("Escape");
await goTo(page, "Projects:Garden");
await page.getByRole("button", { name: "Rename" }).click();
await shot(page, "5-rename-dialog");
await page.getByRole("button", { name: "Cancel" }).click();
await page.locator(".notebook-button").click();
await shot(page, "6-notebook-menu");
await page.keyboard.press("Escape");
await page.close();

console.log("phone");
page = await open({ width: 390, height: 800 });
await shot(page, "7-phone-home");
await page.locator(".icon-button").click();
await shot(page, "8-phone-tree");
await page.locator("details.tags summary").click();
await shot(page, "8a-phone-tree-with-the-lists");
await page.close();

console.log("phone, editing");
page = await openPhone();
await goTo(page, "Projects:Garden");
await shot(page, "31a-phone-reading");
await tap(page, page.locator(".cm-line", { hasText: "beans" }).first());
await page.evaluate(() => window.__keyboard(330));
await shot(page, "31-phone-editing-with-the-bar");
await tap(page, page.getByRole("button", { name: "Make the line a heading, or plain text again" }));
await shot(page, "32-phone-headings-row");
await tap(page, page.getByRole("button", { name: "Heading 2", exact: true }));
await page.evaluate(() => window.__keyboard(0));
await goTo(page, "Help:Tables");
await tap(page, page.locator(".cm-zim-grid td", { hasText: "pears" }));
await page.evaluate(() => window.__keyboard(330));
await shot(page, "33-phone-table-being-edited");
await page.close();
page = await openPhone("dark");
await goTo(page, "Projects:Garden");
await tap(page, page.locator(".cm-line", { hasText: "beans" }).first());
await page.evaluate(() => window.__keyboard(330));
await shot(page, "34-phone-dark-editing");
await page.close();

console.log("desktop, the formatting bar asked for");
page = await open({ width: 1280, height: 820 });
await goTo(page, "Projects:Garden");
await page.locator(".notebook-button").click();
await page.getByRole("menuitem", { name: "Show the formatting bar" }).click();
await page.locator(".cm-line", { hasText: "beans" }).first().click();
await shot(page, "35-desktop-with-the-formatting-bar");
await page.close();

console.log("tables, the journal, tags, completing a link");
page = await open({ width: 1280, height: 820 });
await goTo(page, "Help:Tables");
await shot(page, "23-table-as-a-grid");
await page.locator(".cm-zim-grid td", { hasText: "pears" }).click();
await shot(page, "24-table-being-edited");
await goTo(page, "Journal:2026:10:06");
await page.locator("details.tags summary").click();
await shot(page, "25-journal-calendar-and-tags");
await page.locator(".tags-list .link-button", { hasText: "@garden" }).click();
await shot(page, "26-pages-of-a-tag");
await page.keyboard.press("Escape");
await page.evaluate(() => document.activeElement?.blur());
await goTo(page, "Projects");
await page.locator(".cm-content").click();
await page.keyboard.press("Control+End");
await page.keyboard.type("see [[gard");
await page.locator(".cm-tooltip-autocomplete").waitFor();
await shot(page, "27-completing-a-link");
await page.close();

console.log("tables, dark");
page = await open({ width: 1280, height: 820 }, "dark");
await goTo(page, "Help:Tables");
await shot(page, "28-dark-table-as-a-grid");
await page.locator(".cm-zim-grid td", { hasText: "pears" }).click();
await shot(page, "29-dark-table-being-edited");
await page.keyboard.press("Control+End");
await page.keyboard.type("\nsee [[tag");
await page.locator(".cm-tooltip-autocomplete").waitFor();
await shot(page, "30-dark-completing-a-link");
await page.close();

console.log("pictures and attachments");
page = await open({ width: 1280, height: 820 });
await goTo(page, "Projects:Garden");
await page.locator('input[aria-label^="Choose files to attach"]').setInputFiles([
  { name: "Bed 1.png", mimeType: "image/png", buffer: png(360, 160, [90, 160, 100]) },
  { name: "Seed list.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 a list of seeds") },
]);
await page.waitForFunction(() => document.querySelectorAll(".attachment-list li").length === 2);
await page.evaluate(() => { const scroller = document.querySelector(".page"); scroller.scrollTop = scroller.scrollHeight; });
await shot(page, "10-pictures-and-attachments");
await page.locator("img.cm-zim-image").first().click({ modifiers: ["Control"] });
await page.locator(".viewer-image").waitFor();
await shot(page, "11-picture-viewer");
await page.getByRole("button", { name: "Close", exact: true }).click();
await goTo(page, "Ideas");
await page.evaluate(() => window.__zim.editor.setText("====== Pictures that can't be shown ======\n\nNot in the notebook: {{./nothing-here.png}}\n\nOutside it: {{https://example.org/x.png|a picture from the web}}\n\nA file that isn't there: [[./gone.pdf]]\n"));
await shot(page, "12-picture-states");
await page.close();

console.log("encrypted notebooks");
page = await open({ width: 1280, height: 820 });
const topDialog = () => page.locator("dialog.dialog").last();
// (a browser with no encrypted notebooks can restore some from a backup)
await page.locator(".notebook-button").click();
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("menuitem", { name: "Restore encrypted notebooks from a backup…" }).click()]);
await chooser.setFiles({ name: "encrypted-notebooks-2026-10-09.zimvault", mimeType: "application/octet-stream", buffer: Buffer.alloc(3_400_000, 1) });
const restoring = page.locator("dialog.dialog", { has: page.getByRole("heading", { name: "Restore encrypted notebooks", exact: true }) });
await restoring.waitFor();
await shot(page, "13a-restore-dialog");
await restoring.getByRole("button", { name: "Cancel" }).click();
await page.locator(".notebook-button").click();
await page.getByRole("menuitem", { name: "New notebook…" }).click();
await topDialog().getByLabel("Name").fill("Diary");
await topDialog().getByLabel("Kind").selectOption("encrypted");
await shot(page, "13-new-encrypted-notebook");
await topDialog().getByRole("button", { name: "Create", exact: true }).click();
const making = page.locator("dialog.dialog", { has: page.getByRole("heading", { name: "Encrypted notebooks", exact: true }) });
await making.waitFor();
await making.getByLabel("Passphrase", { exact: true }).fill("short");
await shot(page, "14-passphrase-dialog");
const passphrase = "pale river stone lantern";
await making.getByLabel("Passphrase", { exact: true }).fill(passphrase);
await making.getByLabel("Passphrase again").fill(passphrase);
await making.getByLabel("I understand").check();
await making.getByRole("button", { name: "Create encrypted notebooks" }).click();
await page.waitForFunction(() => window.__zim.app.session?.info.kind === "encrypted");
const told = page.locator("dialog.dialog", { hasText: "Keep a copy of encrypted notebooks" });
await told.waitFor({ timeout: 3000 }).then(async () => {
  await shot(page, "15-keep-a-copy-notice");
  await told.getByRole("button", { name: "OK" }).click();
}, () => undefined);
await page.waitForFunction(() => document.querySelectorAll("dialog.dialog").length === 0);
await goTo(page, "Secrets:Plans");
await page.evaluate(() => window.__zim.editor.setText("====== Plans ======\n\nMeet at the old mill.\n"));
await shot(page, "16-encrypted-notebook-open");
await page.locator(".notebook-button").click();
await shot(page, "17-menu-with-encrypted-notebook");
await page.getByRole("menuitem", { name: "Change the passphrase…" }).click();
const changing = page.locator("dialog.dialog", { has: page.getByRole("heading", { name: "Change the passphrase", exact: true }) });
await changing.getByLabel("Current passphrase").fill(passphrase);
await changing.getByLabel("New passphrase", { exact: true }).fill("short");
await shot(page, "17a-change-passphrase-dialog");
await changing.getByRole("button", { name: "Cancel" }).click();
await page.locator(".notebook-button").click();
await page.getByRole("menuitem", { name: "Back up the encrypted notebooks…" }).click();
await page.locator("dialog.dialog", { has: page.getByRole("heading", { name: "Back up the encrypted notebooks", exact: true }) }).waitFor();
await shot(page, "17a2-backup-dialog");
await page.getByRole("button", { name: "Cancel" }).click();
// typing that can't be saved (the disk is full, say), and Lock pressed: the person is asked before it is lost
await page.evaluate(() => { window.__zim.app.session.save = async () => { throw new Error("the disk is full"); }; });
await page.locator(".cm-content").click();
await page.keyboard.press("Control+End");
await page.keyboard.type("A line the vault could not take.");
await page.locator(".lock-button").click();
await topDialog().waitFor();
await shot(page, "17b-lock-without-saving");
await topDialog().getByRole("button", { name: "Cancel" }).click();
await page.evaluate(() => { delete window.__zim.app.session.save; });
await page.locator(".lock-button").click();
await page.waitForFunction(() => window.__zim.app.session?.info.kind === "open" && document.querySelector(".lock-button").hidden);
await shot(page, "17c-locked-and-back-in-an-open-notebook");
await page.reload();
await page.waitForFunction(() => window.__zim !== undefined);
await page.locator(".notebook-button").click();
await page.getByRole("menuitem", { name: "Unlock encrypted notebooks…" }).click();
await settle(page);
await shot(page, "18-unlock-dialog");
await page.close();

console.log("desktop, dark");
page = await open({ width: 1280, height: 820 }, "dark");
await goTo(page, "Help:Links");
await shot(page, "9-dark-links");
await page.close();

console.log("the app on the device (a copy of the app, so that a second version can be put on its server)");
const copy = mkdtempSync(join(tmpdir(), "zim-shots-"));
cpSync(dist, copy, { recursive: true });
writeServiceWorker(copy);
const site = createStaticServer({ dir: copy });
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const saved = await browser.newContext({ viewport: { width: 1280, height: 820 }, serviceWorkers: "allow" });
await saved.addInitScript(() => { window.__ZIM_TEST__ = true; });
page = await saved.newPage();
page.on("pageerror", (e) => console.log("[page error]", e.message));
await page.goto(`http://127.0.0.1:${site.address().port}/`);
await page.waitForFunction(() => window.__zim?.app?.pwa?.state.phase === "ready", null, { timeout: 30000 });
await page.locator(".notebook-button").click();
await shot(page, "19-menu-with-about");
await page.getByRole("menuitem", { name: "About this version…" }).click();
await shot(page, "20-about-this-version");
await page.getByRole("button", { name: "Close" }).click();
// a second version arrives on the server
const main = `assets/${readdirSync(join(copy, "assets")).find((f) => /^index-.*\.js$/.test(f))}`;
writeFileSync(join(copy, main), `${readFileSync(join(copy, main), "utf8")}\n/* the next version */\n`);
writeFileSync(join(copy, "icons/new-icon-note.txt"), "a file that the next version has and this one does not");
writeServiceWorker(copy);
await page.evaluate(() => window.__zim.app.pwa.update());
await page.waitForFunction(() => !!window.__zim.app.pwa.state.offer);
await shot(page, "21-new-version-banner");
await page.getByRole("button", { name: "Update…" }).click();
await shot(page, "22-update-the-app");
await page.getByRole("button", { name: "Cancel" }).click();
await saved.close();
site.close();
rmSync(copy, { recursive: true, force: true });

await browser.close();
server.close();
