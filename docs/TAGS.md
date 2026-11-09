# Tags

Designed and approved 2026-11-08 (Jamie: "Approved: build first-class tags in
Release Notes as proposed, with calls 1 to 8 as recommended"). Jamie's request,
the same day: a tag "can be entered with or without a leading #, which is
stripped. Tags can contain spaces and emoji", so "tags get their own field/chip
input, not inline parsing of note text", and they attach to notes, Upcoming
dates and check-ins, with a remembered place's tags "copied onto every check-in
recorded there". Jamie's calls are at the end, under "Jamie's calls".

Phase 1, the server, the web, API 1.21.0 and MCP 1.15.0, went live on
2026-11-08 (#336). The migration ran the same day on Jamie's go (below), and
Changelog for iPhone (changelog-ios #57, TestFlight build 95) and Quinn's
Android app (changelog-android #8) have shipped tags. Renaming or merging tags
is out of scope.

## A tag is a name and a key

- **The name** is the tag as it was typed and is shown: "Road Trip", "lake",
  "東京", "🚗 Lake". A leading # (or several) is dropped, the spaces around it
  go, runs of spaces become one, and the letters are composed (NFC).
- **The key** is what matches. "Road Trip", "road trip", "road-trip",
  "Road_Trip" and "#Road Trip" are one tag, `road-trip`. Case goes, accents on
  Latin letters go (Café is `cafe`), and runs of spaces, hyphens, underscores
  and other marks between words become one hyphen.
- **Keys from before stay as they were.** A name in Latin letters alone keeps
  the legacy slug of 2026-10-09 (`maine-2016`), and one in other scripts alone
  keeps its letters, lowercased with their marks, as 2026-10-30 made them
  (`東京`, `москва`). A name that mixes Latin letters with another script, or
  has emoji, keeps every part: #café-東京 is `cafe-東京`, where the legacy slug
  kept only `cafe`.
- **Emoji count** (call 2): "🚗 Road Trip" is `🚗-road-trip`, a different tag
  from "Road Trip". Skin tones, joined emoji and flags stay whole.
- **The limits** (call 4): a name is at most 50 characters, an item has at most
  20 tags, and a name can't hold a comma or a line break. A tags field refuses
  them, with the reason, rather than cutting or splitting. A hashtag typed in a
  note's text keeps today's cut instead: it ends at the first character a
  hashtag can't hold, so `#Road Trip` in the text is the tag `road`.
- **Each tag once per item**, in the first spelling it was given (call 3). An
  item keeps its own spelling; a list of every tag, like the tags page or
  `notes_tags`, shows the most recent spelling of each.

`packages/domain/tags.ts` holds every rule. `contracts/tag-vectors.json`,
written by `tools/export-tag-vectors.ts` from those rules, lists names with
their keys, refusals with their reasons and texts with their hashtags, so
Changelog and Quinn's app can test themselves against the server. A test fails
until the file is current.

## Where tags are kept

Notes, Upcoming dates, check-ins and remembered places keep their tags as two
lists side by side: `tags`, the keys, and `tag_names`, the names. Nothing else
is stored and there is no index: one person's items are read whole, as before.

- **A note's tags** come from a tags field and from the hashtags in its text,
  which still make tags as they always have (call 1). When a note is written
  with a tags field, its tags are those names with the text's hashtags after
  them. An edit or append without one keeps the tags its old text didn't carry
  and takes the hashtags of its new text, so taking a #word out of the text
  drops its tag, as it always has, and a tag from a field stays until a field
  takes it off. On the web, removing a chip that a #word made removes the
  #word from the text too.
- **An Upcoming date** takes several tags (call 5), the whole list each save.
  Until 1.21.0 it had one `tag`, and that field keeps working for this
  release: sent alone it sets the first tag and keeps the rest, and every
  answer still says it, the first tag's key. `tags` wins when both are sent.
- **A check-in** has its own tags, and a stay shows the tags of every check-in
  in it. Tagging a stay sets the list on each of its check-ins.
- **A remembered place** has tags that every new check-in there gets as it
  arrives. When a place gains a tag, its answer counts the stays already
  there, and the web offers once, with that count, to tag them too (call 6);
  `PATCH /v1/check-ins/places/{id}/check-ins` does it for the count shown, and
  a different count now is refused with the new one. Tags that would take the
  place, or any stay there, past 20 are refused, as a field refuses a 21st.
  Taking a tag off a place leaves the check-ins that have it alone. One
  `checkin.tagged` row goes in the activity log with the place's id and the
  count.

## Where tags show

- **The tag page** (`/tag/?t=<tag>`) takes any spelling and shows the tag's
  notes, Upcoming dates and check-ins (call 5). The tags list says each tag's
  name and how many of each kind have it.
- **Search and the pinned row** list tags by name. A pin is kept as its name.
- **The Map** (call 8): its tag filter keeps the notes and the check-ins with
  that tag. Words still hide check-ins, which have none.
- **The email** (call 7): the plain text says "Tags: Road Trip, lake"; the HTML
  links each name to its tag page.
- **The calendar feed** lists a date's tags in its description, as
  "Tags: family, Road Trip".
- **The book's index** has one entry per tag, under its most recent name.
- **The export** keeps `tags` and `tag_names` on every note, check-in and
  remembered place that has tags, and an Upcoming date's names in its Markdown.

## The API and MCP

API 1.21.0 adds `tag_names` beside every `tags`, and takes `tags`, by name, on
notes (`POST /v1/notes`, `PUT /v1/notes/{date}/{id}`), Upcoming dates, a stay
(`PATCH /v1/check-ins/{id}`) and remembered places. Every `tag` filter
(`GET /v1/search`, `GET /v1/map/pins`, `GET /v1/check-ins`) takes any spelling;
only one no tag could be (empty, over 50 characters, with a comma) is refused.
`GET /v1/tags/all` gives each tag's `name` and counts its Upcoming dates (with
the `upcoming` scope) and check-ins (with `activity`), null without them.
`GET /v1/tags` adds `pinned_names` and a `name` on each recent tag.

MCP 1.15.0 shows tags by name. `notes_create` and `notes_edit` take `tags`,
`upcoming_save` takes the whole list, and `notes_search` and `notes_check_ins`
take a tag by any spelling. `notes_tags` gives each tag its `name`, its notes,
its check-ins, and its Upcoming dates with the `upcoming` scope (null without).

## The migration

`tools/fill-tags.ts` brought what was stored before 2026-11-08 up to this. It
ran on 2026-11-08 on Jamie's go, a dry run first, and wrote 739 items: 636 notes
and 103 Upcoming dates. It printed counts only, never a tag or a person.

- A note stored before names gains `tag_names`, each named as its text types
  it. A note already named is left alone.
- A hashtag that mixes Latin letters with another script moves to its new key
  (#café-東京 from `cafe` to `cafe-東京`).
- A hashtag the note's kept tags lack gains its tag, as the fill of 2026-10-30
  did. A kept tag its text doesn't give stays, named by its key.
- An Upcoming date with one `tag` gains `tags` and `tag_names` from it. Its
  `tag` stays, since every writer still keeps it for this release.

Each write is conditional on the words and tags read, with the account proof,
so anything changed since is counted and left. Every reader still names an
unnamed tag from its note's hashtags, or by its key.

## Jamie's calls

All eight as recommended, 2026-11-08:

1. Typed #words still make tags, and removing the chip removes the #word.
2. The key rules above: "🚗 Road Trip" differs from "Road Trip".
3. Each item keeps its own spelling; lists show the most recent spelling.
4. The field refuses a tag over 50 characters, a 21st tag, commas and line
   breaks. Typed #words keep today's cut.
5. Upcoming takes several tags, the calendar feed lists them, and a tag page
   shows its notes, Upcoming dates and check-ins.
6. Adding a tag to a place offers once to tag its existing check-ins, with the
   count. Removing a tag leaves them alone.
7. Email: plain "Tags: Road Trip, lake"; the HTML links each name.
8. The Map's tag filter keeps notes and check-ins with that tag.
