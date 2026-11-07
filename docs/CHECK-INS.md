# Check-ins

Designed 2026-11-06, with Jamie's calls from 2026-11-05 and 2026-11-06 at the
end, under "Jamie's calls". **Phase 1, the server and API 1.18.0, is built**
(Jamie, 2026-11-06: "Approved: build Check-ins phase 1, the server and API
1.18.0, from PR #317"), with what building it decided under "Built in phase 1".
**Phase 2, the web, is built**, under "Built in phase 2". **Phase 3, Changelog
sending them, is built and on TestFlight internal as build 85, version 0.0.8**
(Jamie, 2026-11-06: "Approved: build Check-ins phase 3, Changelog sending
check-ins to the server, with no TestFlight upload" and "Approved: upload
Changelog main (5e9a3be) to TestFlight internal, ending the visits test on that
phone, and merge Release Notes #325 with its guide entry"), under "Built in
phase 3". Stops have arrived from a real phone in the background, and the
locked, Airplane mode and force-quit cases wait on the phone pass, step 23 of the
app's `docs/PHONE-TEST.md`. **Phases 4 and 5, the control, the app's map and Beta,
are built** (Jamie, 2026-11-06: "Lets' move forward with phases 4 and 5. Let's
complete this whole cycle."), under "Built in phases 4 and 5".

Jamie, 2026-11-05: Changelog should notice "when I am at a place (not
traveling)" and add it to Activity, so "I can see where I've been on a map" and
"I can start a note from the activity stream to write about a place I was."
Jamie named it, 2026-11-06: "Check in's is going to be better and it is also a
software term." In the product it is written **check-in**, and **check in** as
a verb.

A check-in says you were somewhere, from about one time to about another. It is
life logging, part of the app and off until you turn it on. It is not a note,
and it never becomes one by itself.

## Rules it keeps

- **A note stays words, files and a place.** "Write about this" starts an
  ordinary note and copies the place into it. The note has no link back, and no
  check-in fields, as Moments learned (`docs/MOMENTS.md`).
- **Any data, any channel.** Every check-in can be read, named and deleted on
  the web and through `/v1`, whichever phone made it, so Quinn's Android app can
  do what Changelog does.
- **Coordinates and place names are never logged** to CloudWatch, and the
  activity log stores neither. A row holds the check-in's id, and the name is
  joined when read, as Upcoming titles are.
- **The census counts them and nothing more** (2026-11-07): check-ins stored,
  by source (visit or tap), accounts with any and with one in the last 7 days,
  and remembered places, for otto-ops' Release Notes product dashboard. It
  reads each check-in's key and source, never a spot or a name.
- **Asked only when it matters.** Always is asked for when someone turns
  check-ins on, never before. Apple allows one Always prompt an app.
- **Amazon Location is told the coordinates alone**, as for a photo's spot.
- **Every write proves its writer** (AGENTS.md, Who can write): a token's goes
  through the capture function with the live token in the same transaction, and
  the web's through its session and the account proof.
- **Saved, not journal entries**, as Upcoming's dates are: a check-in touches no
  streak, count, badge or note search.
- **Only the owner names a place.** Nearby businesses
  are offered and never picked, since the nearest is as often a bus stop.

## What the test showed

A first morning, four stops, from Changelog's `VisitRecorder`:

- iOS told the app about 4 minutes after each arrival it reported, and within a
  minute of each departure. A row can appear soon after arrival, as Jamie
  wanted.
- Accuracy ran from 6 m to 65 m on one morning. A stop's spot is a circle, not
  a point.
- Two stops one minute apart were two real shops, which iOS got right. **A
  short gap does not mean the same place**, and iOS's times are approximate,
  as Apple's docs say, so a stay may run into the drive that ended it. So the
  merge rule below goes by distance first, and times show to the
  minute without ever being added up into travel time.
- A stop iOS reports without an arrival is real. It needs wording ("Until 9:00
  AM"), not an error.

Still open until the week of data is in: how short a stop iOS catches, how many
it misses, and what force-quitting does. Those change how the app behaves and
the numbers below, not the shape of the design.

## A check-in

`USER#<owner> / CHECKIN#<at>#<id>`, where `at` is when it began:

| Field          | What it holds                                                       |
| -------------- | ------------------------------------------------------------------- |
| `arrived`      | ISO time, or null when iOS gave none                                |
| `left`         | ISO time, or null while still there, and always null for a tap      |
| `lat`, `lon`   | the spot, to six places, as a note's spot is                        |
| `accuracy_m`   | the circle's radius                                                 |
| `time_zone`    | the phone's zone there, so a time reads as it did on the day        |
| `day`          | the account's day, the one a note written then would have landed on |
| `source`       | `visit` (iOS or Android reported it) or `tap` (the owner asked)     |
| `district`     | neighbourhood and city, looked up once when it arrives              |
| `name`         | a name given to this check-in alone, or null                        |
| `via`, `token` | as an activity row's                                                |

`at` is `arrived`, or else `left`, or else the time the server heard it. Items
go with the account, are in every owner export and in the monthly backup.

### The name it shows

Worked out when read, first match wins:

1. Its own `name`, given once.
2. A remembered place: the nearest within 100 m of its spot.
3. Its `district`.
4. "Unnamed stop", if the lookup failed or the day's lookups ran out.

Nothing about a remembered place is stored on the check-in, so remembering a
name applies at once to every stop there, past and future, and forgetting it
puts the neighbourhood back, with nothing to backfill. A wrong match is mended
by naming that one check-in once.

### Remembered places

`USER#<owner> / NAMEDPLACE#<id>`: `name` and `spots`, a list of `{lat, lon}`.

Naming a check-in offers a name box, the nearby businesses as one-tap fills, and
one checkbox, **Remember this place**:

- **Off** (the default): the name is on this check-in alone. Off is the default
  so naming one stop never relabels history unasked.
- **On**: the name becomes a remembered place at this spot.

A second spot with a name already in use (matched as tags are, ignoring case)
joins that place, which is how a big place, or two ends of one, stays one name.
Renaming changes all its spots, and forgetting removes them all. There is no
size setting: 100 m everywhere until real data asks for one. At most 200 names
an account, read whole on each join.

A list of remembered places, to rename and forget, sits on the web and in the
app's Settings.

### Back-to-back stops

Stored check-ins stay as iOS reported them. Lists merge two neighbouring ones
**when read**, so the rule can change without touching data, when:

- nothing else lies between them,
- they begin within 30 minutes of the last one ending,
- any names of their own are the same, and
- they are within 100 m of each other, or at the same remembered place.

Deleting a merged row deletes every check-in in it, and a name given to one goes
on every check-in in it.

## The API (1.18.0)

| Call                                        | Scope                              | Does                                                                 |
| ------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `POST /v1/check-ins`                        | `notes:write`                      | adds one, or fills in the one it continues                           |
| `GET /v1/check-ins?from=&to=&before=`       | `activity`                         | newest first, with `lat`, `lon`, its shown name and how it was named |
| `PATCH /v1/check-ins/{id}`                  | `notes:write` own, `notes:all` any | `name`, with the revision read                                       |
| `DELETE /v1/check-ins/{id}`                 | `notes:write` own, `notes:all` any | deletes it                                                           |
| `DELETE /v1/check-ins?confirm=all`          | `notes:all`                        | deletes every one, with one activity row and its count               |
| `GET /v1/check-ins/places`                  | `activity`                         | the remembered places                                                |
| `POST /v1/check-ins/places`                 | `notes:all`                        | `{name, lat, lon}`: remembers it, or adds the spot to that name      |
| `PATCH`, `DELETE /v1/check-ins/places/{id}` | `notes:all`                        | renames or forgets it                                                |

No new scope, on Jamie's call. Remembered places live on the account, so a new
phone, the web map and any other client see the same names (Jamie, 2026-11-06:
"Names need to live on the API").

**The POST is built for what a phone is told.** A client forwards each report as
it comes, with `{arrived, left, lat, lon, accuracy_m, time_zone, source}` and an
Idempotency-Key. A later report with the same `source` and arrival, to the
second, is the same stay: it fills in `left` and answers 200, not 201. So
arrival then departure, a departure alone, a retry or the same report twice all
land in the one record, and the client keeps no server ids. A `tap` sends the
moment it was tapped as `arrived`, so one that waited in a queue keeps its time,
and is never continued by a later report.

Bad spots, a stay ending before it began, and times over a week ahead are
refused with the usual error shape. Older times are allowed, since a phone can be
offline for days. Check-ins have their own daily count, 100 a UTC day, because
each new stay is one paid lookup. Past that a check-in is still saved, with no
`district`.

**Activity.** `GET /v1/activity`, `notes_activity` and the web read a new family,
`checkin`, merged in by time as the MCP reads partition is
(`store.activity`), so a row needs no second item and goes when its check-in
goes. A row carries `checkin` (its id), `label`, `arrived`, `left` and `source`,
and never coordinates. `label` is the one place `tokenActivityView` lets the
owner's own words through, since a row with no name is no use, and that is Jamie's
call 4. `after` can miss one: a phone offline for a day files
check-ins behind a client's cursor, so a client wanting all of them reads `GET
/v1/check-ins`. `checkin.deleted` stays in the log with its `day` and a count,
and never the place, as `note.deleted` does.

**MCP (1.13.0).** `notes_check_ins`, read only, with `notes:read`, and the rows
in `notes_activity`. Naming and deleting stay on the web and in apps. On Jamie's
call this is the same protection as the rest of the account: a connected
assistant that reads notes can read where its owner has been, once they have
turned check-ins on.

## The web

- **Activity:** a "Check-ins" filter, and a row such as "Checked in at Home" with
  its stay beneath ("9:05 AM to 10:15 AM, 70 min"). A row opens the check-in.
- **A check-in's page:** name and Remember, the nearby businesses, its place on
  the map, "Write about this", Delete.
- **The Map:** check-ins get their own mark and their own cluster layer, so they
  never read as notes (Jamie's call 6). A menu shows notes, check-ins or both, on
  top of the release and tag filters. A group tapped lists both kinds, each with
  its mark. Check-ins use their real circle only when opened. Only the owner's
  session reads them, through `/api`, as pins are.
- **Settings:** remembered places, and "Delete all check-ins".
- **Not on a Day page or in any email.** Under "Still open".

## Changelog

This replaces the visits test, and takes its rule out of the app's `AGENTS.md`.

- **The switch** moves to Settings, "Check-ins", off until turned on, then asks
  for Always, once. Refused or reduced, it says so and links to iOS Settings.
  The tap needs only While Using.
- **Recording** keeps `startMonitoringVisits`, and each report goes through the
  Outbox with its key, so a bad connection loses nothing. iOS can wake the app
  while the phone is locked; the token is readable after first unlock, and the
  queue file gets the same protection the test's file has, or it couldn't be
  written.
- **The Activity tab:** a "Check-ins" filter, and rows as on the web, which open
  even with reading locked (Jamie's call 4). The page has Name and Remember, the
  nearby businesses through `POST /v1/places/here`, a small map, "Write about
  this" and Delete.
- **Write about this:** opens the Log with a draft on the check-in's day and
  place, its name as `venue`, as a moment from an earlier day does. Capture is
  never locked.
- **Check in now** (Jamie, 2026-11-05: "manually trigger a breakpoint with a tap.
  That could be a good widget as well"): a button in Log and Activity takes one
  fix and sends a `tap`.
- **The widget:** a Control Center, Lock Screen and Action Button control beside
  New Note. A widget never calls the API here, so it opens
  `com.yourversionnumber.changelog:check-in`, which checks in and says so.
  Checking in without opening the app would need an App Intent getting a fix in
  the background, which is unproven and would break that rule. Try it on a phone
  later, only if opening the app feels too slow.
- **A map in the app**, from the test's MapKit page, once the web's looks right.
- **Signing out** stops recording and leaves the check-ins on the account.
- **Android and others:** the API has no iOS in it. Quinn's app can send
  `visit` from any source that reports stays.

## Built in phase 1

What building it decided, past the design above. None of it changes what an owner
was promised, and all of it can change with no data to rewrite except the first.

- **A name on a merged stay goes on every check-in in it.** Otherwise naming one
  would split the row it was given on. So the merge rule takes the same own name
  as it takes none.
- **A report continues only the token's own check-in,** or any with `notes:all`.
  From another token it makes its own check-in, which reads as one stay with the
  first, so an app signed in again loses nothing and a token can't reach what it
  didn't send. Likewise a token with neither `activity` nor `notes:all` sees no
  remembered place's name in an answer, so it can't probe spots for them.
- **Naming lands whole or not at all,** so a stay of more than 90 check-ins
  (`STAY_WRITE_MAX`, what one transaction holds) can't take one name, and is
  refused with nothing changed. Deleting goes in steps, since a retry finishes
  the job.
- **`PATCH` and `DELETE /v1/check-ins/{id}` act on the whole stay,** and any id in
  it names the stay. The stay's `revision` is the sum of its check-ins', so a
  stop joining it moves the revision a client read.
- **Reports have a hard ceiling,** 1,000 a UTC day (`V1_LIMITS.checkin`), past the
  100 lookups (`V1_LIMITS.lookups`), so a runaway client can't fill the table.
- **A name holds up to 50 spots** (`NAMED_PLACE_SPOTS_MAX`), and renaming a place
  to a name another uses is refused, since the second would never be found.
- **Deleting all check-ins leaves the remembered places,** which are the owner's
  words and work on the next stop.
- **The log has two more kinds,** `checkin.named` and `checkin.place`, for what
  changed. Neither holds a name or a spot. `checkin` rows also carry `day`,
  `time_zone` and `merged`.
- **A page of the log reads past the rows a stay folds away,** so `limit` means
  rows shown, and a stay goes by when it began.
- **Until phase 2 the web's Activity gave these rows no wording of their own.**
  Only a client sending check-ins makes any, and none did.

## Built in phase 2

What building it decided, past the design above.

- **`/check-in/#c=<id>` keeps its id in the fragment,** so no address in a log
  says when someone stopped.
- **Nearby businesses are asked for when wanted,** on Name it or Write about this,
  through `POST /api/places/here`, since each is a paid lookup. Opening a check-in
  asks nothing.
- **Remember takes the stop's own name off,** or it would go on outranking the
  place, and adds the spot of each check-in in the stay that no spot of that name
  is near, or remembering could split the stay.
- **Remember always shows the name chosen.** Where another place is as near or
  nearer, the chosen place takes the stop's own spot. On a spot another place
  already has, a tie, the stay keeps the name as its own too, which outranks both.
- **A tag or words hide check-ins on the Map,** since a check-in has neither, and
  choosing Check-ins clears them. A release narrows both, by the check-in's day.
- **Activity's Check-ins button shows once there are any,** so nobody without them
  sees it. Rows read in the check-in's own zone, under the account's days.
- **Settings shows its Check-ins group once there are stops or names.**
- **Write about this goes on without a place** if the spot's city can't be named:
  the note's Where can add one.
- **The privacy page says Changelog doesn't send them yet.** Its line that the app
  asks only for Here or "Add where I am" stands until phase 3 makes it false.

## Built in phase 3

- **No change here.** The app reads, names and deletes through `/v1` as it was.
- **A row has no spot and `/v1` has no read by id,** so a check-in's page finds
  its stay in the list for that day and the day before, by any of its `ids`.
- **Only reports and taps queue.** A name, a delete and remembered places go at
  once with a held key, as Upcoming's do: each is made from a revision, and a
  refusal is for the owner there and then.
- **Remember is a sequence in the app,** since `/v1` has only `POST places`: add
  the place, read the stay again, take its own name off if it has one, and give
  it the name as its own if another place still wins there, as the web's does.
  Each step has its own key, so saving again picks up where it stopped.
- **The test's switch does not carry over,** since it promised nothing goes to
  Release Notes. Monitoring stops once on the way in. Its file stays on the phone
  to read, share and delete, goes on sign-out as promised, and nothing in it goes
  up without Jamie's answer.
- **The switch and the queue survive the phone's first-unlock state.** iOS can
  start the app before that, when defaults read empty and the token and queue
  can't be read. So the switch is read at each visit and on opening, monitoring
  is never stopped because defaults read empty, and a stop the queue can't take
  yet is held in memory. One heard while the process then dies is lost.
- **A tap at the same place merges** with the stop before it, by the merge rule,
  so it says "Checked in at" that name and adds no row. A stay's page reads
  again when one changes.
- **Not proven by a simulator:** real delivery, a wake in the background, a locked
  phone and a force-quit. The app's `docs/PHONE-TEST.md` step 23 is that pass.

## Built in phases 4 and 5

- **No change here.** The map reads every page of `GET /v1/check-ins`, as the
  web's reads its stays whole, and the control sends a `tap` as Check in now does.
- **A control names an intent,** as New Note does, so it needs no link. The link
  `com.yourversionnumber.changelog:check-in` is there too, for a test to reach it,
  since a control can't be pressed from one.
- **It opens Activity,** where the row shows and the toast says so. A press while
  signed out is dropped, so nothing checks in later on signing in.
- **The app's map is of check-ins alone,** one pin for each place: a remembered
  place, or one name within 100 m. A pin opens a sheet of its stops. It opens with
  reading locked, as a check-in's page does (Jamie's call 4). Notes stay off it, by
  the app's rule that a map of notes is Jamie's word.
- **The reason for Always** is in the app's `docs/DISTRIBUTION.md`, and goes in the
  review notes with each build that carries check-ins.
- **Not proven by a simulator:** pressing the control, on Control Center, the Lock
  Screen and the Action Button. The app's `docs/PHONE-TEST.md` step 24 is that pass.

## What has to be rewritten

Each goes in with the phase that makes it true, not before:

- `site/privacy.md`: "It asks where you are only for Here or 'Add where I am',
  never in the background" stops being true. Places, Changelog and the Amazon
  Location line all change, plus a plain line that a location history is kept
  until deleted, and that assistants and tokens can read it.
- `Config/Info.plist` in the app: both location usage strings.
- The app's `AGENTS.md`, "Location is When In Use", and its visits test rule.
- The guide: a check-ins page, the Changelog page, and the tokens page.
- `AGENTS.md` here: the rules above, and `docs/API.md`, `docs/MCP.md`,
  `docs/WEB-APP.md`.
- Beta App Review needs a written reason for Always, and the build must carry it
  before any external upload. Before the App Store, its privacy label too.

## Build order

Each phase is its own go.

1. **Server:** both item types, `/v1` 1.18.0, the Activity family, export,
   `notes_check_ins`, the docs. Nothing uses it yet, so it can ship while the test
   runs.
2. **Web:** Activity, the check-in page, the Map layer, Settings, the guide and
   the privacy page.
3. **Changelog:** the switch, Outbox, rows, naming, Write about this and Check in
   now, replacing the test. Internal TestFlight on Jamie's go.
4. **The control and the app's map.**
5. **Beta:** the written reason, then an external upload on Jamie's go.

Steps 3 and later should wait for the week of test data, and force-quit above all.

## Testing

As Upcoming's are: pure functions for the name order, the 100 m match and the
merge, with this morning's shape as a case (two real places a minute apart stay
two). API tests pin the repeat report filling in `left`, arrival-less stops,
scope refusals, that no activity row stores a spot or a name, and that deleting
takes the row with it. Tests fake Amazon Location, and never write to live data.
iOS can't report a visit in a simulator, so the app's test feeds one in, as
`testVisits` does, and real delivery is proven only on a phone.

## Still open

1. **Check-ins on a Day page.** Today a day shows notes alone. Recommendation:
   leave it that way in the first version, and see how Activity and the Map feel.
2. **The daily email.** Recommendation: no mention. It stays about what was
   written.
3. **The test's visits.** Settled: Jamie sent the file over and one day's stops
   were added by hand, once. The app has no way to send it, and its copy goes when
   its owner clears it or signs out.

Not in this design: badges, hiding home (Jamie's call 2 waits on real data), and
a check-in setting a day's place or weather.

## Jamie's calls

From the exploration, 2026-11-05:

1. The name began as Breakpoint, replaced on 2026-11-06 (above).
2. Home and repeat places: "Yes it should record them." Everything is recorded,
   back-to-back stops at one place merge, and Activity has its own filter.
3. A row appears on arrival, and its stay is added on leaving: "Yes."
4. Protection: "No need for different protection. This is a form of life logging
   as part of the app." No new scope, and no hiding while reading is locked.
5. Automatic names are the neighbourhood and city, and a venue is picked on tap.
6. "Web map and breakpoints should show as a different visual than a note."
7. For anyone using Changelog, off by default, Always asked only on turning it
   on, each deletable, with a delete-all: "Yes."

Added then: "I should also be able to manually trigger a breakpoint with a tap.
That could be a good widget as well."

From the test, 2026-11-06:

8. Own names: "Will definitely need an option to name locations", for a place
   as well as a stop. A name covers the place, and beats the automatic name.
9. "We could have an option to name a place with a checkbox to 'Remember' so
   that we can either name it once or permanently. Names need to live on the API
   when done."
10. The same place means about 100 m, one number with no setting, and a second
    spot can share a name.
