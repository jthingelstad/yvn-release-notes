# Discuss your Release Notes with an agent

Add a custom remote MCP connector in Claude with
`https://notes.yourversionnumber.com/mcp`. Sign in with your usual Release
Notes email link or code, preferably using the code in the approval tab.
The approval page names the client (a name supplied by that client), shows
the signed-in address, and asks whether photos and recordings can be read
as well. Connect only when you initiated it. Approving shares your archive
with that service under its privacy and retention policies: the notes, and
since 1.4.0 the rest of the account too (badges, releases, the mail log of
the last 30 days and your settings, never your email address or private
addresses), and since 1.5.0 the activity log. It cannot
write notes unless you separately approve adding. This is available to any subscriber who explicitly approves
it; there is no operator impersonation or automatic connection.

Claude supports remote OAuth connectors and image tool results. Recordings
can be discussed from their existing transcripts. Raw inline audio is
available for clients that accept MCP audio content; Claude playback is
not guaranteed. No tool starts transcription, photo descriptions, or other
model processing. Existing transcripts and descriptions are shared with
notes permission even if their processing setting has since been turned off.

In Settings, Connected agents lists each connection, its scopes and last
use. Disconnect blocks its tokens on the next request, including old refresh
tokens. Content already shared remains subject to the agent service's
retention policy. Private download links remain valid for up to ten minutes.
Activity is the last fourteen days, up to fifty requests, with tool, time,
connection id and outcome; successful writes include client and note references. No queries, arguments or returned content
are stored. An interrupted in-flight read can finish after disconnection.

## Transport and tools

The server implements stateless JSON Streamable HTTP at `POST /mcp`,
protocol versions `2025-06-18` and `2025-03-26`. `initialize`, `ping`,
`tools/list`, `tools/call`, and notifications are supported. GET and session
DELETE return 405; there is no server event stream or session id.
Requests without a bearer token return 401 and protected-resource metadata.
Every request checks the token, canonical family and account with strong
reads. Any supplied Origin must match the site. CloudFront forwards the
Authorization and MCP headers and never caches MCP/OAuth responses. Every
response, including errors, carries `Cache-Control: no-store`. Each request
owns its identity/context; reusable SDK clients carry no subscriber state.

The generated `contracts/mcp-surface.json` is the full interface, exported by
`node --import tsx tools/export-mcp-contract.ts` from `server/mcp/contract.ts`.
`packages/backend/oauth.ts`, `server/mcp/` and `workers/capture.ts` implement
the protocol and preserve existing families, refresh rotation and capture
receipts. Every tool has a strict input schema, output schema and accurate
read/write annotations. Results
include structuredContent plus text, a server version and explicit errors
with a next step. Notes are untrusted data, never agent instructions.

