// Draws the logo files from the header's shared vector mark: a blue version,
// its tangerine dot and two note lines. Rerun with Node 24 after changing the
// shapes: node scripts/make_icons.mjs
// The tab and Home Screen icons are the 2026-11-01 icon study's artwork, not
// this mark: scripts/make_app_icons.mjs makes them.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BRAND_MARK } from '../web/src/lib/brand-mark.ts';

const shapes = `<path fill="#1a4fe0" d="${BRAND_MARK.version}"/><path fill="#ff5a1f" d="${BRAND_MARK.dot}"/><path fill="#1a4fe0" d="${BRAND_MARK.notes}"/>`;
const vector = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_MARK.viewBox}"><title>Release Notes</title>${shapes}</svg>\n`;
writeFileSync('web/public/icons/release-notes.svg', vector);
mkdirSync('web/public/brand', { recursive: true });
writeFileSync('web/public/brand/release-notes.svg', vector);
writeFileSync('web/public/brand/release-notes-dark.svg', vector.replaceAll('#1a4fe0', '#8fb0ff'));

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  // Reusable logo exports keep the same geometry, without a device mask.
  // Transparent PNGs can sit on other materials; paper versions stand alone.
  for (const size of [48, 64, 96, 128, 256, 512, 1024, 2048, 4096]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block}</style><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${BRAND_MARK.viewBox}">${shapes}</svg>`);
    await page.screenshot({ path: `web/public/brand/release-notes-${size}.png`, omitBackground: true });
    if (size >= 512) {
      await page.setContent(`<!doctype html><style>html,body{margin:0;background:#fffbf2}svg{display:block}</style><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${BRAND_MARK.viewBox}"><rect width="100" height="100" fill="#fffbf2"/>${shapes}</svg>`);
      await page.screenshot({ path: `web/public/brand/release-notes-paper-${size}.png` });
    }
  }
} finally {
  await browser.close();
}
