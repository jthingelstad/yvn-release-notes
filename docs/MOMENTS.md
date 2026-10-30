# Moments

**Withdrawn on 2026-10-30, in API 1.8.0.** Jamie: "Moments are a source of
inspiration for a user to use a note and an easy way to get images and
everything into the application, but they should not form our API."

## What a moment is now

A source, on the phone. Changelog's Moments button opens Apple's Journaling
Suggestions, and what the person picks fills in the note they are writing:

- **The words.** A workout, a song, steps, a feeling, an event or who was
  there becomes a plain line in the draft ("Walked 3.2 mi in 48 min"), in
  the phone's own units. The person edits it like any other words before
  Commit.
- **The files.** Photos go in as the note's uploads.
- **The place.** A place visited becomes the note's place, through Here.

Release Notes keeps words, files and a place, as it does from every
channel. It keeps nothing of the app's own about what was picked.

## Why it was withdrawn

Step 1 (API 1.6.0, the same morning) kept the picked pieces as typed values
on the note, beside the words. Weighed again, it cost more than it gave:

- Everything that reads a note reads its words: the email, search, the
  book, tags, badges, On this day and the MCP tools. Each would have needed
  its own code to read a second copy of the same thing.
- Its nine kinds copied Apple's types, so a new type from Apple would have
  meant a new Release Notes API version. One framework would have shaped
  the API.
- Only Changelog could make one. No other channel (the web, email, agents)
  could, which sits badly with "any data, any channel".
- Showing stored numbers needed units on the server (miles or kilometres by
  home's country). Words written on the phone already carry the phone's
  units.

What it gave up: exact values (5,150 m where the words say "3.2 mi"), which
totals, a workout badge track or an agent's "how far did I walk?" might
have used. Those were ideas, never designed or promised. If typed values
are wanted one day, they belong to every channel, not one app's picker.

## What was removed

`POST /v1/notes` refuses `moment` as a field it doesn't have
(`invalid_request`, `field` `moment`), and nothing reads one: the token's
read, the activity row, the web's day page, both exports, the OpenAPI file
and the guide. No note on the live table had one (counted 2026-10-30), and
no released app sent one: changelog-ios #38, which would have, was closed
unmerged. `tests-node/api/v1-moments.test.ts` pins the refusal.

The design as it was, with its kinds, rules and open calls, is in git at
`43464f8:docs/MOMENTS.md`.
