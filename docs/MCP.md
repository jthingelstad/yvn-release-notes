# Discuss your Release Notes with an agent

Add a custom remote MCP connector in Claude with
`https://notes.yourversionnumber.com/mcp`. Sign in with your usual Release
Notes email link or code, preferably using the code in the approval tab.
The approval page names the client (a name supplied by that client), shows
the signed-in address, and asks whether photos and recordings can be read
as well. Connect only when you initiated it. Approving shares your archive
with that service under its privacy and retention policies. It cannot
write notes. This is available to any subscriber who explicitly approves
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
connection id and outcome only. No queries, arguments or returned content
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
has a strict input schema, output schema and read-only annotations. Results
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
private downloads. Approval is only through `POST /api/mcp/authorize` with
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
Lambda invocation, upload, deletion or OAuth write permissions. The existing
web function handles OAuth and account-authorized consent/revocation. Both
require CloudFront's generated origin proof; nobody reads the secret.
No new Python package, search index, embedding job or model service is added.
Unexpected tool or activity-recording failures log only the exception type
and user id, then raise a fixed exception without the original exception
chain. This fails the
Lambda invocation, making the existing MCP Errors alarm report the failure;
API Gateway returns its generic 502 response. Invalid tool arguments remain
structured tool errors and do not count as infrastructure failures.

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
