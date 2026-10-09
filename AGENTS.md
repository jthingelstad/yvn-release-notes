# Agent guide: yvn-release-notes

**Release Notes** is a daily email from Your Version Number. Each subscriber
gets one email a day whose subject is their version number ("You're 5.2.113
today"). Whatever they reply becomes the release notes for that version.

It is its own repo and stack, separate from `~/Projects/yourversionnumber.com`
(the birthday and work sites). Those sites keep everything in the URL because
that was a fun way to build them, not because of a rule (Jamie, 2026-10-08:
"This is a hobby project. It's just fun."). This product stores data, and it
has a web app at `notes.yourversionnumber.com` (`docs/WEB-APP.md` is the plan).
Leave the sites alone while the web app is built.

## Who can write

Every write proves the writer owns the subscriber's address:

- **By email**: through a reply address that names the person and day with
  120 random bits, from the subscriber's own address, with a DMARC or aligned
  DKIM pass.
- **On the web**: inside a session that began with a link or code sent to
  that address.

Each subscriber's data is their own. Do not add an endpoint that writes
without one of those two proofs.

## Shape

```
SES inbound (in.yourversionnumber.com MX)
  -> S3 raw/<messageId>                 the message, untouched
  -> Lambda yvn-release-notes-inbound  token -> person + day, auth checks, text -> DynamoDB

EventBridge, every quarter hour
  -> Lambda yvn-release-notes-sender   anyone whose local send time has come -> one email

SES delivery events, via the alarms topic (filtered to Bounce, Complaint)
  -> Lambda yvn-release-notes-events   hard bounce or complaint -> that subscriber stopped

notes.yourversionnumber.com (CloudFront)
  default -> S3 web bucket              web/: static HTML, CSS, vanilla JS
  /api/*  -> HTTP API -> Lambda yvn-release-notes-web
                            -> Lambda yvn-release-notes-export   (async) the zip export -> S3 exports/
```

- `src/release_notes/version.py`: the version arithmetic, ported from the site's
  `computeVersion`. `tests/fixtures/versions.json` is generated from the site's
  own function by `scripts/gen-version-fixtures.mjs` (needs the sibling
  checkout). If the site's arithmetic changes, regenerate and re-test.
- `parse.py`: MIME to note text, quote and signature stripping. Standard
  library only. `links.py`: addresses in notes, their saved titles, and the
  guarded fetch. `media.py`: photos and recordings out of a reply.
- `send.py`, `inbound.py`, `events.py`: the mail handlers. `store.py`: the one table and its
  key layout (documented at the top of the file).
- `infra/template.yaml`: the whole stack. `deploy.sh` packages, deploys and
  activates the receipt rule set.

**Standard library only.** No `requirements.txt`; `boto3` comes from the Lambda
runtime and is imported lazily so the tests run without it.

- `web.py`: the web app's API, routed by method and path. `auth.py`: sign-in
  by link and code, sessions, the limits and the sign-in email (its docstring
  is the design). `places.py`: city search through Open-Meteo. `weather.py`: each day's
  weather and the morning forecast, from Open-Meteo (its docstring is the design). `export.py`: everything a subscriber has, as JSON and
  Markdown; `export_job.py` builds the zip with every photo and recording,
  in the background. `web/` is the static site, synced to the web bucket by
  `deploy.sh`: one `assets/app.js` for every page (`<body data-page>`),
  `assets/site.css`, and the two fonts served from here. Pages load only
  their own files (the CSP is `'self'`), so no inline script or style,
  nothing remote; anything another service answers goes through `/api`.
  The exceptions are named in the CSP: Tinylytics (connect) and the mail
  bucket's host for signed photo links (img, media).
- `tests/fakes.py`: an in-memory table, SES, S3 and Lambda for the web tests, also used
  by `scripts/dev_server.py`. The fakes do not check DynamoDB's request
  shapes, so a new kind of table call also gets a test of the exact request
  (`tests/test_store.py`). `table.meta.client` takes plain Python values like
  the table does; typed values are typed twice (sign-up failed on live
  until 2026-10-08 because of it).
- Python stays the language for the web API too (decided 2026-10-08): one
  language, one copy of the version arithmetic, nothing to install.

## Rules

- **A note belongs to the day of the email it answers**, not the day it
  arrived. A Thursday reply to Tuesday's email is Tuesday's note.
- **Reply as often as you like.** Each reply is its own note
  (`NOTE#<day>#<messageId>`); together, oldest first, they are that day's
  release notes (Jamie, 2026-10-08: "keep them in the database as separate
  things" but "treated as one day's release notes"). Read a day with
  `Store.day_notes` and join it with `notes.combine`. Message ids are random,
  so sort by `received_at`, never by key. A day with any note counts once for
  the streak.
- **Raw mail is the source of truth.** Every filed reply stays whole in S3
  (`raw/`, tagged `outcome=note`, kept indefinitely); never expire those.
  Ignored mail is tagged `outcome=ignored` and expires in 30 days.
- **Photos and recordings** (Jamie, 2026-10-08) arrive by email only, never
  uploaded on the web. Inbound copies each one to
  `media/<user>/<day>/<message id>/<n>.<ext>` in the same bucket and lists it
  on the note as `media` (`media.py`); signature logos (longest side under
  200 px) are left out. Video, PDFs and the rest stay in the raw message and
  show as "in the original email". The page asks
  `/api/days/<day>/notes/<id>/media/<n>`, which checks the session and the
  key's owner and redirects to a ten-minute signed link on the bucket's own
  host, the one host the CSP adds (`img-src`, `media-src`). Never a public
  URL, never a key in an API answer. The email's "A year ago" links to the
  day ("See 2 photos") and carries no file. Transcribing a recording is
  model processing: it needs each subscriber's opt-in.
  `scripts/extract_media.py` fills in notes filed before this.
- A subscriber who deletes an emailed note deletes its message and its
  files too (the web function may delete `raw/*` and `media/*`; old
  versions expire 30 days later).
- **Notes written on the web** are `NOTE#<day>#w-<id>` with `source=web`,
  for today or any day back to the birthday. Every note, emailed or not,
  can be edited (`updated_at`) or deleted by its owner.
- **A subscriber is `active` or `stopped`.** Stopped means no email, with
  `stopped_reason`: `unsubscribed` (the email's one-click
  `List-Unsubscribe`, or the page it opens), `bounce` (a hard bounce) or
  `complaint`. Nothing is deleted; the person starts the emails again in
  settings. Pauses are dated (`PAUSE#<from>`, at most 60 days) and end on
  their own; stopping does not. The sender skips a paused day, and paused
  days neither break a streak nor add to it (`streak.py`).
- **Deleting an account deletes it**: raw emails, photos and recordings,
  any zip export, tokens, every `USER#` item, the address and the profile, after a code mailed to the address.
  Nothing is kept; the export is offered first.
- **The export is a zip** (Jamie, 2026-10-08): the Markdown and JSON plus
  every photo and recording under `files/`, the Markdown showing each photo
  by its path in the zip. Settings starts a build (`POST /api/export/zip`);
  the web function invokes `yvn-release-notes-export` without waiting, and
  the page asks every few seconds. One build at a time, and only the newest
  zip is kept (`exports/<user>/<build id>.zip`, offered for a day, expired
  by the bucket after two; a build that finds itself replaced deletes its
  own). The download is a redirect to a five-minute signed link. The words
  alone, Markdown or JSON, still come straight from `/api/export`.
- **No note text or email addresses in logs.** Log user ids, dates and
  outcomes only.
- **No open or click tracking**, consistent with Jamie's email tracking policy.
- **The web app counts pages in Tinylytics** (site 3816, Jamie 2026-10-08),
  from the bottom of `app.js` rather than the embed script, so script-src
  stays `'self'` and only connect-src names `https://tinylytics.app`. Send
  the path only, never a query string (sign-in and unsubscribe tokens live
  there), no cookies, nothing that names a person. No other analytics.
- **The email is plain text plus HTML** (`compose.py`). The HTML is type on
  paper in the site's colours: cobalt digits, tangerine dots, its own dark
  mode. No borders, boxes, shadows or filled panels (Jamie, 2026-10-07:
  "obsessed with borders and boxes"); `tests/test_compose.py` holds the line. It loads
  **nothing remote**: no images, no web fonts, no stylesheets
  (`tests/test_compose.py` enforces it). Preview by writing `html_body()` to a
  file and screenshotting it; for phone width use a 390px iframe in a wider
  window, since headless Chrome will not lay out below ~500px.
- **The number stands alone.** No decades/years/days breakdown under it
  (Jamie, 2026-10-07: "super redundant"). Below it: a row of 24 text dots for
  how far through the year, the ask, then the reply streak.
- **Streaks** (`streak.py`) count days in a row with a note, up to yesterday,
  from the NOTE keys alone (no new storage). A late reply fills its own day in,
  so streaks can be mended (Jamie: "we don't need to be obsessive"). A missed
  day resets the count quietly and the email shows the longest instead; never
  call a break out. If the streak cannot be read, the email goes without it.
  The design canvas: https://claude.ai/artifact/C9AZwHtrMBVzyRZrrrZSKm
- **A year ago** (Jamie, 2026-10-08): the email shows the notes from the
  same patch number one release back (`version.a_year_before`: 5.3.279 for
  5.4.279, by version, not calendar), after the streak, only when there are
  some, cut near 1000 characters with a link to that day.
- **Links show by name, never raw, and there is no Markdown** (Jamie,
  2026-10-08). The note's text keeps every address as written; the note's
  `links` list names them (`links.py`). A phrase the writer linked in their
  mail app keeps their words (`my post <url>` in the plain text, the anchor
  in the HTML). Any other address gets its page's title and site, fetched
  **once, when the note is written** (email, web, or an edit that adds an
  address), never when it is shown. The fetch is guarded because the address
  is whatever someone typed: http(s) on the usual port, no userinfo, every
  resolved address public and the connection pinned to it, at most three
  redirects each checked again, two seconds, 256 KB, HTML only, three
  fetches a note; anything else is just no title. `links.segments` is the
  one rendering for the email (`compose.linked`), the web (`parts` in each
  note, drawn by `noteBody`) and the Markdown export. Tests never fetch:
  pass a fake `fetch` to `web.handler` and `inbound.process`.
  `scripts/fill_link_titles.py` fills in notes written before this.
- **Weather** (Jamie, 2026-10-08: "Record + today's forecast"). Each
  finished day's high, low and conditions are kept as `WEATHER#<day>` with
  the city they are for, so a move never rewrites the past. The sender keeps
  yesterday's and puts one forecast line in the email, from one Open-Meteo
  call; a note written for an earlier day fetches that day's history. Shown
  on day pages, in "A year ago" and in the export, in Fahrenheit for
  places that use it. Open-Meteo is CC BY 4.0: credit it wherever weather
  shows. Weather is a nicety: a failure is no weather, never a held email
  or a failed note. Only the city's rounded coordinates and time zone go to
  Open-Meteo. Tests never fetch: pass `fetch` to the sender and
  `weather_fetch` to `web.handler`. `scripts/fill_weather.py` fills in days
  with notes written before this.
- **The first email goes at sign-up** (Jamie, 2026-10-08): today's, at
  once, through the sender's `send_now`, with one welcome line saying when
  the rest come; the schedule starts the next day. The ask in every email
  says photos and voice memos work too.
- **Sessions last 14 days from the last visit** and every visit renews
  them, with no outer limit (Jamie, 2026-10-08). `auth.py` has the detail.
- **No rotating prompts or nudges** for now (Jamie, 2026-10-07: "keep it
  simple"). The ask is the same every day.
- **No model processing of notes** (summaries, prompts, anything) without an
  explicit opt-in from each subscriber. Jamie, as the operator, can read every
  note. Any privacy copy must say so plainly.
- **Times:** each subscriber has an IANA `tz` and a `send_time` on a quarter
  hour (default 06:00, Jamie 2026-10-07: the email opens the day and replies
  come in through it), picked in settings. The day and the version are
  computed in their zone.
- Never verify with a write against live data. `sender` takes
  `{"dry_run": true, "now": "<ISO UTC>"}` and writes nothing. `now` is
  refused on a real send: stored times are always the real clock.

## Landing changes

- **Work reaches `main` only through a pull request** (2026-10-07, the same
  model as the clash-royale repos): a branch, `gh pr create --fill`,
  `gh pr merge --auto --rebase --delete-branch`. GitHub merges it once the
  `validate` check is green on a branch up to date with main. The `main`
  ruleset requires that check, rebase merges and linear history, with 0
  approvals and no bypass, Jamie's account included (agents push as it).
- `validate` (`.github/workflows/validate.yml`) runs the workflow lint, the
  unit tests and cfn-lint. Workflows stay SHA-pinned with `permissions: {}`,
  per-job grants and `persist-credentials: false`;
  `sh scripts/test-workflows.sh` checks that. Dependabot moves the pins
  monthly in one PR, which is reviewed like any other: it does not
  auto-merge, because a merged action runs with the repository's token.
- The repository is public. Never commit subscriber data, note text, DNS
  values or anything from the live table or bucket, including in tests and
  fixtures (the tests use a fictional subscriber at example.com).

## Operating

- Deploy: `./deploy.sh` (cloud-engineer profile, us-east-1), from a clean
  checkout of `origin/main` with a green `validate`; it refuses anything
  else (`--break-glass` is for GitHub being down, never a red check). It
  runs the tests again first.
- Tests: `PYTHONPATH=src python3 -m unittest discover -s tests`
- The web app locally: `scripts/dev_server.py` serves `web/` and the real API
  against in-memory fakes, prints sign-in emails instead of sending them, and
  starts with a fictional subscriber, ada@example.com. `--fake-places`
  answers city search and weather without Open-Meteo. Use it (and Playwright
  from a sibling project's `node_modules`) to see pages; never sign in on
  live to check something.
- Add a subscriber (phase 1 has no sign-up): `scripts/add_subscriber.py EMAIL YYYY-MM-DD`
- Read someone's release notes (phase 1 has no reader):
  `scripts/read_notes.py EMAIL [YYYY-MM-DD]`. It prints note text, so run it
  only for the subscriber's own notes; agents do not run it to check things.
- Send someone today's email now, outside their window: invoke the sender
  with `{"send_now": "<user id>"}` (add `"dry_run": true` first to see it).
  Still once per local day; never fake the clock with `now` to do it.
- Alarms go to SNS `yvn-release-notes-alarms`, which is subscribed to the sysadmin
  `projects-ops-alerts` queue. The queue's policy must list the topic.
- DNS for `yourversionnumber.com` is at Namecheap; Jamie applies records by
  hand. The stack needs: the three DKIM CNAMEs (stack outputs `DkimRecord1-3`),
  an MX on the inbound subdomain to SES inbound, and an MX plus SPF on the
  MAIL FROM subdomain. DMARC is Jamie's own record. All were live on
  2026-10-07. Read current values from DNS or the stack, not from this repo.
- The web app adds two records: the ACM validation CNAME for
  `notes.yourversionnumber.com` and `notes` CNAME to the stack output
  `WebDistributionDomain`. The certificate lives outside the stack (an
  in-stack one would hold every deploy until DNS validated); `deploy.sh`
  finds it once ACM says ISSUED and only then attaches the alias.
- `deploy.sh` syncs `web/` to the web bucket (HTML at max-age 60, other files
  600; bump `?v=N` on an asset whose change must land with a page) and
  invalidates the distribution.

## Phases

1. **Jamie only, text only** (done 2026-10-07): sender, inbound, storage,
   subscribers added by hand.
2. **The web app** (`docs/WEB-APP.md`, done 2026-10-08): sign-up and sign-in
   by email link or code, export, notes for today and past days, pause,
   settings (the send time included), `List-Unsubscribe`, bounces stop a
   subscriber.
3. **Around it** (started 2026-10-08): photos and audio from replies
   (built); the export as a zip with the files (built); weather from the
   subscriber's city (Open-Meteo, no key, CC BY 4.0), each day's actual
   weather recorded with its city plus one forecast line in the morning
   email (Jamie, 2026-10-08; built); a yearly "release notes for 5.2" collection on
   the birthday.
