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

SES delivery events, on their own topic (yvn-release-notes-mail-events)
  -> Lambda yvn-release-notes-events   hard bounce or complaint -> that subscriber stopped;
                                         one scrubbed line (kinds, user ids) -> the alarms topic

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
  `transcribe.py`: recordings written out by Amazon Transcribe, and
  `describe.py`: photos described by Claude Haiku 5.5 through the Anthropic API, each for
  those who turn it on (their docstrings are the design).
- `send.py`, `inbound.py`, `events.py`: the mail handlers. `store.py`: the one table and its
  key layout (documented at the top of the file). `census.py`: the
  dashboard's counts, put out by the sender (its docstring lists them).
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
  `Store.day_notes` and join it with `notes.combine`. Note ids are random,
  so sort by `notes.written_at`, never by key. A day with any note counts once for
  the streak.
- **Raw mail is the source of truth.** Every filed reply stays whole in S3
  (`raw/`, tagged `outcome=note`, kept indefinitely); never expire those.
  Ignored mail is tagged `outcome=ignored` and expires in 30 days.
- **Any kind of data can come from any channel** (Jamie, 2026-10-09:
  "assume any type of data we deal with can come from any channel"). Email,
  the web, an import: none is the only way in for text, photos, recordings
  or anything else. Where a channel does not carry something yet, that is
  work not done, never a rule.
- **A note is the same record from every channel** (`notes.py` lists its
  fields): `written_at` (notes filed before 2026-10-09 have `received_at`,
  which `notes.written_at` reads), `tz`, the zone it was written in, so its
  time reads as it did there (email: the subscriber's; web: the browser's;
  an import: the entry's), an optional `place` (name, city, region,
  country, coordinates; shown by name, never the coordinates, the name
  linking to Apple Maps at them unless the place is only the subscriber's
  city, `notes.map_url`, Jamie 2026-10-09), and `source`: `email`, `web` or `import`, an import with
  `origin` (`{app, journal, id}`, the entry it came from).
- **Tags are hashtags** (Jamie, 2026-10-09: on the note, "hashtags",
  lowercase with hyphens, "maine-2016"). A note's `tags` are the slugs of the
  hashtags in its text (`tags.py`), worked out again on every write and
  edit, so the text is the one place a tag lives and removing a hashtag
  removes it. An import writes its tags as a closing line of hashtags; a
  journal other than the main one comes in tagged with its name.
  `/search/` lists every tag and `/tag/?t=<tag>` shows a tag's days.
  No index: one person's notes are read whole, but the tag list brings
  back keys and tags only (`Store.note_tags`) and a tag's page only its
  notes (`Store.tagged_notes`, a filter).
