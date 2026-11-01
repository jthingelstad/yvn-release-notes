// Draws the logo files from the header's shared mark: the Flat icon's ivory
// v and tangerine period on a cobalt tile. Rerun with Node 24 after changing
// the shapes: node scripts/make_icons.mjs
// The tab and Home Screen icons are the 2026-11-01 icon study's own files:
// scripts/make_app_icons.mjs makes them.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BRAND_MARK, brandMarkShapes } from '../web/src/lib/brand-mark.ts';

const shapes = brandMarkShapes();
const vector = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_MARK.viewBox}"><title>Release Notes</title>${shapes}</svg>\n`;
writeFileSync('web/public/icons/release-notes.svg', vector);
mkdirSync('web/public/brand', { recursive: true });
writeFileSync('web/public/brand/release-notes.svg', vector);
// The tile reads on light and dark grounds alike, so the dark master is the
// same mark; the file stays so links to it keep working.
writeFileSync('web/public/brand/release-notes-dark.svg', vector);

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  // Transparent PNGs are the tile alone, its rounded corners see-through.
  // Paper versions stand alone: the tile at 80% on warm paper.
  for (const size of [48, 64, 96, 128, 256, 512, 1024, 2048, 4096]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block}</style><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${BRAND_MARK.viewBox}">${shapes}</svg>`);
    await page.screenshot({ path: `web/public/brand/release-notes-${size}.png`, omitBackground: true });
    if (size >= 512) {
      await page.setContent(`<!doctype html><style>html,body{margin:0;background:#fffbf2}svg{display:block}</style><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-12.5 -12.5 125 125"><rect x="-12.5" y="-12.5" width="125" height="125" fill="#fffbf2"/>${shapes}</svg>`);
      await page.screenshot({ path: `web/public/brand/release-notes-paper-${size}.png` });
    }
  }
} finally {
  await browser.close();
}
