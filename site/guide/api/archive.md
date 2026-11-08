---
title: Reading your archive through the API
description: Your account, days, search, On this day, releases, the map, badges, the mail log and the activity log.
---

## You and this token

### GET /v1/me

Today's date and version, the versions for the next 14 days, your streak, your time zone, when your email goes, your `account`, whether you're a Supporting Member of the Weekly Thing (`supporting_member`, from version 1.12.0 of the API), the week and day you're on, as Today and the morning email show them (`lived`, from 1.13.0), and this token's `id`, name, what it may do and when it expires. Never your birthday.

`account` is the same for every token you make and never changes, so an app can tell whose account a token opens. The token's `id` never changes either, and is never the token itself. Any token may ask.

### DELETE /v1/token

This token revokes itself. Any token may ask.

## Your archive

A token that may read all your notes (`notes:read`, or `notes:all`) can also ask for these, from version 1.15.0. `notes:read` needs nothing else ticked and changes nothing. A token with only `notes:write` reads just the notes it added, and gets `scope_required` here. Each counts as one read.

### GET /v1/days

Your timeline, newest first, with today first: every day with notes, a morning email, a pause or a place. Each says its `version`, `notes_total`, `files`, `emailed`, `paused`, the `place` set on it, `around` (the place a note with none shows, and whether it comes from the `day` or `home`) and `weather`. `?limit=` sets how many, and `?before=` takes `next` for the page after. Read what's on those days with `GET /v1/notes`.

### GET /v1/days/{date}

One day, the same, with its `notes`, whether it's `today`, and what it `collected`. A day stops at about a megabyte of notes: `next` then goes to `GET /v1/notes` as its `after`, with `from` set to that day. A day before your birthday or after today is `date_out_of_range`.

### GET /v1/search?q=lake

Notes with every word, in their words, places, link names, transcripts and descriptions, newest first, with the `total` found. Up to ten words or quoted phrases. `?tag=running` finds a tag's notes, on its own or with `q`. `?from=` and `?to=` narrow it to some days, and `?after=` takes `next`.

### GET /v1/on-this-day

The same day of each earlier release, newest first, as the morning email's On this day, each with its first five notes and its `notes_total`. `?date=` looks back from another day, and `?before=` takes `next`.

### GET /v1/releases

Each year of your life, newest first, with its `days` and `notes`.

### GET /v1/releases/{v}

One of them in detail, like `/v1/releases/52.0`: its longest streak, tags, and badges if you show them.

### GET /v1/tags/all

Every tag you've used, with its `notes`, `days`, `first` and `last`, most used first.

### GET /v1/map/pins

Where your notes were, as the Map's pins, oldest first, with a note's opening words. Draw them on your own map. `?after=` takes `next`. From version 1.19.0 of the API, `q` and `tag` keep only the pins of the notes a search finds, as they do on `GET /v1/search`.

### GET /v1/badges

What you've earned and the tracks, or `show_badges` false and nothing else if you've turned them off.

### GET /v1/mail-log

What became of each email in the last 30 days: its `outcome`, and its subject, sender and opening words, cut short.

`GET /v1/days/{date}`, `GET /v1/search` and `GET /v1/on-this-day` take `?include=urls` too. Wherever weather shows, show `weather_credit` with it.

## The activity log

### GET /v1/activity

Your activity log, newest first, without any words: no note text, no email's subject or sender, no setting's value. It needs a token that may read it.

- A row a token wrote names it by `token` and, from version 1.4.0 of the API, by `token_id`, the `id` that `GET /v1/me` gives; older rows have no `token_id`.
- `after` gives only rows newer than one you've seen, and `before`, with the `next` from the answer, the page older.
- `kinds` keeps some kinds, like `note,mail`, `from` and `to` keep some days, as they do for notes, and `limit` sets how many rows a page holds.
