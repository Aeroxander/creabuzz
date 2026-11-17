#!/usr/bin/env node
/**
 * Draws the install icons from the Creaton mark (public/assets/icons/mark.svg) on the app's gradient, with Chromium
 * from Playwright so the SVG gradients render exactly. Run once when the mark changes: `node scripts/make-icons.mjs`.
 * The PNGs are committed; nothing runs this at build time.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(here, "../public/assets/icons");
const mark = readFileSync(path.join(iconsDir, "mark.svg"), "utf8");
const markUrl = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

/** name, edge in px, share of the edge the mark takes (maskable icons keep it inside the 80% safe circle). */
const ICONS = [
  ["icon-192.png", 192, 0.62],
  ["icon-512.png", 512, 0.62],
  ["icon-maskable-512.png", 512, 0.5],
  ["apple-touch-icon.png", 180, 0.6],
];

const browser = await chromium.launch();
try {
  for (const [name, size, share] of ICONS) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(`<!doctype html><html><body style="margin:0">
      <div style="width:${size}px;height:${size}px;display:grid;place-items:center;
        background:
          radial-gradient(70% 55% at 100% 100%, rgb(99 200 142 / .62), transparent 70%),
          radial-gradient(60% 45% at 0% 0%, hsl(280 75% 55% / .55), transparent 70%),
          linear-gradient(155deg, hsl(266 66% 13%) 0%, hsl(266 62% 24%) 38%, hsl(262 60% 40%) 72%, hsl(210 55% 42%) 100%);">
        <img src="${markUrl}" style="height:${Math.round(size * share)}px;width:auto" alt="">
      </div></body></html>`);
    await page.screenshot({
      path: path.join(iconsDir, name),
      omitBackground: false,
    });
    await page.close();
    console.log(`${name} ${size}x${size}`);
  }
} finally {
  await browser.close();
}