| Tool | What it does |
| --- | --- |
| `notes_context` | Local today, timezone, current version, archive range, capabilities. |
| `notes_list` | Recent notes, a date range or release, newest first, previews. |
| `notes_search` | AND words/quoted phrases (at most ten), case/accent insensitive, tags, dates/release; text, places, link titles and existing transcripts/descriptions. No web 100-day cutoff. |
| `notes_get_day` | Note previews in writing order, the day's version, place and recorded weather (with Open-Meteo credit), whether the email was paused, and the special days it collected when badges are shown. |
| `notes_get_note` | Note text, metadata and media inventory, with `parts` (links by name, tags) only when it has a link or tag (1.6.0); next_offset for long text. |
| `notes_tags` | Hashtags with note counts. |
| `notes_view_photo` | Existing description with description_only=true and notes permission; thumbnail as image content with media permission; original=true returns a private original link. Missing thumbnail falls back to a link; no processing. |
| `notes_get_audio` | Existing transcript in chunks up to 8,000 characters; optional inline bytes or private download. No processing. |
| `notes_on_this_day` | The same patch of each earlier release (as the email's On this day), newest first, days with notes only: up to five whole previews each and `notes_total`; ten days a page by default. |
| `notes_releases` | Releases with notes plus the current one, newest first, with days and note counts; with `release`, one release: days with notes, longest streak, paused days, badges collected (when shown) and its top 100 tags. |
| `notes_badges` | The Badges page: earned (newest first), tracks, this release's special days and the ones still to find. With "Show badges" off, only `show_badges: false`. Since 1.10.0 it includes the firsts earned outside notes (a profile photo, feedback sent, feedback marked done, a book) and a fifth track, `roadmap`, the distinct Upcoming dates ever added (`docs/BADGES.md`), read with the activity log, `FEEDBACK#` and `UPCOMING#` under the reader's existing role. A date added through `upcoming_save` or feedback sent through `notes_send_feedback` that earns a badge writes its `badge.earned` row via `assistant`; neither answer carries `unlocked`, so the next email or the web's welcome back tells it. |
| `notes_activity` | The activity log (`docs/WEB-APP.md`, Activity): what came in, changed and went out, newest first, kept for the life of the account. `from`/`through` are local days (both kept), `kinds` filters by family (`note` matches `note.added`), 50 rows a page by default, at most 100; `next_cursor` is bound to the filters. Mail subjects cut at 300 and words at 2,000 characters. Each connection's own reads are one row a local day. With the upcoming scope (1.5.1), a row naming an Upcoming date carries its `title` as it is now, null once removed; without it, only the date's id. 1.5.2 adds the daily email, each Upcoming reminder it carried (`when`, as the email said it), badges from notes filed by email, stops for a bounce or complaint, transcripts and descriptions (never their words), imports, and a day's own place (kind `place`, the day alone). 1.8.1 adds the profile photo set, changed or removed (kind `photo`), never the image. |
| `notes_mail_log` | The mail log (`docs/WEB-APP.md`): each email to the account's addresses in the last 30 days and what became of it, newest first; subjects cut at 300 and words at 2,000 characters. |
| `notes_account` | Birthday, send time, status, processing settings, "Show badges", home place and pause, with streak, lifetime counts and next release. Never the email address, standing address or calendar feed. |
| `notes_create` | Write one agent note on local today or an explicit past date, optionally with the city it was written in, only with separately approved `notes:write`. With `files` (1.8.0, needs `media:write` too) it keeps photos, recordings and PDFs with it; text, files or both. |
| `notes_append` | Append text only to a note created by this exact connection; never edits a user's note or deletes anything. |
| `notes_edit` | Replace the text of a note created by this exact connection (1.8.0), given the `revision` a full read returned; a note changed since is refused as `conflict`. Needs `notes:write`. Never a user's note, never a delete. |
| `notes_attach` | Add up to 4 files (4 MB together) to a note created by this exact connection (1.8.0), after the files it has; needs `notes:write` and `media:write`. |
| `notes_send_feedback` | Send Jamie feedback about Release Notes (1.9.0): a kind (bug, idea, question, other), up to 4,000 characters, optionally the id of an item it follows and up to 3 screenshots as base64 PNG, JPEG or WebP, 768 KiB each decoded. Files under `notes:read` through the capture function with an idempotency key; 10 a UTC day an account. |
| `notes_my_feedback` | The account's feedback, newest first, by opening words and answer count, with the day's count; with `id`, one item's words and answers in full, continued by `part` and `offset`; with `id` and `screenshot`, that screenshot as image content, which needs `media:read`. |
| `upcoming_list` | Saved Upcoming dates (birthdays, anniversaries, trips, events) with each one's next occurrence, id and revision, in date order; needs the separate `upcoming` scope. A trip or event already over is left out and only counted (`past_left_out`, 1.6.0); `max_entries` is the account's cap, those included. |
| `upcoming_save` | Add or change up to 50 Upcoming dates in one call, all or nothing, only when the user asks; a destination is text the server resolves; `dry_run` checks without saving. |
| `upcoming_delete` | Remove up to 50 Upcoming dates by id and current revision, all or nothing, only when the user asks. Never touches notes. |

Pages default to 20 items, maximum 50, and stop at whole items below a
48,000-character structured result ceiling. Follow next_cursor or next_offset
until null. Cursors are bound to account and filters but are not credentials;
the token always determines the account. They use positions: if the archive
is edited during browsing, restart to get a fresh traversal. File content is
limited to 1.5 MB raw per result (one photo or recording). Larger recordings
use signed downloads. Tool requests are limited to 300/hour and 500/UTC day
per account, across connections. Notes media metadata carries no storage
keys. Notes context does not disclose email, birthday, or account settings;
`notes_account` shows the birthday and settings, and no tool returns the
email address, the standing address or the calendar feed link, which work as
credentials. Settings change only on the web. Activity and mail log
subjects and words are untrusted content like notes.
Release filters whose anniversary years exceed the supported date range
return an invalid_arguments tool result.
Every note includes `author` and `client`; older notes default to user/null.
List, search and day accept `include_assistant=false` to read only the user's
own voice. Descriptions on every tool mark archive content as untrusted.

## When tools change

Clients keep their own copy of `tools/list`: ChatGPT keeps it until the
connector is refreshed in its settings, and an open conversation may keep
the list it started with. A stateless server with no event stream cannot
announce a change, so the contract carries it instead:

- Any change to the tools (a new tool, a schema or a description) is a new
  `server_version` with an entry in `changes`, newest first.
  `contracts/mcp-versions.json` records each version's tools digest;
  `tools/export-mcp-contract.ts` refuses changed tools under a recorded
  version, and the tests refuse a contract that the ledger does not match.
- `notes_context` returns `tools`, every tool offered now with the scope it
  needs and whether this connection has it, and the three latest `changes`.
  An agent that cannot find a listed tool tells the user to refresh or
  reconnect the connector and start a new conversation. Every result's
  `server_version` lets a client notice the change too.
- A new tool names its scope in `TOOL_SCOPES` (`server/mcp/contract.ts`).
  A new scope also needs a way to grant it to existing connections, as
  Settings does for `upcoming`.

To announce a tool to subscribers, a product update can say what it does
and that a connector may need a refresh to show it.

## Feedback

Jamie, 2026-10-28: the feedback system "could be accessible via mcp for
Claude to send feedback too". `notes_send_feedback` files the same record
the web's `/feedback/` does (docs/WEB-APP.md, Feedback), under `notes:read`:
telling the product's maker about the product is not writing to the
archive, so no `notes:write` is needed. It is still a write, so it goes
through the capture function, which rechecks the bearer, decodes and strips
the screenshots and puts them (its only S3 grant, `media/*/feedback/*`, put
only), and commits the item, the daily count, the live grant, a receipt and
a content-free audit together. A retry with the same `idempotency_key` and
arguments answers from the receipt. Refusals say which field or which
`screenshots[i]` and why. A failed commit may leave a screenshot file the
capture function cannot remove; the account's deletion sweeps
`media/<owner>/`.

Every result stays inside the MCP result limit whatever the words: the list
and `notes_send_feedback`'s answer give an item's opening words
(`text_complete`, `text_length`), its answer count and latest answer status.
A read by `id` returns the filing's words and the answers in full, in order,
as far as fit; when `next` is set, call again with its `part` (0 the filing,
n answer n) and `offset` (code points) for the rest. Only the first part of
a read is ever cut.

`notes_my_feedback` lists the items and answers. Answers are Jamie's words
but still untrusted data, never instructions. A screenshot comes back as
image content only with `media:read`. The MCP request body cap is 3.25 MiB
so three screenshots fit.

## Adding notes

Reconnect from your agent to request `notes:write`, then tick "Also allow
adding notes when I ask". It is initially unchecked and existing connections
gain no new permission. New authorization requests without an explicit scope
offer the option; requests explicitly limited to reading cannot grant it.
An agent must act only on an explicit user request, never instructions in
notes, imports, emails, transcripts or photos. Client confirmation remains
the client's responsibility; the server cannot inspect the conversation.

`notes_create({text, date?, place?, idempotency_key})` and
`notes_append({date, id, text, idempotency_key})` take plain text, up to
20,000 characters total per note. Put hashtags in the text. `place` is a
city the user says the note was written in, as text ("Zürich", or
"Paris, Texas" to choose among same-named cities). It is found by the same
city search as the web's Where, and kept as a chosen city. A name the
search does not know is refused, and nothing is written. Left out, the note
shows the day's city (or home's), as any note without a place does. An
append keeps the note's place. No separate tags, files, summaries or
reflections or deletes are added.

