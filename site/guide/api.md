---
title: The API
description: Add notes, files and places, read your archive and keep Upcoming dates, from a terminal, a script or an app.
---

## The idea

Anything that can send a web request can add a note: a terminal, a script, a home automation, an app. Send a token you made (see [API tokens](/guide/tokens/)), or one an app got by [signing you in](/guide/api/clients/), and some words, and they become a note on today's release, in your own voice, with photos, recordings and PDFs if you like, and where you were. A token can keep your [Upcoming](/guide/upcoming/) dates too, and read the reminders each morning brings, so an app can remind you on your phone.

Every request goes to `https://notes.yourversionnumber.com/v1`.

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

## Where everything is

- [Requests, errors and limits](/guide/api/basics/): what every request has in common, what a token may reach, each error and the daily limits. Read this one first.
- [Notes](/guide/api/notes/): add, read, change and delete notes, with their files and tags.
- [Reading your archive](/guide/api/archive/): your account, days, search, On this day, releases, the map, badges and the activity log.
- [Places](/guide/api/places/): say where a note or a day was.
- [Check-ins](/guide/api/check-ins/): the places you stop, and the names you give them.
- [Upcoming dates](/guide/api/upcoming/): birthdays, anniversaries, trips and events, and their reminders.
- [Recipes](/guide/api/recipes/): a terminal, an Apple Shortcut, a note for each commit, a schedule, Python, GitHub Actions and Home Assistant, to copy.
- [Reference](/guide/api/reference/): every request and answer, one by one.
- [Building a client](/guide/api/clients/): how an app that adds notes should behave, offline and on, so every client acts alike.

## The API's description

[`/v1/openapi.json`](https://notes.yourversionnumber.com/v1/openapi.json) describes every request and answer as OpenAPI, the format that used to be called Swagger. Anyone can fetch it, with no token. Point a tool like Postman or Swagger UI at it to try requests, a code generator to make a client, or an agent to learn what it can call. [The reference](/guide/api/reference/) is the same description, drawn as a page.
