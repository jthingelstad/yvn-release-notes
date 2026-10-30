# Agent guide: yvn-release-notes

**Release Notes** is a daily email from Your Version Number. Each subscriber
gets one email a day whose subject is their version number ("You're 5.2.113
today"). Whatever they reply, or write at `notes.yourversionnumber.com`,
becomes the release notes for that version.

It is its own repo and stack, separate from `~/Projects/yourversionnumber.com`
(the birthday and work sites). Those sites keep everything in the URL because
that was a fun way to build them, not because of a rule (Jamie, 2026-10-08:
"This is a hobby project. It's just fun."). This product stores data.
The sites link here, and the front page is for search (Jamie, 2026-10-25:
"Yes we want Release Notes in search where it can be. We also now should
link YVN to Release Notes so people may find it"). So are the public pages
beside it: How it works, Features, the guide, the FAQ, Privacy and the changelog
(`site/`, drawn by `web/src/site.tsx`; Public site and guide). Every other page is the
signed-in app or an emailed link and stays out of search (`web/public/robots.txt`
and the noindex in `web/src/main.tsx`). `/` alone is served as `front.html`,
the front page drawn in at build time for search and previews that run no
script (`web/src/prerender.tsx`, docs/WEB-APP.md). It is free with a Weekly Thing
subscription, and a new account needs one (Subscribers and accounts).

This file holds the rules and the decisions behind them. `docs/OPERATING.md`
says how to run things and `infra/NATIVE-WEB.md` how a release works. Design
detail lives with the code: each module's design comment, the table's key
layout in `packages/backend/store.ts`, the web app in `docs/WEB-APP.md`,
agent connections in `docs/MCP.md`, badges in `docs/BADGES.md`, and
tokens, the public `/v1` API and the Changelog app in `docs/API.md`
(designed 2026-10-29, built in phases). Read those before changing a
module.

## Who can write

Every write proves the writer owns the subscriber's address:

- **By email**: a reply address naming the person and day with 120 random
  bits, within 72 hours of that email, from the subscriber's own address
  (the message's one From), with a DMARC pass or, where the domain publishes
  no DMARC policy, an aligned DKIM pass (`workers/inbound.ts`).
- **On the web**: a session begun with a link or code sent to that address
  (`packages/backend/auth.ts`).
- **By an agent**: `notes:write`, delegated by the owner in that session and
  proved live in the same transaction as each write (Agent connections).
- **By the standing address** (Jamie, 2026-10-12): `<token>@` the inbound
  domain, 120 random bits naming the person, not a day (`INBOX#`), shown
  only in their settings and email footers, with every check a reply has but
  the 72 hours. It files to their day when SES received it and never
  expires; "New address" replaces it and the old one files nothing more. A
  stopped subscriber's address files nothing. The address itself is never
  logged; mail to it shows in the activity log like any reply.

- **By a token** (Jamie, 2026-10-29; docs/API.md): a key the owner makes,
  names and scopes in that session (Settings, API tokens, every
  subscriber's since 2026-10-29), shown once and kept
  as its SHA-256, opening `/v1` only. An app's sign-in makes one the same
  way: the owner chooses it on `/connect/` in that session, and the app
  gets it once for its code (OAuth for the resource `/v1`, no refresh;
  docs/API.md, Phase 5). The capture function checks it again
  and proves the live account and token in the same transaction as each
  write, and a token changes only the notes it wrote.

Each subscriber's data is their own. Do not add an endpoint that writes
without these ownership proofs.

## Shape

```
SES inbound (in.yourversionnumber.com MX)
  -> S3 raw/<messageId>                 the message, untouched
  -> inbound Event Function :live       ownership checks -> DynamoDB

EventBridge, every quarter hour
  -> sender Event Function :live        each subscriber's local send window -> one email

SES delivery events (yvn-release-notes-mail-events)
  -> events Event Function :live        hard bounce/complaint -> stopped;
                                       one scrubbed line -> alarms topic

notes.yourversionnumber.com (CloudFront)
  default -> private S3 web bucket      React/Vite app (dist/web)
  /api/*, /oauth/*, discovery
          -> private Lambda Web Function (server/app, Hono/Node 24)
  /mcp    -> private Lambda Web Function (server/mcp, separate reader role)
  web     -> export Event Function :live -> S3 exports/
  MCP     -> private capture Event Function :live -> guarded note and file writes

DynamoDB stream, for subscribers who opt in
  -> transcribe Event Function :live    recordings -> Amazon Transcribe -> transcript
  -> describe Event Function :live      photos -> Claude Haiku 5.5 -> description
                                       thumbnails for everyone, independently of opt-in
```

Everything is TypeScript on Node 24 (Jamie, 2026-10-13): port-listening Hono
servers on Lambda Web Functions, Event Function workers, operator tools and a
React web UI. Stored accounts, sessions, grants and archives keep their
formats. Each HTTP request owns its session state; only service clients are
reused. Dates are ISO date-only strings, note limits count code points, and
case folding matches existing data.

Where things are (each module's design comment has its contract):

- `packages/domain/`: dates, versions, notes, tags, Upcoming, streaks,
  badges, search and Unicode folding. The version arithmetic follows the
  site's `computeVersion`; `tests-node/fixtures/versions.json` is generated
  from it by `scripts/gen-version-fixtures.mjs` (needs the sibling
  checkout). Regenerate and test if that arithmetic changes.
- `packages/mail/`: MIME parsing and every email. `packages/backend/`: the
  table, sign-in and sessions, files, thumbnails, places, weather, links,
  OAuth, opt-in processing, Day One, exports and the count-only census.
  Sharp stays in the thumbnail and image code and the book's photos, and is
  packaged only with the describe and export workers; Typst only with the
  export worker (`NATIVE` in `tools/package-native.ts`).
- `packages/book/`: the book, a PDF of any span of days (`data.ts` its
  words, `render.ts` its photos and the PDF, `assets/` the one Typst
  template and its fonts, with their licenses).
- `server/app/` is the HTTP API, `server/mcp/` the separate MCP server,
  `workers/` the Event Function handlers, `packages/testing/` the fictional
  fakes, and `tools/dev-server.ts` serves the built app and the real API
  against them.
- `web/` is the React app; `scripts/make_icons.mjs` draws the Home Screen
  icons. UI glyphs are Lucide React through `web/src/components/icon.tsx`
  (2026-10-14): named imports only, icon-only actions named for assistive
  technology, with hover titles, visible focus and 44px targets. Brand marks
  stay their own artwork.
- `tools/{subscribers,tally,read-notes,import-dayone,extract-media,fill-link-titles,fill-weather,fill-tags,badges-baseline,feedback}.ts`
  are operator tools (shared setup in `tools/operator.ts`);
  `tools/export-mcp-contract.ts` keeps `contracts/mcp-surface.json` current,
  and `tools/export-api-contract.ts` the `/v1` OpenAPI file,
  `contracts/api-surface.json`, with its version ledger.
- `tools/{build-server,package-native,native-artifacts,web-platform,release-probe,indexnow}.ts`
  build and upload the code zips, keep the endpoint grants, tell IndexNow
  which public pages a release changed and probe a finished release;
  `tools/{release-identity,release-cli}.ts` are who may release and the
  bundled release tool. `scripts/build-release.sh` builds a
  bundle with no cloud credentials, `scripts/release.sh` releases it, and
  `deploy.sh` is the Mac's path to both.
- `infra/template.yaml` is the stack. `infra/github-deploy-role.yaml` is the
  `yvn-release-notes-deploy` stack (the deploy role and the CloudFormation
  service role), applied by hand from its header.
- **Backups** (Jamie, 2026-10-20: "keep the data in monthly copies for as
  long as we want ... We make no promise about backups"): `infra/backup.yaml`
  is the `yvn-release-notes-backup` stack, applied by hand and never from a
  workflow. AWS Backup copies the table on the 1st of each month into vault
  `yvn-rn-backups`, kept until deleted by hand. A restore goes to a new
  table, never over the live one.

## Rules

### Notes

- **A note belongs to the day of the email it answers**, not the day it
  arrived: a Thursday reply to Tuesday's email is Tuesday's note.
- **Reply addresses take notes for 72 hours** (Jamie, 2026-10-09: "72 hours
  after it was sent. After that, the user can add a note via the web
  interface"). Later replies are ignored as `expired`. The token item never
  expires: the unsubscribe link uses it.
- **A late reply gets a short email back** (Jamie, 2026-10-09: "Yes this
  should not fail silently"), only when every other check passes, never to a
  stopped subscriber, at most one per reply address and 3 a subscriber a day.
- **The activity log** (Jamie, 2026-10-20: "a full log of any activity
  happening in release notes ... knowing exactly what was added, changes,
  removed at any time"; approved 2026-10-21): `/activity/` shows the owner
  one row per thing that happened, newest first (`ACTIVITY#`), kept for the
  life of the account, in the export and gone with it. Connected agents
  read it too (`notes_activity`). A row says when, through what, what
  happened and the day, note or date it touched; it never copies the words
  of a note or an Upcoming entry. A failed log write never fails the change
  it records, and is counted (`activity-unrecorded`). It started on
  2026-10-21 from the mail log, with no backfill from note history.
  `/mail-log/` redirects to it. Badge rows (Jamie, 2026-10-21: "achieving
  a badge should be in the log so Claude knows you got a badge") come one
  per badge at the save that earns it, from any channel. Reminder rows
  (Jamie, 2026-10-21: "an upcoming event reminder should reflect in the
  log, like it does showing up in the email") come one per reminder due in
  the morning's email, those folded into "N more" too, none while paused
  or stopped. An Upcoming or reminder row keeps the date's id; its title
  is read when shown, and an assistant sees it only with the upcoming
  scope. The workers add the daily email, stops for a bounce or
  complaint, transcripts, descriptions and imports (never their words).
- **Mail in the activity log** (Jamie, 2026-10-20: "a per account holder
  log that can be seen by the user in the web interface and we email the
  user if there is a problem in the log"): one row per email to the
  owner's addresses. It keeps an email's words only once its sender is
  proven; mail from another address or that fails verification shows
  sender and subject alone, since inbound opens no MIME before proof and
  the web reads nothing under `raw/`. Another address, a failed
  verification, an unreadable email or one still failing after three tries
  emails the owner, never the sender: once per email, 3 a day, never to a
  stopped subscriber. A timeout or crash gets its row and email too: Lambda's
  failure record goes to the inbound failed queue, which inbound reads
  (`gaveUp`) before handing it on to the failed queue.
  Mail to an address that names nobody is never logged. The mail log's own
  rows (`MAILLOG#`) were never needed: no mail came in between the two
  (checked 2026-10-21), so nothing was moved and readers no longer look.
- **An assistant's reads** are one row a connection a local day (calls and
  tools, never arguments or results), written by the MCP reader under
  `MCPMETA#` since it may not write `USER#` rows.
- **Reply as often as you like.** Each reply is its own note
  (`NOTE#<day>#<messageId>`); oldest first, together they are the day's
  release notes (Jamie, 2026-10-08: "keep them in the database as separate
  things" but "treated as one day's release notes"). Read a day with
  `Store.dayNotes`, join it with `notes.combine`, sort by `notes.writtenAt`,
  never by key. A day with any note counts once for the streak.
- **Web notes** (`NOTE#<day>#w-<id>`, `source=web`) go on today or any day
  back to the birthday. The owner can edit or delete any note; deleting an
  emailed one deletes its message and files (old versions expire in 30
  days).
- **Any kind of data can come from any channel** (Jamie, 2026-10-09: "assume
  any type of data we deal with can come from any channel"). A channel that
  does not carry something yet is work not done, never a rule.
- **Moments are a source, never stored** (Jamie, 2026-10-30: "Moments are
  a source of inspiration for a user to use a note and an easy way to get
  images and everything into the application, but they should not form
  our API."; docs/MOMENTS.md): what an app picks for a note, a workout, a
  song or who was there, becomes its words, its files and its place, which
  every channel has. A note keeps nothing of an app's own record of it,
  and `/v1` refuses `moment` (API 1.8.0 withdrew 1.6.0's).
- **A note is the same record from every channel**
  (`packages/domain/notes.ts`). Its `place` shows by name, never coordinates,
  linked to a map unless it is only the subscriber's city
  (`notes.mapUrl`, Jamie 2026-10-09): our own Map page, opened on the
  note, on the web and in the email (Jamie, 2026-10-24: "go to OUR map").
  The API's `map` field keeps the Apple Maps link the golden fixtures pin;
  the web reads it only as "this place has a spot".
- **Where a note was** (Jamie, 2026-10-12): the web form's optional "Where",
  the device's own spot (Jamie, 2026-10-24: "Here", by a tap, or on each new
  note saved on Today with "Add where I am" on, asked as it is saved, never
  as the page opens; `places.devicePlace`, named through
  `POST /api/places/here`), or else its first photo's EXIF GPS (a JPEG's,
  or an iPhone HEIC's Exif item, `exif.read`), named once by its
  neighbourhood by Amazon Location (`places.namePhoto`), which is told the
  coordinates alone. Here
  is named by its neighbourhood (`district`) and offers the businesses
  Amazon Location finds within the browser's accuracy (50 to 200 m,
  `places.nameSpot`), one tap to name the note by one (`venue`); it never
  picks one itself, since the nearest is as often a bus stop. An
  assistant can name the city with `notes_create`'s `place` (MCP 1.7.0),
  found by the same city search. Email has no text convention. Any note's place can be set, changed or cleared
  after it is saved, whatever channel brought it. Precision (Jamie,
  2026-10-24: "for a note detailed location, specific. For a day the
  city"): a device or photo spot is kept to six places with its city's name,
  and its map link goes to the spot; a day's place, home and weather stay
  at the city. A day can have its own place (`PLACE#<day>`), which comes
  first. A note with no place of its own (an email reply, say) shows the
  day's city, as the weather finds it, or else home, as `place_from` `day`
  or `home`, never mapped (Jamie, 2026-10-24: "inherit the users location
  for that account or day unless they override it"); `views.dayView`
  derives it on read and nothing is stored, and a note cleared with "No
  place" (`place_cleared`) shows none. A past day's weather follows the day's place, else the subscriber's
  city; the morning forecast is always the subscriber's city. The original
  photo is never changed. Coordinates and place names are never logged
  (CloudWatch). The activity log is the owner's own record: a home-city
  change keeps the old and new city by name (Jamie, 2026-10-21: "Yes keep
  the city names"), as settings keep old and new values, never
  coordinates; a day's own place is recorded by its day alone, and a note's
  by its day and note (`note.edited` with `place` set or removed).
- **Raw mail is the source of truth.** Every filed reply stays whole in S3
  (`raw/`, `outcome=note`, kept indefinitely); never expire those. Ignored
  mail (`outcome=ignored`) expires in 30 days.
- **Automatic replies are not notes** (Auto-Submitted, X-Autoreply,
  Precedence bulk and the rest), nor is mail with more than one From. A note
  is at most 20,000 characters (`notes.MAX_NOTE`), emailed or typed, and
  every channel keeps its words through `notes.noteWords` (Jamie,
  2026-10-30: "Approved: build the five API edge cases as recommended"):
  control characters other than tab and newline dropped, and everything
  visible kept, with the joiners, variation selectors and direction marks
  text needs. `/v1` and MCP refuse a lone surrogate escape.
- **Tags are hashtags** in the text (Jamie, 2026-10-09: "hashtags",
  lowercase with hyphens, "maine-2016"), the one place a tag lives. No
  index: one person's notes are read whole. Letters in any script make a
  tag (Jamie, 2026-10-30: "Approved: build the five API edge cases as
  recommended: 1, 3 and 4 as API 1.7.0, 2 as its own PR"): a hashtag with
  no a-z letter even read in full (#東京, #שלום, #Москва) is its own
  letters, lowercased, marks kept; one with them keeps the legacy slug
  exactly, so no tag from before moves (`packages/domain/tags.ts`). A
  note's `tags` are kept when it is written, so older notes gain such tags
  only from `tools/fill-tags.ts --write`, a live run that needs Jamie's go.
- **Search** (Jamie, 2026-10-09: "pull posts by tag, showing all tags that
  have been used, as well as search by string across notes") matches every
  word or "quoted phrase" in text, place, link names, transcripts and photo
  descriptions, without case or accents, newest 100 days shown. The words
  travel in a POST body and the page's `#q=`, never a URL a server sees, and
  are never logged. The Map's words (`POST /api/map/search`) go the same way.
- **Links show by name, never raw** (Jamie, 2026-10-08). A title is
  fetched once, when the note is written, through the guarded fetch in
  `packages/backend/links.ts` (the address is whatever someone typed: keep
  every guard). `links.segments` is the one rendering for the email, the
  web and the export.
- **Rich text is a small subset, and only for notes stamped rich**
  (Jamie, 2026-10-30: "Approved: merge Release Notes #257, rich text";
  `docs/RICH-TEXT.md`; it replaced 2026-10-08's "there is no Markdown"):
  bold, italic, lists, numbered lists and quotes, stored as typed, with
  `markup: 'rich'` set when the note is written and kept by every edit. A
  note without the stamp is plain and renders exactly as before, so the
  golden fixtures never move. `packages/domain/rich.ts` is the one reader
  of the subset for the web, the email, search, the map and the book; the
  book gets strings and flags, never markup.

### Files and processing

- **Photos, recordings and PDFs** (Jamie, 2026-10-08 and 2026-10-09) are kept
  with their note, whatever channel brought them, and shown only to their
  owner by signed links, never a public URL; an S3 key is never a field of
  an API answer.
- **No model processing of notes** (summaries, prompts, anything) without an
  explicit opt-in from each subscriber. Jamie, as the operator, can read
  every note. Any privacy copy must say so plainly.
- **Transcripts** (Jamie, 2026-10-09: "speech to text on audio notes",
  Amazon Transcribe) are off until the subscriber ticks "Write out what I
  say"; at most 30 jobs a subscriber a day. The account has no AI services
  opt-out (Jamie, 2026-10-09: "I don't care if they keep it").
- **Photo descriptions** (Jamie, 2026-10-09: "image descriptions to allow
  images to appear in search", Claude Haiku 5.5 through the Anthropic API)
  are off until the subscriber ticks "Describe my photos".
- **Thumbnails** (Jamie, 2026-10-12: photos in the email) are made once for
  every photo, opted in or not: about 640px, a JPEG under 80 KB, with no EXIF
  or GPS. The email reads only these, never an original. A HEIC gets none
  (`thumb: {}`), but its time and place are still read.
- **A profile photo** (Jamie, 2026-10-28: "I feel like a user should be
  able to create a Profile photo for themselves"): the owner adds,
  changes and removes one in Settings; it shows in the You tab and on
  You, with the You glyph when there is none. The browser crops it square
  and draws it on a canvas as a 512px JPEG, so no EXIF or GPS leaves the
  device and the web function needs no Sharp; `PUT /api/me/photo` keeps
  only a square JPEG of 128 to 512 px, at most 256 KB, with no EXIF, XMP
  or IPTC segment (`packages/backend/profile-photo.ts`). A HEIC works where
  the browser decodes it. It is the owner's alone, like a note's photo: a
  signed link through `/api/me/photo`, never a public URL or a key in an
  answer. The activity log says it was added, changed or removed, never
  the image; the export zip carries it and deleting the account deletes
  it. Not in the email (it loads nothing remote) or the administrator's
  overview.
- **Day One imports are planned before anything is written** (Jamie,
  2026-10-09: "keep it to dry-run"): `--write` imports, and **every live run
  needs Jamie's go**. A repeat skips what was imported before, deleted since
  or not (`IMPORT#`). The export is read as untrusted.
- **Imported days count** toward streaks and every lifetime count (Jamie,
  2026-10-09). The dashboard splits notes into email, web and imported.

### Subscribers and accounts

- **Sign-up is on the web.** The front page asks for the birthday first
  (Jamie, 2026-10-08, option A on the sign-up design canvas,
  https://claude.ai/artifact/KzZxD1K7N9N6Rvq9SBhyxd), then the email;
  nothing is written before sign-in. "Sign in" (`/#sign-in`) is the email
  alone; links for signed-out subscribers go there, not to `/`. No
  subscriber is added by hand (retired 2026-10-09: it skipped the city, the
  tally and the first email). Under the asking, the tour
  (`web/src/components/tour.tsx`; Jamie, 2026-10-25: "Release Notws is a
  hidden gem. Please go ahead and modify its logged out experience to tout
  its features and how well it works. Free to use.") says what it does.
  Every claim in it is something the product does today; keep it so as
  features change. Its sample email is drawn with the visitor's own number
  once one shows (Jamie's call 1, 2026-10-29), in the browser from the
  `/api/sample` answer, with nothing more kept. yourversionnumber.com
  links `/#birthday=YYYY-MM-DD` (call 2), which the page reads as if typed
  and then clears; keep that format, since the other repo writes it
  (docs/WEB-APP.md, What it does).
- **Public site and guide** (Jamie, 2026-10-29: "Approved: build phase 1 of
  the Release Notes signed-out site and guide, with my calls 1-8 as
  recommended", and "Approved: build phases 2-5 of the Release Notes
  public site"): How it works, Features, the guide (`/guide/`, a page for
  getting started, the email and replying, and one for each feature), the
  FAQ and Privacy are Markdown in `site/`, built into their own pages
  (docs/WEB-APP.md, Public pages). The features are one list,
  `web/src/lib/features.ts`, which the tour, `/features/` and `/guide/`
  all draw: change a feature there, and the tour and the docs change
  together. The tour's rule holds for them, and for `llms.txt`: every claim
  is something the product does today, in the tour's voice (plain, second
  person, Jamie in the third person), and each number is checked against
  its constant in `tests-node/site.test.ts`. **A PR that changes something
  a subscriber sees adds its changelog line, and edits a guide page only
  where that page's words stop being true, in the same PR** (Jamie,
  2026-10-30: "Approved: reword the guide rule to edit a guide page only
  when its words stop being true"). A fix that makes the product do what
  the guide already says needs no guide edit. The changelog
  (`site/changelog.md`, `/changelog/`, "Release Notes for Release Notes";
  Jamie, 2026-10-29: "Approved: publish the Release Notes
  changelog backfill as drafted, with answers 1-7 and the two tweaks as
  recommended") has one entry per day something a subscriber notices went
  live, under Release Notes' own version for that day (`lib/build.ts`:
  0.0.0 is 2026-10-07, counted in US Central), newest first. Entries say
  what you can do now, in the tour's voice; internal work stays out, and a
  later change rewrites an older entry that is no longer true rather than
  leaving it. The iPhone app keeps its own the same way (Jamie, 2026-10-29:
  "Please make sure that there is a changelog page for changelog itself on
  the public site."): `site/guide/changelog.md`, `/guide/changelog/`,
  "Release Notes for Changelog", one entry per day a TestFlight build (later
  an App Store one) brings something new, under Changelog's own version for
  that day (0.0.0 is 2026-10-29, counted as Release Notes is), from
  changelog-ios's `AGENTS.md`. While the app is in testing the page says
  so. Privacy says
  plainly that Jamie, as the operator, can read what is stored. The guide
  index links only pages that exist; badges are named only from public
  shelves ("a few are secret"). The first email's welcome line links
  `/guide/start/`; the daily email's foot never links the guide.
- **Release Notes comes with the Weekly Thing** (Jamie, 2026-10-25: "framed
  as better for Weekly Thing supporting members and also gated by
  subscribing to Weekly Thing"). A new account's verified address must be
  on the Weekly Thing's list. The Librarian answers, as it answers Thingy
  (Jamie: "Don’t go direct to Buttondown. Use the librarians api to see if
  a member. It should be like Thingy and offer to sign people up directly
  in release notes."): the server posts its public `/auth` `check` with
  `source: release-notes` (status only, nothing mailed) and reads the
  answer in `packages/backend/weekly-thing.ts`. No key: the Librarian
  treats the source as Thingy's sign-in for Turnstile (librarian-thing's
  `apps/librarian/AGENTS.md`, "Release Notes asks like Thingy"). A reader
  or Supporting Member may start. An address not on the list sees
  "Subscribe <address> to the Weekly Thing" on `/setup/`, which posts
  `/api/me/weekly-thing`: the Librarian's `subscribe` for the session's
  verified address, never a typed one, tagged `source:release-notes` in
  Buttondown. Then it confirms from Buttondown's email and taps "Check
  again". `PUT /api/me` refuses an address not on the list or not yet
  confirmed (403 `weekly-thing`, `weekly-thing-unconfirmed`) with nothing
  written.
  - Accounts made before the gate keep everything (Jamie: "Keep them").
  - Jamie's own plus addresses, `jamie+<anything>@thingelstad.com`, skip
    the gate (Jamie, 2026-10-29: "it would be fine to allow jamie+<anything>
    to bypass the Weekly Thing subscriber check"), for test accounts and an
    app reviewer's: never looked up (`gateFree`), so their accounts read
    like ones made before the gate. The address still needs its emailed
    code, and only Jamie gets that mail.
  - Every account is looked up again on `GET /api/me` once nine days have
    passed (Jamie: "Re-check like Thingy"), or ten minutes while a
    subscription it asked for waits to be confirmed, and by the sender after
    a morning's email once it is due, for accounts that never open the web.
    The first `GET /api/me` after a sign-in looks again too (the session's
    `created_at` is newer than `weekly_thing_at`), as Thingy's sign-in does
    (2026-10-25: Jamie renewed, signed out and in, and no badge came).
    The answer is kept on the profile as `weekly_thing` (`member`,
    `reader`, `unconfirmed`, `none`) with `weekly_thing_at`: a member is
    thanked, and anyone who has left keeps their notes and gets one quiet
    line with the same Subscribe button. Nothing is ever taken away.
  - **Giving** (Jamie, 2026-10-25, picking from suggested perks: "Yearly
    giving badge is EXCELLENT!" and "Love the birthday email idea too!").
    A lookup that answers `member` records the calendar year on the
    profile's `giving` (first and last local day seen, only ever widened,
    each step its own conditional write so lookups racing never narrow it:
    `Store.widenGiving`; `packages/domain/giving.ts`). Each year is a badge
    on its own shelf,
    "Supported Signal", stamped with the first day seen; this year's is
    still to find until earned (Jamie: "We should be encouraging people to
    be a supporting member"); one `badge.earned` row (via `weekly-thing`) while
    "Show badges" is on. A release's page and its birthday email thank the
    member by the nonprofits given to while it ran, whatever "Show badges"
    says; a release with no notes that gave closes with the thank-you
    alone. The nonprofit for each year is `NONPROFITS` in that module,
    copied from the Weekly Thing's `support.json`: add each year's when
    Jamie names it (a year seen before then earns its badge once added).
    Release Notes first asked on 2026-10-25, so no earlier year is known.
    Membership fees go 100% to a nonprofit, and the copy says so and what
    members get, up front (Jamie, 2026-10-25: "remember we are raising money
    for non-profits, we can be up front about the benefits"): what only a
    member can do is shown to everyone, off, with a link to become one.
  - A failed lookup never locks anyone out: sign-up goes ahead and a
    re-check keeps what was known. A failed subscribe asks the reader to
    try again (503 `weekly-thing-busy`); one Buttondown's firewall holds,
    or one the list can't take back, is told to email Jamie (409
    `weekly-thing-review`, `weekly-thing-by-hand`), and the Librarian's
    morning digest lists it. The address is never logged.
- **The first email goes at sign-up** (Jamie, 2026-10-08): today's, at once,
  through the sender's `send_now`, with one welcome line; the schedule
  starts the next day.
- **Sessions last 14 days from the last visit**, renewed by every visit,
  with no outer limit (Jamie, 2026-10-08).
- **A subscriber is `active` or `stopped`.** Stopped means no email, for
  `unsubscribed` (the one-click `List-Unsubscribe` or its page), `bounce`
  (hard) or `complaint`. Nothing is deleted; restarting in settings also
  takes a bounced or complaining address off SES's suppression list, or SES
  would drop every email to it.
- **Pauses** are dated (`PAUSE#<from>`, at most 60 days) and end on their
  own; stopping does not. Paused days neither break a streak nor add to it.
- **Deleting an account deletes it**, after a code mailed to the address:
  raw emails, files, any export or book, tokens, the standing address,
  every `USER#` item, every session, the address's codes and the profile.
  Nothing is kept; the export is offered first. Old file versions expire 30
  days later. A deletion code only deletes and a sign-in code only signs in.
- **The export is a zip** (Jamie, 2026-10-08): the Markdown and JSON plus
  every file. The words alone come straight from `/api/export`.
- **A book** (Jamie, 2026-10-25: "Approved: build step 1 of the Release
  Notes book (screen PDF from any date range)"): `/book/` makes a PDF of
  any days the owner picks, typeset by the export worker with Typst, at 6
  by 9 inches or on US Letter, the maker's pick (Jamie: "pick US Letter or
  6x9 for printing"; `PAGES` in `packages/book/data.ts`). Anyone may make
  one (Jamie, 2026-10-25: "Anyone can make a book without model support.
  Cheap and easy."). One at a time, at most 1,000 photos
  (`packages/book/limits.ts`), offered for a day: `BOOK` beside `EXPORT`,
  the PDF under `exports/`, gone with the account. Every word
  reaches the template as a string, never as markup. Photos are made anew,
  upright, with no EXIF or GPS; a photo's alt text is its description only
  for a subscriber who turned descriptions on. Typst's diagnostics can
  quote the words, so only a count of them is kept and its errors are
  replaced by one fixed line.
- **Claude's commentary in a book** (Jamie, 2026-10-25: "As annotation and
  commentary yes.", "Opus" and "how about 10 books a year (aka, major
  verison?)"): a Supporting Member, or the administrator, may tick "Add
  commentary by Claude" for a book, and the tick is the opt-in for that
  book alone. No other book is read by a model. Claude Opus, through the
  Anthropic API with the runtime secret's key, reads that book's words as
  data (the notes, places, weather, file names, and the descriptions and
  transcripts the subscriber turned on; never a photo, recording or file)
  and writes an introduction, a few lines opening each month, short notes
  beside some days and an afterword (`packages/book/commentary.ts`). Its
  answer is checked field by field and set apart in the PDF, and the
  colophon says whose it is. At most 10 finished books with it in each
  release, the year of life it is made in, counted in the finish's own
  write (`COMMENTARY#<age>`), so one that fails doesn't count; at most 366
  days a book. Only the stop reason and token counts are logged, never a
  word sent or written.
- **Times:** each subscriber has an IANA `tz` and a `send_time` on a quarter
  hour (default 06:00, Jamie 2026-10-07: the email opens the day and replies
  come in through it). The day and the version are computed in their zone.

### Feedback

- **Feedback to Jamie** (Jamie, 2026-10-28: "we have no way to get Feedback
  from users of release notes. It would be nice to have a way users could
  submit feedback of a type, and then Claude could work on those and post a
  reply to the feedback as well. This could be accessible via mcp for
  Claude to send feedback too. (This is reminding me of the feedback system
  we put in Elixir)"): `/feedback/` and the MCP `notes_send_feedback` file
  one item with a kind (`FEEDBACK#<id>`), 10 a UTC day an account; the
  copy says plainly that Jamie reads them. Items are never edited or
  withdrawn; a follow-up is a new item. Answers are appended, each with
  its status (open, answered, needs_info, done), from `/admin-feedback/`
  (the configured administrator) or `tools/feedback.ts`, and each emails the
  filer once, only while their account is active, with no tracking. The
  activity log records filing and answering, never the words. Feedback is
  in the export and goes with the account (docs/WEB-APP.md, Feedback).
- **Claude answers feedback without asking each time** (Jamie, 2026-10-29:
  "Claude may answer feedback through tools/feedback.ts answer --write
  without asking each time"). An agent may run `answer --write` on its own
  judgment: read the item and its screenshots first, run the dry run, and
  answer only what it has fixed, checked or can answer truthfully. A
  question of policy or product is still Jamie's: answer `needs_info` or
  leave the item open and ask him. The standing go covers answers only,
  never another operator tool's `--write`.
- **Screenshots** (Jamie, 2026-10-28: "Make sure a user or agent submitting
  feedback can attach a screenshot."): up to 3 an item, PNG, JPEG or WebP
  (a HEIC where the browser can turn it into one), 768 KiB each, kept under
  `media/<owner>/feedback/` and shown only by signed links; no key in any
  answer. EXIF, GPS and other metadata are stripped in plain code
  (`packages/backend/inline-images.ts`, reusable for other inline uploads);
  Sharp stays out of the web function. No model reads them.
  `notes_my_feedback` returns their bytes only with `media:read`.

### Upcoming

- **Personal dates** (2026-10-13): `/upcoming/` keeps private birthdays,
  anniversaries, trips and events, managed by the owner in their
  email-verified session. They are saved plans, never journal entries, and
  touch no streak, count or note search. The one exception is the Roadmap
  badge track, which counts dates added (Jamie, 2026-10-29: "I do think
  using upcoming should get badges"); nothing else counts them. A trip
  does not move the subscriber's home, forecast or note places (switching
  is deferred).
- **Reminders** travel in the daily email and in any app the owner turns
  them on in, with the email's own lines (Jamie, 2026-10-29: "Reminders are
  going to show up in other places. The daily email is already doing too
  much work."). The email carries at most three due entries with a link to
  all; a failed read never holds the send. An app reads them from
  `GET /v1/upcoming/reminders` (`remindersFor`, with each morning's
  `send_at`) and schedules them on the device; the server sends nothing
  more. No catch-up, tracking or model-generated prompts. An app's
  reminders don't stop for a pause or a stop, since the endpoint reads
  every date as it is; the guide's pause page says so.
- Entries (`UPCOMING#<id>`) are written with atomic revision and capacity
  checks and the session and account proof, are in every owner export and
  go with the account. Never log titles, dates or destinations. Note scopes
  never reach Upcoming.
- **Bulk editing** (Jamie, 2026-10-17: changing many dates "is a lot of
  clicking"): `/upcoming-text/` edits every date as a line of text,
  previewed by a dry run and saved all or nothing. The separate MCP scope
  `upcoming` (Jamie: "here's a bunch of information, go add it to my
  upcoming") lists, saves and deletes dates, at most 50 per call, 50 calls
  a day. Its list leaves out a trip or event already over, counting it only
  (Jamie, 2026-10-21: "One time trips in the past should be left out").
- **Grouping dates** (2026-10-14): one optional tag per entry, normalized
  like note hashtags, with a text search (Jamie, 2026-10-17: "a general
  string search") whose words stay in the page's fragment, never a request.
  A tagged entry can start today's note draft with its hashtag; it never
  creates a note, and Upcoming tags stay apart from journal tags until
  written in a saved note.
- **A private calendar link** (Jamie, 2026-10-17: an iCal feed of Upcoming
  "the user can add in their calendar"): `/api/calendar/<token>.ics`, with
  the standing address's checks (120 random bits, `CALENDAR#`, "New link",
  gone with the account) and no session: the link is the proof, so it is
  never logged or exported. No alarms: reminders travel in the email and
  in apps the owner turns them on in, never the calendar.

### The email

- **Plain text plus HTML** (`packages/mail/compose.ts`). The HTML is type on
  paper in the site's colours: no borders, boxes, shadows or filled panels
  (Jamie, 2026-10-07: "obsessed with borders and boxes"), and it loads
  **nothing remote**; `tests-node/mail/` holds both. Preview by
  screenshotting `htmlBody()`; for phone width use a 390px iframe in a wider
  window, since headless Chrome will not lay out below ~500px.
- **The sender's logo** (Jamie, 2026-10-28: the cake beside our email
  should be "the Release Notes icon we now have"): mail clients that read
  BIMI (Fastmail does without a certificate, since our DMARC is
  `p=reject`) show `web/public/brand/release-notes-bimi.svg`, the mark in
  SVG Tiny PS on paper, under 16 KB, named by `default._bimi` in the
  yourversionnumber.com zone. Without that record a client falls back to
  the site's cake favicon. Keep the file's name and format.
- **The number stands alone.** No decades/years/days breakdown under it
  (Jamie, 2026-10-07: "super redundant"). Below it: 24 text dots for how far
  through the year, the ask, then the streak.
- **Streaks** count days in a row with a note, up to yesterday, from the
  NOTE keys alone (`packages/domain/streak.ts`). A late note mends its day
  (Jamie: "we don't need to be obsessive"). A missed day resets the count
  quietly and the email shows the longest instead; never call a break out.
  The design canvas: https://claude.ai/artifact/C9AZwHtrMBVzyRZrrrZSKm
- **Lifetime counts** (Jamie, 2026-10-09: "a good reminder of creating
  value"): one quiet line under the streak, imported notes included.
- **Badges** (Jamie, 2026-10-20: the email "for sure" carries both lines):
  one line naming what was earned and not yet `seen`, and on a special day
  that is not secret one clause beside the number ("5.4.300 is a round
  number."). Never a line about what is close, at risk or missed. A badge is
  told once, marked `seen` only after the email has gone (a web save's
  unlock line counts too, and so does the web's welcome back, Jamie,
  2026-10-25: "when you come to the website and there is a badge since your
  last visit that should get special attention!"; docs/BADGES.md). "Show
  badges" off drops all of it. Four firsts are earned outside notes (Jamie,
  2026-10-29): Signed commit (a profile photo), Issue opened (feedback
  sent), Merged upstream (feedback marked done) and Tarball (a book), with
  the Roadmap track for Upcoming; docs/BADGES.md has them. On a status
  patch one more line follows the clause, badges on or off ("200 OK.",
  Easter eggs).
- **A birthday closes the release** (2026-10-12): that day's email sums up
  the year of life just ended in one short block ("5.4 is closed": days with
  notes, notes, photos, the longest streak) and links its page,
  `/release/?v=5.4`, which is the year's collection. With badges on, it adds
  the release's coverage and collected days.
- **Yesterday** (Jamie, 2026-10-12: the email confirms everything sent the
  day before came through): the subscriber's own yesterday as the web reads
  it, cut at a sentence, its files as one short line, read only when the
  note index says yesterday has notes. A day with no notes has no block.
- **Photos in the email** (Jamie, 2026-10-12) travel inside the message as
  inline parts, never a link to the bucket: thumbnails only, at most 4 a
  day block, 6 an email and about 400 KB; the rest stay "See N photos". The
  alt text is a description only for a subscriber who turned descriptions
  on.
- **On this day** (Jamie, 2026-10-09, option A of the design session): the
  notes from the same patch number in every earlier release, by version,
  not calendar, with their tags (Jamie: "just have the tags on the posts").
  It replaced "A year ago" (2026-10-08).
- **Weather** (Jamie, 2026-10-08: "Record + today's forecast"): each day's
  weather kept with its city, and one forecast line in the email.
  Open-Meteo is CC BY 4.0: credit it wherever weather shows. A weather
  failure never fails a note.
- **Every optional block fails quietly**: a failed read of the streak,
  badges, the closed release, Yesterday, photos, weather, Upcoming or a
  product update sends the email without it, never holds it.
- **The ask** is the same every day and says photos and voice memos work
  too. No rotating list of prompts for now (Jamie, 2026-10-07: "keep it
  simple"). Nudges as such are fine (Jamie, 2026-10-20: "Badges are a form
  of a nudge. I think that is fine.").
- **Product updates** (2026-10-13): the configured administrator writes and
  schedules them at `/admin/`, one per local email date, shown as "Release
  Notes about Release Notes". `AdminUserId` names an existing
  email-verified subscriber; it is configured privately, never committed,
  and set only through `./deploy.sh --admin-user-id=ID` (empty disables
  it). No admin privilege can be self-assigned by the web.
  Scheduling is explicit and separate from saving; cancelling cannot
  retract a sent email. No extra sends or catch-up; updates are never
  personal notes.

### Easter eggs

- **Three easter eggs** (Jamie, 2026-10-29: "Those are all amazing. I love
  them all." and "Approved: build the Developer mode, Status code and RTFM
  easter eggs in Release Notes, with the status line in the email on those
  mornings"): Developer mode (seven taps on Today's number, kept in the
  browser), Status codes (secret collectibles on HTTP-status patches, with
  a status line in that morning's email) and RTFM (`/man/`, the product as
  a man page). docs/BADGES.md, Easter eggs, has them.
- **Keep them secret.** The tour, the front page, the public pages and
  guide, `llms.txt`, help copy and the MCP tool descriptions never mention
  them (`tests-node/site.test.ts` holds the pages, the tour and `llms.txt`
  to it); the clues are the ones built (the comments in `web/index.html`
  and `robots.txt`, the 404 page's line).
  Every line of `/man/` is true of the product today, as the tour's are;
  keep it so as features change.
- They work with "Show badges" off; only badges, unlock lines and badge
  rows are left out. A found egg is one `egg.found` activity row, ever.

### Privacy and security

- **No note text or email addresses in logs.** Log user ids, dates and
  outcomes only.
- **No open or click tracking**, in line with Jamie's email tracking policy.
- **The web app counts pages in Tinylytics** (site 3816, Jamie 2026-10-08)
  from `web/src/lib/pagecount.ts`, not the embed script: never a query
  string (sign-in and unsubscribe tokens live there), no cookies, nothing
  that names a person. The public pages count the same way, through
  `assets/count-<hash>.js`, bundled from that module (`web/src/site.tsx`).
  No other analytics.
- **The CSP is `'self'`**: no inline script or style, nothing remote;
  anything another service answers goes through `/api` (the Map page's base
  map too: Amazon Location under the web role, `packages/backend/maps.ts`,
  for the signed-in owner alone). Add one of its few
  named exceptions (`docs/WEB-APP.md`, Front end) only when there is no way
  through `/api`.
- **Turnstile on the sign-in email** (2026-10-14, after subscription bombing
  on the Weekly Thing forms: bots type victims' real addresses so our mail
  fills their inboxes). `POST /api/auth/start` is the one public request
  that mails a typed address; the delete code goes only to a signed-in
  account's own address, and nothing under `/oauth/` sends mail. It checks
  the token before any limit or mail and logs one line per request, never
  the address or token. The page's `client_wait_ms` and `client_reason`
  (2026-10-20, after the first week's four `missing` were all real people)
  are its word, logged and never trusted: a reason lets nothing through.
  `observe` (the default) refuses nobody, `off` skips the check, and
  `enforce` refuses `fail` and `missing`; since a Cloudflare outage also
  means `missing`, enforcing is its own decision, made from the observe
  numbers. The sign-in rate limits and their alarm stay as they are.
- **The API answers only CloudFront.** Each Lambda Web Function endpoint uses
  IAM authentication and CloudFront OAC signs every origin request; the
  policy lets only this distribution invoke the live endpoint.
  `CloudFront-Viewer-Address` is trusted only behind that boundary; the
  client `Origin` is still checked before every cookie-authenticated write.
- **SES events never reach the ops queue as is**: they carry the address,
  the subject (a sign-in code) and the reply token. `workers/events.ts`
  sends the alarms topic one scrubbed line.
- **Counts, not people** (`TALLY#<YYYY-MM>`): sign-ups, unsubscribes,
  restarts, bounces, complaints and deletes, one number each a month. A
  stopped subscriber gets nothing from the product, so the unsubscribe count
  is the one to watch (Jamie, 2026-10-08).
- **The operations dashboard is CloudWatch, not the web app** (Jamie,
  2026-10-09: "instead of part of the application ... an AWS dashboard"):
  counts only, no address, user id or note text; a new number goes in
  `packages/backend/census.ts`. Jamie's 2026-10-13 addition permits a
  metadata-only subscriber overview at `/admin-users/` for the configured
  administrator: addresses, delivery state, counts and activity dates,
  never journal contents.

### Testing

- **Never verify with a write against live data.** The sender takes
  `{"dry_run": true, "now": "<ISO UTC>"}` and writes nothing; `now` is
  refused on a real send. Never sign in on live to check something.
- Tests never fetch real services: inject fakes for title, weather and place
  fetches, mail, objects, the store and invocations. The harness and every
  fixture use fictional subscribers only.
- New DynamoDB request kinds need exact SDK-shape tests in
  `tests-node/store/`; fakes alone do not prove AWS shapes. The fake table
  refuses a reserved word used bare in an expression, as DynamoDB does;
  alias it (`#owner`).
- **The golden fixtures are regression data.** They were captured from the
  Python implementation before it retired (2026-10-13) and pin formats that
  stored data and old emails still depend on: `tests-node/mail/fixtures/`,
  `tests-node/export/fixtures/legacy.json`,
  `tests-node/api/fixtures/python-readers.json`,
  `tests-node/domain/legacy-golden.json`,
  `tests-node/operator/legacy-dayone.json` and
  `tests-node/services/fixtures/metadata.json`. Never regenerate one from
  the TypeScript code to make a test pass; a changed golden is a changed
  format or email and needs its own reason.
- **Browser tests are optional** (Jamie, 2026-10-08: quick deploys for most
  changes, the browser run when wanted). On GitHub the `e2e` workflow runs
  by itself on a PR that changes `web/` or `e2e/`, on any PR labelled `e2e`,
  and from the Actions tab (2026-10-20). It is not a required check and the
  deploy does not wait for it: a red e2e run does not stop a merge, so read
  it before merging a change a page shows. The expected number comes from
  `/api/sample`, never a fixed string.

## Agent connections (2026-10-12)

`docs/MCP.md` has the tools, scopes and roles in full.

- **Each scope is the subscriber's own approval**, given in their
  email-verified web session. `notes:read` shares the archive with its
  transcripts and descriptions, and (Jamie, 2026-10-20: "read-only MCP
  tools ... for badges, the mail log, releases, on this day and account
  settings under notes:read", and 2026-10-21 the activity log) the rest
  of the account, read-only: never
  the email address, the standing address or the calendar feed, which work
  as credentials, and badges only while "Show badges" is on; `media:read`
  adds file bytes and ten-minute links. Consent lets the agent process what it reads; it never turns on the
  product's own transcription or description.
- **`notes:write`** is a separate approval, off by default, and existing
  grants stay read-only. It allows creates, appends and edits at the
  user's explicit request, hashtags in the text. An append or edit goes
  only to a note the same connection created (that connection, never a
  name a client supplies). Edits (Jamie, 2026-10-28: "the mcp interface
  doesn't provide a way to edit a note") replace the text from the
  revision the agent read, refuse a note changed since, and keep no
  history, as web edits keep none. No MCP delete of notes. "Turn off
  adding" in Settings keeps reading.
- **`media:write`** (2026-10-28; Jamie: "the mcp interface doesn't allow an
  agent to add an image or attachment") is its own approval, only beside
  `notes:write`, for files on those same notes: base64 photos, recordings
  and PDFs as the web takes them, at most 4 files and 4 MB a call. Kept as
  web uploads are, so thumbnails, EXIF place and the owner's opted-in
  transcripts and descriptions follow as for a web upload. Existing
  connections gain it in place from Settings; "Turn off adding" removes it.
- **`upcoming`** (2026-10-17) is a third approval, for Upcoming dates only,
  never notes. An existing connection gains it in place from Settings
  (Jamie, 2026-10-17: without "disconnecting and reconnecting"). The consent
  screen offers it whatever the client asked for (Jamie, 2026-10-17: it
  "does not reference anything for upcoming"), since a reconnecting client
  re-requests its old scopes.
- **Captures show their author and client** on the web, in emails and in
  both exports, and the owner edits or deletes them as usual.
- **The MCP function is a reader**: its only table writes are MCPMETA rows
  and its one invocation is the private capture function, which rechecks
  the bearer and commits the note, the live grant, an idempotency receipt,
  the daily quota and a content-free audit together. Capture alone keeps an
  agent's files (S3 puts under `media/*/files/`), and removes them when no
  note took them; a token's uploads it checks under `media/*/api/*` alone,
  never the web's `media/*/web/*`. No byte or file name is logged. No MCP token
  authenticates a web write. Activity records hold no arguments or returned
  content, and nothing logs note text.
- **Disconnecting revokes at once**; what was already shared, and unexpired
  private links, stay with the receiving service. Deleting an account blocks
  new MCP and OAuth writes first and removes every grant.
- **Never test a connection** by reading or writing live subscriber notes or
  by signing in against production. Use the dev server and fakes.
- **When tools change**, regenerate the contract with
  `node --import tsx tools/export-mcp-contract.ts`; every tool change is a
  new `server_version` with a `changes` entry, since clients cache the tool
  list (`docs/MCP.md`, When tools change).

## API tokens and `/v1` (2026-10-29)

`docs/API.md` has the design and the phases; phase 1 (tokens, text notes,
tags, the activity log), phase 2 (the OpenAPI file and the guide's
`/guide/tokens/`, `/guide/api/` and `/guide/api/clients/`), phase 3
(signed forms, files on a token's notes, a note's place, the city search
and Here), phase 4 (Upcoming and its reminders) and phase 5 (an app's
sign-in, which makes an API token) are built.

- **`/v1` is the MCP function's**, under its reader role, and every write
  goes to the capture function, as an agent's does. Only an API token opens
  it: no cookie, and no MCP access token. No token authenticates a web route
  or `/mcp`, and `/oauth/revoke` ends only one an app signed in for, when
  that app's own client id comes with it.
- **A token writes in the owner's voice**: `source` `api`, no `author`, its
  name as `token` and the User-Agent's product as `client`. The web shows
  "via <name>"; the email shows nothing. It counts like a web note.
- **No token value in any log or answer** after the one at its making. The
  activity log records each write ("note added via <name>") without words,
  and a token with `activity` reads the log trimmed of every word
  (`tokenActivityView`: no mail subject, words or sender, no settings
  value).
- **Deleting an account** blocks token writes first (`mcp_deleting`), then
  removes every token and its pointer with the agent connections.
- **Offered scopes** are `notes:write`, `media:write` (only beside
  `notes:write`, for files on the notes the token wrote, kept as web
  uploads are), `upcoming` and `activity`. There is no `notes:read` in v1.
  `upcoming` keeps MCP's rules (revisions, dry runs, all or nothing, 50
  dates a request, past one-time dates left out) and reaches every date,
  as MCP's does, with its own count of 50 saves a UTC day across tokens;
  a dry run counts as a read. Its activity rows carry the token's name.
- **Receipts and ids are the account's** (Jamie, 2026-10-30: "Make that
  api change."; API 1.4.0, docs/API.md): an `Idempotency-Key` answers from
  any token of the account (`CAPTURE#api#`), the old per-token receipt is
  honoured until `PER_TOKEN_RECEIPTS_UNTIL`, `/v1/me` gives a derived
  `account` id and the token's `id`, and a token's activity rows carry
  `token_id`. Ownership stays the token's: it changes only the notes it
  wrote.
- **When `/v1` changes**, regenerate the contract with
  `node --import tsx tools/export-api-contract.ts`. Every change is a new
  `API_VERSION` with its `API_CHANGES` entry (`server/mcp/v1.ts`), or the
  tool refuses it. That holds for a fix the contract can't see too, one
  that only makes `/v1` do what its docs already said: a patch version for
  a fix, a minor one for anything gained (Jamie, 2026-10-30: "Approved:
  bump API_VERSION for every API fix, including fixes that only match the
  docs"). `/v1` only gains things; a breaking change is `/v2`. The
  one exception is 1.8.0, which withdrew `moment` before any released app
  sent one (Jamie, 2026-10-30: "Approved: withdraw moments from Release
  Notes as API 1.8.0"). The guide's API page names every request and
  error (`tests-node/site.test.ts`), so it changes in the same PR.
- **Tokens are every subscriber's** (Jamie, 2026-10-29: "Open up token
  generation and all of the needed features so we can continue with
  build. I am fine with these features being enabled automatically.").
  Settings shows API tokens to every account, with nothing to turn on, and
  `/api/tokens` answers any signed-in subscriber for their own tokens alone.
  `features.ts` lists them for the tour, `/features/` and the guide, with
  no flag (Jamie, the same day: "I intend to open this up immediately so no
  need to feature flag. Let's go fast."). A product update about them is
  Jamie's to write.
- **Test with the dev server's fictional account**, which prints a token at
  start. On the live site an agent tests only with its own test account,
  made with Jamie's go (2026-10-29), never a subscriber's.

## Landing changes

- **Work reaches `main` only through a pull request** (2026-10-07, the same
  model as the clash-royale repos): a branch, `gh pr create --fill`,
  `gh pr merge --auto --rebase --delete-branch`. GitHub merges it once
  `validate` is green on a branch up to date with main. The `main` ruleset
  requires that check, rebase merges and linear history, with 0 approvals
  and no bypass, Jamie's account included (agents push as it).
- `validate` runs the workflow lint, pinned cfn-lint and `npm run verify`.
  Workflows stay SHA-pinned with `permissions: {}`, per-job grants and
  `persist-credentials: false`; `sh scripts/test-workflows.sh` checks that,
  and `tests-node/infra/workflows.test.ts` holds the deploy and e2e
  workflows to their guarantees. Installs never run package scripts.
- **Merging to main deploys it**, with no approval step (Jamie, 2026-10-17:
  "I don't want the hand/manual approval. This is a hobby project. I'm the
  only dev."). `deploy` follows each green `validate` run on main and
  releases everything at that commit in one stack update, then probes it.
  **Roll back by reverting the merge** (Jamie, 2026-10-20, approving
  "rollback by revert"); there is no other rollback path.
  `infra/NATIVE-WEB.md` has the flow.
- Dependabot's two grouped PRs a month (action pins, npm packages) are
  reviewed like any other and never auto-merge: a merged action runs with
  the repository's token and a package runs in the build. It skips
  `@types/node` majors, which move with Node. Dependabot cannot see the
  cfn-lint pin: bump it by hand to PyPI's latest, after a local run, when
  the template needs it.
- `tests-node/docs/inventory.test.ts` checks the documented API routes,
  pages, MCP tools, operator tools (this file and `docs/OPERATING.md`),
  table key prefixes and the verification setup against the code. Update
  the docs in the same PR as a changed public contract; table key layouts
  belong in `packages/backend/store.ts`'s design comment.
- The repository is public. Never commit subscriber data, note text, DNS
  values or anything from the live table or bucket, tests and fixtures
  included (they use a fictional subscriber at example.com).

## Operating

`docs/OPERATING.md` has the procedures. Use the cloud-engineer profile in
us-east-1, and Node 24 (`/opt/homebrew/opt/node@24/bin` first on PATH here).

- **Deploy by merging to main.** `./deploy.sh` is the Mac's path, for GitHub
  being down and for what only it sets: the admin id and the Turnstile mode,
  never from a workflow. It runs only from a clean checkout of `origin/main`
  with a green `validate`; `--break-glass` is for GitHub being down, never a
  red check.
- **No release step removes an endpoint grant**, and a grant that differs
  from the live-endpoint grant stops the release for a person to look at.
  Never delete a code zip under `native/` in the source bucket: its revision
  fails for good, and a revert needs it.
- **Never commit or print a release's cloud identifiers** (the account,
  bucket and distribution names, ARNs); the workflow masks them.
- **Send someone today's email now** only through the sender's `send_now`,
  still once per local day; never fake the clock with `now` to do it.
- **Every live write by an operator tool needs Jamie's go**: an import, a
  fill-in script's `--write`, the real `thumbs_all` run, the badges
  baseline's `--write`. Run the dry run first. The one standing go is
  `tools/feedback.ts answer --write` (Feedback).
- `tools/read-notes.ts` prints note text: run it only for the subscriber's
  own notes; agents do not run it to check things. `tools/subscribers.ts`
  prints addresses, so its output stays on this Mac.
- **The runtime secret** `yvn-release-notes-runtime` is Jamie's, kept by
  hand in the console; the stack does not own it, no deploy writes it, and
  agents never read its value. A new credential is a new key in it, not a
  new secret.
- **DNS is in Route 53**, as code: every record in `yourversionnumber.com`
  is in its zone stack in `~/Projects/projects-sysadmin`
  (`config/dns-<zone>-stack.yaml`; its `docs/DNS-MIGRATION.md`), never
  edited in the console, and mail records change only with Jamie's
  approval line. Namecheap stays the registrar. This app's records move
  into its own stack when that is its own change (Jamie, 2026-10-28:
  "Product repos"). Read current values from DNS or the stack, never from
  this repo, which holds none.