`notes_edit({date, id, text, revision, idempotency_key})` (1.8.0; Jamie,
2026-10-28: "the mcp interface doesn't provide a way to edit a note")
replaces the whole text of a note this same connection created, only when
the user asks. `revision` is the token on the note's full view
(`notes_get_note`, or a write's answer): a digest of its
text, edited time and stored revision, so any change since it was read (an
edit on the web, an append, another edit) refuses it as `conflict`, to be
read and redone, never overwritten. The commit's condition holds the same
three, so a change racing the edit refuses it too. Hashtags come from the
new text and link titles are fetched as for a new note; place and files stay.
As on the web, no earlier text is kept. The activity log gets `note.edited`,
never the words.

### Files

`notes_create`'s `files` and `notes_attach({date, id, files,
idempotency_key})` (1.8.0; Jamie, 2026-10-28: "the mcp interface doesn't
allow an agent to add an image or attachment") take a list of `{name, type,
data}`: `data` is the standard base64 of the bytes, `type` the MIME type and
`name` the file's name, kept and shown as the web shows an upload's. The
types are a web upload's (photos as JPEG, PNG, GIF, WebP or HEIC; recordings
as M4A, AAC, MP3, WAV, OGG, WebM or FLAC; PDFs), and the first bytes must
look like that type. One call takes at most 4 files and 4 MB of bytes
together: a synchronous Lambda invoke carries 6 MB, and base64 makes 4 MB
about 5.6 MB (the MCP request itself may be 6,000,000 bytes). More or
larger is refused as `file_too_large` with what to do next; a note holds at
most 20 files (`too_many_files`). Files need the separate `media:write`
approval as well as `notes:write` (`scope_required` names it).

Files are kept as a web upload's checked copy is (`media/<user>/files/`,
tagged as a note's), before the note that names them is written, and
removed again if the note is not; the note's entries have the web's fields.
The stream readers then treat them exactly as a web upload: every photo
gets its thumbnail (a HEIC none, but its time and place are read), a
photo's EXIF place names a note that has none, and transcripts and photo
descriptions come only where the owner turned them on. Answers show the
entries with their numbers, never a storage key. The audit and the
activity log count files (`files`; `note.files` for an attach, with
`added`), never their names or bytes.
Dates are the owner's local days, birthday through today; late captures use
the existing "added later" behavior. Captures are normal journal notes,
count toward streaks, show in email/day views, and the owner can edit or
delete them on the web. Provenance remains in JSON and Markdown exports,
email recaps and web/MCP read responses. Agent names are self-reported
labels, not verified identities.

Use a unique key (1–128 letters, digits, underscores or hyphens) for each
operation, and reuse exactly the same arguments on a retry. For 24 hours a
completed operation returns its original result, even if the note is since
appended to or deleted. A changed request using that key is refused. After
24 hours it is a new operation, even if DynamoDB TTL has not removed the
receipt yet. Receipts are private USER data and disappear on account deletion.
Daily account quotas are 20 creates, 50 appends, 50 edits and 20 attaches across all connections,
in addition to the general request quota. Completed retries do not consume
another write quota or create another audit record. Successful captures
commit the note, receipt, audit and quota atomically, with current family
and account checks; disconnection/deletion races cannot commit afterward.

Settings offers "Turn off adding" for each connection, keeping its read
access. Refresh cannot restore removed permission. Disconnect revokes both.
Audit keeps connection/client, tool, note reference, time and outcome for
fourteen days, never the text, token or argument fingerprint. The request
fingerprint stays only in the private 24-hour retry receipt. Bulk undo, proposals,
reflections and semantic search remain separate future work.

## Upcoming dates

Grant the `upcoming` scope either by reconnecting from your agent and
ticking "Also allow reading and changing my Upcoming dates", or, for a
connection you already have, with "Allow Upcoming for <client>" under
Settings, Connected agents, which widens that connection in place so the
existing token works on its next request. It is separate from note
scopes, initially unchecked, and never added without one of those choices.
The checkbox appears on every consent screen whatever scope the client
requested, because clients re-request the scopes they were first granted
and would otherwise never offer it. It
covers the three `upcoming_*` tools: a list of saved dates with their next
occurrence, and all-or-nothing saves and removals of up to 50 dates per
call, each needing an explicit user request. A change carries the id and
revision from `upcoming_list`; a stale revision refuses the whole call
(`conflict`), and any invalid entry refuses it naming `entries[i]`.
Destinations are text ("Paris, Texas") resolved by the city search; the
annual kinds take `MM-DD`, trips and events `YYYY-MM-DD`. `dry_run` returns
the resolved entries without saving. Each call counts once toward a daily
quota of 50 Upcoming writes per account; retries with the same key replay
the original result for 24 hours. The audit keeps counts only, never titles,
dates or destinations. Nothing here reads or changes notes.

## Authorization

Public protocol routes, separate from `/api` cookie authentication:

| Route | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` | Resource and authorization server discovery. The root variant also works. |
| `GET /.well-known/oauth-authorization-server` | OAuth endpoints and supported scopes/grants/PKCE. |
| `POST /oauth/register` | Public clients, exact HTTPS or loopback HTTP redirects, no secret. |
| `GET /oauth/authorize` | Validate registered redirect, resource, scope and S256 challenge; create ten-minute pending request, redirect to `/connect/#request=…`. |
| `POST /oauth/token` | Form-encoded code or refresh exchange, resource and client id required. |
| `POST /oauth/revoke` | Form-encoded token and matching client id; idempotent family revocation. |

