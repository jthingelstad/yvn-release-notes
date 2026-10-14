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

This file holds the rules, the decisions behind them and how to operate.
The design detail lives with the code: each module's design comment (named
below), `packages/backend/store.ts` for the table's key layout, and
`docs/WEB-APP.md` for the web app, its API and its front end. Read those
before changing a module.

## Who can write

Every write proves the writer owns the subscriber's address:

- **By email**: through a reply address that names the person and day with
  120 random bits, within 72 hours of that email going out, from the
  subscriber's own address (the message's one From), with a DMARC pass or,
  where the domain publishes no DMARC policy, an aligned DKIM pass
  (`workers/inbound.ts`).
- **On the web**: inside a session that began with a link or code sent to
  that address (`packages/backend/auth.ts`).
- **By an agent**: the owner explicitly delegates `notes:write` in that
  email-verified web session. `workers/capture.ts` proves the live grant and account
  in the same transaction as each create or append. Only a connection's
  own assistant-authored notes may be appended to; no MCP edit or delete.
- **By the standing address** (Jamie, 2026-10-12): `<token>@` the inbound
  domain, 120 random bits naming the person, not a day (`INBOX#`), shown
  only in their settings and the footer of their emails, with every check
  a reply has but the 72 hours: from the subscriber's own address, DMARC
  or an aligned DKIM, not automatic (`workers/inbound.ts`). It is filed for their
  own day when SES received it, and it never expires; "New address" in
  settings replaces it, and the old one files nothing from then on. A
  stopped subscriber's address files nothing. It is never logged.

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

The application, workers and operator tools are TypeScript on Node 24
(Jamie, 2026-10-13), with ordinary port-listening Hono HTTP servers on Lambda
Web Functions and a React web UI. Shared accounts, sessions, grants and
archives keep their persisted contracts. Each HTTP request owns its session
state; only service clients are reused. The domain uses ISO date-only strings,
code-point note limits and Unicode case folding compatible with existing data.

