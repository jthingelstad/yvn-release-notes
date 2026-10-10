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
The design detail lives with the code: each module's docstring (named
below), `src/release_notes/store.py` for the table's key layout, and
`docs/WEB-APP.md` for the web app, its API and its front end. Read those
before changing a module.

## Who can write

Every write proves the writer owns the subscriber's address:

- **By email**: through a reply address that names the person and day with
  120 random bits, within 72 hours of that email going out, from the
  subscriber's own address (the message's one From), with a DMARC pass or,
  where the domain publishes no DMARC policy, an aligned DKIM pass
  (`inbound.py`).
- **On the web**: inside a session that began with a link or code sent to
  that address (`auth.py`).

Each subscriber's data is their own. Do not add an endpoint that writes
without one of those two proofs.

## Shape

```
SES inbound (in.yourversionnumber.com MX)
  -> S3 raw/<messageId>                 the message, untouched
  -> Lambda yvn-release-notes-inbound  token -> person + day, auth checks, text -> DynamoDB

EventBridge, every quarter hour
  -> Lambda yvn-release-notes-sender   anyone whose local send time has come -> one email

SES delivery events, on their own topic (yvn-release-notes-mail-events)
  -> Lambda yvn-release-notes-events   hard bounce or complaint -> that subscriber stopped;
                                         one scrubbed line (kinds, user ids) -> the alarms topic

notes.yourversionnumber.com (CloudFront)
  default -> S3 web bucket              web/: the React app, built by Vite (dist/web)
  /api/*  -> HTTP API -> Lambda yvn-release-notes-web
                            -> Lambda yvn-release-notes-export   (async) the zip export -> S3 exports/

DynamoDB stream (for subscribers who turn them on)
  -> Lambda yvn-release-notes-transcribe  recordings -> Amazon Transcribe -> transcript on the note
  -> Lambda yvn-release-notes-describe    photos -> Claude Haiku 5.5 -> description on the note
```

Where things are (each module's docstring is its design):

- Mail: `send.py` (the sender), `compose.py` (the email), `inbound.py`
  (replies), `parse.py` (MIME to note text, quote and signature stripping),
  `events.py` (bounces and complaints).
- Notes: `notes.py` (the record, the same from every channel), `tags.py`,
  `links.py` (link titles and the guarded fetch), `media.py` (photos,
  recordings and PDFs, by email and on the web), `streak.py`, `weather.py`,
  `places.py` (city search).
- The web: `web.py` (the API, a small router), `auth.py` (sign-in,
  sessions, limits), `export.py` (JSON and Markdown), `export_job.py` (the
  zip). `web/` is the React app (`docs/WEB-APP.md`, Front end); its Home
  Screen icons are drawn by `scripts/make_icons.mjs`.
- Opt-in processing: `transcribe.py`, `describe.py`.
- Imports: `dayone.py` (plans), `importer.py` (writes).
- `store.py`: the one table. `census.py`: the dashboard's counts.
- `version.py`: the version arithmetic, ported from the site's
  `computeVersion`. `tests/fixtures/versions.json` is generated from the
  site's own function by `scripts/gen-version-fixtures.mjs` (needs the
  sibling checkout). If the site's arithmetic changes, regenerate and
  re-test.
- `infra/template.yaml`: the whole stack. `deploy.sh` checks it is
  deploying a green `origin/main`, runs the tests, builds the web app,
  packages and deploys the stack, makes its receipt rule set the active one
  (only if no other set is active), then syncs the web app.

**Standard library only** for the Python. No `requirements.txt`; `boto3`
comes from the Lambda runtime and is imported lazily so the tests run
without it. Python stays the language for the web API too (decided
2026-10-08): one language, one copy of the version arithmetic, nothing to
install. The front end is React and TypeScript (decided 2026-10-09).

`tests/fakes.py` is an in-memory table, SES, S3 and Lambda for the web
tests, also used by `scripts/dev_server.py`. The fakes do not check
DynamoDB's request shapes, so a new kind of table call also gets a test of
the exact request (`tests/test_store.py`). `table.meta.client` takes plain
Python values like the table does; typed values are typed twice (sign-up
failed on live until 2026-10-08 because of it).

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
  `inbound.py` has the detail.