`notes:read` is required; `media:read` additionally permits file bytes and
private downloads. Optional `notes:write` delegates adding notes, and appending
to or rewriting the ones the same connection made. Optional `media:write`
(1.8.0), only beside `notes:write`, lets those notes carry files; it is
offered on the consent screen with adding, and an existing connection gains
it in place from Settings ("Allow files for ..."). "Turn off adding" removes
both. Approval is only through `POST /api/mcp/authorize` with
an email-verified browser session and the site's Origin. Bearer tokens
cannot authenticate existing web routes. Denying consumes the request and
returns access_denied to the validated redirect. The resource is exactly
`https://notes.yourversionnumber.com/mcp`. Tokens are 256-bit opaque values
stored only by SHA-256 hash. Codes last five minutes, access tokens one hour,
refresh tokens thirty days sliding. Refresh tokens rotate atomically; reuse
revokes the family, including a simultaneous competing exchange. Rotating
also invalidates the previous access token. TTL cleanup is never authority;
every read checks expiry. Client registrations last one year.

Exchange, consent and metadata transactions prove the account exists and
deleting has not begun. Account deletion sets mcp_deleting first, then deletes
every indexed OAuth credential and MCPMETA record. Refresh updates the family
index expiry along with the canonical family so long-lived connections remain
deletable. Stopping daily emails still permits archive access, like the web.

