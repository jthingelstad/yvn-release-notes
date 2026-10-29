---
title: The API
description: Add notes from a terminal, a script or an app, with the requests, the errors, the limits and recipes to copy.
---

## The idea

Anything that can send a web request can add a note: a terminal, a script, a home automation, an app. Send a token you made (see [API tokens](/guide/tokens/)) and some words, and they become a note on today's release, in your own voice.

Every request goes to `https://notes.yourversionnumber.com/v1`, and `/v1/openapi.json` there describes the whole API for tools that read OpenAPI, with no token needed. For now only Jamie can make tokens; they open to every account after that.

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
- Bodies are JSON, at most 128 KB, and a note is up to 20,000 characters.
- With `Accept: text/plain`, every answer is one short line instead, for terminals.
- A day is written `YYYY-MM-DD`, in the time zone your account keeps. A time has its offset, like `2026-10-29T07:45:00-05:00`.
- Every answer says today's version in `Release-Notes-Version` and the API's own in `API-Version`.

## The requests

- `GET /v1/me`: today's date and version, the versions for the next 14 days, your streak, your time zone, when your email goes, and this token's name, what it may do and when it expires. Never your birthday. Any token may ask.
- `POST /v1/notes`: add a note. Send `{"text": "…"}`, or the words alone as `text/plain`. Hashtags in the words are its tags, and links get their names, as on the web. `date` puts it on an earlier day, back to your birthday. `written_at` is the moment the words were typed: a note sent late files to the day it was typed. With neither, it's today's. The answer has the note's `id`, `date`, `version` and `revision`.
- `GET /v1/notes/{date}/{id}`: one note this token added, with its text, `revision` and `written_at`.
- `PUT /v1/notes/{date}/{id}`: replace its text. Send `{"text": "…", "revision": "…"}` with the revision you read; a note changed since, on the web say, is refused with the current one.
- `POST /v1/notes/{date}/{id}/append`: add a paragraph to it, with `{"text": "…"}`.
- `DELETE /v1/notes/{date}/{id}`: delete it.
- `GET /v1/tags`: your tag row, the pinned tags and then up to 20 recent ones, the tags used most in the last 30 days. Any token may ask.
- `PUT /v1/tags/pinned`: replace your pinned tags, with `{"pinned": ["house", "work"]}`, up to 12 tags. They're the same ones the web shows under the note box.
- `GET /v1/activity`: your activity log, newest first, without any words: no note text, no email's subject or sender, no setting's value. `after` gives only rows newer than one you've seen, and `before`, with the `next` from the answer, the page older. `kinds` keeps some kinds, like `note,mail`, and `limit` sets how many rows a page holds.
- `DELETE /v1/token`: this token revokes itself. Any token may ask.

Adding, changing and deleting notes and pinning tags need a token that may add notes, and only ever touch the notes that same token added. The activity log needs a token that may read it.

## Errors

Every error is the same shape, a code that never changes meaning and a sentence for a person that says what to do next:

```json
{ "error": { "code": "token_expired", "message": "This token expired. Make a new one under Settings, API tokens." } }
```

Act on the code, and show the sentence. Here is each one, with its HTTP status:

- `invalid_request` (400): something in the request isn't right, and `field` names it.
- `text_required` (400): a note needs words.
- `date_out_of_range` (400): `date` is before your birthday or after today.
- `token_missing` (401): no token was sent.
- `token_unknown` (401): that isn't a token Release Notes made.
- `token_revoked` (401): the token was revoked.
- `token_expired` (401): the token expired.
- `scope_required` (403): this token may not do that.
- `not_yours` (403): this token didn't add that note.
- `origin_refused` (403): the API isn't for web pages in a browser.
- `not_found` (404): there is no such request, or no such note.
- `method_not_allowed` (405): that request doesn't take that method.
- `revision_mismatch` (409): the note changed since you read it, and `revision` is its current one.
- `account_closing` (409): the account is being deleted.
- `busy` (409): try again shortly, with the same `Idempotency-Key`.
- `too_large` (413): the request is over 128 KB.
- `idempotency_mismatch` (422): that `Idempotency-Key` went with a different request.
- `rate_limited` (429): a limit for the day is reached, and `Retry-After` says how many seconds to wait.
- `unavailable` (503): try again shortly, with the same `Idempotency-Key`.

## Sending a note once

On a bad connection you can't always tell whether a note arrived. Send an `Idempotency-Key` header with each write, a string you make for that one note, like a random UUID, and send the same key if you try again. Release Notes answers a repeat with what it answered the first time, marked `Idempotent-Replayed: true`, and adds nothing. A key holds for 7 days.

## Limits

Each day, from midnight UTC, an account may add 100 notes and make 200 other changes (appends, edits, deletes and pinned tags), across all its tokens, and each token may read 2,000 times. Past a limit the answer is `rate_limited`, with `Retry-After`. Every write says where it stands in `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.

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
2. Add **Get Contents of URL**, with `https://notes.yourversionnumber.com/v1/notes`. Under it, set the method to **POST**; add the headers `Authorization`, with `Bearer` and your token, and `Accept`, with `text/plain`; and set the request body to **JSON**, with one text field named `text` set to **Provided Input**.
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
