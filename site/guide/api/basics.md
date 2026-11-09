---
title: Requests, errors and limits
description: What every API request has in common: tokens, what each may reach, every error, sending a note once and the daily limits.
---

## Every request

- Send the token as `Authorization: Bearer rn_...`, never in the address.
- Bodies are JSON, at most 256 KB, and a note is up to 20,000 characters, even with every character escaped.
- A note keeps every character you can see, and the invisible ones text needs, like the joiners inside an emoji and the marks that set its direction. Control characters other than tab and newline are dropped, and text with half a character in it (a lone surrogate escape, like `"\ud83d"` alone) is refused.
- With `Accept: text/plain`, every answer is text instead, for terminals: a line, or a line for each thing a list holds, and a note's words as they are.
- A day is written `YYYY-MM-DD`, in the time zone your account keeps. A time has its offset, like `2026-10-29T07:45:00-05:00`.
- Every answer to your token says today's version in `Release-Notes-Version`, and every answer says the API's own in `API-Version`.

## What a token may reach

What a token may do is ticked when you make it. [API tokens](/guide/tokens/) has the form.

| Scope | What it reaches |
| --- | --- |
| `notes:write` | Add notes, and read back, change and delete the ones this token added. Pin tags and find places. |
| `notes:read` | Read all your notes and [your archive](/guide/api/archive/), and change nothing. It needs nothing else ticked. |
| `notes:all` | Beside `notes:write`, read, change and delete any note, wherever you wrote it, and with files ticked add files to any of them. |
| `media:write` | Add files. It comes only with adding notes. |
| `upcoming` | Read and change your Upcoming dates, all of them, not only the ones it added. No other token reaches them. |
| `activity` | Read the activity log and your check-ins. |

Any token may read `GET /v1/me` and revoke itself with `DELETE /v1/token`. `GET /v1/tags` needs a token that adds or reads notes.

## Errors

Every error is the same shape, a code that never changes meaning and a sentence for a person that says what to do next:

```json
{ "error": { "code": "token_expired", "message": "This token expired. Make a new one under Settings, API tokens." } }
```

Act on the code, and show the sentence. Here is each one, with its HTTP status:

| Code and status | What it means |
| --- | --- |
| `invalid_request` (400) | something in the request isn't right, and `field` names it. |
| `text_required` (400) | a note needs words, or its last file. |
| `date_out_of_range` (400) | `date` is before your birthday or after today. |
| `range_too_wide` (400) | `from` and `to` span more days than one request reads. Ask in pieces. |
| `token_missing` (401) | no token was sent. |
| `token_unknown` (401) | that isn't a token Release Notes made. |
| `token_revoked` (401) | the token was revoked. |
| `token_expired` (401) | the token expired. |
| `scope_required` (403) | this token may not do that. |
| `not_yours` (403) | this token didn't add that note, and can't reach all your notes. |
| `origin_refused` (403) | the API isn't for web pages in a browser. |
| `not_found` (404) | there is no such request, or no such note or date, or no city for the spot sent to Here. |
| `method_not_allowed` (405) | that request doesn't take that method. |
| `revision_mismatch` (409) | the note or date changed since you read it. For a note, `revision` is its current one; for a date, read `GET /v1/upcoming` again. |
| `account_closing` (409) | the account is being deleted. |
| `busy` (409) | try again shortly, with the same `Idempotency-Key`. |
| `too_large` (413) | the request is over 256 KB, or a file is over its limit, 50 MB a file. |
| `idempotency_mismatch` (422) | that `Idempotency-Key` went with a different request. |
| `rate_limited` (429) | a limit for the day is reached, and `Retry-After` says how many seconds to wait. |
| `unavailable` (503) | try again shortly, with the same `Idempotency-Key`. |

## Sending a note once

On a bad connection you can't always tell whether a note arrived. Send an `Idempotency-Key` header with each write, a string you make for that one note, like a random UUID, and send the same key if you try again. Release Notes answers a repeat with what it answered the first time, marked `Idempotent-Replayed: true`, and adds nothing. A key holds for 7 days, and for your whole account: sent again through another of your tokens, as an app does after you sign in again, it gets the same answer. So make a new key for each note, never one per token.

## Limits

Each day, from midnight UTC, across all its tokens, an account may:

- add 100 notes
- make 200 other changes: appends, edits, deletes, files added to a note, pinned tags, and naming and deleting check-ins
- save Upcoming 50 times
- name 100 spots with Here
- report 1,000 check-ins, of which it will look up 100 check-ins a day. A check-in past that is still saved, with no neighbourhood.

Each token may read 2,000 times a day. An Upcoming dry run and a city search count as reads. Uploads count with the web's and emailed files: 200 files and 2 GB a day.

Past a limit the answer is `rate_limited`, with `Retry-After`. Every write that counts says where it stands in `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. A repeat answered from its `Idempotency-Key` counts nothing, and says nothing.
