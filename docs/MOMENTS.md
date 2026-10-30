# Moments

A design for keeping what Changelog's Moments button picks as values beside
a note's words, not only as words. Written 2026-10-30, after Jamie's
question the night before: "moments API has promise and maybe we should
consider data model changes to work with it better?"

Step 1 is built in the same PR as this file, and nothing is merged.
Jamie's calls are at the end.

## Recommendation

Keep an optional `moment` on the note: the typed pieces an app picked (a
walk with its distance and time, a song, steps, a feeling, an event, who was
there, a reflection prompt), stored beside the words and never in place of
them.

- **The words stay the note.** Changelog keeps writing its plain lines into
  the draft as it does now ("Walked 3.2 mi in 48 min"), and the person edits
  them freely. The email, search, the book and tags read the words, so
  nothing changes for them in step 1.
- **The moment is kept as it was picked.** Nobody edits its fields. Editing
  the words, on the web or through the token, never touches it. Deleting
  the note deletes it.
- **Step 1 shows it in two places.** The web day page shows it under the
  words, a quiet line for each piece with its glyph. Both exports keep it.
  `/v1` takes it on `POST /v1/notes` and returns it on the note's read. The
  activity row names its kinds and no word of it.
- **The app sends only what the draft still says.** At Commit, Changelog
  sends the pieces whose line is still in the text. A line deleted before
  Commit takes its piece with it, so what the person removed isn't kept.

This is the smallest change that stops the structure being lost, and it
can't lose anything a person has today. Everything else here (search, MCP,
the email, the book, totals, badges) is a later step that reads the same
field.

## What a moment is

```json
{
  "text": "Walked 3.2 mi in 48 min\nListened to A Song by A Band\nWith Ana and Ben",
  "date": "2026-10-28",
  "moment": {
    "at": "2026-10-28T07:40:00-05:00",
    "items": [
      { "kind": "workout", "activity": "walking", "distance_m": 5150, "duration_s": 2890 },
      { "kind": "song", "title": "A Song", "artist": "A Band" },
      { "kind": "people", "names": ["Ana", "Ben"] }
    ]
  }
}
```

`at` is when the moment began (optional, RFC 3339). `items` holds 1 to 12
pieces, in the picker's order, each one closed to its own fields:

