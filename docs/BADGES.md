# Badges

Designed 2026-10-20, with Jamie's calls made the same day (at the end,
under "Jamie's calls"). Steps 1 and 2 of the build order are built: the
evaluator, `GET /api/badges`, the Badges page, the unlock line, the Day and
Release page lines and the export. Step 3 is built: the "Show badges"
setting, the `BADGES` item, the baseline tool, both email lines and the
birthday block. The launch product update is Jamie's to write. Step 4 is
built: `notes_badges` for agents. Four firsts earned outside notes and
the Roadmap track followed on 2026-10-29 (Jamie's calls, 2026-10-29), and
the easter eggs the same day (Easter eggs).

Release Notes works when people write most days. Badges should make
showing up feel good and make the version number more fun to live with,
without turning a journal into a chore. They have two jobs:

1. **Reward rhythm, not perfection.** Most of the weight sits on
   consistency measures that forgive a missed day, and on totals that only
   go up. People who miss a day still keep a habit (Lally et al., 2010: one
   missed opportunity "did not materially affect" habit formation), so the
   design never treats a miss as a failure.
2. **Teach the product through play.** Each first-time badge is a feature
   someone may not know about: replying to the email, photos, voice memos,
   places, hashtags, the standing address, filling in a past day.

The fun comes from the product's own world. Your birthday is a release,
every day is a patch, and the badges speak release engineering: tiers run
alpha, beta, rc, stable, LTS, and every badge is stamped with the version
you earned it on.

## Rules it keeps

These were decided earlier and the design follows them:

- **Late notes mend their day** and a break resets quietly. A missed day is
  never called out (streak rules, 2026-10-07: "we don't need to be
  obsessive").
- **Paused days** neither break a run nor add to it.
- **Imported days count** toward every streak and count (2026-10-09), so
  Day One history earns badges with the dates it really happened.
- **No rotating list of prompts** (2026-10-07: "keep it simple"). Nudges
  as such are fine (Jamie, 2026-10-20: "Badges are a form of a nudge. I
  think that is fine.").
- **The email is type on paper** and loads nothing remote. Badges get at
  most one quiet line.
- **No model processing of notes.** Every badge is a count over fields
  already stored: dates, sources, files, places, weather, hashtags and word
  counts.
- **Counts, not people.** No leaderboards, no sharing, no comparison with
  anyone, and no per-person numbers on the dashboard.
- **No extra emails.** Badges travel in the daily email or not at all.

And three new ones:

- **Nothing is taken away.** A tier is earned at your best run, never your
  current one, so a break costs nothing you have already earned. (Deleting
  the note that earned a badge does remove it: the notes are the truth.)
- **Never show a miss.** The page lists what you have collected and what is
  ahead, never a special day that went by without a note, and never a tier
  that can no longer be reached (late in a release, coverage says when the
  next release starts instead of "76 more days" when 75 are left).
- **A few words count.** The ask is "a few words, a photo, a voice memo",
  so no badge rewards length beyond a single one-off (RFC).

## Five shelves

| Shelf            | What it rewards                                            | How it renews                                  |
| ---------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Tracks           | Consistency, in five tiers                                 | Tiers climb for years                          |
| This release     | Coverage of the current year of life, and its special days | Starts over every birthday                     |
| Firsts and craft | Trying each part of the product, richer notes              | Earned once                                    |
| Collectibles     | Notes on special version numbers, some secret              | Earned once, and again in each release's album |
| Giving           | Each year given as a Weekly Thing Supporting Member        | One a calendar year                            |

### Tracks

Five tracks, each with five tiers: **alpha, beta, rc, stable, LTS**.

| Track               | Counts                                       | alpha | beta |  rc | stable |   LTS |
| ------------------- | -------------------------------------------- | ----: | ---: | --: | -----: | ----: |
| Continuous delivery | Days in a row with a note, at your best      |     3 |    7 |  30 |    100 |   365 |
| Cadence             | Weeks in a row with notes on at least 4 days |     2 |    4 |  12 |     26 |    52 |
| Patches shipped     | Days with notes, all time                    |    10 |   50 | 100 |    365 | 1,000 |
| Coverage            | Share of one release's days with notes       |   25% |  50% | 75% |    90% |  100% |
| Roadmap             | Dates added to Upcoming, all time            |     1 |    5 |  15 |     40 |   100 |

- **Continuous delivery** is the existing streak (`packages/domain/streak.ts`)
  with today included, so a note saved today counts at once. Late notes
  mend, paused days are skipped.
- **Cadence** is the forgiving one, and the one to lead with. A week runs
  Monday to Sunday in the subscriber's zone and is steady with notes on four
  of its days; paused days lower the bar to the days left (a pause already
  set for later in the week counts at once), and a fully paused week is
  skipped. The week in progress joins the run as soon as it
  is steady and never breaks it.
- **Patches shipped** only goes up.
- **Coverage** belongs to one release, birthday to birthday
  (`releaseSpan`): days with notes over that release's 365 or 366 days. It
  only rises during a release, so it is never lost, and every birthday
  starts a new one. The track shows the best release's tier; the page also
  shows the current release.
- **Roadmap** (Jamie, 2026-10-29) counts the distinct Upcoming dates ever
  added: every `upcoming.added` row in the activity log and every
  `UPCOMING#` entry's `created_at`, joined by the entry's id, so a date
  counts once however it came in. Deleting a date takes nothing away, so
  best and now are the same number and it never falls. Its line reads
  "Added a date to Upcoming." for one, else "N dates added to Upcoming.".
  Upcoming counts toward nothing else: no streak, count or other badge.

### Firsts

Most of these land in the first week. Each one points at a feature.

| Badge            | Earned by                                                                 |
| ---------------- | ------------------------------------------------------------------------- |
| Hello, world     | Your first note                                                           |
| ACK              | Answering the daily email                                                 |
| Web release      | Writing a note on the web                                                 |
| Webhook          | Sending a note to your own standing address                               |
| Pair programming | A note added by an agent you connected                                    |
| Release assets   | Attaching a photo                                                         |
| Audio changelog  | Adding a voice memo                                                       |
| Geotagged        | A note with a place                                                       |
| git tag          | Using a hashtag                                                           |
| Dependencies     | A link in a note                                                          |
| Commit message   | A note of twenty words or fewer. Small commits ship.                      |
| Hotfix           | Filling in a day after it ended, for a day that had no note (not imports) |
| Backport         | A note for a day at least 30 days back (not imports)                      |
| Signed commit    | Adding a profile photo                                                    |
| Issue opened     | Sending feedback, on the web or through an agent                          |
| Merged upstream  | Feedback you sent marked done                                             |
| Tarball          | Making a book of your notes                                               |
| Developer mode   | Secret: "Tap, tap, tap…". Tapping your version seven times (Easter eggs)  |
| RTFM             | Secret: "Read the manual.". Reading the manual at `/man/` (Easter eggs)   |

The last four are the first firsts earned outside notes. They are read
from the activity log (`photo.set`, `export.book`, falling back to the
profile photo's own time when no row says when it was set), `FEEDBACK#`
(when an item was filed, and the first answer that marked one done) and,
for the Roadmap, `UPCOMING#`. Like a track's tier, they are never taken
away: removing the photo keeps Signed commit. Pair programming is also
earned by an agent editing a note (a `note.edited` row through an
assistant), so it stays when that note is deleted. Each time becomes its
day in the subscriber's zone, clamped to today, and joins the replay in
order (`badgeEventsOf`). A failed read of any of these leaves its badges
out, logs a scrubbed `badge-facts-partial` line (user id and which read)
and never fails the badges, nor writes a `badge.earned` row for them.

### Craft and conditions

| Badge             | Earned by                                             |
| ----------------- | ----------------------------------------------------- |
| Full stack        | One day with words, a photo and a voice memo          |
| RFC               | More than 1,000 words in one day                      |
| Taxonomy          | Ten different hashtags                                |
| Multi-region      | Notes from five different cities, home included       |
| i18n              | A note from a country other than home                 |
| Cold start        | A note on a day whose high stayed below freezing      |
| Hot reload        | A note on a day that reached 32 °C (90 °F)            |
| All-weather build | Notes on a day of rain, a day of snow and a clear day |

The weather badges read the day's stored weather (`WEATHER#<day>`), the same
record the day pages show, so they cost nothing new and follow the day's
place. Open-Meteo's credit stays wherever weather shows; a badge description
names the condition, not the data.

### Giving

Added 2026-10-25 (Jamie: "Yearly giving badge is EXCELLENT! Love that."),
the one shelf not worked out from notes. Weekly Thing Supporting
Membership gives 100% to one nonprofit a calendar year, so each year a
Weekly Thing lookup sees a member is a badge named for that year's
nonprofit:

> Supported Signal. A Weekly Thing Supporting Member in 2026, the year
> membership went to Signal.

- **The facts** are the profile's `giving` (`packages/domain/giving.ts`): a
  calendar year with the first and last local days a lookup answered
  `member`, recorded wherever the standing is looked up (sign-up, a visit,
  the sender after an email; AGENTS.md, Subscribers and accounts). The
  badge is stamped with the first day seen and joins the replay in date
  order.
- **Nothing is taken away.** A year is only ever widened, so a lapsed
  member keeps every year they gave. `Store.widenGiving` adds the year and
  moves each end as separate conditional writes, so a visit and the sender
  looking at once can neither narrow a year nor drop a new one, and only
  the lookup that added a year writes its activity row. A step refused
  because the other got there first (on the web, the guard reports it as a
  cancelled transaction) is read again and passed. The year is written
  before the standing's time, so a failed write is asked again next time.
- **This year's is still to find** until earned (Jamie, 2026-10-25: "I
  don't have any issue with the giving badge being in still to find. We
  should be encouraging people to be a supporting member."). Its hint
  says this year's nonprofit gets 100% of membership, and the page links
  the members page beside it. An earlier year can no longer be given, so
  is never listed.
- **The nonprofits** are `NONPROFITS`, copied from the Weekly Thing's
  members page data. A year seen before its nonprofit is listed earns its
  badge once it is, told in the next email as usual (no activity row then).
  Release Notes first asked on 2026-10-25, so no earlier year is known.
- **The glyph** is a star, the Weekly Thing's gold star for its members.
- **The birthday** block and the release page thank the member by the
  nonprofits given to while the release ran: "During 5.4 you supported
  Signal as a Weekly Thing Supporting Member. Thank you." That line is a
  thank-you rather than a badge, so it shows with "Show badges" off too,
  and in a release with no notes it is the whole block ("5.4 is closed.").

### Collectibles

Notes on special version numbers. You see your number every morning, so
these make the number itself a game. Secret badges show only their hint
until earned.

| Badge                                             | The version                                        | How often           |
| ------------------------------------------------- | -------------------------------------------------- | ------------------- |
| Release day                                       | x.y.0, your birthday                               | Yearly              |
| Code freeze                                       | The last patch before a birthday                   | Yearly              |
| Round number                                      | .100, .200 or .300                                 | 3 a year            |
| Palindrome                                        | Digits that read the same both ways: 5.4.45, 5.5.5 | 2 to 5 a year       |
| Backward compatible                               | The same patch as one release earlier              | Any day             |
| Version history                                   | Notes in five different releases                   | Once                |
| Don't panic (secret: "The answer.")               | .42                                                | Yearly              |
| Overflow (secret: "A byte can't hold it.")        | .256                                               | Yearly              |
| Pi (secret: "Irrational.")                        | .314                                               | Yearly              |
| Leap patch (secret: "Not every release has one.") | .365, only in a release with a February 29         | About 1 year in 4   |
| Straight (secret: "1, 2, 3…")                     | Digits counting up by one: 4.5.67                  | A few in a lifetime |
| Status code (secret: "Some patches have a status.") | An HTTP status: .100, .101, .200, .201, .204, .301, .304 or .307 | Up to 8 a year |
| Found (secret: "Lost and found.")                 | 4.0.4, once                                        | Once                |
| I’m a teapot (secret: "Short and stout.")         | 4.1.8, once                                        | Once                |
| Major release                                     | x.0.0                                              | Once a decade       |

**Each release has an album.** Every release has its own set of special
days (Release day, the round numbers, the palindromes, .42, .256, .314,
Code freeze), about a dozen. The page shows the current release's
collected days, stamped, and the next few ahead with their dates. It never
shows a count out of a total and never lists a day that passed without a
note. Secret days appear only once collected. Collectibles are lifetime
badges the first time and album entries every time, so a long-time writer
always has something this year.

A note for that day counts whenever it was written, as with streaks. Writing
honestly about a past palindrome day is journaling, not cheating.

## Where badges show

### The Badges page

`/badges/`, linked from the streak line on Today ("33 badges") and from the
You tab (2026-10-24, which took the Archive head's link), whose mark it
carries. No tab of its own: the bar holds five.

From the top:

1. **The count and the latest:** "33 badges. Latest: Palindrome, 5.1.115."
2. **This release:** coverage so far with its next tier, the album's
   collected days, and "Ahead": the next three special days with their
   weekdays and dates.
3. **Tracks:** each with five tier dots in the year-dot style, your best,
   where you are now, and what the next tier needs ("Stable at 26 weeks,
   one more than your best").
4. **Collected:** every badge with its line and the version it was earned
   on, newest first.
5. **Still to find:** unearned firsts and craft with how to earn them;
   secrets as their hint alone.

Type on paper, like everything else: no cards or boxes. Earned glyphs are
cobalt, version stamps tangerine mono, and unearned ones are ink-3.

### The moment you earn one

When saving a note earns something, the answer to the save carries it and
the page shows one line under the form, on Today or another day (Hotfix and
Backport are earned there): the glyph stamps in (a 300 ms scale and turn,
none with reduced motion), then "Unlocked: Round number, 5.4.300" and a
link to the page. A special day of this release collected again, its badge
earned in an earlier one, reads "Collected: Round number, 5.5.200". A badge
celebrated here is not repeated in the email (from step 3, through
`seen`).

The firsts outside notes and the Roadmap get the same line where they are
earned: under the photo in Settings, under Feedback's notice, on Book once
it is asked for, and under Upcoming's and Upcoming as text's notices. Those
answers carry `unlocked` only when something was earned. A date added or
feedback filed by an agent, and Merged upstream (earned when Jamie marks an
item done), write their `badge.earned` rows only, through `assistant` or
`admin`, and are told in the next email or the welcome back; no email is
sent for them.

### Welcome back

A badge earned away from the web (a reply by email, an agent's note, a
Supporting Member's year found at sign-in) used to wait silently for the
next morning's email. Jamie, 2026-10-25: "when you come to the website and
there is a badge since your last visit that should get special attention!"
So the first signed-in page of a visit (`GET /api/badges/new`, read once
a visit, beside the page's own data) shows, above its title, "New since
your last visit" and each badge earned and not yet told: its glyph stamping
in, one after another, its name and version stamp, and its line, at most
three and then "And N more", with "See your badges" and Close. It stays
from page to page until closed or followed, and only in that tab. As it
shows, the page marks it told (`POST /api/badges/seen`), so the email
doesn't repeat it; a failed mark only means seeing it again next visit.
A save's refresh doesn't read it again (it would come back told, and
empty), and signing out forgets it, so another account signing in to the
same tab hears its own and marks them. Turning "Show badges" off drops it
from the page at once.
It reads `seen` as the sender does (`untold` in `packages/domain/badges.ts`):
a track's tiers as the highest, and nothing with "Show badges" off.

### The email

One line under the lifetime line, only on mornings after something was
earned and not yet celebrated:

> New badge: Round number, 5.4.300. See your badges

> New badges: Hotfix, Cold start and Cadence beta. See your badges

Never a line about what is close, at risk or missed.

**On a special day** (about eight a year, the collectibles that are not
secret), one clause beside the number states a fact about it:

> 5.4.300 is a round number.

> 5.4.345 reads the same both ways.

> 5.4.364 is the last patch of 5.4.

It never asks for a note; the number is the point. On a birthday the email
already celebrates the release, so Release day needs no clause.

**On a status patch** (Easter eggs), one more short line follows that
clause, or stands alone beside the number, whatever "Show badges" says:

> 5.4.200 is a round number. 200 OK.

> 404 Not Found.

### Birthdays

The existing closed-release block in the birthday email gains the release's
badges: "5.4 is closed: 212 days with notes, 260 notes and 90 photos.
Longest streak: 30 days. Coverage: beta. Collected: Round number, Pi and a
palindrome." The release page head shows the same. A year of life, shipped,
with its changelog.

### Elsewhere

- **Day pages** say what the day collected: "Collected here: Palindrome."
- **Release pages** say what the release earned under its counts:
  "Coverage: beta. Collected: Round number ×2, Pi and Palindrome." The
  current release's coverage reads "so far".
- **The export** gains a Badges section in the Markdown and a `badges`
  array in the JSON, computed at export time, oldest first: each with its
  name, line, version and the day it came true ("- 5.4.300: Round number.
  A note on a hundredth patch.").
- **Agents** read badges through `notes_badges` (`docs/MCP.md`), so a
  connected assistant can say congratulations. With "Show badges" off it
  returns only that, and `notes_get_day` and `notes_releases` leave out
  what was collected.

## How it plays out

**A new subscriber**, writing most days, earns about eight badges in the
first two weeks: Hello, world, ACK, Commit message, Continuous delivery
alpha and beta, Release assets or git tag, Patches shipped alpha and
Cadence alpha. Then the pace slows to something every few weeks, and the
album renews every birthday.

**A long imported history** opens nearly full, which is right: years of
writing should show. The thresholds were checked against a real
fifteen-year Day One history (dates and weather only, no text): it opens
at stable on three tracks with the LTS tiers still ahead, one Cadence tier
just past its best run, most collectibles found and two still to find.
What keeps such a shelf moving is the renewing part: coverage of the new
release, its album, and the long tiers.

**The album, for a fictional subscriber** born March 14, 1987 (the unit
tests' Ada), on 2026-10-20, 3.9.220. The page's "Ahead" shows:

| Ahead   | Date               |                               |
| ------- | ------------------ | ----------------------------- |
| 3.9.293 | Friday, January 1  | Palindrome, on New Year's Day |
| 3.9.300 | Friday, January 8  | Round number                  |
| 3.9.364 | Saturday, March 13 | Code freeze                   |

The next birthday is 4.0.0, a Major release, and it falls on Pi Day.
Overflow (3.9.256) and Pi (3.9.314) are ahead too, but they are secret, so
they are found by writing on those days or not at all.

## How it works

- **`packages/domain/badges.ts`**: the catalog (id, name, line, hint,
  secret, shelf) and `evaluateBadges(facts, today)`, a pure function like
  `computeStreak`. It returns the earned badges (id, tier, the day earned,
  that day's version), track progress, and this release's album and the
  days ahead. Earned days are derived from history, which is what makes the
  shelf work for imports and lets every badge carry its version stamp.
- **The stamp is the day it came true.** The evaluator replays notes in the
  order they were written (`writtenAt`, in the zone the note was written
  in, as "added later" reads it) and stamps each badge with the version on
  the first day its rule held. A
  note backfilled today for last year earns on today's version, not the
  day it is filed under; an imported note earns on the day it was first
  written. A note keeps no history of its edits, so what an edit or a later
  file adds counts from when the note was written. Collectibles name the special version they were collected on
  ("Palindrome, 4.1.314") and record when they were written separately.
- **`packages/backend/badges.ts`**: `badgeFacts(store, user, profile, today)` reads the
  activity rows badges use (`Store.badgeActivity`), `FEEDBACK#` and
  `UPCOMING#` for the firsts outside notes and the Roadmap, and
  person's `NOTE#` rows (dates, written and received times, source,
  whether an email note has a `subject`: a reply always keeps one, the
  standing address never does; author, media kinds, place city and
  country, link count, text), their
  `WEATHER#` rows (high and code), `PAUSE#` rows and the profile (birthday,
  zone, home). One person's notes are read whole, as search already does.
  Text is used in memory for word counts and hashtags only, never stored or
  logged.
- **`USER#<id> / BADGES`**: the one new item, `seen`, a string set of
  `id` or `id:tier` already celebrated. A web save adds the badges it
  answered as `unlocked` (not a special day collected again, which is no
  new badge); the sender adds to it after an email with the line has gone.
  Turning "Show badges" back on adds everything earned meanwhile, so it is
  shown and not announced; if that write fails the setting stays off and
  the save says so. A send that finds badges turned off after it read them
  drops both lines and marks nothing. All use `ADD` with the account proof, so a
  repeat is harmless and a deleted account gains no row. It goes with the
  account. It is not exported, since it is only bookkeeping.
- **Launch:** `tools/badges-baseline.ts` seeds `seen` with what each
  subscriber has already earned, so nobody's first email lists thirty
  badges. It is a live write, so it runs on Jamie's go. The launch is
  announced through a product update at `/admin/`, in Jamie's words.
- **API:** `GET /api/badges` for the page; a note create answers with
  `unlocked`, what it just earned, worked out from the person's notes read
  after the save, with and without the new one (a failed read leaves it
  out and never fails the note). A Day answers with `collected` and a
  release with `badges`. `GET /api/badges/new` and `POST /api/badges/seen`
  are the welcome back's. All are in `docs/WEB-APP.md`'s API table.
- **Sender:** reads badges and `seen` after the note index, before
  claiming the day; adds what the line named to `seen` once the email has
  gone (a failed write only means telling it again tomorrow). A track's
  tiers earned the same night show as the highest; past four names the
  line ends "and N more". A failed read sends the email without the line
  (the clause still shows: it needs only the version), as the streak does.
  The dry run reports `badges` (how many are new) and `special_day`.
- **Cost:** one more read of a person's notes per email and per saved
  note. At today's scale that is well under a cent a month. If it ever
  matters, the facts can be cached on the `BADGES` item.
- **Tests** with fictional subscribers: a pause inside a cadence week, a
  February 29 birthday (Release day on March 1 in common years, as the
  version arithmetic has it), a 366-day release for Leap patch, zone day
  boundaries, imports excluded from Hotfix and Backport, a late note
  raising a tier, compose tests for both lines, and an e2e save that shows
  the unlock.
- **Dashboard:** nothing new. Notes per day by source already show whether
  people write more.

## Easter eggs

Jamie, 2026-10-29: "Those are all amazing. I love them all." and
"Approved: build the Developer mode, Status code and RTFM easter eggs in
Release Notes, with the status line in the email on those mornings". The
tour, the front page and help copy never mention them; finding them is the
point. With "Show badges" off every egg still works: only the badges,
unlock lines and badge rows are left out.

- **Developer mode** (web). Today's number is a button that looks exactly
  like the number. Seven taps in a row, none more than 2 seconds apart
  (Enter and Space count), turn it on; from the fourth a polite live
  region counts down ("3 taps from being a developer."), the seventh says
  "You are now a developer." and later taps "No need, you are already a
  developer.". It is kept in the browser, never on the server, with
  "Leave developer mode". The panel under the number shows the version in
  hex, binary and Roman numerals (zero is N), uptime in seconds since
  local midnight of the birthday, how far through today's patch, and
  `git log --oneline` of the last ten days with notes, each a hash worked
  out from the note id, the version and its first few words. The first
  turn on earns the secret first Developer mode.
- **Status codes** (badges and the email). Patches that are HTTP statuses
  (.100 Continue, .101 Switching Protocols, .200 OK, .201 Created, .204 No
  Content, .301 Moved Permanently, .304 Not Modified, .307 Temporary
  Redirect) earn the secret collectible Status code once, and each is an
  album entry in its release, named with its meaning: "Status code (304
  Not Modified)". Two versions happen once a life: 4.0.4 is Found and
  4.1.8 is I’m a teapot. None is ever in Ahead. The email adds one line
  beside the number on those mornings ("200 OK.", "404 Not Found.",
  "418 I’m a teapot."), with badges on or off, and it never asks for a note
  (`packages/domain/eggs.ts`).
- **RTFM** (web). `/man/` is RELEASE-NOTES(1), the product as a Unix man
  page, readable by anyone and noindex. The clues are a comment in
  `index.html`, a comment in `robots.txt` and "Lost? Try man
  release-notes" on the 404 page. Opened signed in, it earns the secret
  first RTFM.

A found egg is one `egg.found` activity row (via `web`, field `egg`),
written once ever by `POST /api/eggs`, which knows only these two names
and answers nothing about any other egg. Agents find nothing new: the MCP
tools' descriptions name no egg, and `notes_badges` shows the secrets by
their hint until earned.

## Build order

1. Domain, facts, `GET /api/badges` and the Badges page, with links from
   Today and the Archive. Nothing in the email yet. **Built 2026-10-20.**
2. The unlock moment, Day and Release page lines, and the export.
   **Built 2026-10-20.**
3. The "Show badges" setting, then the email: the badge line, the
   special-day clause, the `BADGES` item, the baseline (Jamie's go) and the
   launch product update. Then the birthday block. The setting ships before
   any email line, so the way out exists from the first one. **Built
   2026-10-20**, in two changes: the setting, the `BADGES` item and the
   baseline tool first, the baseline run between them, then the email
   lines and the birthday block.
4. Badges for agents: `notes_badges`, under `notes:read` (Jamie,
   2026-10-20: "add read-only MCP tools to Release Notes for badges, the
   mail log, releases, on this day and account settings under
   notes:read"). **Built 2026-10-20.**

## Jamie's calls (2026-10-29, easter eggs)

1. "Those are all amazing. I love them all."
2. "Approved: build the Developer mode, Status code and RTFM easter eggs in
   Release Notes, with the status line in the email on those mornings"

## Jamie's calls (2026-10-29)

1. **Four firsts and two hints** ("Approved: add the Signed commit, Issue
   opened, Merged upstream and Tarball badges and the two hint edits to
   Release Notes, with no baseline run"). The hints: Release assets reads
   "Add a photo to a note, here, by email or through an agent." and Pair
   programming "Connect an agent in Settings and ask it to add or edit a
   note." With no baseline run, anyone who already qualifies is told once,
   in their next email or the web's welcome back.
2. **The Roadmap track** ("Only thing I'd change is I do think using
   upcoming should get badges. A series for how many you add that progress
   through some milestones. Could be a reference tos. Roadmap to continue
   our theme."): tiers at 1, 5, 15, 40 and 100 dates added.

## Jamie's calls (2026-10-25)

1. **Giving badges** from the Supporting Member perks suggested that day
   ("Yearly giving badge is EXCELLENT! Love that."), with the birthday
   thank-you ("Love the birthday email idea too!"). A model-written daily
   email was set aside ("I like your three ideas WAY more").
2. **This year's giving badge is still to find** ("We should be
   encouraging people to be a supporting member"), overturning my first
   cut that hid it.

## Jamie's calls (2026-10-20)

1. **The name is Badges** ("Agree. badges.").
2. **The email carries both lines** ("Yes for sure."): the line when
   something is earned, and the clause beside the number on a special day.
3. **A "Show badges" setting**, on by default ("Agree."). Off hides the
   page link, the unlock, both email lines and the birthday block's
   badges; nothing is deleted, and turning it back on shows everything
   earned meanwhile without announcing it.
4. **The catalog stands as written** ("These look good.").

## Not doing

- **Points, XP or levels.** Tiers and stamps already carry progress; a
  currency invites grinding.
- **Leaderboards, sharing or comparison.** Each subscriber's data is their
  own.
- **Streak freezes or repairs.** Late notes already mend a day, for free.
- **"At risk" warnings, countdowns or daily quests.** Loss framing is the
  thing that makes streak apps feel like work.
- **Notifications beyond the daily email.**
- **Badges that judge content** ("wrote about gratitude"). That needs a
  model to read notes, and journals should not be graded.
- **Badges for Upcoming** was here until Jamie, 2026-10-29: "Only thing
  I'd change is I do think using upcoming should get badges. A series for
  how many you add that progress through some milestones. Could be a
  reference tos. Roadmap to continue our theme." The Roadmap track counts
  dates added; Upcoming still counts toward nothing else.
