// Draws the Home Screen and tab icons into web/public/icons/: the version
// number's "v" in Martian Mono, blue, with its tangerine dot, on paper.
// Rerun after changing the look: node scripts/make_icons.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const font = readFileSync('web/src/fonts/martian-mono-latin.woff2').toString('base64');
// size: the square drawn; pad: the share of it kept clear (a maskable icon
// may be cut to a circle, so its mark stays inside the middle 80%).
const ICONS = [
  ['icon-32.png', 32, 0.06],
  ['apple-touch-icon.png', 180, 0.14],
  ['icon-192.png', 192, 0.14],
  ['icon-512.png', 512, 0.14],
  ['icon-maskable-512.png', 512, 0.24]
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, pad] of ICONS) {
  const glyph = Math.round(size * (1 - 2 * pad) * 1.05);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><style>
    @font-face { font-family: M; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 100 800; }
    html, body { margin: 0; width: ${size}px; height: ${size}px; background: #fffbf2; }
    body { display: grid; place-items: center; }
    b { font: 800 ${glyph}px/1 M; color: #1a4fe0; letter-spacing: -0.22em; transform: translate(-0.11em, -4%); }
    i { font-style: normal; color: #ff5a1f; }
  </style><b>v<i>.</i></b>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `web/public/icons/${file}` });
}
await browser.close();