- **Search** (Jamie, 2026-10-09: "pull posts by tag, showing all tags
  that have been used, as well as search by string across notes"):
  `/search/`, every tag, and `POST /api/search {q}`: notes with every word
  or "quoted phrase" in their text, place name or link names, without case
  or accents, newest 100 days shown. It reads every note, like the tags.
  The words go in a POST body and the page's `#q=`, never a URL a server
  sees, and are never logged.
- **Imported days count** toward streaks and every lifetime count (Jamie,
  2026-10-09). The dashboard splits notes into email, web and imported.
- **Day One imports are planned before anything is written** (Jamie,
  2026-10-09: "keep it to dry-run"). `dayone.py` turns an export into the
  notes it would make (`NOTE#<day>#d1-<uuid>`) and touches nothing;
  `scripts/import_dayone.py EMAIL ZIP...` reads the subscriber and prints
  what an import would do, as counts (`--plan-out` to a folder outside the
  repo for the full plan, note text included). `--write` then imports
  (`importer.py`): files and the original first, then each note
  conditionally, then the plan's weather before anything else fills those
  days, with the writer's own link words kept. The ledger item
  `IMPORT#<app>#<journal>` lists every entry imported, so a repeat skips
  them and never brings back a note the subscriber deleted; a `d1-` id on
  any day is skipped too. The export is read as untrusted: an entry whose
  uuid is not 32 hex digits is left out (`bad id`, counted), the journal's
  JSON is refused past 512 MB unpacked before it is read, and only files
  named `<folder>/<name>.<ext>` are looked up; S3 keys are built from the
  user, day, note id and a known extension, never a name from the zip.
  `Store.put_note` turns floats into Decimal all
  the way down. Writing uses boto3 (a virtualenv); every live run needs
  Jamie's go. `scripts/dev_server.py --dayone ZIP` runs the same importer
  into the fakes, to see an import locally first.
- **Photos and recordings** (Jamie, 2026-10-08) are kept with their note,
  whatever channel brought them. From an emailed reply, inbound copies each one to
  `media/<user>/<day>/<message id>/<n>.<ext>` in the same bucket and lists it
  on the note as `media` (`media.py`); signature logos (longest side under
  200 px) are left out. Video, PDFs and the rest of an emailed reply stay in
  the raw message and show as "in the original email". A note's media can
  also be a `file` (a PDF), shown as a link. **On the web** (Jamie,
  2026-10-09: "add a file to an entry via the web ... image, audio, PDF")
  a new note or one already there takes photos, recordings and PDFs, up
  to 50 MB each and 20 a note; a note with files may have no words. The
  browser sends each file straight to the bucket with a form the API signs
  for that type and exact size (`POST /api/uploads`), to
  `media/<user>/web/<id>.<ext>` tagged `outcome=pending`, which the bucket
  expires after a day; the note's write checks its first bytes and tags it
  `outcome=note` (`media.py` has the design). So the CSP's connect-src and
  the bucket's CORS name each other. Each file on a note in an API answer
  carries `url`, a signed link on the bucket's own host, the one host the
  CSP adds (`img-src`, `media-src`), only for keys under the subscriber's
  own `media/<user>/` (`App.media_links`). A link is signed for 15 minutes
  and a warm function hands out the same one for 5, so the browser reuses
  its copy (2026-10-09: photos had been one API call each, and a page of
  them started several cold functions at once). Photos, recordings and
  PDFs all load and open from `url` (Jamie, 2026-10-09: signed links, "the
  right approach", for every file; never public). Past nine minutes on the
  page, or when a link fails, they use
  `/api/days/<day>/notes/<id>/media/<n>`, which checks the session and the
  key's owner and redirects to a fresh link of the same kind. Never a public URL; the key itself
  is never a field of an answer, only inside a signed link. **Recording on the page** (Jamie,
  2026-10-09): the new-note form's Record button (shown only where the
  browser has MediaRecorder) records the microphone, up to 30 minutes, as
  MP4 where the browser makes it (Safari, newer Chrome) else WebM or Ogg.
  Each recording plays back from a `blob:` URL (hence `blob:` in
  media-src) and can be removed before the note is added; adding the note
  sends it like a chosen file. The `Permissions-Policy` header allows the
  microphone to the page itself and turns off the camera, location,
  payment and USB. `upload_type` drops codec parameters
  (`audio/webm;codecs=opus`). The e2e test records Chromium's fake
  microphone. The email's "A year ago" links to the
  day ("See 2 photos") and carries no file. **Transcripts** (Jamie,
  2026-10-09: "speech to text on audio notes", Amazon Transcribe): off
  until the subscriber ticks "Write out what I say" in settings
  (`transcribe` on the profile), which also writes out every recording
  already kept. The table's stream (NEW_AND_OLD_IMAGES, read by the
  transcriber alone) starts a batch job per recording; Transcribe's job
  events bring the words back as `transcript` on the file's media entry
  (`""` when a job failed or heard nothing). The words show in italics (Jamie: so
  it "isn't text you typed") under the
  player, are searched, and go in both exports; not in the email. Jamie
  wanted the settings copy casual and the service unnamed ("They're sent
  off to be transcribed"). The account has no AI services opt-out (Jamie,
  2026-10-09: "I don't care if they keep it"), so Amazon may keep the audio.
  `scripts/extract_media.py` fills in notes filed before this.
  **Descriptions** (Jamie, 2026-10-09: "image descriptions to allow images
  to appear in search"; then Claude Haiku 5.5 through the Anthropic API
  rather than Haiku 4.5 on Bedrock): off until the
  subscriber ticks "Describe my photos" (`describe` on the profile), which
  also describes every photo already kept, in passes the function hands
  on to itself. The same stream sends each new photo to the model; one or
  two sentences come back as `description` on its media entry (`""` when
  the model could not read it). JPEG, PNG, GIF and WebP up to 3.75 MB;
  nothing is shrunk, so bigger photos and HEIC go without. It is the
  photo's alt text, it is searched, and it shows (in italics, marked)
  only in search results where the search found it (Jamie: "descriptions
  only on search results"); in the zip it is the Markdown's alt text and
  on the JSON's file entry. The settings copy says the photos go to "an
  AI", without naming it. The key is `api_key` in the Secrets Manager
  secret `yvn-release-notes-anthropic`, made by hand outside the stack
  (Jamie keeps its value; agents never read it). Until it holds a real
  key the describer sends nothing and logs `no-key`; photos stay waiting,
  so after the key goes in, turning the setting off and on describes them.
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
  settings, which for a bounce or complaint also takes the address off SES's
  account suppression list (`web.unsuppress`), or SES would drop every email
  to it. Pauses are dated (`PAUSE#<from>`, at most 60 days) and end on
  their own; stopping does not. The sender skips a paused day, and paused
  days neither break a streak nor add to it (`streak.py`).
- **SES events never reach the ops queue as is.** They carry the address,
  the subject (a sign-in code) and the reply token. `events.py` sends the
  alarms topic one line: the kind of event, the kind of email (`daily` or
  `account`) and user ids.
- **Automatic replies are not notes.** Inbound ignores mail marked
  `Auto-Submitted` (other than `no`), `X-Autoreply`, `X-Autorespond`, or
  `Precedence: auto_reply`, `bulk` or `junk`, and mail with more than one
  From. A note is at most 20,000 characters (`notes.MAX_NOTE`), emailed or
  typed.
- **Counts, not people** (`TALLY#<YYYY-MM>`): sign-ups, unsubscribes,
  restarts, bounces, complaints and deletes, one number each a month, read
  with `scripts/tally.py`. Never per person. A stopped subscriber gets
  nothing from the product, so the unsubscribe count is the one to watch
  (Jamie, 2026-10-08).
- **The operations dashboard is CloudWatch, not the web app** (Jamie,
  2026-10-09: "instead of part of the application ... an AWS dashboard").
  Dashboard `yvn-release-notes` (stack output `DashboardUrl`), behind AWS
  sign-in. Counts only: no address, user id or note text on it. Its sources:
  the census line the sender prints at the end of every scheduled run
  (embedded metrics, namespace `ReleaseNotes`; never on a dry run or
  `send_now`; a failure is logged and never fails the run), SES's
  `mail-metrics` destination (send, delivery, bounce, complaint, reject,
  counted by the `release-notes-mail` tag: `daily` or `account`; still no
  opens or clicks), and Logs Insights over the functions' logs. A new
  dashboard number goes in `census.py`; `tests/test_census.py` checks the
  dashboard's JSON and that every census metric it shows exists. The
  per-person view is `scripts/subscribers.py`, on this Mac only.
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
- **The API answers only CloudFront** (2026-10-09, a security review). The
  HTTP API's execute-api URL cannot be turned off, since it is CloudFront's
  origin, so CloudFront adds `X-Origin-Verify` to every API request with
  the value of the stack's secret `yvn-release-notes-origin` (generated by
  CloudFormation, resolved into the distribution and the web function's
  `ORIGIN_SECRET`; nobody reads it). `web.handler` answers anything without
  the exact value with a fixed 403 before any route, comparing in constant
  time and never logging the header. That is what makes
  `CloudFront-Viewer-Address` (the sign-in limit per network) and `Origin`
  trustworthy. With no `ORIGIN_SECRET` (the tests, `scripts/dev_server.py`)
  there is no check. The web function `DependsOn` the distribution, so a
  deploy that changes the header updates CloudFront everywhere before the
  function asks for it. Never put `ORIGIN_SECRET` in an output or a log.
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
- **The number stands alone in the email.** No decades/years/days breakdown
  under it (Jamie, 2026-10-07: "super redundant"). Below it: a row of 24 text dots for
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
- **The front page asks for the birthday first** (Jamie, 2026-10-08, option
  A on the sign-up design canvas,
  https://claude.ai/artifact/KzZxD1K7N9N6Rvq9SBhyxd): month, day and year
  fields, then the number explained once (decades, years, days, the next
  release, all from `/api/sample`), then the email. Nothing is written
  before sign-in: the birthday waits in that browser's localStorage
  (`pendingBirthday`, a day at most, since the emailed link often opens in
  another tab) and setup shows it as a sentence ("Not right?" opens the
  fields) and saves it with the city and time. "Sign in" (`/#sign-in`) is
  the email alone, for anyone returning; links meant for signed-out
  subscribers go there, not to `/`.
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
  cfn-lint is pinned too (`pipx run --spec cfn-lint==<version>`), which
  Dependabot cannot see: bump it by hand to PyPI's latest, after a local
  run, when the template needs a newer one.
- The repository is public. Never commit subscriber data, note text, DNS
  values or anything from the live table or bucket, including in tests and
  fixtures (the tests use a fictional subscriber at example.com).

## Operating

- Deploy: `./deploy.sh` (cloud-engineer profile, us-east-1), from a clean
  checkout of `origin/main` with a green `validate` run by GitHub Actions;
  it refuses anything else. `--break-glass` is for GitHub being down, never
  a red check: it skips only the fetch and the check lookup, so HEAD must
  still be a clean checkout of `origin/main` as last fetched. It runs the
  tests again first. The code bucket it made itself refuses plain HTTP
  (its policy is put on every run).
- Tests: `PYTHONPATH=src python3 -m unittest discover -s tests`
- Browser tests (optional, Jamie 2026-10-08: quick deploys for most
  changes, the browser run when wanted): `e2e/` drives sign-up in Chromium
  against `scripts/dev_server.py`, reading sign-in codes and links from the
  dev server's `/dev-mail/`. Locally: `npm ci --ignore-scripts`, then
  `npx playwright install chromium` once, then `npm run e2e`. On GitHub: the
  `e2e` workflow, from the Actions tab or by labelling a PR `e2e`. It is
  not a required check and `deploy.sh` does not wait for it; run it for
  any change to `web/assets/app.js` or the pages. Node is dev tooling only
  (`package.json` holds one dev dependency): nothing under `node_modules`
  is packaged or synced. The expected number comes from `/api/sample`,
  never a fixed string, since it depends on today. The dev server's sign-in
  limits still apply (20 emails an hour from one network), so
  `--repeat-each` past about 4 trips them.
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
  `projects-ops-alerts` queue. The queue's policy must list the topic. SES
  events go to `yvn-release-notes-mail-events`, read only by the events
  function, which puts a scrubbed line on the alarms topic.
- SQS `yvn-release-notes-failed` holds what gave up after its retries: a
  bounce or complaint the events function could not apply (the SNS message,
  address included, so it never goes to the ops queue) and a transcribe or
  describe stream batch (shard and sequence numbers only). Kept 14 days;
  alarm `yvn-release-notes-failed-queue` fires on anything in it. Apply a
  stuck bounce by hand, then delete the message.
- The monthly counts: `scripts/tally.py` (reads only).
- The dashboard: stack output `DashboardUrl`. Alarm `yvn-release-notes-overdue`
  fires when anyone's email is over half an hour late for two quarter
  hours (census `Overdue`); a send time moved past today's window also
  trips it, for that day.
- One row per subscriber (address, state, sign-up day, send time, last
  email, last note, notes, 30-day reply rate): `scripts/subscribers.py`.
  Reads keys and a few fields, never note text. It prints addresses, so its
  output stays on this Mac.
- DNS for `yourversionnumber.com` is at Namecheap; Jamie applies records by
  hand. The stack needs: the three DKIM CNAMEs (stack outputs `DkimRecord1-3`),
  an MX on the inbound subdomain to SES inbound, and an MX plus SPF on the
  MAIL FROM subdomain. DMARC is Jamie's own record. All were live on
  2026-10-07. Read current values from DNS or the stack, not from this repo.
- The root domain's mail is Jamie's Fastmail (MX, SPF and `fm1-3._domainkey`,
  2026-10-08): notes@, postmaster@ and abuse@ reach Jamie. It is separate from
  the stack's records; the root SPF stays Fastmail-only, since SES mail's SPF
  is checked on the MAIL FROM subdomain. In Namecheap, Mail Settings stays
  "Custom MX"; any other choice rewrites the MX records, `in.` included.
- The web app adds two records: the ACM validation CNAME for
  `notes.yourversionnumber.com` and `notes` CNAME to the stack output
  `WebDistributionDomain`. The certificate lives outside the stack (an
  in-stack one would hold every deploy until DNS validated); `deploy.sh`
  finds it once ACM says ISSUED and only then attaches the alias.
- `deploy.sh` syncs HEAD's `web/` (a `git archive` export, so nothing git
  ignores goes up) to the web bucket (HTML at max-age 60, other files
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
