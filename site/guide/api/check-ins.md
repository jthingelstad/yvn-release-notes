---
title: Check-ins through the API
description: Send the places you stop as a phone reports them, read them back, name them and remember them.
---

A check-in says you were somewhere, from about one time to about another. It isn't a note and never turns into one, and it touches no streak, count or search. There are none unless an app you use sends them.

## Send a stop

`POST /v1/check-ins`

Send each stop as the phone reports it, with `POST /v1/check-ins` and an `Idempotency-Key`. Send `source`, which is `visit` for a stop the phone noticed or `tap` for one you asked for, with `lat` and `lon`, and if you have them `accuracy_m`, `time_zone`, `arrived` and `left`. A `visit` needs one of those two times. A `tap` has no `left`: send the moment it was tapped as `arrived`, so one that waited in a queue keeps its time, or nothing, for now. Older times are fine, since a phone can be offline for days. Over a week ahead is refused.

A later report from the same token with the same `source` and arrival, to the second, is the same stay. It fills in what was missing, so an arrival and then a departure, or the same report twice, land in one check-in and your app keeps no ids. A `tap` is never filled in.

Each answer has its `check_in` and `kept`, which is false when the stop is at a place you ignore: nothing is kept, and the `check_in` shows what it would have been, with an `id` that names nothing. Each answer's `check_in` has its `id`, `at`, `day`, `arrived` and `left` (either can be null), `lat`, `lon`, `accuracy_m`, `time_zone`, `source`, `revision`, and the name it shows as `label`. A token that can't read the log or all your notes isn't told a remembered place's name. A name is worked out when it's read, the first of these that fits:

1. Its own `name`, given once.
2. A remembered place, the nearest within 100 m of its spot, whose id is `place`.
3. Its `district`, the neighbourhood and city.
4. "Unnamed stop".

`named_by` says which: `own`, `place`, `district` or `none`. Names are up to 100 characters. An account remembers up to 200 names, each with up to 50 spots, and forgetting one or renaming it changes every stop there at once, past ones too.

Stops next to each other read as one stay, with every stop's id in `ids`, when one begins within 30 minutes of the last one ending and they're the same place: within 100 m or at the same remembered place, without different names of their own. A short gap alone doesn't do it, since two shops can be a minute apart. Any id in a stay names the whole stay, so naming or deleting one acts on them all.

Reading needs a token that may read the activity log. Adding, naming and deleting need one that may add notes, and reach only the check-ins that token sent, or any of them if it may also read all your notes. Changing remembered places and deleting every check-in take that too.

The log has a row for each stay, of the kind `checkin`, with `checkin` (its id), `label`, `arrived`, `left`, `source`, `day`, `time_zone` and `merged`, how many stops it holds. It's the one row that shows words, since a stop with no name says nothing, and no row holds its spot. Only `GET /v1/check-ins` gives that. A phone that was offline files stops behind a cursor you already hold, so an app that wants every one reads `GET /v1/check-ins`, not `after`.

## The requests

- `GET /v1/check-ins`: where you stopped, newest first. `from`, `to`, `limit` and `before` choose a stretch, and `next` is the `before` for the next page.
- `PATCH /v1/check-ins/{id}`: give it a name of its own, with `{"name": "…", "revision": 1}` and the revision you read, or `"name": null` to take it away.
- `DELETE /v1/check-ins/{id}`: delete it, and every stop read as one with it.
- `DELETE /v1/check-ins`: delete every check-in, with `?confirm=all`. It answers how many went, and your remembered places stay.
- `GET /v1/check-ins/places`: the places you've told it to remember, each saying whether it's `ignored`.
- `POST /v1/check-ins/places`: remember a place, with `{"name": "…", "lat": 45.5, "lon": -93.2}`, and `"ignored": true` to ignore it from the start. A name you already use gets this spot too.
- `GET /v1/check-ins/places/{id}`: one place, with `check_ins`, how many stays are there, hidden ones too.
- `PATCH /v1/check-ins/places/{id}`: rename it with `{"name": "…"}`, ignore it with `{"ignored": true}`, or both.
- `DELETE /v1/check-ins/places/{id}`: forget it, all its spots with it. Your check-ins there go back to the names they had, and any it hid show again.
- `DELETE /v1/check-ins/places/{id}/check-ins?count=`: delete every check-in there, hidden ones too, with the count `GET /v1/check-ins/places/{id}` gave you. The place stays.

## Ignored places

Ignore a place you don't want logged, such as home. From then on a stop there isn't kept: your app is told `kept: false`, and nothing is saved or looked up. The check-ins already there are hidden, not deleted. They're left out of `GET /v1/check-ins`, the log and every read of one, which answers `not_found`, until you unignore the place or forget it. A stop already kept there before you ignored it can still be filled in.

To delete them instead, read the place for its `check_ins`, show that number, and send it as `count`. If it changed in between, the answer is `revision_mismatch` with the `count` now, and nothing is deleted.

The log says when a place was ignored (`checkin.ignored`) or unignored (`checkin.unignored`), with the place's id, and a deletion at one place is a `checkin.deleted` with `place` and `count`.