## Infrastructure and operations

A dedicated Hono MCP server on Node 24 runs as its own Lambda Web Function,
using the existing table and private bucket. Its IAM role reads USER, access-token, family and MCPMETA rows; only PutItem under
MCPMETA is allowed. It has GetObject for media only, and no SES, model,
upload, deletion or OAuth write permissions. Its only Lambda invocation
permission is the private capture writer. The web Hono server handles OAuth and account-authorized consent/revocation. Both
Web Function origins require IAM authentication and CloudFront OAC signatures
(`always`, `amz-auth`), with an endpoint-only policy for this distribution.
Direct origin calls are denied; no generated origin-secret header is needed.
The reader and private capture Event Function retain separate least-privilege
roles. No search index, embedding job or model service is added.
Unexpected tool or activity-recording failures log only the exception type
and user id, with no original exception details or chain. Structured
retryable errors are returned to the client. A count-only
embedded `McpFailures` metric keeps these errors visible; the MCP alarm sums
that metric and uncaught Lambda Errors from both reader and writer.
Metadata transaction conflicts retry within bounded CAS loops. Invalid tool arguments remain
structured tool errors and do not count as infrastructure failures.
The capture function has no public route or function URL, no SES, model,
OAuth-write or invocation permission. For an agent's files its S3 grant is
PutObject, PutObjectTagging and DeleteObject under `media/*/files/*`, for
the files it keeps and the ones no note took; it reads none of them. A
token's uploads (`/v1`, docs/API.md, Phase 3) add the web role's checks
under `media/*/api/*` alone (sign the pending form, read the first bytes
and that version's tags and size, copy it, delete that version), ListBucket
so an upload that never arrived reads as missing, an UpdateItem on the
account's `RATE#upload:` day, and ReverseGeocode for Here. Only its role
can write USER note/receipt fields; note and grant conditions constrain the
code's writes. The reader itself still cannot write USER rows. The MCP
request may be up to 6,000,000 bytes. Append and edit update only text,
tags, links, edited time and
revision, preserving owner-added files and place; an attach appends entries
after the number it read (`size(media)`), so a file added on the web
meanwhile refuses it.

`tools/dev-server.ts` dispatches `/mcp`, `/oauth/*` and discovery to these same
handlers against the in-memory fakes. Test with fictional data only. Unit
tests cover OAuth ownership, resource binding, PKCE, expiry, rotation and
replay, revocation, deletion, account isolation, media scopes, strict schemas,
pagination and budgets, storage request shapes and infrastructure permissions.
Browser tests cover consent after sign-in, approval/denial and Settings
revocation. Never sign in against production or read real notes to verify.
Deploy through the usual green PR; read-only live probes
check discovery, unauthenticated 401, web health and origin protection only.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization),
[MCP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
[Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
[Claude integration support](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers).