- **Reply as often as you like.** Each reply is its own note
  (`NOTE#<day>#<messageId>`); together, oldest first, they are that day's
  release notes (Jamie, 2026-10-08: "keep them in the database as separate
  things" but "treated as one day's release notes"). Read a day with
  `Store.day_notes` and join it with `notes.combine`. Sort by
  `notes.written_at`, never by key. A day with any note counts once for
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
- **A note is the same record from every channel** (`notes.py` lists its
  fields). Its `place` shows by name, never the coordinates, the name
  linking to Apple Maps unless the place is only the subscriber's city
  (`notes.map_url`, Jamie 2026-10-09).
- **Raw mail is the source of truth.** Every filed reply stays whole in S3
  (`raw/`, tagged `outcome=note`, kept indefinitely); never expire those.
  Ignored mail is tagged `outcome=ignored` and expires in 30 days.
- **Automatic replies are not notes** (Auto-Submitted, X-Autoreply,
  Precedence bulk and the rest, `inbound.py`), and nor is mail with more
  than one From. A note is at most 20,000 characters (`notes.MAX_NOTE`),
  emailed or typed.
- **Tags are hashtags** in the text (Jamie, 2026-10-09: "hashtags",
  lowercase with hyphens, "maine-2016"; `tags.py`). The text is the one
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
  when it is shown, through the guarded fetch in `links.py` (the address is
  whatever someone typed: keep every guard). `links.segments` is the one
  rendering for the email, the web and the Markdown export.

### Files and processing

- **Photos, recordings and PDFs** (Jamie, 2026-10-08 and 2026-10-09) are
  kept with their note, whatever channel brought them (`media.py`: keys,
  limits, uploads). They are shown only to their owner, by signed links,
  never a public URL; the S3 key is never a field of an API answer.
- **No model processing of notes** (summaries, prompts, anything) without
  an explicit opt-in from each subscriber. Jamie, as the operator, can read
  every note. Any privacy copy must say so plainly.
- **Transcripts** (Jamie, 2026-10-09: "speech to text on audio notes",
  Amazon Transcribe) are off until the subscriber ticks "Write out what I
  say" (`transcribe` on the profile); at most 30 jobs a subscriber a day.
  The account has no AI services opt-out (Jamie, 2026-10-09: "I don't care
  if they keep it"). `transcribe.py` has the rest.
- **Photo descriptions** (Jamie, 2026-10-09: "image descriptions to allow
  images to appear in search", Claude Haiku 5.5 through the Anthropic API)
  are off until the subscriber ticks "Describe my photos" (`describe` on
  the profile). The API key is `api_key` in the secret
  `yvn-release-notes-anthropic`, made by hand outside the stack. Jamie
  keeps its value; agents never read it. `describe.py` has the rest.
- **Day One imports are planned before anything is written** (Jamie,
  2026-10-09: "keep it to dry-run"). `scripts/import_dayone.py EMAIL
  ZIP...` prints what an import would do, as counts (`--plan-out` to a
  folder outside the repo for the full plan, note text included;
  `--weather-sample N` to check the weather archive for N days). `--write`
  imports (`importer.py`), using boto3 from a virtualenv; **every live run
  needs Jamie's go**. A repeat skips what was imported before, deleted
  since or not (the `IMPORT#` ledger). The export is read as untrusted
  (`dayone.py`). `scripts/dev_server.py --dayone ZIP` runs the same
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
  them, with no outer limit (Jamie, 2026-10-08). `auth.py` has the detail.
- **A subscriber is `active` or `stopped`.** Stopped means no email, with
  `stopped_reason`: `unsubscribed` (the email's one-click
  `List-Unsubscribe`, or the page it opens), `bounce` (a hard bounce) or
  `complaint`. Nothing is deleted; the person starts the emails again in
  settings, which for a bounce or complaint also takes the address off
  SES's account suppression list (`web.unsuppress`), or SES would drop
  every email to it.
- **Pauses** are dated (`PAUSE#<from>`, at most 60 days) and end on their
  own; stopping does not. Paused days neither break a streak nor add to it.
- **Deleting an account deletes it**, after a code mailed to the address:
  raw emails, files, any zip export, tokens, every `USER#` item, the session
  in every browser, the address's newest codes, the address and the
  profile. Nothing is kept; the export is offered first. Old versions of
  deleted files expire 30 days later, as backups. A deletion code only
  deletes and a sign-in code only signs in (`auth.py`).
- **The export is a zip** (Jamie, 2026-10-08): the Markdown and JSON plus
  every file (`export_job.py`). The words alone come straight from
  `/api/export`.
- **Times:** each subscriber has an IANA `tz` and a `send_time` on a quarter
  hour (default 06:00, Jamie 2026-10-07: the email opens the day and replies
  come in through it). The day and the version are computed in their zone.

### The email

- **Plain text plus HTML** (`compose.py`). The HTML is type on paper in the
  site's colours: no borders, boxes, shadows or filled panels (Jamie,
  2026-10-07: "obsessed with borders and boxes"), and it loads **nothing
  remote**. `tests/test_compose.py` holds both lines. Preview by writing
  `html_body()` to a file and screenshotting it; for phone width use a
  390px iframe in a wider window, since headless Chrome will not lay out
  below ~500px.
- **The number stands alone.** No decades/years/days breakdown under it
  (Jamie, 2026-10-07: "super redundant"). Below it: 24 text dots for how
  far through the year, the ask, then the streak.
- **Streaks** (`streak.py`) count days in a row with a note, up to
  yesterday, from the NOTE keys alone. A late note mends its day (Jamie:
  "we don't need to be obsessive"). A missed day resets the count quietly
  and the email shows the longest instead; never call a break out. If the
  streak cannot be read, the email goes without it. The design canvas:
  https://claude.ai/artifact/C9AZwHtrMBVzyRZrrrZSKm
- **Lifetime counts** (Jamie, 2026-10-09: "a good reminder of creating
  value"): one quiet line under the streak. Every note counts, imported
  ones too.
- **On this day** (Jamie, 2026-10-09, option A of the design session):
  the notes from the same patch number in every
  earlier release, by version, not calendar, with their tags (Jamie:
  "just have the tags on the posts"). It replaced "A year ago"
  (2026-10-08). `compose.py` has the layout.
- **Weather** (Jamie, 2026-10-08: "Record + today's forecast"): each day's
  weather kept with the city it is for, and one forecast line in the
  email (`weather.py`). Open-Meteo is CC BY 4.0: credit it wherever
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
- **The API answers only CloudFront** (2026-10-09, a security review).
  CloudFront adds `X-Origin-Verify` with the stack's generated secret
  `yvn-release-notes-origin` (resolved into the distribution and the web
  function's `ORIGIN_SECRET`; nobody reads it, agents included), and
  `web.handler` answers anything without it with a fixed 403 (`web.py`). That is what makes
  `CloudFront-Viewer-Address` (the sign-in limit per network) and `Origin`
  trustworthy. The web function `DependsOn` the distribution, so a deploy
  that changes the header updates CloudFront first. Never put
  `ORIGIN_SECRET` in an output or a log.
- **SES events never reach the ops queue as is**: they carry the address,
  the subject (a sign-in code) and the reply token. `events.py` sends the
  alarms topic one scrubbed line.
- **Counts, not people** (`TALLY#<YYYY-MM>`): sign-ups, unsubscribes,
  restarts, bounces, complaints and deletes, one number each a month
  (`scripts/tally.py`). Never per person. A stopped subscriber gets
  nothing from the product, so the unsubscribe count is the one to watch
  (Jamie, 2026-10-08).
- **The operations dashboard is CloudWatch, not the web app** (Jamie,
  2026-10-09: "instead of part of the application ... an AWS dashboard"):
  dashboard `yvn-release-notes`, counts only, no address, user id or note
  text. A new number goes in `census.py`; `tests/test_census.py` checks the
  dashboard's JSON. The per-person view is `scripts/subscribers.py`, on
  this Mac only.

### Testing

- **Never verify with a write against live data.** The sender takes
  `{"dry_run": true, "now": "<ISO UTC>"}` and writes nothing; `now` is
  refused on a real send. Never sign in on live to check something.
- Tests never fetch: pass a fake `fetch` to `web.handler` and
  `inbound.process`, `fetch` to the sender and `weather_fetch` to
  `web.handler`.

## Landing changes

- **Work reaches `main` only through a pull request** (2026-10-07, the same
  model as the clash-royale repos): a branch, `gh pr create --fill`,
  `gh pr merge --auto --rebase --delete-branch`. GitHub merges it once the
  `validate` check is green on a branch up to date with main. The `main`
  ruleset requires that check, rebase merges and linear history, with 0
  approvals and no bypass, Jamie's account included (agents push as it).
- `validate` (`.github/workflows/validate.yml`) runs the workflow lint, the
  unit tests, cfn-lint and the web app's `npm run verify`. Workflows stay
  SHA-pinned with `permissions: {}`, per-job grants and
  `persist-credentials: false`; `sh scripts/test-workflows.sh` checks that.
- Dependabot opens two grouped PRs a month, one for the action pins and one
  for the web app's npm packages, each reviewed like any other: they do not
  auto-merge, because a merged action runs with the repository's token and
  a package runs in the build. It skips `@types/node` majors, which move
  with Node. cfn-lint is pinned too (`pipx run --spec cfn-lint==<version>`),
  which Dependabot cannot see: bump it by hand to PyPI's latest, after a
  local run, when the template needs a newer one.
- `tests/test_docs.py` fails when the docs miss something the code has:
  a route in `web.ROUTES` not in `docs/WEB-APP.md`'s API table (or a row
  with no route), a page in `main.tsx` not in its Pages, a key prefix not
  in `store.py`'s docstring, or a module or script this file never names.
  Update the doc in the same PR.
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
- **Node 24** everywhere (`.node-version`, both workflows; `engines` says
  24 or later). This Mac's default `node` is newer, so put Homebrew's
  `/opt/homebrew/opt/node@24/bin` first on PATH for npm here; `deploy.sh`
  does that itself and refuses any other major. Moving to a new major
  changes all of those together, with `@types/node`.
- Tests: `PYTHONPATH=src python3 -m unittest discover -s tests`. The web
  app: `npm ci --ignore-scripts`, then `npm run verify`.
- The web app locally: `npm run build`, then `scripts/dev_server.py`
  serves the built `dist/web` and the real API against in-memory fakes,
  prints sign-in emails instead of sending them, and starts with a
  fictional subscriber, ada@example.com. `--fake-places` answers city
  search and weather without Open-Meteo, and `--fake-links` names every
  link without fetching it. Use it (and this repo's Playwright) to see
  pages. For hot reload, run `scripts/dev_server.py --port 8790` and
  `npm run dev` (Vite on 5173, sending `/api` and the dev routes to it).
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
  (`scripts/add_subscriber.py` was retired 2026-10-09: it skipped the
  city, the tally and the first email).
- `scripts/read_notes.py EMAIL [YYYY-MM-DD]` prints someone's release
  notes, from before the web app had a reader. It prints note text, so run
  it only for the subscriber's own notes; agents do not run it to check
  things.
- The fill-in scripts for notes from before a feature
  (`scripts/extract_media.py`, `fill_link_titles.py`, `fill_weather.py`)
  take `EMAIL [--dry-run]`; run the dry run first.
- One row per subscriber (address, state, sign-up day, send time, last
  email, last note, notes, 30-day reply rate): `scripts/subscribers.py`.
  Reads keys and a few fields, never note text. It prints addresses, so
  its output stays on this Mac. The monthly counts: `scripts/tally.py`.
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
  emails for everyone (200, `auth.LIMIT_TOTAL`) are used up, counted from
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
