# Agent guide: yvn-release-notes

**Release Notes** is a daily email from Your Version Number. Each subscriber
gets one email a day whose subject is their version number ("You're 5.2.113
today"). Whatever they reply, or write at `notes.yourversionnumber.com`,
becomes the release notes for that version.

It is its own repo and stack, separate from `~/Projects/yourversionnumber.com`
(the birthday and work sites). Those sites keep everything in the URL because
that was a fun way to build them, not because of a rule (Jamie, 2026-10-08:
"This is a hobby project. It's just fun."). This product stores data.
Nothing on the sites links here yet: whether to add a link is Jamie's call,
so leave the sites alone.

This file holds the rules and the decisions behind them. `docs/OPERATING.md`
says how to run things and `infra/NATIVE-WEB.md` how a release works. Design
detail lives with the code: each module's design comment, the table's key
layout in `packages/backend/store.ts`, the web app in `docs/WEB-APP.md`,
agent connections in `docs/MCP.md` and badges in `docs/BADGES.md`. Read
those before changing a module.

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
  MCP     -> private capture Event Function :live -> guarded text writes

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
  Sharp stays in the thumbnail and image code and is packaged only with the
  describe worker.
- `server/app/` is the HTTP API, `server/mcp/` the separate MCP server,
  `workers/` the Event Function handlers, `packages/testing/` the fictional
  fakes, and `tools/dev-server.ts` serves the built app and the real API
  against them.
- `web/` is the React app; `scripts/make_icons.mjs` draws the Home Screen
  icons. UI glyphs are Lucide React through `web/src/components/icon.tsx`
  (2026-10-14): named imports only, icon-only actions named for assistive
  technology, with hover titles, visible focus and 44px targets. Brand marks
  stay their own artwork.
- `tools/{subscribers,tally,read-notes,import-dayone,extract-media,fill-link-titles,fill-weather,badges-baseline,move-mail-log}.ts`
  are operator tools (shared setup in `tools/operator.ts`);
  `tools/export-mcp-contract.ts` keeps `contracts/mcp-surface.json` current.
- `tools/{build-server,package-native,native-artifacts,web-platform,release-probe}.ts`
  build and upload the code zips, keep the endpoint grants and probe a
  finished release; `tools/{release-identity,release-cli}.ts` are who may
  release and the bundled release tool. `scripts/build-release.sh` builds a
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
  per badge at the save that earns it. An Upcoming row keeps the date's id;
  its title is read when shown, and an assistant sees it only with the
  upcoming scope.
- **Mail in the activity log** (Jamie, 2026-10-20: "a per account holder
  log that can be seen by the user in the web interface and we email the
  user if there is a problem in the log"): one row per email to the
  owner's addresses. It keeps an email's words only once its sender is
  proven; mail from another address or that fails verification shows
  sender and subject alone, since inbound opens no MIME before proof and
  the web reads nothing under `raw/`. Another address, a failed
  verification, an unreadable email or one still failing after three tries
  emails the owner, never the sender: once per email, 3 a day, never to a
  stopped subscriber. Only a failure the code catches is logged: a timeout
  or crash reaches the failed queue with no row and no email.
  Mail to an address that names nobody is never logged. Rows from before
  the log (`MAILLOG#`, 30 days) read as mail rows until
  `tools/move-mail-log.ts` moves them or they expire (by 2026-11-20); then
  the merge goes.
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
- **A note is the same record from every channel**
  (`packages/domain/notes.ts`). Its `place` shows by name, never coordinates,
  linked to Apple Maps unless it is only the subscriber's city
  (`notes.mapUrl`, Jamie 2026-10-09).
- **Where a note was** (Jamie, 2026-10-12): the web form's optional "Where",
  or else its first photo's EXIF GPS, named once at city level by Amazon
  Location, which is told the coordinates alone. Email has no text
  convention. A day can have its own place (`PLACE#<day>`), which comes
  first. A past day's weather follows the day's place, else the subscriber's
  city; the morning forecast is always the subscriber's city. The original
  photo is never changed. Coordinates and place names are never logged.
- **Raw mail is the source of truth.** Every filed reply stays whole in S3
  (`raw/`, `outcome=note`, kept indefinitely); never expire those. Ignored
  mail (`outcome=ignored`) expires in 30 days.
- **Automatic replies are not notes** (Auto-Submitted, X-Autoreply,
  Precedence bulk and the rest), nor is mail with more than one From. A note
  is at most 20,000 characters (`notes.MAX_NOTE`), emailed or typed.
- **Tags are hashtags** in the text (Jamie, 2026-10-09: "hashtags",
  lowercase with hyphens, "maine-2016"), the one place a tag lives. No
  index: one person's notes are read whole.
- **Search** (Jamie, 2026-10-09: "pull posts by tag, showing all tags that
  have been used, as well as search by string across notes") matches every
  word or "quoted phrase" in text, place, link names, transcripts and photo
  descriptions, without case or accents, newest 100 days shown. The words
  travel in a POST body and the page's `#q=`, never a URL a server sees, and
  are never logged.
- **Links show by name, never raw, and there is no Markdown** (Jamie,
  2026-10-08). A title is fetched once, when the note is written, through
  the guarded fetch in `packages/backend/links.ts` (the address is whatever
  someone typed: keep every guard). `links.segments` is the one rendering
  for the email, the web and the export.

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
  or GPS. The email reads only these, never an original.
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
  tally and the first email).
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
  raw emails, files, any export, tokens, the standing address, every `USER#`
  item, every session, the address's codes and the profile. Nothing is kept;
  the export is offered first. Old file versions expire 30 days later. A
  deletion code only deletes and a sign-in code only signs in.
- **The export is a zip** (Jamie, 2026-10-08): the Markdown and JSON plus
  every file. The words alone come straight from `/api/export`.
- **Times:** each subscriber has an IANA `tz` and a `send_time` on a quarter
  hour (default 06:00, Jamie 2026-10-07: the email opens the day and replies
  come in through it). The day and the version are computed in their zone.

### Upcoming

- **Personal dates** (2026-10-13): `/upcoming/` keeps private birthdays,
  anniversaries, trips and events, managed by the owner in their
  email-verified session. They are saved plans, never journal entries, and
  touch no streak, count or note search. A trip does not move the
  subscriber's home, forecast or note places (switching is deferred).
- **Reminders** travel only in the daily email, at most three due entries
  with a link to all. A failed read never holds the send. No catch-up,
  extra messages, tracking or model-generated prompts.
- Entries (`UPCOMING#<id>`) are written with atomic revision and capacity
  checks and the session and account proof, are in every owner export and
  go with the account. Never log titles, dates or destinations. Note scopes
  never reach Upcoming.
- **Bulk editing** (Jamie, 2026-10-17: changing many dates "is a lot of
  clicking"): `/upcoming-text/` edits every date as a line of text,
  previewed by a dry run and saved all or nothing. The separate MCP scope
  `upcoming` (Jamie: "here's a bunch of information, go add it to my
  upcoming") lists, saves and deletes dates, at most 50 per call, 50 calls
  a day.
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
  never logged or exported. No alarms; reminders travel only in the email.

### The email

- **Plain text plus HTML** (`packages/mail/compose.ts`). The HTML is type on
  paper in the site's colours: no borders, boxes, shadows or filled panels
  (Jamie, 2026-10-07: "obsessed with borders and boxes"), and it loads
  **nothing remote**; `tests-node/mail/` holds both. Preview by
  screenshotting `htmlBody()`; for phone width use a 390px iframe in a wider
  window, since headless Chrome will not lay out below ~500px.
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
  unlock line counts too). "Show badges" off drops all of it.
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

### Privacy and security

- **No note text or email addresses in logs.** Log user ids, dates and
  outcomes only.
- **No open or click tracking**, in line with Jamie's email tracking policy.
- **The web app counts pages in Tinylytics** (site 3816, Jamie 2026-10-08)
  from `web/src/lib/pagecount.ts`, not the embed script: never a query
  string (sign-in and unsubscribe tokens live there), no cookies, nothing
  that names a person. No other analytics.
- **The CSP is `'self'`**: no inline script or style, nothing remote;
  anything another service answers goes through `/api`. Add one of its few
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
  grants stay read-only. It allows text-only creates and appends at the
  user's explicit request, hashtags in the text. An append goes only to a
  note the same connection created (that connection, never a name a client
  supplies). No MCP edit or delete of notes. "Turn off adding" in Settings
  keeps reading.
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
  the daily quota and a content-free audit together. No MCP token
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
  baseline's `--write` and moving the mail log (`--write`). Run the dry run first.
- `tools/read-notes.ts` prints note text: run it only for the subscriber's
  own notes; agents do not run it to check things. `tools/subscribers.ts`
  prints addresses, so its output stays on this Mac.
- **The runtime secret** `yvn-release-notes-runtime` is Jamie's, kept by
  hand in the console; the stack does not own it, no deploy writes it, and
  agents never read its value. A new credential is a new key in it, not a
  new secret.
- **DNS is at Namecheap** and Jamie applies records by hand. Read current
  values from DNS or the stack, never from this repo.
