# The web app: notes.yourversionnumber.com

Agreed with Jamie on 2026-10-08 and built that day; the front end moved to
React on 2026-10-09. This is the design of what runs: change it with the
code. AGENTS.md has the rules for everything since (files, tags, search,
transcripts, descriptions, imports), and `packages/backend/store.ts` the
table's full key layout.

The application and workers use TypeScript on Node 24 (2026-10-13), with
native Hono HTTP servers on Lambda Web Functions and a redesigned React UI.
The API, persisted account/note contracts, email ownership proof and existing
sessions/grants remain compatible. `docs/TYPESCRIPT-REBUILD.md` records the
staged execution and rollback gates.

Release Notes has a standalone web app at `notes.yourversionnumber.com`. The
birthday and work sites at `yourversionnumber.com` stay as they are, and
nothing there links here yet: that is Jamie's call.

## What it does

1. **Sign up or sign in.** The front page asks for the birthday first
   (month, day and year fields), then explains the number once (decades,
   years, days, the next release, all from `/api/sample`), then asks for
   the email. Nothing is written before sign-in: the birthday waits in that
   browser's localStorage (`pendingBirthday`, a day at most, since the
   emailed link often opens in another tab), and setup shows it as a
   sentence ("Not right?" opens the fields) and saves it with the city and
   time. "Sign in" (`/#sign-in`) is the email alone. We send a
   link and a six-digit code. The code covers the case where you asked on
   the laptop and read the mail on the phone. A new address then confirms
   or picks:
   - **Birthday**, carried over from the front page.
   - **Location, to the city.** It is chosen from a search, and gives the
     time zone and coordinates rounded to the city (for the day's weather
     and the morning forecast, `packages/backend/weather.ts`). No street address, no device location.
   - **Send time**, on a quarter hour. The default is 06:00.

   Today's email goes as soon as they finish, with a welcome line, and the
   schedule starts the next day (Jamie, 2026-10-08: they "get the email and
   connect the dots shortly after signing in"). An address that already
   subscribes goes straight to its notes.
2. **Today**: the version number, today's notes from email and the web
   together, a box to write one, and the streak.
3. **Timeline**: days by version, newest first, with their notes. Above
   them, the releases (a release is a year of life, "5.4", birthday to
   birthday), newest first, the current one marked, each a link to its
   page: `/release/?v=5.4`, its days with notes, oldest first, under a
   head with its dates, its counts, its longest streak and its tags by how
   many notes have them (Jamie, 2026-10-12).
4. **Any past day**: pick a date and add notes to it (backfill). Any day from
   the birthday to yesterday. A note can say where it was ("Where", the
   city search, optional), and a day can have a place of its own with no
   note; a past day's weather follows it (AGENTS.md, Where a note was).
5. **Pause**: no emails for N days (1-60) or until a date. Resume any time;
   otherwise the emails start again on their own.
6. **Export your data**: every note, its day and version, plus the profile,
   as Markdown and JSON; since phase 3, a zip with those and every photo
   and recording, built in the background (`workers/export.ts`). It arrives with sign-in, before anything else, so
   deleting an account never means losing what was in it.
7. **Settings**: four keyboard-accessible disclosure groups—Daily email
   (open initially), Writing & search, Connected agents and Your account.
   Changes save as they are made; opening a group changes no preference.
   Connector setup and recent activity are secondary disclosures. Contains
   send time and location, the standing address (a note any
   day by email, no reply needed; Copy, and "New address" to replace it),
   sign out, delete account (after an
   export is offered, and with a fresh code).
8. **The daily email** gains a "Pause or manage" link and one-click
   `List-Unsubscribe`. A hard bounce or complaint stops the subscriber.
9. **Since**: tags (`/tag/?t=`) and search (`/search/`), photos,
   recordings and PDFs added on the web (`packages/backend/media.ts`), recording on the
   page (Front end, below). AGENTS.md has their rules.

## Defaults (Jamie can change any)

- A backfilled day counts toward the streak, the same as a late reply.
- Paused days neither break the streak nor add to it.
- Any of your own notes can be edited or deleted, emailed ones included.
  Deleting an emailed note deletes its raw message from S3 as well. The
  bucket is versioned, so the old version lingers 30 days, then expires.
- The birthday is locked after sign-up, because changing it renumbers every
  day you have kept.
- Photos, recordings and PDFs show with their note, by a signed link that
  lasts at least ten minutes once handed out (each is signed for 15 and
  reused for 5), for their owner only (`packages/backend/media.ts`). They come from emailed
  replies, web uploads and imports; any channel may bring them (Jamie,
  2026-10-09).
- A photo with a thumbnail (`packages/backend/thumbs.ts`) also answers `thumb`, a signed
  link to it. The Timeline, Search and tag lists show the thumbnail and
  open the original on a tap; a Day and Today show the original.
- A link in a note shows by name: the words you linked, or the page's
  title, fetched once when the note is saved (`packages/backend/links.ts` has the
  guards). The text keeps the address as written, and the exports carry
  both. No Markdown.
- Page counts go to Tinylytics site 3816, its own site beside the main
  site's 3343 (Jamie, 2026-10-08), sent by the app (`lib/pagecount.ts`) without the embed
  script. Path only, no cookies, nothing per person.

## Shape

```
notes.yourversionnumber.com
  CloudFront (PriceClass_100, ACM certificate issued outside the stack)
    default  -> private S3 web bucket (OAC) -> React/Vite app
    /api/*, /oauth/*, discovery -> private Lambda Web Function (server/app)
    /mcp     -> private Lambda Web Function (server/mcp, separate reader role)
    API      -> existing DynamoDB table
             -> export Event Function :live (async ZIP)
    MCP      -> private capture Event Function :live (guarded delegated text)
```

- **Language: TypeScript on Node 24.** Hono servers listen on the endpoint
  supplied by `AWS_LAMBDA_HTTP_ENDPOINT`, without an event-handler adapter.
  Shared `packages/domain/` holds the site's version arithmetic, calendar,
  notes, tags, streaks and Unicode search behavior. `packages/backend/`
  supplies asynchronous stores/services. Mail and processing use native
  Event Function workers. Only the describe worker carries Sharp's native
  Linux Arm64 image libraries.
- **Request isolation:** each HTTP request creates its own session/context;
  reusable SDK clients hold no subscriber state. Mutations transactionally
  prove the live session and account. Atomic renewal/claim/sign-up prevents
  revoked-session and deleting-account races. Existing email links, codes,
  sessions and accounts keep their wire/storage formats.
- **Every HTTP response is private:** `Cache-Control: no-store` also applies
  to redirects and errors. Native listener shutdown stops accepting requests
  and drains active requests within a bounded deadline.
- **Security headers** on every response: a CSP of `'self'` (no inline
  script or style), HSTS, `DENY` framing, and a Permissions-Policy that
  allows only the microphone. The CSP names its few exceptions: Tinylytics
  for the page count, and the mail bucket's host for signed file links and
  uploads. Everything else goes through `/api`: the city search asks
  Open-Meteo's geocoder (no key, CC BY 4.0) from there.
- **New items in the table.** `expires_at` (epoch seconds) is the table's
  TTL. The web app's first items were these; the design comment at the top of
  `packages/backend/store.ts` is the full, current layout.

  | Item | Key | Lifetime |
  |---|---|---|
  | Sign-in link and code | `LOGIN#<hash>` | 15 minutes |
  | Session | `SESSION#<hash>` | 14 days from last use, renewed by each visit, no outer limit |
  | Rate-limit counter | `RATE#<bucket>#<hour>` | about an hour |
  | Pause | `USER#<id>` / `PAUSE#<start>` | kept |
  | Note written on the web | `USER#<id>` / `NOTE#<day>#w-<id>`, `source=web` | kept |

  The profile gains `city`, `region`, `country`, `lat` and `lon` (rounded to
  two places), with `tz` from the same lookup.
- **Sign-in** follows Elixir's design (`packages/auth/src/magic.mjs`):
  - The link and the code burn one shared single-use row. Code attempts are
    counted before comparing, capped at 5, compared in constant time.
  - At most 20 wrong codes per address a day, across all its sign-ins.
  - Only hashes are stored.
  - The answer is the same whether or not the address has an account.
  - The link lands on a "Sign in" button, because mail scanners open links.

  SES production access is account-wide and shared with Elixir's sign-in
  mail, so these limits protect both.
  The limits are 5 sign-in emails per address (without any +tag), 20 per
  network (an IPv4 address or an IPv6 /64), 60 per IPv6 /48 and 200 in all,
  each per hour; past one, the answer is 429. They are checked narrowest
  first and only an email that goes counts, so one network past its own
  limit cannot use up the total (2026-10-09); alarm
  `yvn-release-notes-signin-total` fires when the total is reached. The
  network comes from CloudFront's `CloudFront-Viewer-Address`, which the
  API's own origin request policy passes on. The API answers only
  CloudFront through IAM-authenticated Web Function endpoints. CloudFront
  OAC always signs origin requests with SigV4 (`amz-auth`), and the endpoint
  resource policy allows only this distribution to invoke its live endpoint.
  Direct origin calls are denied by the platform; the rollback endpoint has
  no distribution grant and zero request allowance. No origin-secret header
  is needed. `CloudFront-Viewer-Address` is trusted only behind this boundary.
  On `/oauth/*`, a viewer-request function changes form-encoded query spaces
  (`+`) to `%20` before OAC signs the origin request. This avoids the native
  endpoint's signature rejection of that encoding; decoded values and repeated
  parameters stay the same. It never logs the query or alters consent/scopes.
- **Session**: an `__Host-` cookie, Secure, HttpOnly, SameSite=Lax. Every
  write must carry `Origin: https://notes.yourversionnumber.com`. The API
  receives only the headers it reads (Origin, Content-Type, Accept, the
  viewer address) and only that cookie.
- **Pages**: `/` (the birthday, the number it makes from `/api/sample`,
  then the email; `/#sign-in` the email alone), `/signin/` (the link lands
  here, token in the fragment), `/setup/` (a new address's three
  questions), `/today/` (where sign-in lands), `/timeline/`,
  `/day/?d=YYYY-MM-DD` (any day, for backfill), `/release/?v=5.4`, `/search/`,
  `/tag/?t=<tag>`, `/upcoming/`, `/settings/`, `/pause/`, `/delete/`, `/unsubscribe/`, `/admin/`, `/admin-users/`.
  `/connect/` approves an external agent request whose opaque id stays in the fragment.
  `/admin/` manages product updates; `/admin-users/` shows subscriber metadata. Administration is visible in settings only to the configured administrator.

- **A pause** starts on the next day an email would go (today, unless
  today's has gone) and runs 1 to 60 days. It is `PAUSE#<from>` with
  `through`, and the profile carries the latest one (`pause_from`,
  `pause_through`) so the sender skips it without another read. Changing a
  pause that is running keeps its start; resuming ends it yesterday, or
  drops it if it has not begun. The timeline folds paused days without
  notes or a place of their own into one row.
- **Deleting an account** takes a code mailed to the account's own address
  (`POST /api/me/delete-code`; its single-use row has `purpose=delete`,
  so the same attempt count and address/total limits apply, but it never
  signs in and a sign-in code never deletes). Deletion sets `mcp_deleting`
  first, blocking new OAuth/MCP/processing and web writes. Cleanup removes
  raw messages, private files and exports (including in-flight staged files
  by owner-prefix sweep), reply tokens, standing address, USER rows, indexed
  OAuth grants/MCP metadata, all sessions, newest purpose-specific codes,
  address and profile. Purpose-code recovery can retry a partial deletion.
  Old versions in the mail bucket expire after 30 days; the page says so.
- **The timeline** lists every day with an email, a note or a place of
  its own, newest first, and today, with the day's own place under its
  weather. Days with none of them (before sign-up, or while stopped) are
  left out unless a note or a place is given them. A note written or replied after
  its day is "added later".
- **The sender** skips a paused subscriber, and a stopped one: `status` is
  `active` or `stopped`, with `stopped_reason` `unsubscribed`, `bounce` or
  `complaint`. The configuration set publishes SES's events to their own
  topic, `yvn-release-notes-mail-events`; the function
  `yvn-release-notes-events` stops the subscriber on a hard bounce or
  complaint and puts one scrubbed line on the alarms topic.
- **Sign-up's first email** is today's, at once: the web function invokes
  the sender with `send_now` (`packages/backend/accounts.ts`), which marks the day sent,
  so the schedule's first is tomorrow's. Only a subscriber's first email
  (no `last_sent_date` before it) carries the welcome line. If the invoke
  fails, sign-up still succeeds and the schedule sends today's when it can.
- **The home page** goes straight on for someone signed in (to `/today/`,
  the page they were sent back from, or `/setup/` for a new account): a
  `rn-in` hint in localStorage (the cookie is HttpOnly) keeps the form
  hidden until `/api/me` answers.
- **Logs**: ids, routes and outcomes. Never note text, addresses or cities.

## Front end

`web/` (decided 2026-10-09, replacing hand-written pages and one `app.js`):
a single-page React app on the thingy stack (React 19, Vite, TypeScript,
TanStack Router and Query). `web/src/main.tsx` holds the routes, `pages/`
one component a page, `components/` the shared pieces, `lib/` the API
client and helpers, `styles/site.css` the one stylesheet, and the two
fonts are served from here.

The redesigned UI uses warm paper, Bricolage typography and the version as
its focal point. Today places the editor before saved notes, with labelled
file, recording and place controls. Desktop navigation is a rail; phone
navigation stays at the bottom with safe-area spacing. Archive uses the
existing `/timeline/` address. Dark appearance and reduced-motion preferences
are supported. Icons (`web/src/components/icon.tsx`) and fonts are local;
no image dependency or new CSP exception is required.

- CloudFront's function answers every address that is not a file with
  `index.html` (the dev server does the same), and the router shows the
  page.
- The signed-in pages sit behind one gate in `main.tsx` that has the
  profile before any of them shows. Each page's data (`lib/queries.ts`)
  loads before it shows, from the moment its link is pointed at. Every
  page but the front one, Not found and the error page is its own chunk.
- Back and forward restore the scroll, and a new page moves focus to its
  heading.
- A note added, edited or deleted shows at once and comes back, saying
  why, if the write fails (`lib/notecache.ts`, `components/notelist.tsx`).
  A note's text is drawn by `NoteBody` (`components/notes.tsx`) from its
  `parts`.
- A page that breaks shows the app's error page (`pages/AppError.tsx`, the
  router's `defaultErrorComponent`), which reloads or goes to Today. A tab
  left open on an earlier build loads the app again when it reaches for a
  page's code that is gone.
- The city search is React Aria's `Autocomplete`
  (`components/placepicker.tsx`): the places stay on the page under the
  field, arrow keys move through them and Enter picks. It is its own
  chunk, so React Aria loads only with setup and settings, and on Today
  and Day only once someone opens a "Where" (`components/where.tsx`, the
  note form's place and the day's own). React Aria
  would add a `<style>` tag the CSP refuses; `index.html` carries an
  element with its id so it does not, and `site.css` has the rule.
- **The CSP** is `'self'`: no inline script or style (nothing inlined by
  the build, no `style` props), nothing remote. The exceptions it names:
  Tinylytics (connect) and the mail bucket's host (img and media for
  signed file links, connect for uploads), plus `blob:` in media-src.
- **Recording on the page** (Jamie, 2026-10-09): the new-note form's
  Record button, shown only where the browser has MediaRecorder, records
  the microphone up to 30 minutes, as MP4 where the browser makes it
  (Safari, newer Chrome) else WebM or Ogg. Each recording plays back from
  a `blob:` URL and can be removed before the note is added; adding the
  note sends it like a chosen file. The Permissions-Policy allows the
  microphone to the page itself and turns off the camera, location,
  payment and USB. The e2e test records Chromium's fake microphone.
- **Home Screen**: `web/public/manifest.webmanifest` (standalone, opening
  on `/today/`) and the icons in `web/public/icons/`, drawn by
  `scripts/make_icons.mjs`: a cobalt "v", its tangerine dot and two note
  lines on warm paper. The font-independent shapes in
  `web/src/lib/brand-mark.ts` also draw the small decorative mark beside
  "Release Notes" in every header, using the theme's blue in dark mode.
  [The logo files](BRAND.md) include scalable masters and reusable PNGs
  through 4096px, with transparent or warm-paper backgrounds.
  Favicons have their own 16px and 32px renders; Home Screen icons have
  more breathing room, and the maskable icon keeps the whole mark inside
  its central safe circle. No service worker: every page needs the API,
  and one would only risk an old build. On an iPhone the Home Screen app keeps its own
  cookies, so the emailed link signs in Safari, not the app; there the
  sign-in page points at the code.
- **Page counts** (`lib/pagecount.ts`) go to Tinylytics on each page shown,
  without the embed script: the page's address without its query string,
  and on a visit's first page the referring site's origin only. No
  cookies, nothing that names a person.
- `npm run verify` (format, lint, browser/native types and unit tests, both builds) is part of
  `validate`. `deploy.sh` builds from HEAD and syncs `dist/web`.

## API

| | |
|---|---|
| `POST /api/mcp/authorize` | Inspect or approve/deny a pending OAuth request; session and Origin required. |
| `GET /api/mcp/connections` | Active agent connections, approved scopes and last use. |
| `DELETE /api/mcp/connections/{id}` | Revoke the owner's connection immediately; `?write_only=true` removes only adding permission. |
| `GET /api/mcp/activity` | Up to 50 content-free tool records from fourteen days; successful writes include client and note references. |
| `GET /api/health` | |
| `GET /api/sample?birthday=&tz=` | a version number today: the front page's example (1981-06-14), or the birthday being typed at sign-up |
| `POST /api/auth/start` `{email}` | always 202; mails a link and code when the limits allow |
| `POST /api/auth/verify` `{email, code}` or `{token}` | sets the cookie; says whether the account is new |
| `POST /api/auth/signout` | |
| `GET /api/places?q=` | city search, through Open-Meteo; needs a session |
| `GET /api/me` | the profile, or `{new: true}` for an address signing up; `inbox` is the standing address; `admin: true` only for the configured administrator |
| `PUT /api/me` | sign-up (`birthday`, `place`, `send_time`), or settings (`send_time`, `place`, `status: "active"` to start again); the birthday cannot change |
| `GET /api/export?format=md\|json` | the words alone, as a download (JSON by default) |
| `POST /api/export/zip` | start a zip of everything, photos and recordings too (202); answers with the build already going, if one is |
| `GET /api/export/zip` | how it is going: `none`, `building`, `failed`, or `ready` with size, files and until |
| `GET /api/export/zip/file` | the built zip: a redirect to a five-minute signed link |
| `GET /api/upcoming` | owner-only saved `entries`, each with its next/current/past `occurrence` (`date`, `end_date`, `days_until`, `status`, `line`); local `today`, `tz`, and retained-entry `limit` (200). No table keys |
| `POST /api/upcoming` | create a private date (201): `kind`, `title`, `date`, optional `tag`, `year`, `end_date`, `place`, `email`, `reminders`; see Upcoming below |
| `PUT /api/upcoming/{id}` | replace an owned date with the same fields and its saved `revision`; 409 for stale revision, 404 for a missing/foreign entry |
| `DELETE /api/upcoming/{id}` `{revision}` | delete an owned date using its current revision; frees retained-entry capacity |
| `GET /api/today` | today: version, the year's 24 dots, the next release, today's notes, the streak (today counts once it has a note) |
| `GET /api/days?before=&limit=` | the timeline, 30 days a page; `before` in the answer is the next page's cursor |
| `GET /api/releases` | the releases index: each release with notes, and the current one (`current`), newest first, with `from`, `through`, `days` (with notes) and `notes`; from the notes' keys alone |
| `GET /api/releases/{v}?after=&limit=` | one release (`4.5`): its head (`from`, `through`, `current`, `days_with_notes`, `notes`, `longest`, `tags` by count) and its days with notes, oldest first, 30 a page; `after` in the answer is the next page's cursor. 404 `release` for one not begun |
| `GET /api/days/{date}` | one day: version, notes (each note's `parts` is its text split into strings and links by name), `weather`, the day's recorded weather as a line, when kept, and `where`, the day's own place by name, when set |
| `POST /api/days/{date}/notes` | write for today or a past day; `uploads` attaches files, and a note with files may have no text; `place` (a city from `/api/places`) says where |
| `PUT/DELETE /api/days/{date}/place` | set the day's own place (a city from `/api/places`) or clear it; answers `{date, where, weather}`, the past day's weather fetched again for it |
| `PUT/DELETE /api/days/{date}/notes/{id}` | edit, delete (an emailed note's email and files go with it) |
| `POST /api/days/{date}/notes/{id}/media` `{uploads}` | add files to a note already there |
| `GET /api/days/{date}/notes/{id}/media/{n}` | a file: a redirect to a fresh signed link, for its owner. Every file in an answer already carries `url`; this is the fallback once it has run out |
| `POST /api/uploads` | a signed form for one file, of the type and exact size given, for five minutes; 429 `upload-limit` past the day's ceilings |
| `GET /api/tags` | every tag, most used first |
| `GET /api/tags/{tag}` | every day with a note tagged so, newest first |
| `POST /api/search` `{q}` | notes with every word or "quoted phrase"; the words never go in a URL |
| `PUT /api/pause` `{days}` or `{through}` | pause, or change the pause |
| `DELETE /api/pause` | resume now |
| `POST /api/me/inbox` | a new standing address in place of the old one, which files nothing from then on; answers `{inbox}`; 409 `try-again` if another tab changed it first |
| `POST /api/me/delete-code` | mails the account's address a code to confirm deleting |
| `DELETE /api/me` `{code}` | deletes everything; needs that fresh code |
| `POST /api/unsubscribe?t=` | the email's one-click unsubscribe (RFC 8058); the token is the day's reply token, and this is the one write without an Origin |
| `GET /api/unsubscribe?t=` | redirects to `/unsubscribe/`, a page with a button, for mail apps that open the link |
| `GET /api/admin/users` | administrator only: `users` with email, status (`active`, `paused`, `stopped`), stopped_reason, pause_through, joined_at, tz, send_time, last_sent_date, last_added_at, entries and days; `as_of` is the snapshot time; nullable metadata is null |
| `GET /api/admin/updates` | administrator only: saved drafts and schedules (`updates`), and the administrator's local `today`; each update has `id`, `title`, `text`, named `links` and rendered `parts`, `revision`, `status`, `date`, `created_at`, `updated_at` |
| `POST /api/admin/updates` `{title,text}` | administrator only: create a draft (201), without scheduling |
| `PUT /api/admin/updates/{id}` `{title,text,revision}` | administrator only: edit a draft; scheduled text cannot be edited until cancelled |
| `DELETE /api/admin/updates/{id}` `{revision}` | administrator only: delete a draft |
| `POST /api/admin/updates/{id}/schedule` `{date,revision}` | administrator only: reserve one date with a saved text snapshot; dates cannot precede the administrator's today; 409 for an occupied date or stale revision |
| `DELETE /api/admin/updates/{id}/schedule` `{revision}` | administrator only: cancel its schedule and return to a draft; does not retract emails already sent |

## Upcoming

`/upcoming/`, in the main navigation, keeps personal dates independently of
journal notes: birthdays, anniversaries, trips and one-time events. Each entry
has a name/title (1–120 code points on one line), an optional tag, dates, email preference,
reminder offsets, revision and creation/update times. Entries never generate
notes, increment journal counts, contribute to streaks or appear in note search.
No model processes these entries. The owner adds, edits and deletes them in
an email-verified session; Origin is required for writes, and each transaction
proves the current account/session, entry revision and retained-entry capacity.
At most 200 entries, including past events, are retained per owner. Concurrent
edits are refused instead of overwriting another tab. No titles, personal dates,
destinations, tags or addresses appear in logs; sender diagnostics report counts only.

`tag` is one optional hashtag, accepted with or without `#`, trimmed and normalized
through the journal's tag slug rules (lowercase, accents folded, hyphens).
Use 1–50 letters/numbers with single separating hyphens and at least one letter
that normalizes to a–z. Missing, null or blank clears it; legacy entries read as
null. Multiple tags and invalid punctuation are refused as `upcoming-tag`.
The tag groups plans only; it does not add anything to journal tag lists or search.

Kinds and dates:

- `birthday` and `anniversary`: `date` is `MM-DD`, recurring annually; `year`
  is optional/null, otherwise an integer original year whose full date is valid
  and no later than the owner's today. A known birth year gives the birthday's
  version through the existing version arithmetic; decade birthdays are major
  releases. A known anniversary year gives the number of years. February 29
  occurs on March 1 in non-leap years, matching birthday version arithmetic.
- `trip`: `date` and required `end_date` are ISO dates, with an inclusive end
  on/after the start; `place` is required, chosen using the existing city search.
- `event`: `date` is an ISO date; a city `place` is optional. No annual repeat.

A city has `name`, `region`, `country`, IANA `tz`, and rounded `lat`/`lon` (the
same validation as other city selections). Annual entries have no place; trips
and events have no original year. `email` defaults true. `reminders` is a list
of 1–6 distinct integer offsets, 0–365 days before; defaults `[7,1,0]`, or
`[14,1,0]` for a trip. Zero means the event day and, for trips, its last day
(one-day trips appear once). Web-only entries keep no email appearances.
Unknown fields, including requests for automatic time-zone switching, are refused.

All occurrences/reminder selection use the subscriber's local daily-email date.
A compact **Upcoming** section follows streak/lifetime counts, before history,
in both plain text and HTML. At most three due entries show, today's before
future dates, with a link to the complete list and the number of additional due
entries. Empty sections disappear. Reminders travel only in the existing daily
email: no extra sends, catch-up messages, tracking or changed reply ownership.
Optional read failures omit Upcoming without holding the daily email. Pauses,
stopped accounts and the daily-send claim retain their existing behavior.

The page shows annual dates' next occurrence, active trips and future events;
completed trips/events remain under **Past events**, editable or deletable.
Each event occupies one compact table row, ordered by occurrence date ascending
(including past events). Tables scroll horizontally within the page on phones.
Trips store a destination only in this first stage. They do not change the
account's saved home, time zone, forecast or default note location. Automatic
travel switching remains future work. Kind and Tag filters combine across both
future and past entries; Tag also offers **No tag**. Filters are kept in the page
fragment across reloads, with matching counts and a clear action. New dates start
with the selected kind/tag. Existing tags are suggested in the editor.
**Write a note** on a tagged entry opens today's editable draft with its hashtag,
preserving existing draft text and avoiding a duplicate hashtag. The tag travels
in a fragment, never a server-visible query. Nothing is saved until the owner
submits the note; there is no separate event-note relationship, and changing an
event's tag does not change saved notes. Notes remain the owner's account of what
actually happened.

Upcoming entries are included in JSON, Markdown and ZIP exports, in a separate
`upcoming` collection/section (omitted when there are none for legacy export
compatibility), and removed by purpose-verified account deletion with every
other USER row. Existing MCP scopes grant access to journal notes only;
Upcoming is not added to the agent tool surface.

## Product updates

The administrator signs in through the same email link/code as everyone else.
`AdminUserId` is a CloudFormation parameter, default empty (access disabled),
passed only to the native app as `ADMIN_USER_ID`. Set it to the existing
subscriber id for the operator's verified address, outside this public repo.
The staged publication accepts `./deploy.sh --native-http-phase=publish
--admin-user-id=ID`; activate that candidate through the normal HTTP phase.
Omitting the option preserves the assignment; an explicit empty value disables
it in the newly published candidate. Never write the operator's id into source.
Account recreation gives a new id and requires a new assignment. The API
checks the configured id on every request; the same write transaction proves
the live session, current account/address, draft revision and date-slot ownership.
Native HTTP activation also verifies the configured administrator id.

Settings links to **Administration** for that account. `/admin/` supports
creating/editing/deleting drafts, a text preview, scheduling a saved draft, and
cancelling a schedule before editing it again. Titles are at most 120 code
points, text at most 2,000. Plain text only, with guarded title fetching when
saved; the preview shows resolved link names after saving. No media or Markdown.

One update per date appears as **Release Notes about Release Notes**, below the
version/year progress and before the daily ask in HTML; after the opening in
plain text. It uses the email's type-on-paper layout and named links. The date
is each recipient's local daily-email date (including the sign-up email or an
operator's send-now), so time zones may receive it at different UTC times.
Already-sent, paused and stopped days get no additional email or catch-up.
Scheduling during a day reaches only remaining sends, and cancellation stops
remaining reads without retracting emails or a snapshot already being sent.
A completed date stays labelled scheduled in the list: this is schedule history,
not delivery tracking. Optional read failures omit the update and preserve the
daily send; the sender dry run reports its id, never its words, and writes nothing.
These records stay outside personal notes, counts, streaks, search and exports.

## Release and verification

Use the green PR/validate gate and the explicit native publication,
activation and recorded rollback phases in `AGENTS.md`. Unit, browser and
load tests use the native local harness and fictional subscribers. Never
sign in against production or write live data to verify a release. Read-only
live checks may inspect public health/discovery and unauthenticated origin
protection; worker candidate probes use only `{"self_test":true}`.

## DNS (Namecheap, by Jamie)

1. The ACM validation CNAME for `notes.yourversionnumber.com` (requested
   2026-10-08; read it from ACM, not from here).
2. `notes` CNAME to the distribution's `cloudfront.net` name (stack output
   `WebDistributionDomain`).

## Agent connections

`docs/MCP.md` documents `/mcp`, the public OAuth discovery and protocol routes,
and owner consent. These public routes are dispatched separately from the
cookie API, behind the same CloudFront OAC/IAM boundary. Cookie writes retain
same-origin checks. The `/connect/` request survives a sign-in in the same
tab, via the existing return path including its fragment. Settings lists
connections, disconnect and turn-off-adding controls, and content-free
recent activity. Adding consent is separate and initially unchecked.
Note metadata shows assistant provenance as "added by <client>"; client
names are self-reported. Existing notes read as user-authored. The JSON
export preserves provenance. `workers/capture.ts` is private, invoked only by MCP,
with no public web route or ability to authenticate cookie writes.

The **Users** link in administration opens a read-only subscriber overview with
address search, status filtering, totals and reload. Each subscriber occupies
one compact table row. Column headings sort in either direction, with email
ascending by default and missing dates last in both directions. It shows email status,
schedule/time zone, last sent local date, last addition time, join time, entry
count and distinct journal-day count. Active means daily sending is enabled,
not proof of delivery or reading. Pauses use each subscriber's current local
date; stopped reasons are limited to unsubscribe, bounce and complaint.

`packages/backend/subscriber-overview.ts` consumes only the dedicated Store
projection: profile metadata, NOTE keys/source/writing/receipt times and IMPORT
ledger update times. It never loads journal text, tags, links, media, locations,
credentials or import ids. Mail uses receipt time when present; imports use the
ledger update time rather than their original writing date. Missing legacy
timestamps stay unknown. Counts reflect retained entries; import-ledger times
remain after an imported entry is deleted. This is not an activity audit log.
Deleting accounts are omitted, and no subscriber details enter request logs.
The WebRole's new Scan permission requires SPECIFIC_ATTRIBUTES and allows only
the projection's metadata attributes; existing owner journal readers are not
used by this endpoint. CloudWatch remains the count-only operations dashboard.
