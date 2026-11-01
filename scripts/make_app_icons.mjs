// Makes the browser-tab and Home Screen icons from the 2026-11-01 icon study
// (docs/design/icon-study-2026-11-01): Flat for tabs, the full paper fold for
// the Home Screen and installed app. Rerun with Node 24 after the study's
// artwork changes: node scripts/make_app_icons.mjs
//
// The study's 16 and 32 pixel Flat files are the reviewed tab icons, so they
// are copied as they are. Everything else is resized from the 1254 pixel
// master. Output is opaque sRGB with no metadata (the masters carry a content
// credentials chunk that the icons do not need).
import sharp from 'sharp';

const STUDY = 'docs/design/icon-study-2026-11-01';
const FLAT = `${STUDY}/favicons/flat`;
const FOLD = `${STUDY}/app-icons/release-notes-primary.png`;
const OUT = 'web/public/icons';

const png = (image) => image.removeAlpha().toColourspace('srgb').png({ compressionLevel: 9 });

await png(sharp(`${FLAT}-16px.png`)).toFile(`${OUT}/icon-16.png`);
await png(sharp(`${FLAT}-32px.png`)).toFile(`${OUT}/icon-32.png`);
for (const [file, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512]
]) {
  await png(sharp(FOLD).resize(size, size, { kernel: 'lanczos3' })).toFile(`${OUT}/${file}`);
}

// Maskable: launchers may crop to any shape that holds the central circle of
// radius 40%. The fold reaches 47% from the centre, so the whole picture is
// shrunk to 84% (the fold then reaches 39.5%) and laid on a cobalt field
// blended from the master's own corners. The shrunk picture's outer edge fades
// into that field, so no seam shows where the two meet.
const SIZE = 512;
const SCALE = 0.84;
const inner = Math.round(SIZE * SCALE);
const offset = Math.round((SIZE - inner) / 2);

const master = sharp(FOLD).removeAlpha();
const { width: mw, height: mh } = await master.metadata();
const corner = async (left, top) => {
  const { data } = await sharp(FOLD).removeAlpha().extract({ left, top, width: 40, height: 40 }).resize(1, 1, { kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
};
const [tl, tr, bl, br] = await Promise.all([corner(0, 0), corner(mw - 40, 0), corner(0, mh - 40), corner(mw - 40, mh - 40)]);
const shrunk = await sharp(FOLD).removeAlpha().resize(inner, inner, { kernel: 'lanczos3' }).raw().toBuffer();

const field = Buffer.alloc(SIZE * SIZE * 3);
const feather = Math.round(inner * 0.06);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const u = x / (SIZE - 1);
    const v = y / (SIZE - 1);
    const i = (y * SIZE + x) * 3;
    for (let c = 0; c < 3; c++) {
      field[i + c] = Math.round((1 - u) * (1 - v) * tl[c] + u * (1 - v) * tr[c] + (1 - u) * v * bl[c] + u * v * br[c]);
    }
    const ix = x - offset;
    const iy = y - offset;
    if (ix < 0 || iy < 0 || ix >= inner || iy >= inner) continue;
    const edge = Math.min(ix, iy, inner - 1 - ix, inner - 1 - iy);
    const alpha = Math.min(1, edge / feather);
    const j = (iy * inner + ix) * 3;
    for (let c = 0; c < 3; c++) field[i + c] = Math.round(alpha * shrunk[j + c] + (1 - alpha) * field[i + c]);
  }
}
await png(sharp(field, { raw: { width: SIZE, height: SIZE, channels: 3 } })).toFile(`${OUT}/icon-maskable-512.png`);
