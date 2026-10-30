# The web app: notes.yourversionnumber.com

Agreed with Jamie on 2026-10-08 and built that day; the front end moved to
React on 2026-10-09. This is the design of what runs: change it with the
code. AGENTS.md has the rules for everything since (files, tags, search,
transcripts, descriptions, imports), and `packages/backend/store.ts` the
table's full key layout.

The application and workers use TypeScript on Node 24 (2026-10-13), with
Hono HTTP servers on Lambda Web Functions and a redesigned React UI. The API,
persisted account/note contracts, email ownership proof and existing
sessions/grants carried over from the Python version unchanged.

Release Notes has a standalone web app at `notes.yourversionnumber.com`. The
birthday and work sites at `yourversionnumber.com` stay as they are; their
home and 404 pages link here. Beside the app, a few public pages say what
Release Notes is and how to use it: How it works, the guide, the FAQ,
Privacy and the changelog (Public pages, below).

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
   the laptop and read the mail on the phone. The first screen says, in
   one line under the question, that it is free with a Weekly Thing
   subscription and that we'll offer to add anyone without one. Under the
   asking, the tour (`components/tour.tsx`) says what Release Notes does,
   with a morning's email, and that it is free with the Weekly Thing.
   That sample is a made-up 5.2.113 until a birthday is typed (and in
   `front.html` always); once the number shows, the browser draws it again
   from the same `/api/sample` answer with the visitor's own number, their
   day, the same patch in their two newest earlier releases that reached
   it (On this day) and when their next release ships (`lib/sample.ts`,
   the domain's arithmetic). No other request is made and nothing more is
   kept; the notes, weather and streak stay made up, and the sample says
   so. "Change birthday" goes back to the made-up one. **A birthday in
   the link:** yourversionnumber.com links the front page as
   `/#birthday=YYYY-MM-DD` (Jamie's call 2, 2026-10-29), and the page
   reads it as it opens, unless a code is waiting in that tab: the fields
   are filled in, the number and the sample are shown and the birthday
   waits as a typed one does. It is strict (that one field, a real
   calendar day, 29 February only in a leap year, from 1900-01-01 to the
   visitor's own today) and anything else is dropped without a word. Once
   read, used or not, it is cleared from the address bar with
   `history.replaceState`, so a copied address doesn't carry it (the
   waiting birthday still brings the number back on a reload). A fragment
   never reaches a server, and the page count sends the path alone.
   Someone signed in goes on to Today as before. A new address must get
   the Weekly Thing (AGENTS.md, Subscribers and accounts): one that
   doesn't sees "Subscribe <address> to the Weekly
   Thing" instead of the form, then confirms from Buttondown's email and
   taps "Check again"; "Use that one" signs out, back to the front page,
   the birthday still waiting. Then it confirms or picks:
   - **Birthday**, carried over from the front page.
   - **Location, to the city.** It is chosen from a search, and gives the
     time zone and coordinates rounded to the city (for the day's weather
     and the morning forecast, `packages/backend/weather.ts`). No street address, no device location: home
     is chosen. A note can carry the device's spot (Where a note was, AGENTS.md).
   - **Send time**, on a quarter hour. The default is 06:00.

   Today's email goes as soon as they finish, with a welcome line, and the
   schedule starts the next day (Jamie, 2026-10-08: they "get the email and
   connect the dots shortly after signing in"). An address that already
   subscribes goes straight to its notes.

2. **Today**: the version number with the streak and what ships next under
   its dots, the day's place, a box to write a note, and today's notes from
   email and the web together.
3. **Archive** (`/timeline/`): days by version, newest first, with their
   notes. Days in a row with nothing in them read as one quiet line (their
   versions, their dates, "Add some"), paused days apart from the rest
   ("Your streak waited"). Above them, the releases (a release is a year of
   life, "5.4", birthday to birthday), newest first, the current one
   marked, each a link to its page: `/release/?v=5.4`, its days with notes,
   oldest first, under a head with its dates, three figures (days with
   notes, notes, longest streak) and its tags by how many notes have them
   (Jamie, 2026-10-12), and links to the releases either side. A tag's page
   (`/tag/?t=`) takes the same head: how many notes on how many days, and
   when. Search puts its box and button on one line and counts what it
   found, newest first.
4. **Any past day**: the days either side and a calendar to pick another,
   the day's notes first, then a box to add one (backfill). Any day from
   the birthday to yesterday. A note can say where it was ("Where", the
   city search, optional), and a day can have a place of its own with no
   note; a past day's weather follows it (AGENTS.md, Where a note was).
5. **Pause**: no emails for N days (1-60) or until a date. Resume any time;
   otherwise the emails start again on their own. The lengths are 52px option rows.
   **Delete** offers the zip as an outline button ("Make the zip") above a
   ruled step whose filled button emails the code.
6. **Export your data**: every note, its day and version, plus the profile,
   as Markdown and JSON; since phase 3, a zip with those and every photo
   and recording, built in the background (`workers/export.ts`). It arrives with sign-in, before anything else, so
   deleting an account never means losing what was in it.
   **A book** (`/book/`, 2026-10-25) is a PDF of any days the owner picks,
   at 6 by 9 inches or on US Letter, whose type, margins and photos grow
   with the page: a title page with every release in the span as a strip
   and the book's figures, a contents page (months, and a small calendar
   for a span of 13 months or less) when there is more than one month or an
   index, a compact opener for each month, each day under its version,
   date, weather and place (hung in a rail beside the notes on US Letter,
   stacked above them on the 6 by 9), the notes with their photos first,
   lists, places, voice memo transcripts and file names, an agent's notes
   hung from a rule, an index of tags and places by release for three days
   or more, and a colophon. The export worker typesets it with Typst from
   `packages/book/` (`data.ts` the words, `render.ts` the photos and the
   PDF, `assets/book.typ` the one template), at most 1,000 photos, one book
   at a time, offered for a day, for anyone. The page picks a release or
   any two days (`?from&to`, which the Release page's "Make a book of this
   release" fills in), counts what they hold, and takes an optional title
   and the page size; the default title is the release's name for a book
   that starts a release and ends within it, else the dates. A Supporting
   Member (or the administrator) also sees "Add commentary by Claude", the
   consent for that book alone, saying what is sent to Anthropic and how
   many of the release's 10 are left; anyone else sees the same box, off
   and dimmed, with what it does, that membership goes 100% to the year's
   nonprofit and "Become a Supporting Member". The tick clears once the book is
   asked for. Claude's pieces are set apart under a rule, or as pages of
   their own, and named in the colophon (`packages/book/commentary.ts`).
7. **Settings**: the address and "Changes save as you go." as the lede,
   then four keyboard-accessible disclosure groups between rules, each a
   title, a one-line summary and a chevron: Daily email (open initially),
   Writing and search, Connected agents and Your account, with
   Administration as a last row for the configured administrator.
   Changes save as they are made; opening a group changes no preference.
   Connector setup and recent activity are secondary disclosures. Contains
   send time and location, the standing address (a note any
   day by email, no reply needed; Copy, and "New address" to replace it),
   "Show badges" (on unless turned off; `docs/BADGES.md`),
   the profile photo (Your account; Profile photo, below),
   sign out, delete account (after an
   export is offered, and with a fresh code).
8. **The daily email** gains a "Pause or manage" link and one-click
   `List-Unsubscribe`. A hard bounce or complaint stops the subscriber.
9. **Since**: tags (`/tag/?t=`) and search (`/search/`), photos,
   recordings and PDFs added on the web (`packages/backend/media.ts`), recording on the
   page (Front end, below). AGENTS.md has their rules.
10. **Badges** (`/badges/`, `docs/BADGES.md`, 2026-10-20): what writing
    regularly has earned, each stamped with the version it came true on.
    Linked from the streak line on Today and from You. Worked out on each read from stored fields
    (`packages/domain/badges.ts`); the one thing stored is `seen`, what
    has already been celebrated. A note saved on Today or another day
    says what it unlocked under the form (as do a first profile photo in
    Settings, feedback sent, a book asked for and dates added to Upcoming
    or Upcoming as text); a Day page says what its
    special day collected ("Collected here: Palindrome."), a release's
    head its coverage and special days, and both exports list the
    badges, oldest first. "Show badges" off in Settings hides the links,
    the unlock and those lines; the page and the exports stay. Earned
    badges sit on a filled disc, what is still to find on an outline;
    the release's days ahead and collected are small cards of version,
    date and name.
    **You** (`/you/`) leads with the profile photo, or its fallback,
    beside the title, then one status line (today's version, when
    the email comes or that it is paused or stopped, the city), then
    Badges, Activity and Settings as ruled rows with a chevron.
11. **Activity** (`/activity/`, linked from You and from each mail
    notice; 2026-10-21, from the mail log of 2026-10-20):
    what happened in the account, newest first, 100 rows a page with
    "Older", under a one-line lede and a "What’s kept here" disclosure.
    Rows sit under the local day they happened, each its time, a glyph
    for its kind, what happened and the channel. Jamie, 2026-10-20: "a full log of any activity happening in
    release notes ... a super powerful tool for Claude to see via MCP".
    Rows (`packages/domain/activity.ts`) live at
    `USER#<owner>/ACTIVITY#<time>#<kind>#<id>`, kept for the life of the
    account, deleted with it and in the JSON export, oldest first. An
    assistant's reads are one row a connection a local day under
    `MCPMETA#`, which the MCP reader writes; parallel calls that race for
    it wait a random, growing moment and read again, up to eight tries.
    `/mail-log/` redirects here.
    - **Mail**: inbound (`workers/inbound.ts`) writes one row per message
      once the address names a subscriber, with the account proof, and
      never for an address that names no one. Filed (with a link to its
      day), not filed and why, or failed (still being retried, or given
      up on after three tries). A row keeps the sender only when it
      differs from the subscriber's address, and the words only once the
      sender is proven (a late reply, a final failure): inbound opens no
      MIME before that proof, and the web role reads nothing under `raw/`.
      "Add to <day>" appends those words to that day's draft in this tab
      and opens it; nothing is saved until the note is. A notice goes to
      the subscriber's own address, never the sender's, for another
      sender, a failed verification, an unreadable message, and a final
      failure: once per message and at most three a UTC day, none while
      the emails are stopped. A late reply keeps its own late notice.
    - **Reads**: each connected assistant's calls on a local day, by tool,
      with the time of the last; never what it asked or read.
    - **Changes** (`packages/backend/activity.ts`), each written after the
      change with the account proof, through the web or an assistant (by
      its client's name): a note added, changed, deleted or given files;
      each badge a save earned, at that save (none with "Show badges" off,
      none lost; an assistant's or an edit's are not marked seen, so the
      email still tells of them); an Upcoming date added, changed or
      removed, by its id, its title read when shown and gone once it is
      removed; settings, each field's old and new value (never
      coordinates); a pause set or ended; stopping by the unsubscribe
      link and restarting; sign-ins (link or code); exports; the standing
      address and calendar link made, replaced or turned off (never the
      address or link); connections added, changed and ended (by the
      owner, by the client, or for a reused refresh token); a day's own
      place set or cleared (the day alone); the profile photo added,
      changed or removed (never the image); and joining.
    - **What the product did**: each daily email sent (its day and
      version) and one row for every Upcoming reminder due that morning,
      those past the email's three included (the date's id, how near, as
      the email said it, and the email's day; none while paused or
      stopped); the badges a note filed by email earned, written as soon
      as the note is stored so a retry loses none; a stop for a
      bounce or complaint; each recording written out (or nothing made
      out) and each pass that described a note's photos, never the words;
      and each Day One import that brought anything in, by its counts
      (a run that stops partway records what it committed; its retry
      records the rest).
      A note filed by email is its mail row.
    - A row that can't be written never undoes the change: it is logged as
      `activity-unrecorded` and counted (`ActivityUnrecorded`, by a metric
      filter on the web's log and an embedded metric in the workers'). A
      change that comes twice to one thing within a second (two appends to
      a note) keeps both rows: its key adds a short random tail.
    - An email inbound gave up on after a timeout or crash is logged from
      Lambda's failure record: it goes to SQS
      `yvn-release-notes-inbound-failed`, which inbound reads one at a time
      (`gaveUp` in `workers/inbound.ts`). It finds the owner from the
      address as inbound's first step does; the row says failed after the
      tries Lambda made, keeps any words an earlier try kept, and the owner
      gets the usual notice. A row already filed or not filed stays as it is.
      Then the record goes on to the failed queue unchanged. A row that cannot
      be written leaves the record to be read again; the third failed read
      sends it on unread.
12. **Map** (`/map/`, a tab since 2026-10-24; Jamie: "a Map
    view for my notes"): every note with a place of its own and
    coordinates, as pins that gather into numbered groups as the map zooms
    out. A note showing its day's or home's city has no spot of its own
    and is left off, as is one cleared with "No place". Choosing a pin or a
    numbered group lists its notes under the map ("3 notes in
    Minneapolis"), newest first, each as notes read elsewhere: its day's
    version, linked to the day, the words and where (Jamie, 2026-10-24: "it
    should work for groups of notes too", and "listing below map"); + and − or a double tap zoom in. Words, a tag and a release
    narrow the pins (Jamie, 2026-10-24: "filter the pins on the map: by
    search param, tag, year", then "The year should be a version ... like
    5.4, 5.3, 4.4"), as `#q=`, `#tag=` and `#v=` (a release's name, as on
    `/release/?v=`, listed newest first): the words are found by
    `POST /api/map/search` as the Search page finds them, so they never go
    in a URL a server sees, and the tag and release come from the pins. Each menu offers what the other filters leave, the
    map moves to fit what is kept, and a filter replaces the note a place
    link opened on. A note's place, on
    any page, links here (Jamie, 2026-10-24: "the links to locations now go
    to OUR map"): `/map/#d=<day>&n=<id>` opens on its spot (close in on a
    device or photo spot, the city for a chosen city) with the notes there
    already listed. The day and id ride in the `#`, so no server sees which
    note. The email's Yesterday links its places here too, and the day's own
    place as `#d=<day>&ll=<lat>,<lon>`, which opens on that city with the
    day's notes listed (no note need have a spot of its own).
    The base map is
    Amazon Location's Standard style, light or dark as the system is, drawn
    flat and north up (Amazon's style asks for a globe; Jamie wanted "a
    two-dimensional map"), and comes through `/api/map/*` under the web role: the browser holds no key
    and asks no other host, and only a signed-in owner gets it. Tiles,
    glyphs and sprites are kept by the browser for a day (`private`);
    everything else stays `no-store`. MapLibre GL runs its worker from this
    origin, so the CSP is unchanged. Tiles cost $0.04 a thousand.
13. **Profile photo** (Jamie, 2026-10-28: "I feel like a user should be
    able to create a Profile photo for themselves";
    `packages/backend/profile-photo.ts`). Settings, under Your account,
    shows it with "Add a photo" (then "Change") and "Remove". The
    page makes it: the picked photo is decoded in the browser
    (`createImageBitmap`, upright by its EXIF orientation, or an `<img>`
    from a `data:` address where that can't), cropped square from its
    middle and drawn on a canvas as a 512px JPEG (`web/src/lib/photo.ts`).
    A canvas keeps no camera details or GPS, though Safari's writes a small
    EXIF block of its own, and the web function needs no Sharp. A HEIC works where the browser
    decodes one (Safari on an iPhone or a Mac); elsewhere the page says it
    can't open it and asks for a JPEG or PNG. It goes up as any file does
    (`POST /api/uploads`), and `PUT /api/me/photo` keeps it only as a
    JPEG by its bytes, at most 256 KB, square, 128 to 512 pixels a side,
    and cuts its APP1 (EXIF, XMP), APP13 (IPTC) and comment segments out
    before keeping it, so nothing that could hold GPS is stored whatever
    sent it (refusing them turned away every iPhone, 2026-10-28). It is kept at
    `media/<owner>/profile/<id>.jpg` (tagged `profile`) and named by
    `PROFILE.photo`; a new one replaces the old only while the profile
    still names the one read, then the old is deleted. Shown only to its
    owner: `GET /api/me` says `photo: {at}`, never the key, and the page
    loads `/api/me/photo?v=<at>`, a redirect to a fresh fifteen-minute
    signed link, which the CSP's img-src allows as it does a note's photo
    (the mail bucket's host). It shows in the bar's You tab (on a phone
    and in the rail) and on You, with the You glyph when there is none.
    The export zip carries it as `profile-photo.jpg`; deleting the
    account deletes it. Not in the email, which loads nothing remote, nor
    the administrator's overview, nor MCP's `notes_account`.
14. **Easter eggs** (Jamie, 2026-10-29: "Approved: build the Developer
    mode, Status code and RTFM easter eggs in Release Notes, with the
    status line in the email on those mornings"; docs/BADGES.md, Easter
    eggs). Nothing in the tour, the front page or help copy mentions them.
    - **Developer mode**: Today's number is a `<button>` that looks
      exactly like the number, named by the version
      (`web/src/components/developer.tsx`, `web/src/lib/developer.ts`).
      Seven taps in a row (Enter and Space count; a gap over 2 seconds
      starts over) turn it on; from the fourth a polite live region under
      the number counts down ("3 taps from being a developer."). It is
      kept in this browser's localStorage, never on the server, with
      "Leave developer mode". The panel under the number, in mono, shows
      the version in hex, binary and Roman numerals (zero is N), uptime
      in seconds since local midnight of the birthday, how far through
      today's patch, and `git log --oneline` of the last ten days with
      notes, read from `GET /api/days` as the Archive reads it, each hash
      worked out from the day's first note id. The first turn on posts
      `POST /api/eggs` `{egg: "developer"}`; a failure changes nothing.
    - **RTFM**: `/man/` is Release Notes as a man page,
      RELEASE-NOTES(1), for anyone, noindex like every page but `/`.
      Its clues: a comment in `web/index.html`, a comment in
      `robots.txt` (no rule) and a line on the 404 page. Opened signed
      in, it posts `{egg: "rtfm"}`; signed out it posts nothing.
    - Each found egg is one `egg.found` activity row (via `web`), ever,
      and with "Show badges" on its secret first ("Developer mode",
      "RTFM") with the unlock line.

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
  supplies asynchronous stores/services. Mail and processing use
  Event Function workers. Only the describe worker carries Sharp's native
  Linux Arm64 image libraries.
- **Request isolation:** each HTTP request creates its own session/context;
  reusable SDK clients hold no subscriber state. Mutations transactionally
  prove the live session and account. Atomic renewal/claim/sign-up prevents
  revoked-session and deleting-account races. Existing email links, codes,
  sessions and accounts keep their wire/storage formats.
- **Every HTTP response is private:** `Cache-Control: no-store` also applies
  to redirects and errors. Listener shutdown stops accepting requests
  and drains active requests within a bounded deadline.
- **Security headers** on every response: a CSP of `'self'` (no inline
  script or style), HSTS, `DENY` framing, and a Permissions-Policy that
  allows only the microphone and the location. The CSP names its few exceptions: Tinylytics
  for the page count, the mail bucket's host for signed file links and
  uploads, and Cloudflare's challenge host (script and frame) for the
  sign-in Turnstile. Everything else goes through `/api`: the city search asks
  Open-Meteo's geocoder (no key, CC BY 4.0) from there, and the Map page's
  base map comes from Amazon Location the same way.
- **New items in the table.** `expires_at` (epoch seconds) is the table's
  TTL. The web app's first items were these; the design comment at the top of
  `packages/backend/store.ts` is the full, current layout.

  | Item                    | Key                                             | Lifetime                                                     |
  | ----------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
  | Sign-in link and code   | `LOGIN#<hash>`                                  | 15 minutes                                                   |
  | Session                 | `SESSION#<hash>`                                | 14 days from last use, renewed by each visit, no outer limit |
  | Rate-limit counter      | `RATE#<bucket>#<hour>`                          | about an hour                                                |
  | Pause                   | `USER#<id>` / `PAUSE#<start>`                   | kept                                                         |
  | Note written on the web | `USER#<id>` / `NOTE#<day>#w-<id>`, `source=web` | kept                                                         |

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
  Direct origin calls are denied by the platform. No origin-secret header
  is needed. `CloudFront-Viewer-Address` is trusted only behind this boundary.
  On `/oauth/*`, a viewer-request function changes form-encoded query spaces
  (`+`) to `%20` before OAC signs the origin request. This avoids the Web
  Function endpoint's signature rejection of that encoding; decoded values and repeated
  parameters stay the same. It never logs the query or alters consent/scopes.

- **Session**: an `__Host-` cookie, Secure, HttpOnly, SameSite=Lax. Every
  write must carry `Origin: https://notes.yourversionnumber.com`. The API
  receives only the headers it reads (Origin, Content-Type, Accept, the
  viewer address) and only that cookie.
- **Pages**: `/` (the birthday, the number it makes from `/api/sample`,
  then the email; `/#sign-in` the email alone; `/#birthday=YYYY-MM-DD` the
  number for that birthday, as if typed), `/signin/` (the link lands
  here, token in the fragment), `/setup/` (a new address's three
  questions), `/today/` (where sign-in lands), `/timeline/`,
  `/day/?d=YYYY-MM-DD` (any day, for backfill), `/release/?v=5.4`, `/badges/`, `/map/`, `/search/`,
  `/tag/?t=<tag>`, `/upcoming/`, `/upcoming-text/`, `/you/`, `/settings/`, `/activity/` (`/mail-log/` redirects there), `/book/`, `/pause/`, `/delete/`, `/unsubscribe/`, `/feedback/`, `/admin/`, `/admin-users/`, `/admin-feedback/`, `/man/`.
  `/connect/` approves an external agent request whose opaque id stays in the fragment. With no request it shows the MCP address to add, with Copy; with one, the request's question is the title, what it shares as a list, each extra approval as a ruled checkbox row, and the retention paragraphs in full above Allow.
  `/feedback/` sends Jamie feedback and shows the answers (Feedback); `/admin/` manages product updates; `/admin-users/` shows subscriber metadata; `/admin-feedback/` is the feedback queue. Administration is visible in settings only to the configured administrator.

- **Public pages**: `/how-it-works/`, `/features/`, `/guide/` and its
  pages (`/guide/start/`, `/guide/the-email/`, `/guide/replying/`,
  `/guide/address/`, `/guide/photos-and-voice/`, `/guide/places-and-map/`,
  `/guide/tags-and-search/`, `/guide/upcoming/`, `/guide/badges/`,
  `/guide/agents/`, `/guide/book/`, `/guide/export/`,
  `/guide/pause-and-stop/`, `/guide/delete/`, and for apps and scripts
  `/guide/tokens/`, `/guide/api/`, `/guide/api/clients/` and `/guide/changelog/`,
  Release Notes for Changelog, the iPhone app's own changelog), `/faq/`, `/privacy/` and
  `/changelog/` (Release Notes for Release Notes, which the version at the
  foot of Settings links to). Each is a
  Markdown file in `site/` drawn into its own `index.html` at build time,
  outside the app (Public pages, under Front end).

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
existing `/timeline/` address.

**Navigation** (Jamie, 2026-10-24, option A2 on the navigation design
canvas, https://claude.ai/artifact/SYr3VHYuSLduMpCwVcUtXj): five tabs,
Today, Archive, Map, Upcoming and You, the same on a phone and in the rail
whether "Show badges" is on or off. Search is in the header, not a tab: a
44px icon at the top right on a phone and a "Search notes" row under the
name in the rail, named "Search notes" either way; its page opens with the
box focused when nothing has been asked yet. `/you/` holds Badges (gone
with "Show badges" off), Activity and Settings, with Sign out on a phone,
where the rail's button is not. The rail adds one place the tabs don't
(Jamie, 2026-10-25: "on mobile I would put it inside of Archive? On desktop
I'd put it on it's own in the rail"): "Make a book", below You. On a phone
the Archive links to it and the book page's crumb leads back there.
A Supporting Member's rail has a mark above Sign out (Jamie, 2026-10-25:
"a permanent ribbon or affect of some sort in the left hand rail ... that
says 'Supporting Member'"): the giving star, "Supporting Member" and where
this year's membership goes, linking to Badges (`components/welcome.tsx`).
A phone has no room for it; You says the same. Every signed-in page's bar
also brings the welcome back (docs/BADGES.md). `placeOf` in `components/common.tsx` marks each page's place with
`aria-current="page"`: Day and Release mark Archive, and so does Book on a
phone; Badges, Activity, Settings, Connect, Pause, Delete and the two admin
pages mark You; Search and Tag mark the header's search and no tab; Edit
as text marks Upcoming. The admin pages are never in the navigation.

**The page system** (2026-10-24, the design refinement canvas,
https://claude.ai/artifact/D6yGSqSTcDuQAQ7VjwRbhF): one 720px column (the
Map's runs to 1040px), the title 64px from the top on every page. A page
under a tab opens with a crumb back up (`Crumb` in `components/common.tsx`):
Day and Release go to Archive, Tag to Search, Badges, Activity and Settings
to You, Pause and Delete to Settings, Edit as text to Upcoming. Actions come
in four kinds: the tangerine button (`.go`), a filled tangerine-ink danger
button (`.go.danger`), a 16px cobalt action link 44px tall (`.quiet`), and a
44px icon button in ink-3 that turns cobalt when pointed at
(`.quiet.icon-button`). Links inside a sentence keep their underline. Note
meta and counts are 13px ink-3; tangerine is for the button, the dots,
tiers and stamps. Light ink-3 is #6e7092, which passes 4.5:1 on paper. On
a phone the side margins are 20px and only the Map runs edge to edge.

Dark appearance and reduced-motion preferences
are supported. UI glyphs use Lucide React, bundled locally through the fixed
named imports in `web/src/components/icon.tsx`; unused icons are excluded from
the build. Navigation and writing tools retain visible labels. Compact edit,
delete, attach-file and write-note actions use glyphs with accessible names,
hover titles, keyboard focus rings and 44px touch targets. Delete confirmations
retain their explicit text. Upcoming kinds use Cake (birthday), PartyPopper
(anniversary), Plane (trip) and CalendarDays (one-time event), with accessible
kind/recurrence labels and hover titles. Icons and fonts require no remote loads
or new CSP exception.

- CloudFront's function answers every address that is not a file with
  `index.html`, and the router shows the page; `/` alone it answers with
  `front.html`, and an address under a public page's section with that
  page's own `index.html`, sending one without its final slash to it (a
  301). The dev server does the same.
- `front.html` is `index.html` with the front page drawn into `#app` at
  build time (`web/src/prerender.tsx`, from `vite.config.ts`), so search
  and link previews that run no script read what the page says. It is
  `Home` itself as it opens for someone signed out, asking for the
  birthday, with what that view hides left out: nothing typed twice, and
  nothing dated, fetched or personal. The app never hydrates it:
  `createRoot` replaces it as the app first draws, and `site.css` keeps it
  out of sight wherever scripts run (`@media (scripting: none)` alone shows
  it), so no one running the app sees it, signed in or out. Every other
  address keeps `index.html`'s empty `#app`, so none of them says the front
  page's words. `tests-node/front-page.test.ts` builds both pages and
  `e2e/front.spec.mjs` reads them in Chromium, with scripts and without.
- Search sees the front page and the public pages alone. `index.html`
  carries the front page's canonical link and share tags, and `front.html`
  the same head; each public page has its own. The sharing card (the
  picture, its alt text and the X card kind, today the paper mark as a
  `summary` card) is one constant, `SHARE_CARD` in `lib/share-card.ts`:
  `vite.config.ts` adds its tags to `index.html`'s head and each public
  page's shell (`site.tsx`) draws them, so a new card is a change there
  alone. `tests-node/front-page.test.ts` and `tests-node/site.test.ts`
  hold every page to it. `web/public/robots.txt` keeps crawlers off the API, OAuth and MCP
  addresses and names `sitemap.xml`, which lists `/` and the public pages,
  and the router marks every other page `noindex` as it resolves, since
  they all serve `index.html`. Those pages stay crawlable: a page
  robots.txt blocks can still be listed, because its `noindex` is never
  read.
- Each sitemap `<lastmod>` is the day that page's words last changed.
  `site/sitemap.json` holds, for `/` and each public page, a hash of what
  the built page says (title, description and its words) beside that day;
  `tests-node/front-page.test.ts` (for `/`) and `tests-node/site.test.ts`
  fail when the words change until both are moved to the day the change
  goes live. Never a build date: search ignores a `lastmod` that is always
  now. A release sends IndexNow every address whose entry here changed
  (`tools/indexnow.ts`, `infra/NATIVE-WEB.md`). `robots.txt`, `sitemap.xml` and `llms.txt` go up named UTF-8;
  `robots.txt` and `sitemap.xml` are served with their own CSP
  (`PlainFilesHeadersPolicy`), which lets the browser's viewer style the
  XML; under the app's CSP Chrome shows it unstyled, with "..." where it
  folds.
- **Public pages** (Jamie, 2026-10-29, phase 1 of the signed-out site):
  How it works, Features and the guide (phase 3), the FAQ, Privacy and the
  changelog (phase 4) are Markdown in `site/`,
  each opening with a `title:` and a `description:`; `site/faq.md` is
  `/faq/` and `site/guide/index.md` is `/guide/`. After the app's build,
  `vite.config.ts` runs `web/src/site.tsx`, which draws each, read by
  `web/src/site-pages.ts` with markdown-it (raw HTML off), inside a React
  shell (`renderToStaticMarkup`):
  the front page's bar, stylesheet and foot, the row of public links
  (`components/site-links.tsx`, also at the foot of `/`), and its own
  canonical and share tags. The app's script never loads on them; the one
  script is `assets/count-<hash>.js`, bundled from `lib/pagecount.ts` so
  the pages are counted as the app's are. The same build writes
  `sitemap.xml` (from `site/sitemap.json`, which also sets the order) and
  `llms.txt` (the pages, the MCP address and each scope in plain words).
  The features are one typed list, `lib/features.ts` (each one's head,
  line and guide page): the front page's tour draws the ones it shows, and
  a paragraph of `{features}` in a page's Markdown becomes every feature,
  linked to its guide page (`/features/`), and one of `{guide}` the guide
  pages they link, by group, leaving out any linked above it (`/guide/`).
  So the tour and the docs say the same thing, and a changed line moves
  both pages' hashes.
  A new page is a Markdown file and a line in `site/sitemap.json`; a new
  section is also a line in `WebIndexFunction`'s `PUBLIC`
  (`tests-node/infra/web-index.test.ts` holds the two together). A
  mistyped address under a section gets the bucket's bare 404.
  `tests-node/site.test.ts` builds them and checks every link, every
  number against its constant, and that no page names an Easter egg or a
  secret badge. You's Help row links `/guide/`, and the first email's
  welcome line `/guide/start/`.
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
  Tinylytics (connect), the mail bucket's host (img and media for
  signed file links, connect for uploads), plus `blob:` in media-src, and
  `https://challenges.cloudflare.com` in script-src and frame-src for the
  sign-in Turnstile (`lib/turnstile.ts`). That script loads only once
  someone focuses or types in the email field, renders explicitly and
  interaction-only into `#signin-check` (never id `turnstile`: that
  element would shadow `window.turnstile`), and when it cannot load the email
  request goes without a token and says why (`turnstile_reason`). `#signin-check` follows both the email form
  and "Check your email", and takes room only while Cloudflare is asking
  (`data-turnstile="asking"`); once answered it collapses (`quiet`), so
  "Success!" never lingers on the next step.
- **Recording on the page** (Jamie, 2026-10-09): the new-note form's
  Record button, shown only where the browser has MediaRecorder, records
  the microphone up to 30 minutes, as MP4 where the browser makes it
  (Safari, newer Chrome) else WebM or Ogg. Each recording plays back from
  a `blob:` URL and can be removed before the note is added; adding the
  note sends it like a chosen file. The Permissions-Policy allows the
  microphone and the location to the page itself and turns off the camera,
  payment and USB. The e2e test records Chromium's fake microphone.
- **Inherited place**: a note with no place of its own shows the day's city
  (or home's) in italics, unlinked, its title saying which, the same on
  its day, search and tag pages (worked out from the whole day). Where on
  it sets one, or "No place" clears it, so nothing shows.
- **Here** (Jamie, 2026-10-24): the note form's Here button, and the Where
  button on a saved note, ask the browser where it is (`web/src/lib/here.ts`)
  only when tapped, or on Today with "Add where I am" on (on unless turned
  off, Jamie 2026-10-24) as a note with no place is saved, never as the
  page opens (Jamie, 2026-10-24: "Do it when we know that we need the
  location"; a note is saved without one when the browser can't or won't
  say, and "Not there" after a Here leaves it off), and name the spot
  through `/api/places/here`, by its neighbourhood ("At Downtown West,
  Minneapolis"). "Were you at" lists the businesses near enough, and a tap
  names the note by one ("Caribou Coffee, Minneapolis"), another goes back.
  On a saved note Here saves at once and stays open on that list until
  Done. A spot within 150 m of the last one named reuses its names without
  asking the server. "Not there" takes it off for that note.
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
  The manifest's colours are the dark theme's navy (Jamie, 2026-10-28):
  an installed Android app paints the strip under the system navigation
  bar in the manifest's one colour, which can't follow dark mode, and navy
  was picked over a white strip under the dark page. The page draws under
  that bar (`viewport-fit=cover`) and pads its foot with the safe-area
  insets.
- **Build line**: the foot of Settings names the build (`lib/build.ts`):
  its version, Release Notes' own (Jamie, 2026-10-28), counted by Your
  Version Number's arithmetic from its launch on 2026-10-07 to the day it
  was made in Chicago; the
  commit, linked to GitHub; and when it was made, in the subscriber's
  zone. `vite.config.ts` stamps it in; `scripts/build-release.sh` passes
  the release's commit, since it builds from a git archive. It tells an
  installed app that hasn't reloaded from the live one.
- **Page counts** (`lib/pagecount.ts`) go to Tinylytics on each page shown,
  without the embed script: the page's address without its query string,
  and on a visit's first page the referring site's origin only. No
  cookies, nothing that names a person.
- `npm run verify` (format, lint, browser/server types and unit tests, both builds) is part of
  `validate`. `deploy.sh` builds from HEAD and syncs `dist/web`.

## API

|                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/mcp/authorize`                                                               | Inspect or approve/deny a pending OAuth request; session and Origin required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/mcp/connections`                                                              | Active agent connections, approved scopes and last use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DELETE /api/mcp/connections/{id}`                                                      | Revoke the owner's connection immediately; `?write_only=true` removes only adding permission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /api/mcp/connections/{id}/scope`                                                  | Add a permission to the owner's live connection in place: `{scope: 'upcoming'}` is the only one offered; the existing token sees it on its next request. 404 for a missing or foreign connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/mcp/activity`                                                                 | Up to 50 content-free tool records from fourteen days; successful writes include client and note references.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/tokens`                                                                       | The subscriber's own API tokens (docs/API.md), newest first: name, scopes, made, last used, expiry and whether it has expired; never a value or hash. One its own client revoked is removed for good here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /api/tokens`                                                                      | Make an API token from `{name, scopes, expiry}` (`expiry` is `90d`, `1y` or `never`; `media:write` only beside `notes:write`). 201 answers its `token`, the one time it is shown. 409 `token-name-taken` or `token-limit` (20 live).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DELETE /api/tokens/{id}`                                                               | Revoke the token at once; its next request is refused `token_revoked`. 404 for a missing or foreign token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/health`                                                                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/sample?birthday=&tz=`                                                         | a version number today: the front page's example (1981-06-14), or the birthday being typed at sign-up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/auth/start` `{email, turnstile_token, turnstile_wait_ms, turnstile_reason?}` | 202 and mails a link and code; 429 `limited` past a limit; 403 `turnstile` only in enforce mode, for a missing or failed token (`packages/backend/turnstile.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/auth/verify` `{email, code}` or `{token}`                                    | sets the cookie; says whether the account is new                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/auth/signout`                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/activity?before=`                                                             | the owner's activity log, newest first, 100 rows a page: `email`, `tz`, `today`, `entries` and `next` (the `before` of the next page, or null). Each entry has `id`, `at` and `kind`; a mail row adds `message`, `received_at`, `via` reply or address, `day`, `version`, `subject`, `outcome` filed, not-filed or failed, `reason`, `sender` when it was another address, `text` only for a row not filed whose sender was proven, `attempts` and `notified`; a reads row adds `day`, `client`, `connection`, `calls`, `tools`, `errors` and `last_at`; every other row adds the fields its kind keeps (`packages/domain/activity.ts`), and one naming an Upcoming date (`upcoming`) its `title` as it is now, or null once removed. 400 `before` for anything but a row id or time. No table keys                                                      |
| `GET /api/places?q=`                                                                    | city search, through Open-Meteo; needs a session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/places/here` `{lat, lon, accuracy_m}`                                        | names the device's spot through Amazon Location (told the coordinates alone): `{name, region, country, tz, district, nearby, lat, lon, accuracy_m, from: "device"}`, `name` the city, `district` its neighbourhood when known, `nearby` up to six businesses within the accuracy (50 to 200 m) as `{name, lat, lon, distance_m}`, the spot kept to six places, for a note's `place` (with `venue` set to a picked one; `nearby` is never kept). 404 `place-unnamed` where no city is found, 502 `places-failed`; needs a session                                                                                                                                                                                                                                                                                                                         |
| `GET /api/me`                                                                           | the profile, or `{new: true, email, weekly_thing?}` for an address signing up; `inbox` is the standing address; `badges` is "Show badges"; `here` is "Add where I am"; `photo`, `{at}`, says there is a profile photo and when it was set (never its key); `weekly_thing` is the address's Weekly Thing standing (`member`, `reader`, `unconfirmed`, `none`), absent until a lookup has answered, and looked up again after nine days (ten minutes while unconfirmed) and on the first call after a sign-in; `admin: true` only for the configured administrator                                                                                                                                                                                                                                                                                         |
| `PUT /api/me`                                                                           | sign-up (`birthday`, `place`, `send_time`), or settings (`send_time`, `place`, `transcribe`, `describe`, `badges`, `here`, `status: "active"` to start again); the birthday cannot change. `badges: true` after `false` counts everything earned meanwhile as seen. Sign-up answers 403 `weekly-thing` for an address not on the Weekly Thing's list and `weekly-thing-unconfirmed` for one not yet confirmed                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/export?format=md\|json`                                                       | the words alone, as a download (JSON by default), with a `badges` list (a Badges section in Markdown), oldest first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/export/zip`                                                                  | start a zip of everything, photos and recordings too (202); answers with the build already going, if one is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/export/zip`                                                                   | how it is going: `none`, `building`, `failed`, or `ready` with size, files and until                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/export/zip/file`                                                              | the built zip: a redirect to a five-minute signed link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/book`                                                                         | the book building or built, with its `page` size: `none`, `building`, `failed` (`reason: empty` when its days had no notes, `commentary` when Claude couldn't write it), or `ready` with size, pages, photos, missing and until; `annotated` when it asked for Claude's commentary, and for a Supporting Member or the administrator `commentary`: `left` of `max` for this `release`, and `max_days`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/book`                                                                        | start a book of `from` through `to`, with an optional `title`, `page` (`6x9`, the default, or `letter`) and `commentary: true` (202; 400 `date`, `title`, `book-page`, `book-empty`, `book-photos`, `book-commentary`, `book-commentary-days`; 403 `book-commentary-members`; 409 `book-commentary-left`); answers with the build already going, if one is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/book/plan?from&to`                                                            | what those days hold (days, notes, photos, voice memos) and the title a book of them gets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/book/file`                                                                    | the built PDF: a redirect to a five-minute signed link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/upcoming`                                                                     | owner-only saved `entries`, each with its next/current/past `occurrence` (`date`, `end_date`, `days_until`, `status`, `line`); local `today`, `tz`, and retained-entry `limit` (200). No table keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/upcoming`                                                                    | create a private date (201): `kind`, `title`, `date`, optional `tag`, `year`, `end_date`, `place`, `email`, `reminders`; see Upcoming below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PUT /api/upcoming/{id}`                                                                | replace an owned date with the same fields and its saved `revision`; 409 for stale revision, 404 for a missing/foreign entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DELETE /api/upcoming/{id}` `{revision}`                                                | delete an owned date using its current revision; frees retained-entry capacity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /api/upcoming/batch`                                                              | many dates in one atomic request: `add` (entry fields, `place` may be destination text), `change` (the same plus `id` and `revision`), `remove` (`id` and `revision`); `dry_run: true` checks, resolves destinations and returns the `plan` without saving. Problems name the `list` and `index`; 409 `upcoming-conflict` when a revision or the 200-entry capacity changed underneath                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/calendar`                                                                    | make the private calendar link, or a new one in place of the old, which answers nothing from then on: `{calendar}`, the feed's URL; 409 `try-again` if another tab changed it first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DELETE /api/calendar`                                                                  | remove the link; `{ok: true}`, even when there was none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/calendar/{token}.ics`                                                         | the iCalendar feed of the link's owner's Upcoming dates, `text/calendar`; the link is the proof, no session or cookie; 404 `not-found` for any other token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/today`                                                                        | today: version, the year's 24 dots, the next release, today's notes, the streak (today counts once it has a note)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/days?before=&limit=`                                                          | the timeline, 30 days a page; `before` in the answer is the next page's cursor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/releases`                                                                     | the releases index: each release with notes, and the current one (`current`), newest first, with `from`, `through`, `days` (with notes) and `notes`; from the notes' keys alone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/releases/{v}?after=&limit=`                                                   | one release (`4.5`): its head (`from`, `through`, `current`, `days_with_notes`, `notes`, `longest`, `badges` (not with badges off) with its coverage tier and special days `collected` by kind with a `count`, `giving` (only when there is some) the nonprofits given to as a Supporting Member while it ran, `tags` by count) and its days with notes, oldest first, 30 a page; `after` in the answer is the next page's cursor. 404 `release` for one not begun                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/badges`                                                                       | the subscriber's badges as of their `today` (with `tz` and today's `version`): `count`; `earned`, newest first, each with `key` (`id`, or `id:level` for a track tier), `name`, `line`, `shelf` (`track`, `first`, `craft`, `collectible` or `giving`, a year given as a Supporting Member, `giving-2026`), `earned` (the day it came true), and the `day` and `version` it is stamped with (a collectible's special day); `tracks` (`tier` 0-5, `level`, `best`, `now`, `since`, `next`); `release`, this release's `days`, `percent`, coverage `level`, `next` only while it can still be reached, `following` (the next release and its date), its `collected` special days and the next three `ahead` (never a secret one); `missing`, what is still to find, a secret one as its `hint` alone. Read from the notes' stored fields, never their text |
| `GET /api/badges/new`                                                                   | what was earned and not yet told (`seen`), in the order earned, one tier a track (its highest): `badges`, each with `key`, `id`, `name`, `line` and `version`, and `keys`, every untold key a track's lower tiers included; empty while "Show badges" is off. The page shows it once, on the first signed-in page of a visit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/badges/seen`                                                                 | mark `keys` (at most 500, each an earned badge's key; anything else is left out) as told, so the email doesn't tell them again: `seen`, how many (400 `badges-seen`; nothing while "Show badges" is off)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /api/eggs` `{egg}`                                                                | an easter egg found (`developer` or `rtfm`, docs/BADGES.md): one `egg.found` activity row the first time, nothing after; `unlocked` when it earned a badge and "Show badges" is on, and nothing about any other egg (400 `egg` for any other name)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/map/notes`                                                                    | the Map page's pins: each note with a place of its own and coordinates, as `date`, `id`, `lat`, `lon`, `place` (its label), `exact` (a device or photo spot, not a chosen city), `tags` (its hashtags), `release` (the release its day falls in, as `4.5`), `version` (its day's, as `4.5.113`) and `text` (its first 140 characters); `notes`, how many notes there are in all                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/map/search` `{q}`                                                            | which pins have every word or "quoted phrase", matched as `POST /api/search` matches, as `found` (`date` and `id` alone) with the `terms`; the words never go in a URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/map/style/{scheme}`                                                           | Amazon Location's Standard style, `Light` or `Dark`, with its tiles, glyphs and sprite pointed at the routes below; any other source is dropped. Kept by the browser for a day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/map/tiles/{z}/{x}/{y}`                                                        | one vector tile of the base map, kept by the browser for a day; 404 outside the zoom's grid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/map/glyphs/{fonts}/{range}`                                                   | the style's font glyphs for one 256-character range (`0-255.pbf`), kept by the browser for a day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/map/sprites/{scheme}/{sprite}`                                                | the style's sprite sheet, `sprites.json`, `sprites.png` or their `@2x`, kept by the browser for a day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/days/{date}`                                                                  | one day: version, notes (each note's `parts` is its text split into strings and links by name; a note with no place of its own has the day's city or home's as `place` with `place_from` `day` or `home`, and no `map`), `weather`, the day's recorded weather as a line, when kept, `where`, the day's own place by name, when set, and `collected`, the special days (by name) a day with notes collected (not with badges off)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/days/{date}/notes`                                                           | write for today or a past day; `uploads` attaches files, and a note with files may have no text; `place` (a city from `/api/places`, or a spot from `/api/places/here`) says where. Answers with the note and `unlocked`, what it just earned in the order it came true (`key`, `id`, `name`, `version`; `album` for this release's special day collected again), left out with badges off or when that could not be read; the badges in it become `seen`                                                                                                                                                                                                                                                                                                                                                                                                |
| `PUT/DELETE /api/days/{date}/place`                                                     | set the day's own place (a city from `/api/places`) or clear it; answers `{date, where, weather}`, the past day's weather fetched again for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PUT/DELETE /api/days/{date}/notes/{id}`                                                | edit, delete (an emailed note's email and files go with it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PUT/DELETE /api/days/{date}/notes/{id}/place`                                          | set (`place`, as for a new note) or clear where any note was, whatever channel brought it; answers the note, the past day's weather fetched again for it. Leaves `updated_at` alone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/days/{date}/notes/{id}/media` `{uploads}`                                    | add files to a note already there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/days/{date}/notes/{id}/media/{n}`                                             | a file: a redirect to a fresh signed link, for its owner. Every file in an answer already carries `url`; this is the fallback once it has run out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/uploads`                                                                     | a signed form for one file, of the type and exact size given, for five minutes; 429 `upload-limit` past the day's ceilings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/tags`                                                                         | every tag, most used first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/tag-row`                                                                      | the tag row under the note box (packages/backend/tag-row.ts): `pinned`, the pinned tags in order; `recent`, the tags used most in the last 30 days that aren't pinned, each `{tag, count, last_used}`, at most 20; `window_days`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PUT /api/tag-row` `{pinned}`                                                           | replace the pinned tags, at most 12, normalized as hashtags and each once; answers the new row. 400 `pins` for anything else, 409 `try-again` when another change raced it; a change is one `settings.changed` row (`pinned_tags`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/tags/{tag}`                                                                   | every day with a note tagged so, newest first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /api/search` `{q}`                                                                | notes with every word or "quoted phrase"; the words never go in a URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PUT /api/pause` `{days}` or `{through}`                                                | pause, or change the pause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DELETE /api/pause`                                                                     | resume now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /api/me/weekly-thing`                                                             | adds the session's verified address to the Weekly Thing through the Librarian (never a typed one; works before the account exists): `{weekly_thing}`, `unconfirmed` once Buttondown has sent its confirmation, or the standing it already had. 409 `weekly-thing-review` (held by Buttondown's firewall) or `weekly-thing-by-hand` (can't be re-added automatically), 503 `weekly-thing-busy`, 404 `weekly-thing-off` with no Weekly Thing configured                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/me/inbox`                                                                    | a new standing address in place of the old one, which files nothing from then on; answers `{inbox}`; 409 `try-again` if another tab changed it first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/me/photo`                                                                     | the profile photo: a redirect to a fresh fifteen-minute signed link, for its owner; 404 `photo` when there is none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PUT /api/me/photo` `{upload, type}`                                                    | keep a photo sent with `POST /api/uploads` as the profile photo, replacing any before (deleted): a JPEG at most 256 KB, square, 128 to 512 px a side, kept with its EXIF, XMP, IPTC and comments cut out (400 `photo-type`, `photo-too-big`, `photo-size`, `upload`; 409 `try-again` if another tab changed it first). Answers the profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DELETE /api/me/photo`                                                                  | remove the profile photo and delete its file; answers the profile, even when there was none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/me/delete-code`                                                              | mails the account's address a code to confirm deleting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DELETE /api/me` `{code}`                                                               | deletes everything; needs that fresh code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/unsubscribe?t=`                                                              | the email's one-click unsubscribe (RFC 8058); the token is the day's reply token, and this is the one write without an Origin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/unsubscribe?t=`                                                               | redirects to `/unsubscribe/`, a page with a button, for mail apps that open the link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/feedback`                                                                     | the owner's feedback, newest first (`items`, each with its answers and screenshot numbers, never a file key), `filed_today`, `per_day` (10), `screenshots_max` (3) and `screenshot_bytes` (768 KiB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/feedback` `{kind,text,follows?,screenshots?}`                                | files one item (201): `kind` bug, idea, question or other; `text` up to 4,000 characters; `follows` an earlier item's id; up to 3 screenshots as `{type,data}` (PNG, JPEG or WebP, base64, 768 KiB each decoded), stripped of metadata before they are kept. 400 `feedback-kind`, `feedback-text`, `feedback-too-long`, `feedback-follows`, `feedback-image-count`, `-type`, `-data` or `-too-big` (with `index`); 429 `feedback-limit`; 409 `feedback-conflict`. The body may be about 3.1 MiB                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/feedback/{id}/screenshots/{n}`                                                | redirects (302) to a fifteen-minute signed link to the owner's screenshot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/admin/feedback`                                                               | administrator only: every account's feedback, newest first, each with `owner`, `email` and `account` (its status)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/admin/feedback/{owner}/{id}/answers` `{text,status,revision}`                | administrator only: appends one answer (201, `{item, mail}`) with the status it sets (`answered`, `needs_info`, `done`) and emails the filer once while their account is active (`mail` `sent`, `failed` or `not-sent`). 404 `feedback-missing`; 409 `feedback-changed` (stale revision) or `feedback-full` (20 answers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /api/admin/feedback/{owner}/{id}/screenshots/{n}`                                  | administrator only: the same signed link to that account's screenshot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/admin/users`                                                                  | administrator only: `users` with email, status (`active`, `paused`, `stopped`), stopped_reason, pause_through, joined_at, tz, send_time, last_sent_date, last_added_at, entries and days; `as_of` is the snapshot time; nullable metadata is null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/admin/updates`                                                                | administrator only: saved drafts and schedules (`updates`), and the administrator's local `today`; each update has `id`, `title`, `text`, named `links` and rendered `parts`, `revision`, `status`, `date`, `created_at`, `updated_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/admin/updates` `{title,text}`                                                | administrator only: create a draft (201), without scheduling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PUT /api/admin/updates/{id}` `{title,text,revision}`                                   | administrator only: edit a draft; scheduled text cannot be edited until cancelled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `DELETE /api/admin/updates/{id}` `{revision}`                                           | administrator only: delete a draft                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/admin/updates/{id}/schedule` `{date,revision}`                               | administrator only: reserve one date with a saved text snapshot; dates cannot precede the administrator's today; 409 for an occupied date or stale revision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DELETE /api/admin/updates/{id}/schedule` `{revision}`                                  | administrator only: cancel its schedule and return to a draft; does not retract emails already sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Badges earned outside notes** (2026-10-29, `docs/BADGES.md`): `PUT
/api/me/photo` (Signed commit, the first photo only), `POST /api/feedback`
(Issue opened), `POST /api/book` (Tarball), `POST /api/upcoming` and `POST
/api/upcoming/batch` (the Roadmap, for dates added) also answer with
`unlocked`, in the same shape as a note's, but only when something was
earned; with nothing earned, badges off or a failed read the field is left
out. What they answer becomes `seen`, and the same write records one
`badge.earned` row per badge. `POST
/api/admin/feedback/{owner}/{id}/answers` marking an item done earns the
filer Merged upstream: rows only, via `admin`, told in their next email.

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

**Editing as text.** `/upcoming-text/`, linked from Upcoming, shows every saved
date as one line (`packages/domain/upcoming-text.ts`): the kind and the date
first, then the title as free text, then any of `#tag`, `@destination`,
`email:off` and `remind:30,7,0`. Nothing has to line up in columns. Preview
parses the text in the browser, pairs lines with saved dates by kind and
title, and asks the API for a dry run, which resolves destinations and shows
what would be added, changed and removed; Apply sends the same batch, which
commits all of it or nothing. A deleted line removes its date. Agents do the
same through the MCP `upcoming` scope (`docs/MCP.md`).

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
entries. Empty sections disappear. Reminders travel in the existing daily
email, and in apps the owner turns them on in, which read the same lines from
`GET /v1/upcoming/reminders` (docs/API.md): no extra sends from the server,
catch-up messages, tracking or changed reply ownership.
Optional read failures omit Upcoming without holding the daily email. Pauses,
stopped accounts and the daily-send claim retain their existing behavior.

The page shows annual dates' next occurrence, active trips and future events;
completed trips/events remain under **Past dates**, editable or deletable.
Each date is one row (a table read as rows: when, then what it is with its
kind, tag and "daily email" or "web only" beneath, then Edit), ordered by
occurrence date ascending (including past dates). Delete is at the foot of
Edit, so a row carries one action, or two with a tag. On a phone the date
sits over the title.
Trips store a destination only in this first stage. They do not change the
account's saved home, time zone, forecast or default note location. Automatic
travel switching remains future work. Kind and Tag filters combine across both
future and past entries; Tag also offers **No tag**. **Words** (2026-10-17)
filters as you type: every word or "quoted phrase" must appear, without case or
accents, in the title, tag, kind, destination or the occurrence line (so "5.0.0"
or "major" finds a birthday), through the note search's term rules
(`upcomingSearchText` in `packages/domain/upcoming.ts`). It reads the list already
loaded; no request carries the words. Filters are kept in the page fragment
across reloads (`kind`, `tag`, `q`), with matching counts and a clear action. New dates start
with the selected kind/tag. Existing tags are suggested in the editor.
**Write a note** on a tagged entry opens today's editable draft with its hashtag,
preserving existing draft text and avoiding a duplicate hashtag. The tag travels
in a fragment, never a server-visible query. Nothing is saved until the owner
submits the note; there is no separate event-note relationship, and changing an
event's tag does not change saved notes. Notes remain the owner's account of what
actually happened.

**In your calendar** (2026-10-17): the page offers a private iCalendar link,
`/api/calendar/<token>.ics`, 120 random bits naming the owner
(`CALENDAR#<token>`, `PROFILE.calendar`), made and replaced on the page, never at
sign-up. The link alone opens the feed, with no session and no cookie, so the
page says to keep it private; **New link** replaces it (the old one answers 404
from then on) and **Remove link** ends it. **Subscribe** is the same link as
`webcal:`, which opens Calendar on Apple devices; elsewhere the link is pasted
as a calendar from a URL. The feed (`packages/domain/calendar.ts`) holds every
saved date as an all-day event: trips over their inclusive days, one-time events,
and annual dates once a year from last year through three years ahead, each
birthday with the version it turns that year (a leap day on March 1 outside leap
years, as in the email) and a known anniversary with its count of years. A tag
and "A major release." go in the description, a destination in the location.
No alarms: reminders travel in the daily email and in apps, never the feed. Entries' own update times
stamp the events (`DTSTAMP`, `LAST-MODIFIED`, `SEQUENCE` is the revision), so an
unchanged feed reads the same twice and calendar apps update in place. The
token is never logged (reads log the owner and a count) and never exported; a
deleted account's token goes with its profile.

Upcoming entries are included in JSON, Markdown and ZIP exports, in a separate
`upcoming` collection/section (omitted when there are none for legacy export
compatibility), and removed by purpose-verified account deletion with every
other USER row. Note scopes never reach Upcoming; only the separate
`upcoming` scope does (`docs/MCP.md`).

## Feedback

Jamie, 2026-10-28: "we have no way to get Feedback from users of release
notes. It would be nice to have a way users could submit feedback of a
type, and then Claude could work on those and post a reply to the feedback
as well." Elixir's feedback system is the model.

`/feedback/` (You, Feedback) sends one item: a kind (something wrong, an
idea, a question, something else), the words, and up to three screenshots
(Jamie, 2026-10-28: "Make sure a user or agent submitting feedback can
attach a screenshot"). The page says plainly that Jamie reads every item.
The browser opens each picture (a HEIC too, where it can), draws it again
on a canvas at most 2,400px on its longer side and sends a PNG when one fits
in 768 KiB, else a JPEG (`web/src/lib/screenshots.ts`); the server checks the
bytes and strips EXIF, XMP, GPS and text blocks again in plain code
(`packages/backend/inline-images.ts`, no Sharp in the web function) before
it stores each one at `media/<owner>/feedback/<id>-<n>.<ext>`. Screenshots
are shown only by signed links, and no model reads them. An assistant files
the same record through `notes_send_feedback` (docs/MCP.md).

An item is never edited or withdrawn. Jamie's answers are appended one at a
time, each with the status it sets: open (waiting), answered, needs_info
(Jamie asked something) or done. A follow-up, or an answer to Jamie's
question, is a new item that `follows` the first. Ten items a UTC day an
account, across the web and assistants (`FEEDBACKRATE#<day>`, counted in the
same transaction as the item).

`/admin-feedback/` is the administrator's queue: every account's items,
newest first (waiting ones by default), with the address and account state,
the screenshots by signed link, and an answer form with the status. Each
answer sends one email to the filer, plain text and HTML with nothing remote
and no tracking, only while the account is active (not stopped or being
deleted); a failed email never undoes the answer. `tools/feedback.ts` does
the same from the Mac (docs/OPERATING.md).

The activity log has `feedback.filed` and `feedback.answered` rows: the
item's id, kind, how many screenshots, the status set and whether the email
went, never the words. Feedback and its screenshots are in the export
(`feedback` in the JSON, a Feedback section in the Markdown, the screenshots
as `files/<day>-feedback-<id>-<n>.<ext>`) and go with the account.

## Product updates

The administrator signs in through the same email link/code as everyone else.
`AdminUserId` is a CloudFormation parameter, default empty (access disabled),
passed only to the web function as `ADMIN_USER_ID`. Set it to the existing
subscriber id for the operator's verified address, outside this public repo.
Set it with `./deploy.sh --admin-user-id=ID` from the Mac. Omitting the
option preserves the assignment; an explicit empty value disables it. Never
write the operator's id into source.
Account recreation gives a new id and requires a new assignment. The API
checks the configured id on every request; the same write transaction proves
the live session, current account/address, draft revision and date-slot ownership.

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

Use the green PR/validate gate; a merge releases and a revert rolls back
(`infra/NATIVE-WEB.md`). Unit, browser and load tests use the
local harness and fictional subscribers. Never
sign in against production or write live data to verify a release. Read-only
live checks may inspect public health/discovery and unauthenticated origin
protection; the release probe invokes workers only with `{"self_test":true}`.

## DNS (Route 53, as code)

`yourversionnumber.com` is a Route 53 hosted zone, and every record in it is
code in the zone's CloudFormation stack in `~/Projects/projects-sysadmin`
(`config/dns-<zone>-stack.yaml`; `docs/DNS-MIGRATION.md` there). Never edit a
record in the console. Namecheap stays the registrar. Two records serve this
app, both in that stack today. Jamie decided (2026-10-28, "Product repos")
that a site's records move into its own repo's stack, each move a change of
its own; this repo's have not moved yet:

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
export preserves provenance. The separate `upcoming` scope, its own
checkbox on `/connect/`, lets an agent list, add, change and remove
Upcoming dates through the same capture function; Settings shows it on the
connection, and an existing connection gains it only when the owner chooses
"Allow Upcoming" for it in Settings (no reconnect needed). `workers/capture.ts` is private, invoked only by MCP,
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
