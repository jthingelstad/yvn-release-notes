---
title: Upcoming dates through the API
description: Read and change your birthdays, anniversaries, trips and events, and the reminders each morning's email carries.
---

Each date has a `kind` (birthday, anniversary, trip or event), a `title` on one line, and a `date`: month and day, `MM-DD`, for a birthday or anniversary, and the full `YYYY-MM-DD` for an event or a trip's first day. A birthday or anniversary may have its first `year`, so the line can say which one it is. A trip has an `end_date` and a `place`, its destination, like "Zürich" or "Paris, Texas". `tags` group dates, by name, up to 20 of them, as a note's do (the single `tag` of before version 1.21.0 still works), `reminders` are the days before to remind, and `"email": false` keeps a date's reminders out of the morning email, and so out of `GET /v1/upcoming/reminders`. [Upcoming](/guide/upcoming/) says how each works, and `/v1/openapi.json` has every field.

```sh
curl https://notes.yourversionnumber.com/v1/upcoming/batch \
  -H "Authorization: Bearer $RN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data '{"add": [{"kind": "birthday", "title": "Mom", "date": "11-04", "year": 1955}]}'
```

To change a date, send its `id` and `revision` in `change`, with every field again as it should be. To remove one, send its `id` and `revision` in `remove`.

## The requests

- `GET /v1/upcoming`: your Upcoming dates, soonest first, each with its `id`, its `revision`, its `next` date and the line the email says about it. A trip or event that's over is left out and only counted, as `past_left_out`.
- `POST /v1/upcoming/batch`: add, change and remove dates together, up to 50 dates a request, as `{"add": […], "change": […], "remove": […]}`. It saves all or nothing: if one date isn't right, none is saved, and `field` names the one, like `add[1]`. With `"dry_run": true` it checks everything and finds each trip's city, and saves nothing. The answer lists what was `added`, in the order you sent it, then what was `changed` and `removed`.
- `GET /v1/upcoming/reminders`: the reminders each morning's email carries, day by day, for the next 14 days, or up to 31 days ahead with `days`. Each day has `send_at`, the moment that morning's email is due, and each reminder the date's `id` as `upcoming`, the day it falls on as `date`, and its `when` and `line`, as the email says them. A date with its email reminders turned off isn't there; a paused email doesn't change the list.
- `DELETE /v1/upcoming/{id}`: remove one date, with the revision you read as `?revision=`.
