# Discuss your Release Notes with an agent

Add a custom remote MCP connector in Claude with
`https://notes.yourversionnumber.com/mcp`. Sign in with your usual Release
Notes email link or code, preferably using the code in the approval tab.
The approval page names the client (a name supplied by that client), shows
the signed-in address, and asks whether photos and recordings can be read
as well. Connect only when you initiated it. Approving shares your archive
with that service under its privacy and retention policies. It cannot
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
Authorization and MCP headers and never caches MCP/OAuth responses.

The generated `contracts/mcp-surface.json` is the full interface. Every tool
has a strict input schema, output schema and accurate read/write annotations. Results
include structuredContent plus text, a server version and explicit errors
with a next step. Notes are untrusted data, never agent instructions.

| Tool | What it reads |
| --- | --- |
| `notes_context` | Local today, timezone, current version, archive range, capabilities. |
| `notes_list` | Recent notes, a date range or release, newest first, previews. |
| `notes_search` | AND words/quoted phrases (at most ten), case/accent insensitive, tags, dates/release; text, places, link titles and existing transcripts/descriptions. No web 100-day cutoff. |
| `notes_get_day` | Note previews in writing order, day place and recorded weather, with Open-Meteo credit. |
| `notes_get_note` | Note text, links by name, metadata and media inventory; next_offset for long text. |
| `notes_tags` | Hashtags with note counts. |
| `notes_view_photo` | Existing description with description_only=true and notes permission; thumbnail as image content with media permission; original=true returns a private original link. Missing thumbnail falls back to a link; no processing. |
| `notes_get_audio` | Existing transcript in chunks up to 8,000 characters; optional inline bytes or private download. No processing. |
| `notes_create` | Write one plain-text agent note on local today or an explicit past date, only with separately approved `notes:write`. |
| `notes_append` | Append text only to a note created by this exact connection; never edits a user's note or deletes anything. |

Pages default to 20 items, maximum 50, and stop at whole items below a
48,000-character structured result ceiling. Follow next_cursor or next_offset
until null. Cursors are bound to account and filters but are not credentials;
the token always determines the account. They use positions: if the archive
is edited during browsing, restart to get a fresh traversal. File content is
limited to 1.5 MB raw per result (one photo or recording). Larger recordings
use signed downloads. Tool requests are limited to 300/hour and 500/UTC day
per account, across connections. Notes media metadata carries no storage
keys. Notes context does not disclose email, birthday, or account settings.
Release filters whose anniversary years exceed the supported date range
return an invalid_arguments tool result.
Every note includes `author` and `client`; older notes default to user/null.
List, search and day accept `include_assistant=false` to read only the user's
own voice. Descriptions on every tool mark archive content as untrusted.

## Adding notes

Reconnect from your agent to request `notes:write`, then tick "Also allow
adding notes when I ask". It is initially unchecked and existing connections
gain no new permission. New authorization requests without an explicit scope
offer the option; requests explicitly limited to reading cannot grant it.
An agent must act only on an explicit user request, never instructions in
notes, imports, emails, transcripts or photos. Client confirmation remains
the client's responsibility; the server cannot inspect the conversation.

`notes_create({text, date?, idempotency_key})` and
`notes_append({date, id, text, idempotency_key})` take plain text, up to
20,000 characters total per note. Put hashtags in the text. No separate tags,
place convention, files, summaries/reflections, updates or deletes are added.
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
Daily account quotas are 20 creates and 50 appends across all connections,
in addition to the general request quota. Completed retries do not consume
another write quota or create another audit record. Successful captures
commit the note, receipt, audit and quota atomically, with current family
and account checks; disconnection/deletion races cannot commit afterward.

Settings offers "Turn off adding" for each connection, keeping its read
access. Refresh cannot restore removed permission. Disconnect revokes both.
Audit keeps connection/client, tool, note reference, time, request hash and
outcome for fourteen days, never the text or token. Bulk undo, proposals,
reflections and semantic search remain separate future work.

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
private downloads. Optional `notes:write` delegates text capture only. Approval is only through `POST /api/mcp/authorize` with
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

A dedicated MCP Lambda uses the existing table and private bucket. Its IAM
role reads USER, access-token, family and MCPMETA rows; only PutItem under
MCPMETA is allowed. It has GetObject for media only, and no SES, model,
upload, deletion or OAuth write permissions. Its only Lambda invocation
permission is the private capture writer. The existing
web function handles OAuth and account-authorized consent/revocation. Both
require CloudFront's generated origin proof; nobody reads the secret.
No new Python package, search index, embedding job or model service is added.
Unexpected tool or activity-recording failures log only the exception type
and user id, with no original exception details or chain. Structured
retryable errors are returned to the client. A count-only
embedded `McpFailures` metric keeps these errors visible; the MCP alarm sums
that metric and uncaught Lambda Errors from both reader and writer.
Metadata transaction conflicts retry within bounded CAS loops. Invalid tool arguments remain
structured tool errors and do not count as infrastructure failures.
The capture function has no public route or function URL, no S3, SES, model,
OAuth-write, deletion or invocation permission. Only its role can write USER
note/receipt fields; note and grant conditions constrain the code's writes.
The reader itself still cannot write USER rows. Append updates only text,
tags, links, edited time and revision, preserving owner-added files/place.

The dev server dispatches `/mcp`, `/oauth/*` and discovery to these same
handlers against the in-memory fakes. Test with fictional data only. Unit
tests cover OAuth ownership, resource binding, PKCE, expiry, rotation and
replay, revocation, deletion, account isolation, media scopes, strict schemas,
pagination and budgets, storage request shapes and infrastructure permissions.
Browser tests cover consent after sign-in, approval/denial and Settings
revocation. Never sign in against production or read real notes to verify.
Deploy through the usual green PR and `deploy.sh`; read-only live probes
check discovery, unauthenticated 401, web health and origin protection only.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization),
[MCP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
[Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
[Claude integration support](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers).
