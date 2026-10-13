# Shared domain logic

Browser-safe functions shared by HTTP servers, event workers and operator tools.
Public function names use camelCase; stored note fields retain their existing
snake_case spelling. Calendar-day arguments are canonical `YYYY-MM-DD` strings;
clock arguments to `localDay` and `iso` are epoch seconds.

- `dates.ts`: parsing/validation, day arithmetic, anniversaries, local day and UTC timestamps.
- `version.ts`: version values (`String(value)` formats them), history and release spans.
- `notes.ts`: stored-record interfaces, timestamps, names/maps and attributed combined text.
- `tags.ts`: hashtag spans use code-point offsets, matching Python. Render via `split`.
- `streak.ts`: email streaks through yesterday and bounded pause expansion.
- `search.ts`: shared AND/quoted-term matching against existing note fields.
- `unicode.ts`: code-point length/slicing, legacy whitespace and search normalization.

`combine` expects notes already in writing order, as the original function did.
It accepts `{ label }` to escape an assistant client label for a markup renderer.
`dayLinks` preserves the first named record per URL. Readers must still enforce
ownership before obtaining private links or returning records.

The generated `unicode-data.ts` freezes Python Unicode 16 behavior: full
casefold and NFKD with nonzero combining classes removed, ASCII NFKD for tag
slugs, alphanumeric ranges for hashtags, and decimal values for release names.
Do not substitute `toLowerCase`, JavaScript `\w`, or removal of all Unicode marks:
each changes existing archive search/tag results. Hangul decomposition is
algorithmic. The Node tests independently verify the full codepoint range
against a legacy Python golden digest and synthetic text fixtures.

Regenerate those tables deliberately when changing the compatibility contract,
using Python 3 with `unicodedata.unidata_version == '16.0.0'`. For each character
`c`, fold is `''.join(x for x in unicodedata.normalize('NFKD', c.casefold()) if
not unicodedata.combining(x))`; store only mappings that differ from `c`, excluding
Hangul U+AC00–U+D7A3. ASCII decomposition is
`unicodedata.normalize('NFKD', c).encode('ascii', 'ignore').decode()`, storing
nonempty values for non-ASCII inputs. Ranges use `str.isalnum()`, decimal values
use `str.isdecimal()` and `unicodedata.decimal()`. No application runtime or
deployed build depends on Python for these tables.

Run the isolated tests with Node 24:

```sh
node --experimental-strip-types --test tests-node/domain/*.test.ts
```
