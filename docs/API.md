# Tokens, the public API and Changelog

Designed 2026-10-29, with Jamie's calls made the same day (at the end,
under "Jamie's calls"). Phases 1 to 5 are built on the server (2026-10-29);
the build order is under "Phases".

Jamie, 2026-10-29: the idea is "enabling and kind of embracing the techie,
kind of geeky aspect of release notes", and making it "even easier to get
information into release notes". It is one idea with two doors:

- A **token** is a named, scoped key that the owner makes on the web.
- The **API** (`/v1`) is what a token opens.
- **Changelog**, an iPhone app, is "a super efficient way to send events into
  release notes, hence the name Changelog". Changelog, curl, a Shortcut and
  any client someone else writes all use the same API.

**v1 is for adding things.** Jamie, 2026-10-29: "adding content is the
primary thing and I also think Upcoming should be supported as well. That is
a great feature that could then power notifications." So v1 adds notes with
their files, places and tags, plus Upcoming dates and their reminders. Its
one wider read is the activity log, trimmed of words. Reading the archive
waits until after v1.

```sh
echo "Fixed the kitchen faucet #house" | curl -sS --data-binary @- \
  -H "Authorization: Bearer $RN_TOKEN" -H "Accept: text/plain" \
  https://notes.yourversionnumber.com/v1/notes
Filed in 4.5.137.
```

(Examples use the dev server's fictional subscriber, born 1981-06-14, on
2026-10-29.)

## Rules it keeps

- **Every write proves ownership** (AGENTS.md, Who can write). A token is a
  fifth proof. Like `notes:write` for an agent, it is delegated in the
  owner's email-verified web session and checked live on every request.
- **No bearer authenticates a web route** (`packages/backend/oauth.ts`). A
  token opens `/v1` only: it never authenticates an `/api` request, and
  `/v1` ignores cookies.
- **Nothing logs note text, file names or bytes, or token values.** Activity
  rows say what happened and through what, never the words.
- **Scopes are the owner's own approvals,** ticked one by one when a token
  is made.
- **The capture writer is the only writer** for delegated writes
  (`workers/capture.ts`). It commits the note, the live grant check, the
  idempotency receipt, the quota and the audit together. The API is a
  second door onto it, so MCP and the API can't drift apart.
- **Upcoming entries never log titles, dates or destinations.** Note scopes
  never reach Upcoming.
- **Never test against live data.** Builds are tested with the dev server's
  fictional account and fakes.

## Tokens

A token is the owner's own key, with no refresh (`packages/backend/tokens.ts`).
It is a `USER#` row, `APITOKEN#<id>`, so the capture function, which writes
only `USER#` rows, proves it in the same transaction as each write, as it
proves an agent's grant. Its hash points back from `OAUTHACCESS#<hash>`
(`kind` `token`, resource `<origin>/v1`), which the MCP bearer check never
accepts, tracked under `OAUTHUSER#` so the account's deletion removes it with
the agent connections. No role changes: the MCP and capture roles already
read and write those prefixes (`tests-node/infra/mcp-role.test.ts` holds
`/v1` to both).

- **Made in Settings, under API tokens,** or by an app's sign-in (Phase 5),
  which is the same form on the consent page. A web session is required.
  The owner gives it:
  - a **name**: 1 to 40 code points, unique among the account's live
    tokens. It is the token's identity: "Terminal", "Changelog on my
    iPhone". Unlike an MCP client's self-reported name, the owner chose it;
  - its **scopes** (below);
  - an **expiry** of 90 days, 1 year (the default) or never.
- **Shown once:** `rn_` followed by 43 base64url characters (256 random
  bits, `newToken()`), with a copy button. The prefix makes a leaked token
  easy to find in a repo or a log. Only its SHA-256 hash is stored. (A QR
  code for Changelog to scan waits for the app's camera; it is pasted for
  now.)
