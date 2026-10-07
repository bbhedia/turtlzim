// Takes screenshots of the built app in its main states, so that how it looks can be seen (and
// compared from one change to the next), not just asserted on: light and dark, wide and phone-sized.
//
//   npm run build && node test/screenshots.mjs <directory>
//
// Needs the browser that scripts/setup-browser.sh installs.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";
import { launchBrowser } from "./browser-launch.mjs";
import { png } from "./pictures.mjs";

const out = process.argv[2] ?? process.env.SCREENSHOTS;
if (!out) {
  console.error("usage: node test/screenshots.mjs <directory to put the screenshots in>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const server = createStaticServer({ dir: fileURLToPath(new URL("../dist/", import.meta.url)) });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();

async function open(viewport, colorScheme = "light") {
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true });
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
await page.keyboard.press("Escape");
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

await browser.close();
server.close();