| `kind`       | Fields                                                                                              | From Journaling Suggestions |
| ------------ | --------------------------------------------------------------------------------------------------- | --------------------------- |
| `workout`    | `activity` (walking, running, cycling, hiking, swimming, other), `name`, `distance_m`, `duration_s` | Workout, WorkoutGroup       |
| `song`       | `title`, `artist` (one at least)                                                                    | Song                        |
| `podcast`    | `episode`, `show` (one at least)                                                                    | Podcast                     |
| `played`     | `title`, `artist` (one at least): something listened to in another app                              | GenericMedia                |
| `steps`      | `count` (1 to 1,000,000), `movement` (walking, running, both)                                       | MotionActivity              |
| `feeling`    | `labels` (up to 10, Health's words: "calm"), `valence` (very_unpleasant ... very_pleasant)          | StateOfMind                 |
| `event`      | `title`, `place`, `start`, `hosted` (kept as false when not sent)                                   | EventPoster                 |
| `people`     | `names` (1 to 20)                                                                                   | Contact                     |
| `reflection` | `prompt`, Apple's words                                                                             | Reflection                  |

What isn't a piece:

- **A place visited is the note's own `place`**, named through Here, as the
  Moments button does now. A place with no spot stays a line in the words
  ("At Lake Harriet").
- **Photos are the note's files**, through `uploads`. A video is still left
  out.

The rules:

- Words are trimmed, runs of spaces become one, empty ones are left out and
  repeats kept once. A name, title or place is at most 200 characters, a
  prompt 400.
- Numbers are finite and in range: up to 1,000 km and a week for a workout,
  kept to tenths.
- An unknown kind or field is `invalid_request`, naming it
  (`moment.items[2].distance_m`). So a new kind comes to Release Notes
  first, in a new API version, before an app sends it.
- A moment comes with words or files. Alone it is `text_required`, as an
  empty note is.
- Only a new note takes one. Append, edit and the file route refuse
  `moment` as a field they don't have.

`packages/domain/moments.ts` holds the model, the check (`momentOf`), the
kinds an activity row gets (`momentKinds`), and the plain line each piece is
shown as (`momentParts`).

## How the words and the moment relate

Three ways to do it:

- **A. Kept as picked (recommended).** The moment is a record of what was
  picked, and the words are the person's. Each can say something the other
  doesn't: the words can add "with a blister", and the moment keeps 5,150 m
  exactly. No edit path changes it. It needs no new write path, and no
  rule for matching edited words back to pieces.
- **B. It follows the words.** Every edit of the words drops the pieces
  whose line is gone. This is fragile: "Walked 3.2 mi in 48 min" edited to
  "Walked 3.2 mi in 48 minutes, slowly" would drop the walk, and only
  Changelog knows which line came from which piece.
- **C. Editable fields.** A form for a walk's distance and a song's title.
  More screens, more writes, for values nobody needs to fix: they came
  from the phone.

A applies on the server. In the app, B applies only until Commit: the draft
is still the person's to shape, and a piece whose line they deleted isn't
sent.

The one gap in A: a moment saved by mistake goes only with its note. A
"Remove moment" control on the note (web, and later the app) closes it. It
is one Update that removes the attribute, with its own activity row
(`note.edited` with `moment` removed). It is in step 2, and it is a call
for Jamie.

## Where it shows

| Where           | Step 1                                                                  | Later                                                                                                                             |
| --------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/v1` POST      | `moment` on `POST /v1/notes` (1.6.0)                                    |                                                                                                                                   |
| `/v1` GET       | the note's read returns it as kept                                      |                                                                                                                                   |
| `/v1` activity  | `note.added` has `moment`: its kinds, never a word                      |                                                                                                                                   |
| Web day page    | a line for each piece under the words, with its glyph                   | the lists (Timeline, search, tags) once the day page has been seen                                                                |
| Export JSON     | `moment` on the note, as kept, only when it has one                     |                                                                                                                                   |
| Export Markdown | `Moment: Walk · 3.2 mi · 48 min; A Song · A Band` after the day's words |                                                                                                                                   |
| MCP read tools  | not yet                                                                 | `notes_get_day`, `notes_get_note`, `notes_search`, `notes_on_this_day` return it, under `notes:read`, with a new `server_version` |
| Search          | the words only, which already hold the lines                            | song, artist, show, event, place and people match too                                                                             |
| The email       | the words only                                                          | a line under the note in Yesterday and On this day, only if Changelog stops writing lines                                         |
| The book        | the words only                                                          | the same quiet line under the note                                                                                                |

Units follow home: miles where the road signs give miles (the United
States, the United Kingdom and a few more, `usesMiles`), else kilometres.
A swim is in yards or metres. The day page and the export use the same
rule.

The day page shows the moment under the words, the same lines the export
uses: "Walk · 3.2 mi · 48 min", "A Song · A Band", "8,214 steps", "Calm,
grateful", "With Ana and Ben". In step 1 that repeats what Changelog wrote
into the words. That is call 3.

## What it unlocks

Ideas only. None is designed or promised.

- **On this day, with numbers.** "A year ago, 5.3.301: a 3.2 mi walk by the
  lake." The email's On this day could say what a moment was, not only
  quote the words.
- **A release's totals.** The birthday email's "5.4 is closed" block could
  add "412 mi walked, 61 workouts", and the release page a line per
  activity. Counts only, like the rest of that block.
- **A badge track.** Workouts as a track (walks, runs, rides, counted like
  the others), or firsts: a first moment, a first song, a hosted event.
  Badges count notes, never what the words say, so this counts kinds.
- **The Map.** A walk's place is already the note's place. A route would
  be new data and isn't proposed.
- **Agents.** An assistant with `notes:read` could answer "how far did I
  walk in October?" from values rather than by parsing words.

## Privacy

`site/privacy.md` already says Jamie, as the operator, can read what is
stored. A moment is stored like the words, so one plain sentence goes under
"The iPhone app":

> A moment you pick from Apple's Journaling Suggestions in Changelog is
> kept with its note, as the words are (a walk's distance and time, a
> song, how you felt, who you were with), and goes when the note does.

Kept light, on purpose. What holds behind it:

- Nothing is read until the person picks a moment and commits the note.
  Changelog never reads Health or the picker in the background.
- No model reads a moment. It is never logged, and an activity row names
  only its kinds.
- It is in the export, and deleting the note or the account deletes it.
- Names of people are what the picker gave the phone, stored as words, the
  same as typing them.

For the App Store, the privacy label probably adds Health & Fitness data
(a workout, a state of mind), linked to you and not used for tracking.
Apple's guideline 5.1.3 covers health data. I haven't checked whether a
Journaling Suggestions pick counts as HealthKit data there. That needs
reading before the App Store submission, not before step 1.

## Edits and deletes

- **Words edited** (web, `/v1` PUT, append): the moment stays. Both paths
  are Updates that set only the words and what follows from them, so no
  code had to change. A test pins it.
- **Note deleted:** the item goes, and the moment with it.
- **Account deleted:** every `USER#` item goes.
- **Moved to another day:** not possible today. A note's day is its key.
- **The moment itself:** not editable. Removable in step 2 if Jamie says yes.
- **A token's own note read back** (`GET /v1/notes/{date}/{id}`) returns
  it, so an app that queued a note offline can see it landed whole.

## API rules this follows

- A new `API_VERSION`, 1.6.0, with its `API_CHANGES` entry. `/v1` only
  gains things: a client that never sends `moment` sees nothing new but
  one more optional field on a read and on an activity row.
- The contract was regenerated with
  `node --import tsx tools/export-api-contract.ts`. `Moment` and
  `MomentItem` are in the OpenAPI file, closed to their fields.
- The guide's API page (`site/guide/api.md`) names the field, its kinds and
  its refusal.
- The idempotency fingerprint covers the whole request, so the same key
  with another moment is `idempotency_mismatch`, and a retried note keeps
  the moment it first carried.
- No new DynamoDB request kind: a new note is the same Put with one more
  attribute.

## Steps

1. **Built here.** Storage, `/v1` POST and GET, the activity kinds, the web
   day page, both exports, docs. Changelog sends it, in a draft
   changelog-ios PR.
2. **Next, once Jamie has seen it.** The "Remove moment" control. MCP read
   tools. Search over a moment's words. The lists.
3. **If Changelog stops writing lines into the words** (call 3): the email,
   the book and On this day show the moment's lines themselves.
4. **Ideas** from What it unlocks, each designed on its own when picked.

## Jamie's calls

1. **Step 1 as built:** keep the moment beside the words, kept as picked
   (A above). Recommended: yes.
2. **Removing a saved moment:** a "Remove moment" control on the note in
   step 2. Recommended: yes. Until then, a moment goes only with its note.
3. **Words and lines say the same thing twice.** In step 1, Changelog's
   lines are in the words, and the day page shows the moment under them.
   Recommended: keep both for now, so the email and search lose nothing.
   Once the email, search and the book read moments (step 3), Changelog
   stops writing lines for the pieces it sends as values, and the person
   writes only what they want to add.
4. **Where it shows next:** recommended, the lists (Timeline, search, tags)
   and the MCP read tools in step 2. The email waits for call 3.
5. **Units from home's country** (miles in the US and UK), with no setting.
   Recommended: yes.
6. **The privacy sentence** as drafted above. Recommended: yes.
7. **Which idea to design first**, if any: On this day with numbers,
   release totals, or a workout badge track. Recommended: release totals,
   since the birthday block already counts things.
