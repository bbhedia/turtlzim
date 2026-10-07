#!/usr/bin/env node
// Draws the app's icons (public/icons/) from one picture, with the browser the tests use: a page with
// two lines of text and a Z on it, on the app's blue. Run it when the picture below changes:
//
//   node scripts/make-icons.mjs
//
// The pictures are committed; nothing in the build needs this script or a browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../test/browser-launch.mjs";

const out = fileURLToPath(new URL("../public/icons/", import.meta.url));
mkdirSync(out, { recursive: true });

const BLUE = "#0b57d0";

/**
 * The picture, 512 x 512. `rounded`: the corners are drawn (an icon that shows as it is); otherwise the
 * blue goes to the edge, for a place that cuts its own shape (a phone's launcher, `maskable`). `scale`
 * shrinks the page toward the middle, for a shape that cuts into the picture.
 */
function picture({ rounded, scale = 1 }) {
  const t = (1 - scale) * 256;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ""} fill="${BLUE}"/>
  <g transform="translate(${t} ${t}) scale(${scale})">
    <path d="M136 104h168l72 72v216a24 24 0 0 1-24 24H160a24 24 0 0 1-24-24V128a24 24 0 0 1 24-24z" fill="#ffffff"/>
    <path d="M304 104v48a24 24 0 0 0 24 24h48z" fill="#b4d5ff"/>
    <path d="M176 224h72l-72 72h72" fill="none" stroke="${BLUE}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="288" y="262" width="52" height="18" rx="9" fill="${BLUE}" opacity="0.4"/>
    <rect x="176" y="326" width="164" height="18" rx="9" fill="${BLUE}" opacity="0.4"/>
    <rect x="176" y="362" width="108" height="18" rx="9" fill="${BLUE}" opacity="0.4"/>
  </g>
</svg>`;
}

const files = [
  // the one that is drawn at any size (and the tab's icon)
  { name: "icon.svg", svg: picture({ rounded: true }) },
  { name: "icon-192.png", svg: picture({ rounded: true }), size: 192 },
  { name: "icon-512.png", svg: picture({ rounded: true }), size: 512 },
  // cut to a shape by the phone: the page stays inside the middle 80%, where nothing is cut away
  { name: "icon-maskable-512.png", svg: picture({ rounded: false, scale: 0.78 }), size: 512 },
  // iOS rounds it itself and wants no transparency
  { name: "apple-touch-icon.png", svg: picture({ rounded: false, scale: 0.9 }), size: 180 },
];

const browser = await launchBrowser();
try {
  for (const file of files) {
    if (!file.size) {
      writeFileSync(out + file.name, file.svg + "\n");
      console.log(file.name);
      continue;
    }
    const page = await browser.newPage({ viewport: { width: file.size, height: file.size }, deviceScaleFactor: 1 });
    await page.setContent(`<body style="margin:0;background:transparent"><img width="${file.size}" height="${file.size}" src="data:image/svg+xml;base64,${Buffer.from(file.svg).toString("base64")}"></body>`);
    await page.locator("img").evaluate((img) => img.decode());
    writeFileSync(out + file.name, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: file.size, height: file.size } }));
    await page.close();
    console.log(file.name);
  }
} finally {
  await browser.close();
}