- **At most 20 live tokens** an account.
- **Settings lists each one** after the agent connections, with its name,
  scopes, when it was made, the day it was last used (from each call's
  content-free record, as a connection's is) and when it expires. Revoke
  ends it on the next request. Scopes don't change in place: make a new
  token and revoke the old one.
- **An ended token says so.** Its row goes, and its pointer stays 30 days
  marked `revoked`, so its client hears `token_revoked`, not
  `token_unknown`, and knows to sign in again.
- **A token ends** when:
  - the owner revokes it;
  - it revokes itself (`DELETE /v1/token`, a client's sign out), or, for a
    token an app signed in for, its app ends it at `/oauth/revoke` with its
    own client id;
  - it expires;
  - the account is deleted. Deletion blocks token writes first, as it does
    MCP writes (`mcp_deleting`), then removes every token.
- **A stopped account still writes** through a token, as it does on the web
  and through MCP. `GET /v1/me` reports the status, so a client can say why
  no email is coming.
- **Activity rows:**
  - `connection.added` (`connection`, the name as `client` and as `token`,
    and `scopes`) when a token is made;
  - `connection.removed` with `reason` `owner`, or `client` when it revoked
    itself. Nothing writes a row when a token expires; Settings shows it as
    expired.
  - A token's reads are one row a token a local day, as an agent's are
    (calls, never arguments or results).
- **Who sees Tokens:** every subscriber, in Settings, with nothing to turn
  on (Jamie, 2026-10-29: "Open up token generation and all of the needed
  features so we can continue with build. I am fine with these features
  being enabled automatically."). Until then only the configured
  administrator did (`AdminUserId`).

## Voice and via

Today `author: 'assistant'` does two jobs. It means "not the owner's words"
and also "came through a connection". A note typed into Changelog or a
terminal is the owner's own words that only came _via_ something.

- **Every token writes in the owner's voice.** A token's note is
  `source: 'api'` (`NOTE#<day>#t-<id>`, as an agent's is `a-`), with the
  token's id (`connection`) and its name at the time (`token`). It has no
  `author`.
- It reads, counts and searches like a web note. It counts toward streaks
  and badges, and the email shows it with no "Added by" line.
- **"via <name>"** shows quietly on the web, in both exports and in the
  activity log, but not in the morning email (Jamie's calls, 3).
- **`client`** is the product a client names in its User-Agent, such as
  `Changelog` from `Changelog/0.1 (iOS 26.1)` or `curl` from `curl/8.7.1`.
  It is letters, digits and `._-`, at most 40, and absent when nothing
  usable came. Like MCP's client names it is self-reported, so it labels
  and earns a badge, but never grants anything.
- An "automation" voice, shown as "Added by <name>:" and left out of
  streaks, comes back only if webhooks ever do (Deferred). Nothing here
  blocks it.

## Where it runs

`/v1/*` is served by the MCP Web Function (`server/mcp`), behind a new
CloudFront behavior to the same origin: HTTPS only (an API client is never
redirected), and its own origin request policy, which forwards no cookie
and adds the `Idempotency-Key` and `User-Agent` a write needs. The function already does three
things the API needs:

- checks bearer tokens with strong reads;
- holds the reader role;
- calls the capture function for every write.

There is no new DNS record, certificate or function.

| Option                                   | Verdict                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/*` on the MCP Web Function          | **Chosen.** One behavior added, no new write path.                                                                                             |
| Bearer tokens on the web server's `/api` | No. The web role can write everything, it breaks the bearer rule, and `/api` is the React app's private API, whose shape changes with the app. |
| A third Web Function                     | No. More infrastructure for no separation the first lacks.                                                                                     |

- **Contract first,** as MCP is. `server/mcp/openapi.ts` builds OpenAPI 3.1
  from the route definitions and the constants, served at
  `/v1/openapi.json`, which needs no token, and
  `node --import tsx tools/export-api-contract.ts` writes it to
  `contracts/api-surface.json`. Its `info.version` is `API_VERSION` and its
  `x-changes` is `API_CHANGES` (`server/mcp/v1.ts`), which say what changed.
  `contracts/api-versions.json` keeps each version's digest, so a change
  under a version already recorded is refused, and tests refuse drift
  between the routes, the contract and the guide.
- **`/v1` only ever gains things:** new endpoints, new optional fields, new
  error codes. A breaking change would be `/v2`. Deprecations are announced
  in `x-changes`, with a date.
- **Not for browsers in v1.** It sends no CORS headers, and a request
  carrying any Origin other than the site's is refused, as on `/mcp`.
- **The dev server** (`tools/dev-server.ts`) serves `/v1` against its
  fictional account and prints a ready-made token at start. It is the
  sandbox for anyone building a client. An Android emulator reaches it at
  `10.0.2.2`.

## Scopes

| Scope         | Opens                                                                                           | From            |
| ------------- | ----------------------------------------------------------------------------------------------- | --------------- |
| `notes:write` | creating notes; appending to, editing, reading and deleting notes this token wrote; pinned tags | MCP             |
| `media:write` | files on this token's notes; only beside `notes:write`                                          | MCP             |
| `upcoming`    | Upcoming dates and their reminders                                                              | MCP             |
| `activity`    | the activity log, trimmed of words                                                              | new, `/v1` only |

- **Every token can** read `/v1/me` and the owner's tags, and can revoke
  itself.
- **Not in v1: `notes:read` and `media:read`.** A key that lives a year in
  shell history and can read a whole journal is a bigger risk than MCP's
  hour-long access tokens. Archive reads come after v1 if a client needs
  them.
- **No token can** make tokens, change settings, export, or delete the
  account. The one exception is the pinned tags list (Tags), which Jamie
  wants the same on the web and every phone.
- An agent's OAuth consent (`/mcp`) never offers `activity`. An app's
  sign-in (`/v1`, Phase 5) offers the four token scopes, because what it
  gets is a token.

## The API

### Across every endpoint

- **Address:** `https://notes.yourversionnumber.com/v1/...`
- **Auth:** `Authorization: Bearer rn_...`, and nothing else: no query
  string tokens, no cookies.
- **JSON in and out,** UTF-8. A note's text may be up to `MAX_NOTE` (20,000
  code points), and a request body at most 256 KB (`V1_BODY`; 128 KB
  before 1.7.0), room for the longest note with every character escaped,
  as Python's `json.dumps` sends it (an emoji is twelve bytes). A JSON body
  with a lone surrogate escape anywhere is refused (`unicode.wellFormed`),
  and a note's words lose control characters other than tab and newline,
  as from every channel (`notes.noteWords`; API 1.7.0).
- **`Accept: text/plain`** gets text instead, for terminals: a write's one
  line (`Filed in 4.5.137.`), a list's line for each thing, a note's words
  as they are. Accept is read in full: text wins only where it outranks
  `application/json` by q, or ties and comes first (API 1.5.0). A
  `text/plain` body on `POST /v1/notes` is the note's text. So is a form
  (`application/x-www-form-urlencoded`, which `curl -d` sends for any
  words) unless every name in it is `text`, `date` or `written_at` and
  `text` is one: then it is read as those fields (`NOTE_FORM`, API 1.7.0),
  as a Shortcut's Form body sends them. A multipart, image, audio or video
  body is refused, naming `Content-Type`; files go through uploads.
- **Dates and times:** `YYYY-MM-DD` dates are days in the account's own
  zone; times are RFC 3339.
- **Headers on every answer:**
  - `Cache-Control: no-store` (`/v1/openapi.json`, which needs no token,
    is `public, max-age=300`);
  - `Release-Notes-Version: 4.5.137`, today's version, on every answer to
    a good token, a 404 or 405 included (a browser's refused request reads
    nothing, so has none);
  - `API-Version: 1.7.0`, the API's own version (`API_VERSION` in
    `server/mcp/v1.ts`).
- **Idempotency:** every write but `POST /v1/uploads` and
  `POST /v1/places/here` takes an `Idempotency-Key` header (1 to 128
  printable ASCII characters). Those two keep no receipt: a retry gets a
  new form, or a new lookup that counts again (API 1.5.0 stopped listing
  the key on them). Receipts last **7 days** on `/v1`, against
  24 hours on MCP, because a phone can be offline for a weekend.
  - The same key with the same request answers the first result again,
    with `Idempotent-Replayed: true`.
  - The same key with a different request is a 422,
    `idempotency_mismatch`.
  - The key is optional, so a one-off curl still works. The client guide
    says every app sends one.
  - Receipts are the account's (API 1.4.0, 2026-10-30):
    `USER#<owner>/CAPTURE#api#<sha256 of the key>`, so a key sent again
    through any token of the account (an app's queue after it signs in
    again) gets the first answer, and another account never sees it. Two
    tokens of one account sending one key for different requests get
    `idempotency_mismatch`. The hash is of the operation and its arguments
    alone, and a token's scopes are checked before any receipt is read, so
    a token that couldn't make the request is refused, never answered.
  - Before 1.4.0 each token kept its own, `CAPTURE#<token id>#<key hash>`.
    Until `PER_TOKEN_RECEIPTS_UNTIL` (2026-11-13T00:00Z: the 7 days such a
    receipt lives, from a release about 2026-10-30, with a week to spare) a
    write also reads that one, answers from it if it is live, and commits
    only while it isn't (one condition check in the same transaction), so a
    resend begun under 1.3.0 is never filed twice. Such a receipt answers
    only the token that wrote it. After the cutoff, neither is looked at,
    and the code for it can go.
- **Errors** all have one shape, with a stable code and a sentence that says
  what to do next:

  ```json
  {
    "error": { "code": "scope_required", "message": "This token can't add files. Make a token with Add files ticked." }
  }
  ```

  | Status | Codes                                                                          |
  | ------ | ------------------------------------------------------------------------------ |
  | 400    | `invalid_request` (with `field`), `text_required`, `date_out_of_range`         |
  | 401    | `token_missing`, `token_unknown`, `token_revoked`, `token_expired`             |
  | 403    | `scope_required`, `not_yours` (a note another channel wrote), `origin_refused` |
  | 404    | `not_found`                                                                    |
  | 409    | `revision_mismatch` (with the current `revision`), `account_closing`, `busy`   |
  | 413    | `too_large`                                                                    |
  | 422    | `idempotency_mismatch`                                                         |
  | 429    | `rate_limited`, with `Retry-After` in seconds                                  |
  | 5xx    | `unavailable`: try again with the same `Idempotency-Key`                       |

- **Limits,** a day in UTC, per account across all its tokens and separate
  from MCP's:
  - 100 notes created;
  - 200 changes (appends, edits, deletes and pin changes);
  - 2,000 reads a token;
  - files and Upcoming keep the web's and MCP's limits (phases 3 and 4).

  Writes that count answer `RateLimit-Limit`, `RateLimit-Remaining` and
  `RateLimit-Reset` for their own limit; a replay counts nothing and has
  none.

### Phase 1: tokens and text

**`GET /v1/me`**, any scope. What a client needs to show today's version and
fire notifications offline, without ever porting the version arithmetic. The
birthday is never sent.

```json
{
  "account": "acct_5d41402abc4b2a76b9719d911017c592",
  "today": "2026-10-29",
  "version": "4.5.137",
  "tz": "America/Chicago",
  "send_time": "06:30",
  "wrote_today": true,
  "streak": 12,
  "paused_until": null,
  "status": "active",
  "show_badges": true,
  "days": [
    { "date": "2026-10-29", "version": "4.5.137" },
    { "date": "2026-10-30", "version": "4.5.138" }
  ],
  "token": {
    "id": "0f8e2c4a9b7d4e1f8a6c3b5d7e9f1a2b",
    "name": "Terminal",
    "scopes": ["notes:write"],
    "expires_at": "2027-10-29T14:02:11Z"
  },
  "api_version": "1.4.0"
}
```

`days` runs 14 days from today, and a birthday in it shows as a new major or
minor version on its day. `status` is `active` or `stopped`.

`account` and `token.id` came in 1.4.0 (2026-10-30), for an app that has to
know whose account a token opens and which rows are its own:

- `account` is `acct_` and 32 hex characters, the same for every token of
  the account and never changing (`tokens.accountId`): the first half of
  the SHA-256 of the account's internal id, a random UUID, under the label
  `release-notes/v1/account/`. It is derived on each read, never stored or
  used as a key, and the internal id can't be got back from it. It is one
  id for every client, not one per app.
- `token.id` is the token's own record id, 32 hex characters, the one notes
  already carry as `connection`. It grants nothing and is never the token
  or its hash.

**`POST /v1/notes`**, `notes:write`.

```json
{ "text": "Ran the river loop #running", "date": "2026-10-28", "written_at": "2026-10-28T23:58:40-05:00" }
```

- `text` or `uploads` is required: a note may be only its files.
  Hashtags in the text are its tags, and links get their titles fetched
  once, as on the web.
- `date` is optional, any day from the birthday through today.
- `written_at` is optional: the moment the words were typed, a real time
  (no February 30, no 24:00) from the birthday on. It must not be
  more than five minutes in the future; a time before the birthday is
  `date_out_of_range` with `field: written_at`. A note queued offline at 11:58pm
  and sent at 12:05am files to the day it was typed, in the account's zone,
  unless `date` says otherwise. It also orders the note within its day.
- `uploads` (with `media:write`) and `place` are as under Phase 3.
- `moment` (1.6.0, 2026-10-30) is optional: the typed pieces an app picked
  for the note, kept beside the words as they came, returned by the
  note's read and named by kind in its `note.added` row.
  `docs/MOMENTS.md` has the model, its rules and the steps after it.
- With neither `date` nor `written_at`, the note files to today.

It answers 201:

```json
{
  "note": {
    "id": "t-3f9c0a6e1b2d4c5e8f7a9b0c1d2e3f40",
    "date": "2026-10-28",
    "version": "4.5.136",
    "revision": "076263bf596e19962d84b076",
    "token": "Terminal"
  },
  "unlocked": [{ "key": "api", "name": "API release" }]
}
```

`unlocked` is present only while Show badges is on, and never on a replay:
it was said the first time. A `revision` is an opaque string, as MCP's is;
send it back unchanged.

**`GET`, `PUT`, `DELETE /v1/notes/{date}/{id}`** and **`POST
/v1/notes/{date}/{id}/append`**, `notes:write`. These work only on a note
this token wrote. Any other note is a 403, `not_yours`, as MCP's appends
and edits are.

- `GET` returns the note's text, `revision`, `written_at` and file count, so
  an app can pick up an edit made on the web.
- `PUT {text, revision}` replaces the text from the revision the client
  read. A note changed since is a 409, `revision_mismatch`, with the
  current revision. No history is kept, as for web edits.
- `POST .../append {text}` adds a paragraph.
- `DELETE` removes the note and the files uploaded with it (a token's note
  has no others), as a web delete does. This is new: MCP has no delete. A token writes in the owner's voice, and an app
  needs to undo a mistake it just sent.

**`GET /v1/tags`**, any scope. The tag row:

```json
{
  "pinned": ["house", "work"],
  "recent": [{ "tag": "running", "count": 6, "last_used": "2026-10-28" }],
  "window_days": 30
}
```

`recent` is the tags used most in the last 30 days, leaving out pinned ones,
ties broken by last use. It has at most 20.

**`PUT /v1/tags/pinned`** `{"pinned": [...]}`, `notes:write`. Up to 12 tags,
normalized as note hashtags are. Pins live on the account, so the web's
Today form and every phone show the same ones. A `settings.changed` row
names the field.

**`DELETE /v1/token`**, any scope. The token revokes itself and answers 204.

**`GET /v1/activity`**, `activity`. The log, newest first, as `notes_activity`
reads it, but trimmed of words:

- mail rows keep `message`, `received_at`, `via`, `day`, `version`,
  `outcome` and `reason`, but never `subject`, `text` or `sender`;
- `settings.changed` keeps each change's `field`, never `from` or `to`;
- Upcoming titles are joined only when the token also has `upcoming`;
- every other kind is already free of words (`packages/domain/activity.ts`).

Token writes show `via: "token"`, with the token's name as `token`, and `client`.
From 1.4.0 (2026-10-30) every row a token writes, its daily reads row and
its own sign-out (`connection.removed`, reason `client`) also carry
`token_id`, the `token.id` from `/v1/me`, so a client picks out its own rows
by id, never by a name a later token can reuse. Rows written before then are
not backfilled and have no `token_id` (the field is left out, never null);
a reads row from before the release gains it at its next read that day.

```
GET /v1/activity?after=<id>&kinds=note,mail,badge,status&limit=50
```

- `after` gives rows newer than a row the client has seen ("what's new
  since").
- `before` gives the next older page, and `next` in the answer is the
  cursor for it.
- `kinds` filters by family (`ACTIVITY_FAMILIES`).
- `limit` is 1 to 100, 50 by default.

A test pins the trimming: no `/v1/activity` answer ever carries a mail
subject, mail words, another sender or a settings value.

### Phase 3: files and places

- **`POST /v1/uploads`** `{name, type, size}`, `media:write`. One signed S3
  form for one file, under the web's limits: 50 MB a file, 20 files a note,
  200 uploads and 2 GB a day per account (one count with the web's), each
  form good for five minutes. It answers 201 with the `upload` id, its
  `type`, the form's `url` and `fields`, and `expires_in`. It has no
  receipt: a retry gets a new form, and an unused one expires. A client
  asks for the form just before it uploads. The client then posts the file
  straight to S3, and names the upload as `{upload, type, name}` in the
  note's `uploads`, or in `POST /v1/notes/{date}/{id}/media` with
  `{uploads}` on a note this token wrote (a change, for the daily count).
  Thumbnails, EXIF place, and the owner's opted-in transcripts and
  descriptions follow, as for a web upload.
- **A note takes its files as the web's does**: each checked against the
  bytes that arrived, then copied to a kept key. The pending file goes only
  once the note has its copy, so a write refused or lost before it lands
  leaves the upload for a retry with the same Idempotency-Key, and a note
  takes each upload once.
- **`GET /v1/places?q=`** is the web's city search. **`POST
/v1/places/here`** `{lat, lon, accuracy_m}` gives the spot, its
  neighbourhood and up to six nearby businesses, as the web's Here does,
  as `{place, nearby}`. A note sends a `place` back as it came, the Here one
  with `venue` set to a `nearby` name if the owner picks one. It is kept
  as sent, with its shape checked (`places.clean`, `places.devicePlace`)
  and never looked up again, as the web's Where keeps the city its browser
  sends back: it is the owner's own note in their own voice, and signing
  each answer or naming the spot again on every write would add a cost and
  a way to fail for no one's protection (Jamie, 2026-10-30, case 5 of the
  API edge cases). Both need `notes:write`. Each Here is a paid lookup, so an account names 100 spots
  a UTC day through its tokens.
- **The one infrastructure change, flagged.** Signed forms and the attach
  step after them run in the web server today, under a session. The MCP
  function's roles were built without upload rights. Phase 3 lets the
  capture function sign forms for its own pending prefix,
  `media/<user>/api/`, and run the same attach, with the same checks. That
  is a role change in `infra/template.yaml` (that prefix's form, read,
  copy and delete rights, ListBucket so a missing upload reads as missing,
  the account's upload count, and ReverseGeocode for Here), shipped through
  a normal deploy and reviewed as its own PR before any route reaches it.
- **HEIC photos get no thumbnail** (AGENTS.md, Thumbnails), so they never
  reach the email. Changelog sends the photo picker's compatible JPEG, with
  place and time kept (Jamie's calls). Other clients should do the same.

### Phase 4: Upcoming and reminders

- **`GET /v1/upcoming`**, **`POST /v1/upcoming/batch`** and **`DELETE
/v1/upcoming/{id}`**, all `upcoming`. These keep MCP's rules:
  - a revision on every change;
  - `dry_run`;
  - all or nothing;
  - at most 50 entries a call and 50 writes a day;
  - past one-time trips and events left out of the list and only counted.
    Each entry has its own fields: kind, title, date, year, end, destination,
    tag, reminder days and `email`. Each also has the server's own line
    ("Mom turns 7.0.0. A major release.").
- **`GET /v1/upcoming/reminders?days=14`**, `upcoming`. Each day's due
  reminders, from `remindersFor`, with the line and the `when` the email
  uses that morning, and the moment of the account's send time on that day:

  ```json
  {
    "from": "2026-10-28",
    "through": "2026-11-10",
    "days": [
      {
        "date": "2026-11-04",
        "send_at": "2026-11-04T06:30:00-06:00",
        "reminders": [
          {
            "upcoming": "0b6f2c9e-4d1a-4f3b-9c8e-2a7d5e1f6b30",
            "date": "2026-11-11",
            "when": "In 7 days",
            "line": "Mom turns 7.0.0. A major release."
          }
        ]
      }
    ]
  }
  ```

  `date` is the day the entry falls on; a day with nothing due is left
  out. Reminders follow each entry's `email` flag, and not the account's
  pauses or stop, so a phone reminds while the email rests.

  The server stays the one place that knows the reminder rules and leap
  days, so an iPhone app, an Android app and the email can't disagree.
  `days` is at most 31.

### Phase 5: OAuth for apps

Pasted tokens are fine for development and TestFlight. The App Store wants
a sign-in. Built 2026-10-29 (`packages/backend/oauth.ts`, `tokens.ts`,
`web/src/pages/Connect.tsx`; `tests-node/oauth/sign-in.test.ts`):

- **An app's sign-in makes an API token,** the same key Settings makes.
  OAuth's resource may be `<origin>/v1` as well as `/mcp`. For `/v1` the
  consent page (`/connect/`, in the owner's email-verified session) is the
  token form: a name (the app's registered name, or with the first number
  no live token has, "Changelog 2"), what it may do, ticked from the scopes
  the app asked for (`notes:write`, `media:write` only beside it, `upcoming`,
  `activity`; never `notes:read`), and an expiry (90 days, 1 year, the
  default, or never). Allowing makes nothing yet: the code holds the
  choice for five minutes. Spending it at `/oauth/token` (PKCE S256, the
  same client, redirect and resource) makes the token in the same
  transaction that marks the code used, and answers it once:
  `access_token` `rn_...`, `token_type` Bearer, the `scope` allowed and
  `expires_in` unless it never expires.
- **No refresh token.** An app, its share extension and its Siri intent
  are separate processes that all send notes. A rotating refresh token
  shared between them, whose reuse ends the grant, would sign the phone
  out whenever two refreshed at once. One long-lived key, scoped so it
  can't read a word, is what a pasted token already is (Scopes, above), so
  the sign-in adds no new kind of credential: it saves the copying.
- **A code that comes back** a second time ends the token it made (RFC
  6749, 4.1.2), and the activity log says why (`token-reuse`).
- **Signing out:** `DELETE /v1/token`, or `/oauth/revoke` with the token
  and the client id it was signed in for. A token made in Settings has no
  client, so `/oauth/revoke` never ends it.
- **It is listed with the other tokens** in Settings, and revoked there.
  Its `connection.added` row carries `app`, the name the app registered:
  "Signed in Changelog as the API token Changelog".
- **Native callbacks (RFC 8252):** registration accepts a private-use
  scheme, a reversed domain with at least one dot followed by `:/`, such as
  `com.yourversionnumber.changelog:/oauth`, as well as https and loopback
  http. An https app link works with no change here. An Android app link
  needs `/.well-known/assetlinks.json` listing the app's package and
  signing certificate, and an iPhone universal link needs an
  `apple-app-site-association`. Either is the site vouching for the app,
  so it lists only an app Jamie calls official; until then every app,
  Changelog included, uses its own scheme, which PKCE protects.
- **Discovery:** `/.well-known/oauth-protected-resource/v1`, and the
  authorization server's metadata lists every scope. The OpenAPI file
  describes the flow as the `signIn` scheme (API 1.3.0).
- **Pasted tokens stay,** for the dev server, scripts and anyone who
  prefers them.

Calls made in building it, each easy to change (Jamie, 2026-10-29: "Lets
get phase 5 done."): the token form is the consent, with the app's scopes
ticked to start with, since the owner began the sign-in in the app; a
signed-in token is an ordinary API token rather than a connection of its
own; and there is no refresh.

## Clients other people build

The API is public, and the repo is too. Someone with only the docs and the
repo should be able to build a client without asking, and an Android
Changelog written outside the project is the case the docs are written for.

- **`/guide/tokens/`**: making, naming and revoking tokens, in plain words.
- **`/guide/api/`**: the endpoints, the errors and the limits, with recipes
  to copy:
  - curl;
  - an Apple Shortcut (published, for the Action Button);
  - a git `post-commit` hook;
  - cron or launchd;
  - Python;
  - a GitHub Actions step;
  - Home Assistant.
- **`/guide/api/clients/`**, how a capture client should behave, so every
  app acts alike:
  - queue offline, and resend with the same `Idempotency-Key`;
  - send `written_at`;
  - take versions and reminders from the server, never compute them;
  - handle 429 and the 401 codes;
  - never log the token.
- **`/guide/changelog/`**: the app's own page, "Release Notes for Changelog",
  with what each version brought (Jamie, 2026-10-29: "Please make sure that
  there is a changelog page for changelog itself on the public site.").
- **`/v1/openapi.json`**, and `llms.txt` lists the API next to MCP.

The guide's tests that pin numbers to code constants cover these pages too:
limits, expiry choices, the 7 days.

## Changelog for iPhone

A capture tool with four verbs:

- **log** a note;
- **plan** a date;
- **get reminded**;
- **check** what happened. Jamie, 2026-10-29: "showing recent activity
  would be a good thing in there too, because it's a way to confirm what
  did the app do and what did other entities do".

It never reads the archive. The web is where you read, search, look back
and change settings. It lives in its own public repo,
`jthingelstad/changelog-ios` (MIT, bundle ID `com.yourversionnumber.changelog`),
which holds its own design.

- **Open to typing.** The keyboard is up when it opens. A line goes in two
  taps, and the button says **Commit**.
- **Never lose a note.** Everything goes through an offline queue, sent with
  its idempotency key and `written_at`, so a retry never duplicates.
- **Never reads your words.** It asks for `notes:write`, `media:write`,
  `upcoming` and `activity`. A lost phone can add notes and see that things
  happened, but can read back only what it sent itself.
- **The software metaphor in small doses.** Today's version is at the top in
  monospace. A sent note says "Filed in 4.5.137", and an empty day says "No
  changes yet in 4.5.137".
- **Built plainly:**
  - SwiftUI, for iOS 26 and later;
  - no third-party packages;
  - the token in the Keychain;
  - the queue sent again when the connection comes back, finished in the
    background time iOS gives an app leaving the screen, and tried by
    background refresh;
  - App Intents, widgets and a share extension later.

| Version | Adds                                                                                                                                                      | Needs   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0.1     | Log with text and the tag row, the version header, the offline queue, today's activity with edit and delete, the Activity screen, sign-in by pasted token | phase 1 |
| 0.2     | photos, the camera, voice memos, Here, the share extension                                                                                                | phase 3 |
| 0.3     | the Upcoming screen, reminder and activity notifications, the optional daily prompt                                                                       | phase 4 |
| 0.4     | App Intents, the Action Button, a Control Center control, widgets                                                                                         | nothing |
| 1.0     | OAuth sign-in (the server's side built 2026-10-29), the App Store                                                                                         | phase 5 |

TestFlight and the App Store wait for the paid Apple Developer Program.
Until then, builds go on a device from Xcode. For the App Store it needs:

- a privacy label: user content, linked to you, no tracking;
- a review account;
- a link to `/delete/`;
- no membership links in the app until the purchase rules are checked.

## Badges

Two new Firsts (docs/BADGES.md), both read from notes. API release is
built (2026-10-29, as tokens opened). OTA update waits until anyone can
install Changelog (TestFlight or the App Store), since Still to find would
otherwise point everyone at an app they can't get:

| Badge       | Earned by                                       |
| ----------- | ----------------------------------------------- |
| API release | A note sent through a token you made            |
| OTA update  | A note sent from Changelog (`client` Changelog) |

- A token's note also counts toward every other badge as a web note does,
  but it is not a Web release.
- `unlocked` in the create answer lets an app show a short toast, only
  while Show badges is on.
- OTA update rests on a self-reported name, like Pair programming's client
  names. It is a badge, not a proof.

## Rules to add to AGENTS.md

These land with phase 1, and the reminder rule with phase 4:

- **By a token,** under Who can write: made in an email-verified session,
  named, scoped, stored as a hash, revocable, opening `/v1` only.
- No token value in any log. The activity log gets one row for each token
  write ("note added via Terminal").
- Deleting an account blocks token writes first, then removes tokens.
- Reminders travel in the email and in any app the owner turns them on in,
  with the email's own lines, in Jamie's words above.
- Test with the dev server's fictional account only. Live checks are
  read-only: discovery, a 401 without a token, health.

## Testing

- **Tokens:** their lifecycle (make, use, expire, revoke, self-revoke,
  account deletion), at most 20, unique names, hash-only storage.
- **The bearer rule:** a token alone on any `/api` route is a 401, and a
  session cookie on `/v1` is ignored.
- **Scopes:** every endpoint against every scope.
- **Writes:** `not_yours` on others' notes, revisions, 7-day receipts and
  replays, quotas and the `RateLimit` headers.
- **Trimming,** as above.
- **Logs:** a captured log run never contains a token, note text or a file
  name.
- **The contract:** routes, `contracts/api-surface.json` and the guide pages
  agree (`tests-node/api/openapi.test.ts`, `tests-node/site.test.ts`).
- **The dev server's** `/v1` passes the same suite as the fakes.

## Phases

| Phase                        | Ships                                                                                                                                                                                                                                                                                                    | Gives                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **0. Design**                | this document                                                                                                                                                                                                                                                                                            | the contract agreed                                   |
| **1. Tokens and text**       | Tokens in Settings (admin only at first); `/v1/me`; notes create, read, append, edit and delete; tags and pins; `/v1/activity`; idempotency, limits and errors; via on the web, in exports and in the activity log; the web's tag row; the `/v1/*` behavior; the dev server's `/v1`; the AGENTS.md rules | curl from the terminal; Changelog 0.1 starts          |
| **2. Docs and the Shortcut** | the OpenAPI file, its ledger and tests; the guide pages; recipes; `llms.txt`; a published Shortcut                                                                                                                                                                                                       | one-press capture with no app; other people's clients |
| **3. Files and places**      | `/v1/uploads` and attach, with the role change; city search and Here                                                                                                                                                                                                                                     | photos and voice from scripts; Changelog 0.2          |
| **4. Upcoming**              | the Upcoming endpoints and reminders; the AGENTS.md reminder rule                                                                                                                                                                                                                                        | Changelog 0.3 and its notifications                   |
| **5. OAuth for apps**        | the native-app callback and the `/v1` resource                                                                                                                                                                                                                                                           | Changelog 1.0 on the App Store                        |

The order agreed: 0, then 1 (with Changelog 0.1 alongside), then 2 and 4,
then 3. Phases 3 and 4 don't depend on each other.

## Deferred: webhooks

Jamie, 2026-10-29: "webhooks might be a bad idea ... Nobody has asked for
it, and they are likely to be very high volume", so they wait for "a whole
future session on their own, and maybe never do". What an earlier draft
had, so that session doesn't start cold:

- a secret URL per hook (`/v1/hooks/<secret>`), like the calendar link,
  which the access log already keeps out of paths;
- each hook an automation voice: "Added by <name>:", out of streaks, with a
  small quota of its own;
- later, a GitHub adapter checking `X-Hub-Signature-256`, with
  `X-GitHub-Delivery` as the idempotency key.

Outbound webhooks would send note content out of Release Notes, which is a
separate question again. Meanwhile anyone can post events from their own
scripts with a token and curl, within the daily limit.

## Not now: multiple journals

Jamie, 2026-10-29, on journals as Day One has them: "Right now, release
notes is only ever about you. So should we consider that, or am I
complicating things?" Not now. Release Notes is one stream about one person,
and that is what holds it together:

- the version number is one person's life;
- the email asks one question a day, and its streak, Yesterday and On this
  day read that one stream;
- badges, the book and the yearbook gather that one stream.

Journals as most people use them are already here as tags. The Day One
importer turns every journal but the main one into a tag
(`packages/backend/dayone.ts`), and the tag row makes them one tap.

If a real need shows up, there are three things tags can't yet do. None is
needed now, and none is blocked:

- leave something out of the email, On this day or the book (a tag
  filter);
- limit a token to one tag;
- keep a journal about someone else, with their own birthday. That is
  really a second account.

## Jamie's calls

Made 2026-10-29. The design as recommended ("Really good. I agree with your
assessment."):

- every token writes in your voice, as "via <name>";
- expiry of 90 days, 1 year (the default) or never;
- 100 notes a day across tokens;
- `/v1` on this host, served by the MCP function;
- a token or QR code for TestFlight, OAuth for the App Store;
- the product's own changelog stays at `/changelog/`, and the app's page
  goes at `/guide/changelog/`;
- Keep a Changelog's words as plain hashtags;
- two new Firsts.

Then, later the same day:

- **v1 is for adding things,** plus Upcoming: "adding content is the
  primary thing". So archive reads left v1.
- **Files:** JPEG from the app ("Fine with this").
- **Reminders on the phone:** yes. "Reminders are going to show up in other
  places. The daily email is already doing too much work."
- **The daily prompt** is off by default ("Sure").
- **Receipts** are kept 7 days on `/v1`.
- **Pins:** "Pinned tags are good and then also augmented with frequently
  used RECENT tags."
- **Activity** in the app, with notifications from it (the quote under
  Changelog); real push deferred ("Agree on the real push deferral").
- **Webhooks deferred,** and **no multiple journals** (above).

The readiness questions, all as recommended ("I'm good with your
recommendations"):

1. **Who and when:** every subscriber, not only members. Tokens show only
   to the admin until the guide pages are live and Jamie has used one. No
   product update, front-page or tour mention until Jamie writes one.
   (Overtaken the same day: tokens opened to everyone, and the tour lists
   them, "I intend to open this up immediately so no need to feature flag.")
2. **Reminders in the email:** the phone side is built first. A setting that
   takes them out of the email is a separate small PR.
3. **via** shows on the web, in exports and in the activity log, not in the
   morning email.
4. **The first live note** through a token is Jamie's own. (Overtaken the
   same day, when Jamie opened tokens to everyone "so we can continue with
   build".)
5. **The app's repo:** public, MIT, `com.thingelstad.changelog` (now
   `com.yourversionnumber.changelog`, Jamie's ask on 2026-10-29).
6. **This design** merges after the automated review, without waiting for
   Jamie's read. Anything beyond it comes back as a question.
7. **Order:** 0, then 1 with Changelog 0.1, then 2 and 4, then 3.
8. **Guide pages** wait for in-flight work on the public site to land.
9. **Names:** the Log button says **Commit**. The Firsts are **API release**
   and **OTA update**.
10. **Activity:** the trimmed `activity` scope, and opt-in notifications.