Where things are (each module's design comment explains its contract):

- `packages/domain/`: `dates.ts`, `version.ts`, `notes.ts`, `tags.ts`, `upcoming.ts`,
  `streak.ts`, `search.ts`, `unicode.ts` and `unicode-data.ts`. The version
  arithmetic follows the site's `computeVersion`; `releaseSpan` defines a
  year of life, birthday to birthday. `tests-node/fixtures/versions.json`
  is generated from the site's own function by `scripts/gen-version-fixtures.mjs`
  (needs the sibling checkout). Regenerate and test if that arithmetic changes.
- `packages/mail/{parse,compose,auth}.ts`: MIME parsing, note/quote/signature
  extraction, the daily email, and sign-in/deletion emails.
- `packages/backend/{store,store-types,services,aws}.ts`: the one table's key
  layout, document-value SDK requests and injected service contracts/adapters.
  `census.ts` supplies the count-only dashboard.
- `packages/backend/{links,media,uploads,exif,thumbs,places,weather}.ts`:
  guarded title fetches, private file handling, image metadata, thumbnails,
  city naming and weather. Sharp is confined to thumbnail/image processing;
  its pinned Linux Arm64 runtime closure is packaged only with the describe worker.
- `packages/backend/{auth,sessions,accounts,guarded-store,views,exports}.ts`:
  email-verified sign-in, request-local sessions, owner DTOs, upload/account
  proofs and export endpoints. `export.ts` produces JSON/Markdown;
  `workers/export.ts` builds the ZIP with bounded multipart uploads.
- `packages/backend/{oauth,transcribe,describe,dayone,importer}.ts`:
  agent consent/grants, opt-in processing, untrusted Day One plans and imports.
- `server/app/{app,account-routes,archive-routes,note-routes,requests,index}.ts` is the native API. `server/mcp/`
  contains the separate native MCP server, reader and contract; `docs/MCP.md`
  describes it. `server/shared/listen.ts` handles bounded graceful shutdown.
- `workers/{send,inbound,events,transcribe,describe,export,capture}.ts`:
  Event Function handlers. `workers/entries/{send,inbound,events}.ts` bind
  production services. `workers/runtime.ts` supplies content-free runtime probes.
- `web/` is the React app (`docs/WEB-APP.md`, Front end); Home Screen icons
  are drawn by `scripts/make_icons.mjs`.
- `packages/testing/{store,services}.ts` are fictional DynamoDB, mail, S3
  and invocation fakes. `tools/dev-server.ts` serves the built app and the
  actual native API against them. New DynamoDB request kinds also need exact
  SDK-shape tests in `tests-node/store/`; fakes alone do not prove AWS shapes.
- `tools/{subscribers,tally,read-notes,import-dayone,extract-media,fill-link-titles,fill-weather}.ts`
  are operator tools, with shared setup in `tools/operator.ts`.
  `tools/export-mcp-contract.ts` keeps `contracts/mcp-surface.json` current.
- `tools/{build-server,package-native,native-artifacts,native-release,web-platform}.ts`
  build deterministic native artifacts, retain immutable S3 versions and
  manage private release/policy receipts. `infra/template.yaml` is the stack.
  `deploy.sh` requires a clean green `origin/main`, verifies an archived
  committed tree, publishes/activates only the requested native phase, and
  syncs the web app. `docs/TYPESCRIPT-REBUILD.md` records the migration gates.
- `tsconfig.server.json` and `tests-node/` check servers, workers and tools;
  `npm run verify` checks the complete application. Shared `package-lock.json`
  pins runtime/build dependencies; installs do not run package scripts.

## Rules

### Notes

- **A note belongs to the day of the email it answers**, not the day it
  arrived. A Thursday reply to Tuesday's email is Tuesday's note.
- **Reply addresses take notes for 72 hours** after their email went out
  (Jamie, 2026-10-09: "72 hours after it was sent. After that, the user
  can add a note via the web interface"). Later replies are ignored as
  `expired`; the note goes in through the web, on any day. The token item
  never expires: the email's unsubscribe link uses it.
- **A late reply gets a short email back** (Jamie, 2026-10-09: "Yes this
  should not fail silently"), only for a reply that passes every other
  check, so a forged sender never gets one, and never to a stopped
  subscriber; at most one per reply address and 3 a subscriber a day.
  `workers/inbound.ts` has the detail.
- **Reply as often as you like.** Each reply is its own note
  (`NOTE#<day>#<messageId>`); together, oldest first, they are that day's
  release notes (Jamie, 2026-10-08: "keep them in the database as separate
  things" but "treated as one day's release notes"). Read a day with
  `Store.dayNotes` and join it with `notes.combine`. Sort by
  `notes.writtenAt`, never by key. A day with any note counts once for
  the streak.
- **Notes written on the web** are `NOTE#<day>#w-<id>` with `source=web`,
  for today or any day back to the birthday. Every note, emailed or not,
  can be edited (`updated_at`) or deleted by its owner. Deleting an emailed
  note deletes its message and files too (old versions expire 30 days
  later).
- **Any kind of data can come from any channel** (Jamie, 2026-10-09:
  "assume any type of data we deal with can come from any channel"). Email,
  the web, an import: none is the only way in for text, photos, recordings
  or anything else. Where a channel does not carry something yet, that is
  work not done, never a rule.
- **A note is the same record from every channel** (`packages/domain/notes.ts` lists its
  fields). Its `place` shows by name, never the coordinates, the name
  linking to Apple Maps unless the place is only the subscriber's city
  (`notes.mapUrl`, Jamie 2026-10-09).
- **Where a note was** (Jamie, 2026-10-12): chosen on the web (the
  optional "Where" on the Today and Day forms, from the city search), or
  else its first photo's, read from the JPEG's EXIF GPS (`packages/backend/exif.ts`) and
  named once, at city or locality level, by Amazon Location (`packages/backend/places.ts`),
  which is told the coordinates alone. By email only a reply's photos give
  a place; there is no text convention. A day can have its own place with
  no note (`PLACE#<day>`), and it comes before any note's. A past day's
  weather follows the day's place; days with none keep the subscriber's
  city, and the morning forecast is always the subscriber's city
  (`packages/backend/weather.ts`). The original photo is never changed. Coordinates and
  place names are never logged.
- **Raw mail is the source of truth.** Every filed reply stays whole in S3
  (`raw/`, tagged `outcome=note`, kept indefinitely); never expire those.
  Ignored mail is tagged `outcome=ignored` and expires in 30 days.
- **Automatic replies are not notes** (Auto-Submitted, X-Autoreply,
  Precedence bulk and the rest, `workers/inbound.ts`), and nor is mail with more
  than one From. A note is at most 20,000 characters (`notes.MAX_NOTE`),
  emailed or typed.
- **Tags are hashtags** in the text (Jamie, 2026-10-09: "hashtags",
  lowercase with hyphens, "maine-2016"; `packages/domain/tags.ts`). The text is the one
  place a tag lives. `/search/` lists every tag and `/tag/?t=<tag>` shows
  a tag's days. No index: one person's notes are read whole.
- **Search** (Jamie, 2026-10-09: "pull posts by tag, showing all tags
  that have been used, as well as search by string across notes"):
  `POST /api/search {q}` finds notes with every word or "quoted phrase" in
  their text, place, link names, transcripts and photo descriptions,
  without case or accents, newest 100 days shown. The words go in a POST
  body and the page's `#q=`, never a URL a server sees, and are never
  logged.
- **Links show by name, never raw, and there is no Markdown** (Jamie,
  2026-10-08). A title is fetched once, when the note is written, never
  when it is shown, through the guarded fetch in `packages/backend/links.ts` (the address is
  whatever someone typed: keep every guard). `links.segments` is the one
  rendering for the email, the web and the Markdown export.

### Files and processing

- **Photos, recordings and PDFs** (Jamie, 2026-10-08 and 2026-10-09) are
  kept with their note, whatever channel brought them (`packages/backend/media.ts`: keys,
  limits, uploads). They are shown only to their owner, by signed links,
  never a public URL; the S3 key is never a field of an API answer.
- **No model processing of notes** (summaries, prompts, anything) without
  an explicit opt-in from each subscriber. Jamie, as the operator, can read
  every note. Any privacy copy must say so plainly.
- **Transcripts** (Jamie, 2026-10-09: "speech to text on audio notes",
  Amazon Transcribe) are off until the subscriber ticks "Write out what I
  say" (`transcribe` on the profile); at most 30 jobs a subscriber a day.
  The account has no AI services opt-out (Jamie, 2026-10-09: "I don't care
  if they keep it"). `packages/backend/transcribe.ts` has the rest.
- **Photo descriptions** (Jamie, 2026-10-09: "image descriptions to allow
  images to appear in search", Claude Haiku 5.5 through the Anthropic API)
  are off until the subscriber ticks "Describe my photos" (`describe` on
  the profile). The API key is `api_key` in the secret
  `yvn-release-notes-anthropic`, made by hand outside the stack. Jamie
  keeps its value; agents never read it. `packages/backend/describe.ts` has the rest.
- **Thumbnails** (Jamie, 2026-10-12: photos in the email) are made for
  every photo, opted in or not, once, when it is filed: about 640px, a
  JPEG under 80 KB, beside the original, with no EXIF or GPS. The email
  reads only these, never an original. The same read records a JPEG's
  `taken_at` and spot on its media entry. `packages/backend/thumbs.ts` has the rest.
- **Day One imports are planned before anything is written** (Jamie,
  2026-10-09: "keep it to dry-run"). `node --import tsx tools/import-dayone.ts EMAIL
  ZIP...` prints what an import would do, as counts (`--plan-out` to a
  folder outside the repo for the full plan, note text included;
  `--weather-sample N` to check the weather archive for N days). `--write`
  imports (`packages/backend/importer.ts`), through the Node AWS SDK; **every live run
  needs Jamie's go**. A repeat skips what was imported before, deleted
  since or not (the `IMPORT#` ledger). The export is read as untrusted
  (`packages/backend/dayone.ts`). `node --import tsx tools/dev-server.ts --dayone ZIP` runs the same
  importer into the fakes first.
- **Imported days count** toward streaks and every lifetime count (Jamie,
  2026-10-09). The dashboard splits notes into email, web and imported.

### Subscribers and accounts

- **Sign-up is on the web.** The front page asks for the birthday first
  (Jamie, 2026-10-08, option A on the sign-up design canvas,
  https://claude.ai/artifact/KzZxD1K7N9N6Rvq9SBhyxd), then the email;
  nothing is written before sign-in. "Sign in" (`/#sign-in`) is the email
  alone; links meant for signed-out subscribers go there, not to `/`.
- **The first email goes at sign-up** (Jamie, 2026-10-08): today's, at
  once, through the sender's `send_now`, with one welcome line; the
  schedule starts the next day.
- **Sessions last 14 days from the last visit** and every visit renews
  them, with no outer limit (Jamie, 2026-10-08). `packages/backend/sessions.ts` has the detail.
- **A subscriber is `active` or `stopped`.** Stopped means no email, with
  `stopped_reason`: `unsubscribed` (the email's one-click
  `List-Unsubscribe`, or the page it opens), `bounce` (a hard bounce) or
  `complaint`. Nothing is deleted; the person starts the emails again in
  settings, which for a bounce or complaint also takes the address off
  SES's account suppression list (`Mail.unsuppress`), or SES would drop
  every email to it.
- **Pauses** are dated (`PAUSE#<from>`, at most 60 days) and end on their
  own; stopping does not. Paused days neither break a streak nor add to it.
- **Deleting an account deletes it**, after a code mailed to the address:
  raw emails, files, any zip export, tokens and the standing address, every `USER#` item, the session
  in every browser, the address's newest codes, the address and the
  profile. Nothing is kept; the export is offered first. Old versions of
  deleted files expire 30 days later, as backups. A deletion code only
  deletes and a sign-in code only signs in (`packages/backend/auth.ts`).
- **The export is a zip** (Jamie, 2026-10-08): the Markdown and JSON plus
  every file (`workers/export.ts`). The words alone come straight from
  `/api/export`.
- **Times:** each subscriber has an IANA `tz` and a `send_time` on a quarter
  hour (default 06:00, Jamie 2026-10-07: the email opens the day and replies
  come in through it). The day and the version are computed in their zone.

### Upcoming

- **Personal dates** (2026-10-13): `/upcoming/` stores private birthdays,
  anniversaries, trips and one-time events, managed by the owner in their
  email-verified session. `packages/domain/upcoming.ts`,
  `packages/backend/upcoming.ts` and `docs/WEB-APP.md` define recurrence,
  reminder timing and API fields. They are saved plans, never journal entries,
  and do not affect streaks, counts or note search. Known birth years use the
  existing version arithmetic; February 29 rolls to March 1 in non-leap years.
- **Reminders** travel only in the existing daily email, at selected offsets,
  at most three due entries with a link to all. A failed read never holds the
  daily send. No catch-up, extra messages, tracking or model-generated prompts.
- **Trips** retain inclusive start/end dates and a city destination. Automatic
  time-zone/location switching is deferred; saved home, forecasts and note
  places keep their existing behavior. Past events remain in Upcoming history.
- Entries live under `USER#` as `UPCOMING#<id>`, with atomic revision/capacity
  checks and the current session/account proof on writes. Include them in all
  owner exports and account deletion; never log titles, dates or destinations.
  Existing MCP scopes and tools do not read or write Upcoming.
- **Grouping dates** (2026-10-14): one optional tag per entry, such as `#sps`,
  normalized like note hashtags. Kind and Tag filters combine on Upcoming,
  including past events. A tagged entry can start today's editable note draft
  with its hashtag, preserving existing text; it never creates a note on its own.
  Upcoming tags remain separate from journal tags until written in a saved note.

### The email

- **Product updates** (2026-10-13): the configured administrator writes and
  schedules text at `/admin/`, reached from settings. `AdminUserId` defaults
  empty and is configured privately, never committed. Assign it through
  `./deploy.sh --native-http-phase=publish --admin-user-id=ID`
  (an explicit empty id disables access), followed by ordinary HTTP activation.
  It identifies an existing email-verified subscriber; no admin privilege can
  be self-assigned by the web.
  `packages/backend/product-updates.ts` and `docs/WEB-APP.md` define the contract.
  One saved update per local email date appears near the top as "Release Notes
  about Release Notes". Scheduling is explicit, separate from saving a draft;
  cancellation cannot retract sent emails. No extra sends or catch-up, and these
  updates are never personal notes. A read failure never holds the daily email.

- **Plain text plus HTML** (`packages/mail/compose.ts`). The HTML is type on paper in the
  site's colours: no borders, boxes, shadows or filled panels (Jamie,
  2026-10-07: "obsessed with borders and boxes"), and it loads **nothing
  remote**. `tests-node/mail/` holds both lines. Preview by writing
  `htmlBody()` to a file and screenshotting it; for phone width use a
  390px iframe in a wider window, since headless Chrome will not lay out
  below ~500px.
- **The number stands alone.** No decades/years/days breakdown under it
  (Jamie, 2026-10-07: "super redundant"). Below it: 24 text dots for how
  far through the year, the ask, then the streak.
- **Streaks** (`packages/domain/streak.ts`) count days in a row with a note, up to
  yesterday, from the NOTE keys alone. A late note mends its day (Jamie:
  "we don't need to be obsessive"). A missed day resets the count quietly
  and the email shows the longest instead; never call a break out. If the
  streak cannot be read, the email goes without it. The design canvas:
  https://claude.ai/artifact/C9AZwHtrMBVzyRZrrrZSKm
- **Lifetime counts** (Jamie, 2026-10-09: "a good reminder of creating
  value"): one quiet line under the streak. Every note counts, imported
  ones too.
- **Yesterday** (Jamie, 2026-10-12: the email confirms everything sent the
  day before came through): under the streak, the subscriber's own
  yesterday as the day reads on the web, cut at a sentence, with its files
  as one short line. A day with no notes has no block (a missed day is never
  called out). It costs two small reads (the day's notes and its own
  place), only when the note index says yesterday has notes. `packages/mail/compose.ts`
  has the layout.
- **Photos in the email** (Jamie, 2026-10-12) travel inside the message
  as inline parts (`multipart/related`, `cid:`), never a link to the
  bucket: the thumbnails only, at most 4 a day block, 6 an email and about
  400 KB, Yesterday first; the rest stay "See N photos". The alt text is
  the photo's description only for a subscriber who turned descriptions
  on. Any failure sends the email without photos.
- **On this day** (Jamie, 2026-10-09, option A of the design session):
  the notes from the same patch number in every
  earlier release, by version, not calendar, with their tags (Jamie:
  "just have the tags on the posts"). It replaced "A year ago"
  (2026-10-08). `packages/mail/compose.ts` has the layout.
- **Weather** (Jamie, 2026-10-08: "Record + today's forecast"): each day's
  weather kept with the city it is for, and one forecast line in the
  email (`packages/backend/weather.ts`). Open-Meteo is CC BY 4.0: credit it wherever
  weather shows. A failure is no weather, never a held email or a failed
  note.
- **The ask** is the same every day and says photos and voice memos work
  too. No rotating prompts or nudges for now (Jamie, 2026-10-07: "keep it
  simple").

### Privacy and security

- **No note text or email addresses in logs.** Log user ids, dates and
  outcomes only.
- **No open or click tracking**, in line with Jamie's email tracking policy.
- **The web app counts pages in Tinylytics** (site 3816, Jamie 2026-10-08)
  from `web/src/lib/pagecount.ts`, not the embed script: never a query
  string (sign-in and unsubscribe tokens live there), no cookies, nothing
  that names a person. No other analytics.
- **The CSP is `'self'`**: no inline script or style, nothing remote,
  anything another service answers goes through `/api`. Its few named
  exceptions are in `docs/WEB-APP.md` (Front end); add one only when
  there is no way through `/api`.
- **The API answers only CloudFront.** Each Lambda Web Function endpoint uses
  IAM authentication. CloudFront OAC signs every origin request with SigV4
  (`SigningBehavior=always`, `SigningProtocol=amz-auth`); its policy permits
  only this distribution to invoke the live endpoint. Direct origin access
  is denied by the platform. The rollback endpoint has no distribution grant
  and zero request allowance. This replaces the generated origin-secret
  header. `CloudFront-Viewer-Address` is trusted only behind that boundary;
  client `Origin` is still checked before every cookie-authenticated write.
- **SES events never reach the ops queue as is**: they carry the address,
  the subject (a sign-in code) and the reply token. `workers/events.ts` sends the
  alarms topic one scrubbed line.
- **Counts, not people** (`TALLY#<YYYY-MM>`): sign-ups, unsubscribes,
  restarts, bounces, complaints and deletes, one number each a month
  (`tools/tally.ts`). Never per person. A stopped subscriber gets
  nothing from the product, so the unsubscribe count is the one to watch
  (Jamie, 2026-10-08).
- **The operations dashboard is CloudWatch, not the web app** (Jamie,
  2026-10-09: "instead of part of the application ... an AWS dashboard"):
  dashboard `yvn-release-notes`, counts only, no address, user id or note
  text. A new number goes in `packages/backend/census.ts`; `tests-node/census.test.ts` checks the
  dashboard's JSON. Jamie's 2026-10-13 addition permits a metadata-only
  subscriber overview at `/admin-users/`, for the configured administrator:
  addresses, delivery state/schedule and entry counts/activity dates, never
  journal contents. `packages/backend/subscriber-overview.ts` defines its
  projection and DTO. `tools/subscribers.ts` remains the local CLI report.
  Agent captures are counted separately as `AgentNotes`; structured MCP
  infrastructure failures emit a count-only `McpFailures` metric.

### Testing

`docs/NATIVE-COMPATIBILITY.md` maps the retired Python test inventory to
named native regressions and explicit obsolete implementation assumptions.

- **Never verify with a write against live data.** The sender takes
  `{"dry_run": true, "now": "<ISO UTC>"}` and writes nothing; `now` is
  refused on a real send. Never sign in on live to check something.
- Tests never fetch real services: inject fake title/weather/place fetchers,
  mail, objects, store and invocation services into the HTTP app and workers.
  The native harness and all fixtures use fictional subscribers only.

## Landing changes

- **Work reaches `main` only through a pull request** (2026-10-07, the same
  model as the clash-royale repos): a branch, `gh pr create --fill`,
  `gh pr merge --auto --rebase --delete-branch`. GitHub merges it once the
  `validate` check is green on a branch up to date with main. The `main`
  ruleset requires that check, rebase merges and linear history, with 0
  approvals and no bypass, Jamie's account included (agents push as it).
- `validate` (`.github/workflows/validate.yml`) runs the
  workflow lint, pinned cfn-lint and `npm run verify`. Workflows stay
  SHA-pinned with `permissions: {}`, per-job grants and
  `persist-credentials: false`; `sh scripts/test-workflows.sh` checks that.
- Dependabot opens two grouped PRs a month, one for the action pins and one
  for the application's npm packages, each reviewed like any other: they do not
  auto-merge, because a merged action runs with the repository's token and
  a package runs in the build. It skips `@types/node` majors, which move
  with Node. cfn-lint is pinned too (`pipx run --spec cfn-lint==<version>`),
  which Dependabot cannot see: bump it by hand to PyPI's latest, after a
  local run, when the template needs a newer one.
- `tests-node/docs/inventory.test.ts` checks the documented API routes,
  frontend Pages, MCP tools, operator coverage, table key prefixes and native
  verification configuration against the implementation.
  Update the docs in the same PR as a changed public contract. Table key
  layouts belong in `packages/backend/store.ts`'s design comment.
- The repository is public. Never commit subscriber data, note text, DNS
  values or anything from the live table or bucket, including in tests and
  fixtures (the tests use a fictional subscriber at example.com).

## Operating

- Deploy: `./deploy.sh` (cloud-engineer profile, us-east-1), from a clean
  checkout of `origin/main` with a green `validate` run by GitHub Actions;
  it refuses anything else. `--break-glass` is for GitHub being down, never
  a red check: it skips only the fetch and the check lookup, so HEAD must
  still be a clean checkout of `origin/main` as last fetched. It runs the
  tests again first, and builds the web app from a `git archive` of HEAD,
  so nothing git ignores goes in; a failed build stops the deploy. Its
  comments have the rest (the code bucket, cache lifetimes, the
  invalidation).
- Native publication and activation are separate: `./deploy.sh
  --native-http-phase=publish`, then `--native-http-phase=activate`;
  `--native-worker-phase=publish`, then `--native-worker-phase=activate`.
  Use `--native-http-phase=rollback` or `--native-worker-phase=rollback`
  to restore the recorded prior routing/versions. Ordinary deploys preserve
  current native artifact versions and live pins. A full-shell private lock,
  exact source/build identity, immutable per-build receipts and fresh metadata
  checks protect retries; an uncertain CloudFormation update must finish
  before another phase runs. Candidate worker probes use only
  `{"self_test":true}` on published immutable versions, never subscriber data.
  Never remove origin policies before restoring legacy routing during a
  retained-runtime recovery. Receipts stay mode 600 in a private directory
  outside the public repository; never commit their cloud identifiers.
- **Node 24** everywhere (`.node-version`, both workflows; `engines` says
  24 or later). This Mac's default `node` is newer, so put Homebrew's
  `/opt/homebrew/opt/node@24/bin` first on PATH for npm here; `deploy.sh`
  does that itself and refuses any other major. Moving to a new major
  changes all of those together, with `@types/node`.
- Tests and builds: `npm ci --ignore-scripts`, then `npm run verify`
  (format, lint, browser/native types and unit tests, both builds).
  `npm run test:server` runs Node's native test suite alone. Pinned
  `pipx run --spec cfn-lint==1.57.2 cfn-lint infra/template.yaml` checks
  CloudFormation; Python is a dependency of this infrastructure linter,
  not an application runtime.
- Locally: `npm run build`, then `node --import tsx tools/dev-server.ts
  --fake-places --fake-links`. It serves `dist/web` and the real Hono HTTP/MCP
  API against in-memory fakes, captures mail at `/dev-mail/`, and starts with
  fictional ada@example.com. Fake places/weather and link titles prevent
  external fetches. `--dayone ZIP` imports into those fakes first. For hot
  reload, start it with `--port 8790`, then `npm run dev` (Vite on 5173,
  forwarding `/api` and development routes). `/dev-runtime/` identifies the
  native Node harness; Playwright starts its own, never reusing another server.
- Browser tests (optional, Jamie 2026-10-08: quick deploys for most
  changes, the browser run when wanted): `e2e/` drives sign-up in Chromium
  against the dev server, reading sign-in codes and links from its
  `/dev-mail/`. Locally: `npx playwright install chromium` once, then
  `npm run e2e` (it builds first). On GitHub: the `e2e` workflow, from the
  Actions tab or by labelling a PR `e2e`. Not a required check, and
  `deploy.sh` does not wait for it; run it for any change under `web/`
  that a page shows. The expected number comes from `/api/sample`, never a
  fixed string. The dev server's sign-in limits still apply (20 emails an
  hour from one network), so `--repeat-each` past about 4 trips them.
- Send someone today's email now, outside their window: invoke the sender
  with `{"send_now": "<user id>"}` (add `"dry_run": true` first to see it).
  Still once per local day; never fake the clock with `now` to do it.
- Subscribers sign up on the web; there is no way to add one by hand
  (the hand-added subscriber shortcut was retired 2026-10-09: it skipped
  the city, the tally and the first email).
- `node --import tsx tools/read-notes.ts EMAIL [YYYY-MM-DD]` prints someone's release
  notes, from before the web app had a reader. It prints note text, so run
  it only for the subscriber's own notes; agents do not run it to check
  things.
- The fill-in scripts for notes from before a feature
  (`tools/extract-media.ts`, `tools/fill-link-titles.ts`, `tools/fill-weather.ts`)
  take `EMAIL [--dry-run]` and default to planning only. Run the dry run
  first; use `--write` only for an approved live run.
- Thumbnails for photos kept before they existed: invoke the describe
  function with `{"thumbs_all": "*", "dry_run": true}` (or one user id)
  to count them; the real run (no `dry_run`) needs Jamie's go. It hands
  itself on near its time limit and skips any photo that has one.
- One row per subscriber (address, state, sign-up day, send time, last
  email, last note, notes, 30-day reply rate): `node --import tsx tools/subscribers.ts`.
  Reads keys and a few fields, never note text. It prints addresses, so
  its output stays on this Mac. The monthly counts: `node --import tsx tools/tally.ts`.
  Both read only.
- Alarms go to SNS `yvn-release-notes-alarms`, which is subscribed to the
  sysadmin `projects-ops-alerts` queue. The queue's policy must list the
  topic.
- SQS `yvn-release-notes-failed` holds what gave up after its retries: a
  bounce or complaint the events function could not apply (the SNS
  message, address included, so it never goes to the ops queue) and a
  transcribe or describe stream batch (shard and sequence numbers only).
  Kept 14 days; alarm `yvn-release-notes-failed-queue` fires on anything in
  it. Apply a stuck bounce by hand, then delete the message.
- The describe, transcribe and export functions each run at most two at
  once (reserved concurrency 2, 2026-10-09 audit). Throttled stream batches
  wait and are tried again without using up their retries, and throttled
  async events are tried for up to six hours, so a busy moment is slower,
  not lost.
- The dashboard: stack output `DashboardUrl`. Alarm
  `yvn-release-notes-overdue` fires when anyone's email is over half an
  hour late for two quarter hours (census `Overdue`); a send time moved
  past today's window also trips it, for that day.
- Alarm `yvn-release-notes-signin-total` fires when the hour's sign-in
  emails for everyone (200, `LIMIT_TOTAL` in `packages/backend/auth.ts`) are used up, counted from
  the web function's `{"event":"mail-limited","limit":"total"}` log line
  (renaming it silently breaks the alarm): nobody can
  sign in until the hour turns. The narrower limits are checked first and
  a refused request counts against none, so reaching the total takes many
  networks.
- DNS for `yourversionnumber.com` is at Namecheap; Jamie applies records by
  hand. The stack needs: the three DKIM CNAMEs (stack outputs
  `DkimRecord1-3`), an MX on the inbound subdomain to SES inbound, and an
  MX plus SPF on the MAIL FROM subdomain. DMARC is Jamie's own record. All
  were live on 2026-10-07. Read current values from DNS or the stack, not
  from this repo.
- The root domain's mail is Jamie's Fastmail (MX, SPF and
  `fm1-3._domainkey`, 2026-10-08): notes@, postmaster@ and abuse@ reach
  Jamie. It is separate from the stack's records; the root SPF stays
  Fastmail-only, since SES mail's SPF is checked on the MAIL FROM
  subdomain. In Namecheap, Mail Settings stays "Custom MX"; any other
  choice rewrites the MX records, `in.` included.
- The web app adds two records: the ACM validation CNAME for
  `notes.yourversionnumber.com` and `notes` CNAME to the stack output
  `WebDistributionDomain`. The certificate lives outside the stack (an
  in-stack one would hold every deploy until DNS validated); `deploy.sh`
  finds it once ACM says ISSUED and only then attaches the alias.

## Phases

1. **Jamie only, text only** (done 2026-10-07): sender, inbound, storage,
   subscribers added by hand.
2. **The web app** (`docs/WEB-APP.md`, done 2026-10-08): sign-up and sign-in
   by email link or code, export, notes for today and past days, pause,
   settings (the send time included), `List-Unsubscribe`, bounces stop a
   subscriber.
3. **Around it** (started 2026-10-08). Built: photos and audio from
   replies; the export as a zip with the files; weather from the
   subscriber's city (Open-Meteo, no key, CC BY 4.0), each day's actual
   weather recorded with its city plus one forecast line in the morning
   email (Jamie, 2026-10-08); "On this day" and lifetime counts; tags and
   search; files and recordings on the web; opt-in transcripts and photo
   descriptions; the Day One import; the CloudWatch dashboard; the React
   app and Home Screen app (2026-10-09). Not yet: a yearly "release notes
   for 5.2" collection on the birthday.

## Agent connections (2026-10-12)

MCP reading is approved explicitly by each subscriber in their existing
email-verified web session. `notes:read` shares the archive and existing
transcripts/descriptions; optional `media:read` shares private file bytes
and ten-minute links. This consent permits an external agent to process
what it reads; it never turns on the product's transcription or description
settings. Optional `notes:write` is separately approved, off by default,
and existing grants stay read-only. It permits text-only `notes_create`
and `notes_append`, at the user's explicit request. Hashtags stay in the
text. All captures show author/client provenance on the web, in emails
and in both exports, and the owner can edit
or delete them through the web as usual. An append belongs to the exact
connection that created the note, never to a name supplied by a client.
No MCP token can authenticate a web write. The MCP function's
separate role cannot write USER or OAuth rows, send mail, invoke models,
upload/delete files. Its table writes are MCPMETA only; its one invocation
permission is the private capture function. That writer rechecks the bearer
and conditionally commits the note, live family/profile proof, 24-hour
idempotency receipt, daily quota (20 creates, 50 appends per account) and
content-free audit together. It cannot delete data, write OAuth rows, use
SES, S3 or models, or invoke functions. Receipts live under USER and are
deleted with the account; their original result may include note text,
never logged. Reusing a key with changed arguments is refused. In Settings,
turning off adding removes the write scope while keeping read access.
Activity records contain no arguments or returned content. Disconnect
revokes the family immediately; already shared content and unexpired
private links remain with the receiving service. Deleting an account
blocks new MCP metadata/OAuth writes first and removes all indexed grants.
Never test a connection by reading or writing live subscriber notes or signing in
against production. Use the dev server and fakes. Regenerate the contract
with `node --import tsx tools/export-mcp-contract.ts` when tools change.
