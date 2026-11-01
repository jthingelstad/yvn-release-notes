# Release Notes logo

The mark is the 2026-11-01 icon study's Flat icon: an ivory "v" and its
tangerine period on a cobalt tile with rounded corners. The v is traced
from `docs/design/icon-study-2026-11-01/favicons/flat.png` in place, into
the font-independent shapes in `web/src/lib/brand-mark.ts`, so the site
header and the reusable exports below show the mark a browser tab shows.
The tile keeps its colours in dark mode. (Until 2026-11-01 the mark was a
cobalt v, a tangerine dot and two written lines, with no tile.)

Regenerate all files using Node 24:

```sh
node scripts/make_icons.mjs
```

## Reusable files

Files in `web/public/brand/` are published at
`https://notes.yourversionnumber.com/brand/`.

| File | Use |
| --- | --- |
| `release-notes.svg` | Scalable master: the tile, its corners transparent |
| `release-notes-dark.svg` | The same mark, kept so links to it still work; the tile reads on dark grounds too |
| `release-notes-{size}.png` | The tile at 48, 64, 96, 128, 256, 512, 1024, 2048 and 4096 pixels square, corners transparent |
| `release-notes-paper-{size}.png` | The tile at 80% on warm paper, 512, 1024, 2048 and 4096 pixels square |

Use the SVG when the destination supports it. A large PNG works for slides,
documents and other image workflows. The paper 512 is also the picture a
shared link shows (`web/src/lib/share-card.ts`). These exports have no
shadow, texture or paper fold.

## Browser and Home Screen

The tab and Home Screen icons are the 2026-11-01 icon study's own files
(`docs/design/icon-study-2026-11-01/`), not renders of the vector mark: a
single folded ivory v with a tangerine period on cobalt. The paper curl is
the identity detail.

- **Tabs:** the study's Flat version. `icon-16.png` and `icon-32.png` are its
  reviewed 16 and 32 pixel files, copied as they are.
- **Email sender logo (BIMI):** the Flat v again, traced to SVG Tiny PS in
  `web/public/brand/release-notes-bimi.svg`, shrunk to fit a round crop.
- **Home Screen and installed app:** the full paper fold, resized from the
  1254 pixel master: the 180 pixel Apple touch icon and the 192 and 512 pixel
  app icons. The maskable 512 pixel icon shrinks the whole picture to 84% on a
  cobalt field, so the fold stays inside the central circle of radius 40%.

Regenerate them with Node 24:

```sh
node scripts/make_app_icons.mjs
```

`icons/release-notes.svg` is the header mark's vector, from
`scripts/make_icons.mjs`. The companion iPhone app, Changelog, uses three
stacked folded v marks on ink navy (`jthingelstad/changelog-ios`,
`docs/design/icon-study-2026-11-01/`); the two must stay distinct side by
side on a Home Screen. The rejected directions (a literal open journal, three
paper slips) stay rejected.
