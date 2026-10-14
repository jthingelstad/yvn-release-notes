# Release Notes logo

The mark combines a cobalt version "v", a tangerine dot and two written
lines. The same font-independent shapes in `web/src/lib/brand-mark.ts`
draw the site header, browser icons, Home Screen icons and reusable exports.
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

`web/public/icons/` contains dedicated 16px and 32px favicons, the 180px
Apple touch icon, 192px and 512px app icons, a maskable 512px icon, and an
SVG copy of the mark. Favicon framing is tighter to preserve detail. Home
Screen files include warm-paper backgrounds and extra space; the maskable
file keeps the complete mark inside the central circle of radius 40%.
