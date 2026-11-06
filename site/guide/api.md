---
title: The API
description: Add notes, files and places, and keep Upcoming dates, from a terminal, a script or an app, with the requests, the errors, the limits and recipes to copy.
---

## The idea

Anything that can send a web request can add a note: a terminal, a script, a home automation, an app. Send a token you made (see [API tokens](/guide/tokens/)), or one an app got by [signing you in](/guide/api/clients/), and some words, and they become a note on today's release, in your own voice, with photos, recordings and PDFs if you like, and where you were. A token can keep your [Upcoming](/guide/upcoming/) dates too, and read the reminders each morning brings, so an app can remind you on your phone.

Every request goes to `https://notes.yourversionnumber.com/v1`, and `/v1/openapi.json` there describes the whole API for tools that read OpenAPI, with no token needed.

## Your first note

Keep your token in an environment variable, so it stays out of your shell's history, then:

```sh
curl https://notes.yourversionnumber.com/v1/notes \
  -H "Authorization: Bearer $RN_TOKEN" \
  -H "Content-Type: text/plain" \
  -H "Accept: text/plain" \
  --data-binary "Fixed the gate latch #house"
```

It answers with one line: `Filed in 5.2.113.`

## Every request

- Send the token as `Authorization: Bearer rn_...`, never in the address.
- Bodies are JSON, at most 256 KB, and a note is up to 20,000 characters, even with every character escaped.
- A note keeps every character you can see, and the invisible ones text needs, like the joiners inside an emoji and the marks that set its direction. Control characters other than tab and newline are dropped, and text with half a character in it (a lone surrogate escape, like `"\ud83d"` alone) is refused.
- With `Accept: text/plain`, every answer is text instead, for terminals: a line, or a line for each thing a list holds, and a note's words as they are.
- A day is written `YYYY-MM-DD`, in the time zone your account keeps. A time has its offset, like `2026-10-29T07:45:00-05:00`.
- Every answer to your token says today's version in `Release-Notes-Version`, and every answer says the API's own in `API-Version`.

## The requests

