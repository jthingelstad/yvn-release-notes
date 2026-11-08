---
title: Notes through the API
description: Add, read, change and delete notes, with their files and tags.
---

A token with only `notes:write` reaches the notes it added. One that may also read all your notes reaches any note. [What a token may reach](/guide/api/basics/#what-a-token-may-reach) has the rest.

## Add a note

`POST /v1/notes`

Send `{"text": "…"}`, or the words alone as `text/plain`. A form works too, as a Shortcut's **Form** body or `curl --data-urlencode "text=…"` sends it, with `text` and, if you like, `date` or `written_at`. Any other form is taken as the words, so `curl -d "my words"` still works, and a `multipart` body is refused.

Hashtags in the words are its tags, and links get their names, as on the web. What else you can send:

- `tags` gives it tags by name, with spaces or emoji if you like: `{"text": "…", "tags": ["Road Trip", "lake"]}`. A `#` in front is dropped, and "Road Trip", "road trip" and "road-trip" are one tag. Up to 20, each up to 50 characters, with no commas or line breaks. The words' hashtags are its tags too, after these. From version 1.21.0.

- `date` puts it on an earlier day, back to your birthday.
- `written_at` is the moment the words were typed: a note sent late files to the day it was typed. With neither, it's today's.
- `uploads` gives it files (see [Photos, recordings and PDFs](#photos-recordings-and-pdfs)), and then it needs no words.
- `place` says where it was (see [Places](/guide/api/places/)).
- `"markup": "rich"` says its `text` has rich-text marks, like `**bold**` and lists. Without it, the words are plain and the marks show as typed. An edit keeps what the note is. From version 1.16.0.

The answer has the note's `id`, `date`, `version` and `revision`, and how many `files` it has.

## Read notes

### GET /v1/notes?from=YYYY-MM-DD&to=YYYY-MM-DD

The notes this token added on those days, or every note on them if it may read all your notes, oldest first, each as the request below gives it.

- `to` is the last day, and left out it's `from`, so one day is `?from=` alone.
- A request reads up to 31 days; ask for a longer span in pieces.
- `limit` sets how many a page holds, and `next` in the answer, sent back as `after`, gives the next page.
- A page stops at about a megabyte, so it can hold fewer than `limit` notes: keep asking with `after` until `next` is null.
- Days with none give an empty list.

### GET /v1/notes/{date}/{id}

One note this token added, or any note if it may read all your notes, with its text, `revision` and `written_at`, and its files as `media`: each one's number `n`, `kind`, `type`, `name`, `size`, and `thumb` when it has a small copy.

A note also says:

- `tags`, each tag's key, like `road-trip`, which is what matches, and `tag_names`, the same tags as they were written, like "Road Trip" (from version 1.21.0)
- `markup` (`rich`, or null for plain words)
- `parts`, its words cut into strings, links and tags, ready to show
- its own `place`, and `no_place` if you took its place away
- `edited_at`, `tz` and `late`
- who wrote it (`author` and `client`), and `from` for an import
- `attachments`, how many files its email carried that weren't kept

Each file says its `transcript` and `description`, the words Release Notes kept if you turned those on, or null, and `writing` while a transcript is still to come. A transcript arriving doesn't change the note's `revision`; `transcript.added` in the activity log says when.

Add `?include=urls` to either request to get each file's `url` and its small copy's in the answer, good for ten minutes, instead of asking for them one by one. All of this is from version 1.14.0.

## Change a note

- `PUT /v1/notes/{date}/{id}`: replace its text. Send `{"text": "…", "revision": "…"}` with the revision you read; a note changed since, on the web say, is refused with the current one.
- `POST /v1/notes/{date}/{id}/append`: add a paragraph to it, with `{"text": "…"}`.
- `PUT /v1/notes/{date}/{id}/place`: say where it was. See [Places](/guide/api/places/).
- `DELETE /v1/notes/{date}/{id}/place`: take its place away, so it says `no_place` and shows none from its day.
- `DELETE /v1/notes/{date}/{id}`: delete it.

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

Send photos as JPEG, PNG or WebP where you can. A HEIC photo is kept as it is, with its time and place, and gets a JPEG thumbnail like any other, but only some browsers can open the whole photo.

### The other file requests

- `POST /v1/notes/{date}/{id}/media`: add files to a note, with `{"uploads": […]}`.
- `GET /v1/notes/{date}/{id}/media/{n}`: an address for one of its files, as `url`, good for ten minutes and fetched with no token. `?size=thumb` gives a photo's small copy instead, for a list.
- `DELETE /v1/notes/{date}/{id}/media/{n}`: take one file off it, with its small copy, transcript and description. The other files keep their numbers, and its `revision` changes. A note with no words can't lose its last file, so delete the note instead. A file that came by email stays in that note's email until the note is deleted, and no app can read it there. Taking a file off a note you didn't add through this token also needs a token that may read and change all your notes. From version 1.17.0.

## Tags

- `GET /v1/tags`: your tag row, the pinned tags and then up to 20 recent ones, the tags used most in the last 30 days. Any token may ask. Each has its key and, from version 1.21.0, its name: `pinned_names` beside `pinned`, and a `name` on each recent one.
- `PUT /v1/tags/pinned`: replace your pinned tags, with `{"pinned": ["house", "Road Trip"]}`, up to 12 tags, by name, in any language's letters, like `Москва` or `東京`. They're the same ones the web shows under the note box.
