# Rich text in notes

Jamie asked (2026-10-29): "how can we handle rich text better or at all?"
This is the answer. Jamie merged the pull request that built it (#257,
2026-10-30: "Approved: merge Release Notes #257, rich text"), which settled
decisions 1, 3, 4, 5 and 8 as built, and then took the rest as recommended
(2026-10-30: "Approved: RICH-TEXT decisions 2, 6, 7, 9 and 10 as
recommended"). Still to build: MCP and `/v1` taking `markup` (decision 2),
then Changelog's composer (decision 7), then email replies.

## Recommendation

Notes get a small Markdown-like subset: **bold**, _italic_, bulleted and
numbered lists, quotes, and the paragraphs and line breaks they already
have. The text is stored exactly as typed. A note is read as rich only when
it carries `markup: 'rich'`, set once when it is written and kept by every
edit. Every note without the stamp, which today is every note, renders
byte for byte as before. In #257 only the web's note box writes rich
notes; replies, agents, `/v1` and imports stay plain until Jamie picks
them (decision 2).

## Decisions

All ten are decided: 1, 3, 4, 5 and 8 as #257 built them, the
recommendation each one gives, and 2, 6, 7, 9 and 10 as marked.

1. **The guard.** A stamp on each note (recommended), an account setting,
   or a cut-over date. The stamp is the only one that can never change what
   an old note means. An account setting would reread years of notes at
   once, where `5* hotel` or a line starting `- ` suddenly turns into
   markup. A date is invisible to the writer, and imports carry old dates.
2. **Which ways in write rich text.** Decided as recommended: the web
   now (#257). Next, as their own PRs: MCP and `/v1` take an optional `markup: 'rich'`
   argument (agents write Markdown by habit; each needs its version bump
   and changes entry), and Changelog follows `/v1`. Email replies last:
   bold, italic and lists from the HTML part of a reply, mapped to the
   subset, because the plain part's stars depend on the mail app.
3. **The subset.** Recommended: what is listed under The subset, and no
   headings, inline code, `[label](url)` links, strikethrough, nested lists,
   tables or images. Headings fight hashtags (`#` starts both) and the
   day's own headings in the email, the web and the book. Inline code needs
   a box or a tinted background, which the email's no-boxes rule rules out,
   and a diary rarely needs it. Links stay "by name, never raw", so they
   need no syntax.
4. **The plain-text email** shows a rich note as typed, with its stars and
   dashes (recommended; this is how plain-text mail has always shown
   emphasis), or as bare words.
5. **Edits keep a note's format.** A plain note stays plain when edited,
   and there is no "make this note rich" button yet (recommended: none
   until someone asks).
6. **Day One imports.** The importer strips headings, bold, italic and
   escapes today, and `tests-node/operator/legacy-dayone.json` pins that.
   Decided as recommended: leave it. An opt-in "keep formatting", mapping
   Day One's Markdown to the subset and stamping the notes rich, waits
   until someone asks for it.
7. **Changelog's composer.** Decided as recommended: when `/v1` takes
   `markup`, an iOS 26 `TextEditor` bound to an `AttributedString`, so the
   system's own Bold and Italic (the edit menu, ⌘B and ⌘I on a keyboard)
   work, saved as the subset; a small list and quote toolbar above the
   keyboard if wanted. Typing `**` on a phone is poor, so the app should
   never ask for it.
8. **How a quote looks.** Set in and in the second ink, with no rule beside
   it (recommended; the email allows no borders).
9. **Italic in the book.** The book's typeface, Bricolage Grotesque, has
   no italic, and Typst sets `emph` upright, so italic words print plain
   (bold, lists and quotes do print). Decided as recommended: leave it
   for now; an italic face from another family stays an option.
10. **Telling subscribers.** #257 added a section to Getting started, a
    line in the changelog for the day it merged, and the "How to format"
    line under the box. Decided as recommended: Features lists it ("Bold,
    lists and quotes."), and the front page's tour leaves it out.

## The subset

| Write                      | Get                                             |
| -------------------------- | ----------------------------------------------- |
| `**bold**` or `__bold__`   | **bold**                                        |
| `*italic*` or `_italic_`   | _italic_                                        |
| `- `, `* ` or `• ` a line  | a bulleted list                                 |
| `1. ` or `1) ` a line      | a numbered list, counting from its first number |
| `> ` a line                | a quote                                         |
| a blank line               | a new paragraph                                 |
| a single newline           | a line break                                    |
| `\*`, `\_`, `\-`, `\>` ... | the mark itself                                 |

Strict, so plain habits keep their meaning:

- A mark pairs only around words. `5* hotel`, `2*3*4`, `snake_case_name`
  and `a*b*c` stay as typed: neither `*` nor `_` works inside a word.
- Pairs close within their line. An unpaired mark stays a character.
- A list mark needs words after it: `-`, `---` and `-- like this` are text.
  Numbers have one to three digits, so `1999. A good year.` is a sentence.
- A line indented two spaces under a list item goes on with that item.
  A list or a quote can start right after a paragraph line, without a
  blank line.

## Storage

The text as typed, plus `markup: 'rich'` on the note's item (`format` is a
DynamoDB reserved word). Nothing is migrated. The web API's note view and
the JSON export carry `markup`; the Markdown export already writes notes as
typed. `packages/domain/rich.ts` is the one reader of the subset.

## Where a note shows

| Place                                                          | A rich note                                                                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Web: Today, a day, Timeline, a tag, search                     | `NoteBody` draws paragraphs, lists and quotes from `parts`; search marks still light up inside bold or italic                                  |
| Web: the Map's preview                                         | the words without marks                                                                                                                        |
| Email HTML: Yesterday and On this day                          | the same blocks with inline styles, ASCII entities, no borders; a day mixing rich and plain notes escapes the plain ones so they read as typed |
| Email plain text                                               | as typed, escapes removed                                                                                                                      |
| A cut excerpt (Yesterday's sentence cut, On this day's budget) | closes any bold or italic the cut left open; the ellipsis sits inside the last paragraph or item                                               |
| Export: Markdown and JSON                                      | the text as typed; JSON adds `markup`                                                                                                          |
| The book                                                       | blocks of strings with `strong`, `em`, `quote` flags and numbered lists; Typst never sees markup                                               |
| MCP tools and `/v1`                                            | unchanged: the text as typed and `parts` (phase 2 adds `markup`)                                                                               |
| Changelog's Today words                                        | unchanged: it reads only its own token's notes, which can't be rich until `/v1` takes `markup`                                                 |
| Search                                                         | matches the words, so `"long day"` finds `**long** day`                                                                                        |

## Hashtags, links and marks

Addresses and hashtags are found first and are never read for marks, so
underscores inside an address are safe. In rich text a bare address never
ends in `*` or `_`, so `**https://example.com**` is a bold link (an address
that really ends in `_` loses it, as one ending in `.` already does). On
a day mixing plain and rich notes, a plain note's address that ends in
`*` or `_` goes in angle brackets, so it stays whole and keeps its name.
`**#lake**` is a bold tag. `_#lake_` is not a tag, because a tag must not
follow a letter, digit or `_`; italic tags use `*#lake*`.

## Writing it

On the web, a row under the note box (and under a rich note's edit box):
Bold, Italic, List, Numbered list and Quote, then "How to format". The
buttons and ⌘B and ⌘I (Ctrl on other systems) type the marks in around the
selection, or take them off, as an edit the browser's Undo takes back.
Since marks pair within a line, bold or italic over several lines goes on
each line, after any list or quote mark. A plain note's edit box has no
row, since it stays plain.

## Not in this PR

`markup` on MCP and `/v1`, email replies, the Day One option, Changelog's
composer, a way to make an old note rich, and Features or tour copy.
