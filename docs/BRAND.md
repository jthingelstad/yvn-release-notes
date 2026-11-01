# Release Notes logo

The mark combines a cobalt version "v", a tangerine dot and two written
lines. The same font-independent shapes in `web/src/lib/brand-mark.ts`
draw the site header and the reusable exports below. The browser and Home
Screen icons are separate artwork (below).
The header uses the theme's lighter blue in dark mode.

Regenerate all files using Node 24:

```sh
node scripts/make_icons.mjs
```

## Reusable files

Files in `web/public/brand/` are published at
`https://notes.yourversionnumber.com/brand/`.

| File | Use |
| --- | --- |
| `release-notes.svg` | Transparent scalable master, cobalt and tangerine |
| `release-notes-dark.svg` | Transparent scalable master for dark backgrounds |
| `release-notes-{size}.png` | Transparent PNGs at 48, 64, 96, 128, 256, 512, 1024, 2048 and 4096 pixels square |
| `release-notes-paper-{size}.png` | Warm-paper PNGs at 512, 1024, 2048 and 4096 pixels square |

Use the SVG when the destination supports it. A large PNG works for slides,
documents and other image workflows; the transparent version lets the
destination's background show through. These exports have no rounded outer
frame, shadow or texture.

## Browser and Home Screen

The tab and Home Screen icons are not drawn from the header mark. They are
the 2026-11-01 icon study (`docs/design/icon-study-2026-11-01/`): a single
folded ivory v with a tangerine period on cobalt. The paper curl is the
identity detail.

- **Tabs:** the study's Flat version. `icon-16.png` and `icon-32.png` are its
  reviewed 16 and 32 pixel files, copied as they are.
- **Home Screen and installed app:** the full paper fold, resized from the
  1254 pixel master: the 180 pixel Apple touch icon and the 192 and 512 pixel
  app icons. The maskable 512 pixel icon shrinks the whole picture to 84% on a
  cobalt field, so the fold stays inside the central circle of radius 40%.

Regenerate them with Node 24:

```sh
node scripts/make_app_icons.mjs
```

`icons/release-notes.svg` stays the header mark's vector, from
`scripts/make_icons.mjs`. The companion iPhone app, Changelog, uses three
stacked folded v marks on ink navy (`jthingelstad/changelog-ios`,
`docs/design/icon-study-2026-11-01/`); the two must stay distinct side by
side on a Home Screen. The rejected directions (a literal open journal, three
paper slips) stay rejected.
