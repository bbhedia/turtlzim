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

console.log("desktop, dark");
page = await open({ width: 1280, height: 820 }, "dark");
await goTo(page, "Help:Links");
await shot(page, "9-dark-links");
await page.close();

await browser.close();
server.close();