- `GET /v1/me`: today's date and version, the versions for the next 14 days, your streak, your time zone, when your email goes, your `account`, whether you're a Supporting Member of the Weekly Thing (`supporting_member`, from version 1.12.0 of the API), the week and day you're on, as Today and the morning email show them (`lived`, from 1.13.0), and this token's `id`, name, what it may do and when it expires. Never your birthday. `account` is the same for every token you make and never changes, so an app can tell whose account a token opens; the token's `id` never changes either, and is never the token itself. Any token may ask.
- `POST /v1/notes`: add a note. Send `{"text": "…"}`, or the words alone as `text/plain`. A form works too, as a Shortcut's **Form** body or `curl --data-urlencode "text=…"` sends it, with `text` and, if you like, `date` or `written_at`. Any other form is taken as the words, so `curl -d "my words"` still works, and a `multipart` body is refused. Hashtags in the words are its tags, and links get their names, as on the web. `date` puts it on an earlier day, back to your birthday. `written_at` is the moment the words were typed: a note sent late files to the day it was typed. With neither, it's today's. `uploads` gives it files (see [Photos, recordings and PDFs](#photos-recordings-and-pdfs)), and then it needs no words. `place` says where it was (see [Places](#places)). The answer has the note's `id`, `date`, `version` and `revision`, and how many `files` it has.
- A note with rich-text marks, like `**bold**` and lists, says so: send `"markup": "rich"` with its `text`. Without it, the words are plain and the marks show as typed. An edit keeps what the note is. From version 1.16.0.
- `GET /v1/notes?from=YYYY-MM-DD&to=YYYY-MM-DD`: the notes this token added on those days, or every note on them if it may read all your notes, oldest first, each as the request below gives it. A page stops at about a megabyte, so it can hold fewer than `limit` notes: keep asking with `after` until `next` is null. `to` is the last day, and left out it's `from`, so one day is `?from=` alone. A request reads up to 31 days; ask for a longer span in pieces. `limit` sets how many a page holds, and `next` in the answer, sent back as `after`, gives the next page. Days with none give an empty list.
- `GET /v1/notes/{date}/{id}`: one note this token added, or any note if it may read all your notes, with its text, `revision` and `written_at`, and its files as `media`: each one's number `n`, `kind`, `type`, `name`, `size`, and `thumb` when it has a small copy.
- A note also says its `tags`, `markup` (`rich`, or null for plain words), `parts` (its words cut into strings, links and tags, ready to show), its own `place`, `no_place` if you took its place away, `edited_at`, `tz`, `late`, who wrote it (`author` and `client`), `from` for an import, and `attachments`, how many files its email carried that weren't kept. Each file says its `transcript` and `description`, the words Release Notes kept if you turned those on, or null, and `writing` while a transcript is still to come. A transcript arriving doesn't change the note's `revision`; `transcript.added` in the activity log says when.
- Add `?include=urls` to either request to get each file's `url` and its small copy's in the answer, good for ten minutes, instead of asking for them one by one. All of this is from version 1.14.0.
- `GET /v1/notes/{date}/{id}/media/{n}`: an address for one of its files, as `url`, good for ten minutes and fetched with no token. `?size=thumb` gives a photo's small copy instead, for a list.
- `PUT /v1/notes/{date}/{id}`: replace its text. Send `{"text": "…", "revision": "…"}` with the revision you read; a note changed since, on the web say, is refused with the current one.
- `POST /v1/notes/{date}/{id}/append`: add a paragraph to it, with `{"text": "…"}`.
- `POST /v1/notes/{date}/{id}/media`: add files to it, with `{"uploads": […]}`.
- `PUT /v1/notes/{date}/{id}/place`: say where it was, with `{"place": …}`. See [Where a note was](#where-a-note-was).
- `DELETE /v1/notes/{date}/{id}/place`: take its place away, so it says `no_place` and shows none from its day.
- `DELETE /v1/notes/{date}/{id}/media/{n}`: take one file off it, with its small copy, transcript and description. The other files keep their numbers, and its `revision` changes. A note with no words can't lose its last file, so delete the note instead. A file that came by email stays in that note's email until the note is deleted, and no app can read it there. Taking a file off a note you didn't add through this token also needs a token that may read and change all your notes. From version 1.17.0.
- `POST /v1/uploads`: a form to upload one file to, before a note takes it.
- `DELETE /v1/notes/{date}/{id}`: delete it.
- `GET /v1/tags`: your tag row, the pinned tags and then up to 20 recent ones, the tags used most in the last 30 days. Any token may ask.
- `PUT /v1/tags/pinned`: replace your pinned tags, with `{"pinned": ["house", "work"]}`, up to 12 tags, in any language's letters, like `москва` or `東京`. They're the same ones the web shows under the note box.
- `GET /v1/places`: the cities by a name, like `?q=Zürich`, for a note's place.
- `POST /v1/places/here`: the city, neighbourhood and businesses nearby for the spot a device is at, for a note's place.
- `GET /v1/upcoming`: your Upcoming dates, soonest first, each with its `id`, its `revision`, its `next` date and the line the email says about it. A trip or event that's over is left out and only counted, as `past_left_out`.
- `POST /v1/upcoming/batch`: add, change and remove dates together, up to 50 dates a request, as `{"add": […], "change": […], "remove": […]}`. It saves all or nothing: if one date isn't right, none is saved, and `field` names the one, like `add[1]`. With `"dry_run": true` it checks everything and finds each trip's city, and saves nothing. The answer lists what was `added`, in the order you sent it, then what was `changed` and `removed`.
- `GET /v1/upcoming/reminders`: the reminders each morning's email carries, day by day, for the next 14 days, or up to 31 days ahead with `days`. Each day has `send_at`, the moment that morning's email is due, and each reminder the date's `id` as `upcoming`, the day it falls on as `date`, and its `when` and `line`, as the email says them. A date with its email reminders turned off isn't there; a paused email doesn't change the list.
- `DELETE /v1/upcoming/{id}`: remove one date, with the revision you read as `?revision=`.
- `POST /v1/check-ins`: say you stopped somewhere, as a phone reports it. See [Check-ins](#check-ins).
- `GET /v1/check-ins`: where you stopped, newest first. `from`, `to`, `limit` and `before` choose a stretch, and `next` is the `before` for the next page.
- `PATCH /v1/check-ins/{id}`: give it a name of its own, with `{"name": "…", "revision": 1}` and the revision you read, or `"name": null` to take it away.
- `DELETE /v1/check-ins/{id}`: delete it, and every stop read as one with it.
- `DELETE /v1/check-ins`: delete every check-in, with `?confirm=all`. It answers how many went, and your remembered places stay.
- `GET /v1/check-ins/places`: the places you've told it to remember.
- `POST /v1/check-ins/places`: remember a place, with `{"name": "…", "lat": 45.5, "lon": -93.2}`. A name you already use gets this spot too.
- `PATCH /v1/check-ins/places/{id}`: rename it, with `{"name": "…"}`.
- `DELETE /v1/check-ins/places/{id}`: forget it, all its spots with it. Your check-ins there go back to the names they had.
- `GET /v1/activity`: your activity log, newest first, without any words: no note text, no email's subject or sender, no setting's value. A row a token wrote names it by `token` and, from version 1.4.0 of the API, by `token_id`, the `id` that `GET /v1/me` gives; older rows have no `token_id`. `after` gives only rows newer than one you've seen, and `before`, with the `next` from the answer, the page older. `kinds` keeps some kinds, like `note,mail`, `from` and `to` keep some days, as they do for notes, and `limit` sets how many rows a page holds.
- `DELETE /v1/token`: this token revokes itself. Any token may ask.

Reading back, adding, changing and deleting notes, pinning tags and finding places need a token that may add notes, and only ever read or touch the notes that same token added. A token that may also read all your notes reads, changes and deletes any note, wherever you wrote it, and with files ticked adds files to any of them. Files need a token that may add files too, which comes only with adding notes. Upcoming needs a token that may read and change your Upcoming dates; it reaches all of them, not only the ones it added, and no other token reaches them. The activity log needs a token that may read it.

## Reading your archive

A token that may read all your notes (`notes:read`, or `notes:all`) can also ask for these, from version 1.15.0. `notes:read` needs nothing else ticked and changes nothing. A token with only `notes:write` reads just the notes it added, and gets `scope_required` here. Each counts as one read.

- `GET /v1/days`: your timeline, newest first, with today first: every day with notes, a morning email, a pause or a place. Each says its `version`, `notes_total`, `files`, `emailed`, `paused`, the `place` set on it, `around` (the place a note with none shows, and whether it comes from the `day` or `home`) and `weather`. `?limit=` sets how many, and `?before=` takes `next` for the page after. Read what's on those days with `GET /v1/notes`.
- `GET /v1/days/{date}`: one day, the same, with its `notes`, whether it's `today`, and what it `collected`. A day stops at about a megabyte of notes: `next` then goes to `GET /v1/notes` as its `after`, with `from` set to that day. A day before your birthday or after today is `date_out_of_range`.
- `GET /v1/search?q=lake`: notes with every word, in their words, places, link names, transcripts and descriptions, newest first, with the `total` found. Up to ten words or quoted phrases. `?tag=running` finds a tag's notes, on its own or with `q`. `?from=` and `?to=` narrow it to some days, and `?after=` takes `next`.
- `GET /v1/on-this-day`: the same day of each earlier release, newest first, as the morning email's On this day, each with its first five notes and its `notes_total`. `?date=` looks back from another day, and `?before=` takes `next`.
- `GET /v1/releases`: each year of your life, newest first, with its `days` and `notes`.
- `GET /v1/releases/{v}`: one of them in detail, like `/v1/releases/52.0`: its longest streak, tags, and badges if you show them.
- `GET /v1/tags/all`: every tag you've used, with its `notes`, `days`, `first` and `last`, most used first.
- `GET /v1/map/pins`: where your notes were, as the Map's pins, oldest first, with a note's opening words. Draw them on your own map. `?after=` takes `next`.
- `GET /v1/badges`: what you've earned and the tracks, or `show_badges` false and nothing else if you've turned them off.
- `GET /v1/mail-log`: what became of each email in the last 30 days: its `outcome`, and its subject, sender and opening words, cut short.

`GET /v1/days/{date}`, `GET /v1/search` and `GET /v1/on-this-day` take `?include=urls` too. Wherever weather shows, show `weather_credit` with it.

## Errors

Every error is the same shape, a code that never changes meaning and a sentence for a person that says what to do next:

```json
{ "error": { "code": "token_expired", "message": "This token expired. Make a new one under Settings, API tokens." } }
```

Act on the code, and show the sentence. Here is each one, with its HTTP status:

- `invalid_request` (400): something in the request isn't right, and `field` names it.
- `text_required` (400): a note needs words, or its last file.
- `date_out_of_range` (400): `date` is before your birthday or after today.
- `range_too_wide` (400): `from` and `to` span more days than one request reads. Ask in pieces.
- `token_missing` (401): no token was sent.
- `token_unknown` (401): that isn't a token Release Notes made.
- `token_revoked` (401): the token was revoked.
- `token_expired` (401): the token expired.
- `scope_required` (403): this token may not do that.
- `not_yours` (403): this token didn't add that note, and can't reach all your notes.
- `origin_refused` (403): the API isn't for web pages in a browser.
- `not_found` (404): there is no such request, or no such note or date, or no city for the spot sent to Here.
- `method_not_allowed` (405): that request doesn't take that method.
- `revision_mismatch` (409): the note or date changed since you read it. For a note, `revision` is its current one; for a date, read `GET /v1/upcoming` again.
- `account_closing` (409): the account is being deleted.
- `busy` (409): try again shortly, with the same `Idempotency-Key`.
- `too_large` (413): the request is over 256 KB, or a file is over its limit, 50 MB a file.
- `idempotency_mismatch` (422): that `Idempotency-Key` went with a different request.
- `rate_limited` (429): a limit for the day is reached, and `Retry-After` says how many seconds to wait.
- `unavailable` (503): try again shortly, with the same `Idempotency-Key`.

## Sending a note once

On a bad connection you can't always tell whether a note arrived. Send an `Idempotency-Key` header with each write, a string you make for that one note, like a random UUID, and send the same key if you try again. Release Notes answers a repeat with what it answered the first time, marked `Idempotent-Replayed: true`, and adds nothing. A key holds for 7 days, and for your whole account: sent again through another of your tokens, as an app does after you sign in again, it gets the same answer. So make a new key for each note, never one per token.

## Limits

Each day, from midnight UTC, an account may add 100 notes, make 200 other changes (appends, edits, deletes, files added to a note and pinned tags), save Upcoming 50 times, name 100 spots with Here and report 1,000 check-ins, across all its tokens, and each token may read 2,000 times. An Upcoming dry run and a city search count as reads. Reports look up 100 check-ins a day; a check-in past that is still saved, with no neighbourhood. Naming and deleting one count as other changes. Uploads count with the web's: 200 files and 2 GB a day. Past a limit the answer is `rate_limited`, with `Retry-After`. Every write that counts says where it stands in `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a repeat answered from its `Idempotency-Key` counts nothing, and says nothing.

## Photos, recordings and PDFs

A file goes in three steps:

1. Ask for a form with `POST /v1/uploads`, giving the file's `type`, like `image/jpeg`, its exact `size` in bytes, and its `name` if it has one. The answer has the upload's id as `upload`, the `type` it was signed for, and a `url` and its `fields`.
2. Post the file to that `url` within 5 minutes, as `multipart/form-data`: every one of the `fields`, then the file itself, last, as `file`.
3. Name it in a note's `uploads`, as `{"upload": "…", "type": "image/jpeg", "name": "lake.jpg"}`: on `POST /v1/notes` for a new note, or on `POST /v1/notes/{date}/{id}/media` to add it to one this token added.

```sh
form=$(curl -fsS https://notes.yourversionnumber.com/v1/uploads \
  -H "Authorization: Bearer $RN_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(jq -n --argjson size "$(wc -c < lake.jpg)" '{name: "lake.jpg", type: "image/jpeg", size: $size}')")
curl -fsS "$(jq -r .url <<<"$form")" \
  $(jq -r '.fields | to_entries[] | "--form-string \(.key)=\(.value)"' <<<"$form") \
  -F file=@lake.jpg
curl -fsS https://notes.yourversionnumber.com/v1/notes \
  -H "Authorization: Bearer $RN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/plain" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data "$(jq '{text: "The lake at dawn #lake", uploads: [{upload, type, name: "lake.jpg"}]}' <<<"$form")"
```

Release Notes checks each file against what arrived, then keeps it with the note, as it keeps one you add on the web: a photo gets its thumbnail and, on a note with no place of its own, the place it was taken, and photos and recordings get the descriptions and transcripts you've turned on. A note can have up to 20 files, at 50 MB a file. A note takes each upload once, and an upload no note takes is gone after a day. A form has no `Idempotency-Key`: if an upload fails, ask for a new one.

Send photos as JPEG, PNG or WebP where you can. A HEIC photo is kept, with its time and place, but gets no thumbnail, so it never shows in the email.

## Places

A note's `place` says where it was. Send one of two things, as it came:

- **A city** from `GET /v1/places?q=Zürich`, which answers the cities by that name, each with its `region`, `country`, time zone and spot. Pick the right one: two cities can share a name.
- **The spot a device is at**, from `POST /v1/places/here`. Send `lat` and `lon` in degrees, and the device's `accuracy_m` in metres if it has one. The answer's `place` has the spot's city and its neighbourhood as `district`, and `nearby` lists up to 6 businesses within the accuracy. If the person picks one, send the place with `venue` set to its name; nothing is picked for them. The spot is kept to six decimal places, and nothing is kept until a note takes it. Here takes no `Idempotency-Key`: if its answer is lost, ask again, and that counts again.

A place is kept as you send it. Release Notes checks its shape, its names, time zone and spot, but doesn't look it up again, so send the one the person picked.

On the web, a note with a spot links to your map. A note with no place shows the day's city, or your home's.

Changing a saved note's place, with `PUT /v1/notes/{date}/{id}/place`, takes either of those too, and leaves its words and its `revision` alone. A token changes the place of the notes it added, or of any note if it may read and change all your notes.

A token that may do that can also say where a whole day was: `PUT /v1/days/{date}/place` with `{"place": …}` and a city, and `DELETE /v1/days/{date}/place` to take it away. It's what every note that day with no place of its own shows. A day takes a city, not a device's spot.

An earlier day's weather follows its place, as on the web. A new note with a place on an earlier day brings it along too. If the weather can't be had just then, your write still counts.

## Check-ins

A check-in says you were somewhere, from about one time to about another. It isn't a note and never turns into one, and it touches no streak, count or search. There are none unless an app you use sends them.

Send each stop as the phone reports it, with `POST /v1/check-ins` and an `Idempotency-Key`. Send `source`, which is `visit` for a stop the phone noticed or `tap` for one you asked for, with `lat` and `lon`, and if you have them `accuracy_m`, `time_zone`, `arrived` and `left`. A `visit` needs one of those two times. A `tap` has no `left`: send the moment it was tapped as `arrived`, so one that waited in a queue keeps its time, or nothing, for now. Older times are fine, since a phone can be offline for days. Over a week ahead is refused.

A later report with the same `source` and arrival, to the second, is the same stay. It fills in what was missing, so an arrival and then a departure, or the same report twice, land in one check-in and your app keeps no ids. A `tap` is never filled in.

Each answer has its `check_in`: its `id`, `at`, `day`, `arrived` and `left` (either can be null), `lat`, `lon`, `accuracy_m`, `time_zone`, `source`, `revision`, and the name it shows as `label`. A name is worked out when it's read, the first of these that fits:

1. Its own `name`, given once.
2. A remembered place, the nearest within 100 m of its spot, whose id is `place`.
3. Its `district`, the neighbourhood and city.
4. "Unnamed stop".

`named_by` says which: `own`, `place`, `district` or `none`. Names are up to 100 characters. An account remembers up to 200 names, each with up to 50 spots, and forgetting one or renaming it changes every stop there at once, past ones too.

Stops next to each other read as one stay, with every stop's id in `ids`, when one begins within 30 minutes of the last one ending and they're the same place: within 100 m or at the same remembered place, without different names of their own. A short gap alone doesn't do it, since two shops can be a minute apart. Any id in a stay names the whole stay, so naming or deleting one acts on them all.

Reading needs a token that may read the activity log. Adding, naming and deleting need one that may add notes, and reach only the check-ins that token sent, or any of them if it may also read all your notes. Changing remembered places and deleting every check-in take that too.

The log has a row for each stay, of the kind `checkin`, with `checkin` (its id), `label`, `arrived`, `left`, `source`, `day`, `time_zone` and `merged`, how many stops it holds. It's the one row that shows words, since a stop with no name says nothing, and no row holds its spot. Only `GET /v1/check-ins` gives that. A phone that was offline files stops behind a cursor you already hold, so an app that wants every one reads `GET /v1/check-ins`, not `after`.

## Upcoming dates

Each date has a `kind` (birthday, anniversary, trip or event), a `title` on one line, and a `date`: month and day, `MM-DD`, for a birthday or anniversary, and the full `YYYY-MM-DD` for an event or a trip's first day. A birthday or anniversary may have its first `year`, so the line can say which one it is. A trip has an `end_date` and a `place`, its destination, like "Zürich" or "Paris, Texas". `tag` groups dates, `reminders` are the days before to remind, and `"email": false` keeps a date's reminders out of the morning email, and so out of `GET /v1/upcoming/reminders`. [Upcoming](/guide/upcoming/) says how each works, and `/v1/openapi.json` has every field.

```sh
curl https://notes.yourversionnumber.com/v1/upcoming/batch \
  -H "Authorization: Bearer $RN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data '{"add": [{"kind": "birthday", "title": "Mom", "date": "11-04", "year": 1955}]}'
```

To change a date, send its `id` and `revision` in `change`, with every field again as it should be. To remove one, send its `id` and `revision` in `remove`.

## From the terminal

A shell function, in your `.zshrc` or `.bashrc`:

```sh
rn() {
  curl --fail-with-body -sS https://notes.yourversionnumber.com/v1/notes \
    -H "Authorization: Bearer $RN_TOKEN" \
    -H "Content-Type: text/plain" \
    -H "Accept: text/plain" \
    --data-binary "$*"
}
```

Then `rn "Fixed the gate latch #house"`. Quote a note with a hashtag in it, since some shells take a `#` as the start of a comment.

## An Apple Shortcut

Build it once in the Shortcuts app:

1. Add **Ask for Input**, with the prompt "What happened?".
2. Add **Get Contents of URL**, with `https://notes.yourversionnumber.com/v1/notes`. Under it, set the method to **POST**; add the headers `Authorization`, with `Bearer` and your token, and `Accept`, with `text/plain`; and set the request body to **JSON** (or **Form**), with one text field named `text` set to **Provided Input**.
3. Add **Show Notification**, with **Contents of URL**, to see the version it was filed in.

On an iPhone with an Action Button, choose the shortcut under Settings, then **Action Button**, for a note at one press. The token lives inside the shortcut, so never share the shortcut itself.

## A note for each commit

A git `post-commit` hook, saved as `.git/hooks/post-commit` and made executable with `chmod +x`:

```sh
#!/bin/sh
# One note for each commit, sent in the background.
repo=$(basename "$(git rev-parse --show-toplevel)")
curl -fsS https://notes.yourversionnumber.com/v1/notes \
  -H "Authorization: Bearer $RN_TOKEN" \
  -H "Content-Type: text/plain" \
  -H "Idempotency-Key: $(git rev-parse HEAD)" \
  --data-binary "Committed to $repo: $(git log -1 --pretty=%s) #code" >/dev/null 2>&1 &
```

The commit's own id is the key, so a commit is never noted twice.

## On a schedule

A job run by cron or launchd doesn't see your shell's variables, so keep the token in a file only you can read (`chmod 600`) and read it there. A script that notes a backup when it finishes:

```sh
#!/bin/sh
RN_TOKEN=$(cat "$HOME/.config/release-notes/token")
if restic backup "$HOME/Documents"; then
  curl -fsS https://notes.yourversionnumber.com/v1/notes \
    -H "Authorization: Bearer $RN_TOKEN" \
    -H "Content-Type: text/plain" \
    --data-binary "The nightly backup ran #backup" >/dev/null
fi
```

In a crontab, `30 23 * * * $HOME/bin/backup-and-note.sh` runs it every night at half past eleven. On a Mac, a launchd agent with a `StartCalendarInterval` runs it the same way.

## Python

With nothing to install:

```python
import json, os, urllib.request, uuid

def note(text, key=None, **fields):
    """Add a note. Pass the same key again to retry without a second note."""
    request = urllib.request.Request(
        "https://notes.yourversionnumber.com/v1/notes",
        data=json.dumps({"text": text, **fields}).encode(),
        headers={
            "Authorization": "Bearer " + os.environ["RN_TOKEN"],
            "Content-Type": "application/json",
            "Idempotency-Key": key or str(uuid.uuid4()),
            "User-Agent": "my-script/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as answer:
        return json.load(answer)["note"]

print(note("Finished the first draft #writing")["version"])
```

## A GitHub Actions step

Keep the token as a repository secret named `RN_TOKEN`, then add a step:

```yaml
- name: Note the release
  env:
    RN_TOKEN: ${{ secrets.RN_TOKEN }}
  run: |
    curl -fsS https://notes.yourversionnumber.com/v1/notes \
      -H "Authorization: Bearer $RN_TOKEN" \
      -H "Content-Type: text/plain" \
      -H "Idempotency-Key: $GITHUB_RUN_ID" \
      --data-binary "Shipped $GITHUB_REPOSITORY #shipped"
```

The run's id is the key, so running the job again doesn't add the note twice.

## Home Assistant

A REST command in `configuration.yaml`, with the token in `secrets.yaml` as `release_notes_auth: "Bearer rn_..."`:

```yaml
rest_command:
  release_note:
    url: https://notes.yourversionnumber.com/v1/notes
    method: post
    headers:
      Authorization: !secret release_notes_auth
      Accept: text/plain
    content_type: application/json
    payload: '{"text": {{ text | to_json }}}'
```

Then any automation can add a note:

```yaml
action: rest_command.release_note
data:
  text: 'The garage door was left open for an hour #house'
```

## Building an app

[Building a client](/guide/api/clients/) says how an app that adds notes should behave, offline and on, so every client acts alike.
