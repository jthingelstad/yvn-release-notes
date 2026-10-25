# The book's template and fonts

`book.typ` is the one Typst template a book is set with (`../render.ts`
feeds it `/data.json` and the photos). Typst reads only TrueType or
OpenType files, not WOFF2 or variable fonts, so these are static instances
made once from the variable fonts and committed:

| File                                                            | Source                                                                       | Made with                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `BricolageGrotesque-Regular.ttf`, `-Bold.ttf`, `-ExtraBold.ttf` | google/fonts `ofl/bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf` | fonttools `varLib.instancer` at opsz 12, wdth 100, wght 400, 700 and 800 |
| `MartianMono-Regular.ttf`, `-Bold.ttf`                          | google/fonts `ofl/martianmono/MartianMono[wdth,wght].ttf`                    | the same, at wdth 100, wght 400 and 700                                  |
| `TwemojiMozilla.ttf`                                            | mozilla/twemoji-colr release v0.7.0                                          | as released (COLR colour emoji)                                          |

Each instance was renamed so Typst finds it by family and weight: name IDs
1, 2, 3, 4 and 6 set plainly ("Bricolage Grotesque", "Bold", and so on)
and IDs 16, 17 and 25 removed.

Licenses: Bricolage Grotesque and Martian Mono are under the SIL Open Font
License 1.1 (`fonts/OFL-bricolage-grotesque.txt`,
`fonts/OFL-martian-mono.txt`); the instances are Modified Versions under
it, keep its notices and are not sold on their own. Twemoji's artwork is
CC BY 4.0 and the font is Mozilla's, under `fonts/LICENSE-twemoji-mozilla.md`.
The colophon of every book credits all three.

There is no fallback for scripts these fonts lack (Chinese, Japanese,
Korean, Arabic and others): Typst draws a missing glyph as a box and counts a
warning. Adding a font means adding it here, to `FONTS` in `../render.ts`,
and to the colophon in `../data.ts`.

SHA-256:

```
729262e1de51c263adc3d99f8c773bd61d6ae49080239aa0121e86de260dc0dc  BricolageGrotesque-Regular.ttf
e8f3901cb014da0107329d923628b7c2c8322bb6c847ced48b0789539fe6e8c7  BricolageGrotesque-Bold.ttf
e3fe3f0bbe394123a540865f0ce4814dcafc5b51d0bee77a00465c6ee4330a4d  BricolageGrotesque-ExtraBold.ttf
e59c4cd0689c035ff6fa3f5d2c0473648e939f620d9a410edc14321a0acb35fd  MartianMono-Regular.ttf
cbd1a71810d51fc59aa40d0c166c4c89b0a73b7d67d229be20a2cd41e6fbb9ba  MartianMono-Bold.ttf
6d90152ee0d29e82fe2a87793af5aa4b7ad13e6538360889e141e81ed299ee8e  TwemojiMozilla.ttf
```
