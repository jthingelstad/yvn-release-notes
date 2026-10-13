# TypeScript and Lambda Web Functions rebuild execution plan

Rebuild Release Notes as a React and TypeScript product on Node 24. Use
ordinary Hono HTTP servers on Lambda Web Functions for the application API
and MCP, and Node Event Functions for mail, media, export and delegated
capture. Retain the existing archive and product behavior.

## Execution status and start condition

- Jamie authorized takeover of the interrupted MCP session and requested
  its PR merge followed by rebuild execution on 2026-10-13.
- PR #80 merged as dff4801 after the final audit-privacy correction,
  focused independent reviews and green validate. The production baseline
  was deployed successfully and health/unauthenticated MCP behavior checked.
- The isolated preparation checkout began at `origin/main` commit
  `61a9464` and refreshed to dff4801. The current baseline has 673 Python
  tests (five existing optional-Pillow skips) and 32 web tests.
- Jamie confirmed a web UI redesign, staged compatible releases in
  us-east-1, shared existing data and separate API/MCP permissions.
- After the explicit MCP-complete signal, Jamie authorized PR creation,
  auto-rebase merge, production deployment and rollback without another
  approval. That authority excludes live imports, backfills and test sign-ins.
- Both subscriber sign-in and CloudFront origin signing may improve.
  Preserve ownership, privacy and account access; implementation methods
  are open to redesign. Native iOS/Android applications are outside scope.
- The approved visual direction is warm paper, strong typography, a focal
  version number, spacious writing and clearer archive/search navigation.
- Implementation is underway in isolated managed worktrees. No live test
  writes, imports, backfills, secret reads, production sign-ins or reads
  of subscriber note content are permitted for migration verification.

## Destination

Keep React, Vite, TanStack Router and TanStack Query for the web app, served
from its private S3 bucket through the existing CloudFront distribution.
Use Hono and its ordinary Node HTTP server for API and MCP. Both listen
on the runtime's `AWS_LAMBDA_HTTP_ENDPOINT` in production and a configured
local address in development. Remove the API Gateway event payload shape
from the final application.

Keep API and MCP in separate processes and IAM roles. Preserve the final
MCP session's narrowly delegated capture worker and consent model. Its
read path must not inherit general application write permissions.

Use explicit shared packages:

| Location | Responsibility |
| --- | --- |
| `web/` | Redesigned React pages and components |
| `server/app/` | HTTP API, sign-in, sessions, OAuth and metadata |
| `server/mcp/` | MCP HTTP transport and reader |
| `workers/` | Mail, stream processing, export, delegated capture |
| `packages/domain/` | Dates, versions, releases, notes, tags, search and streaks |
| `packages/contracts/` | Public DTOs, runtime schemas and generated MCP contract |
| `packages/backend/` | DynamoDB, auth, AWS clients, media and guarded fetches |
| `packages/testing/` | Fictional fixtures, fakes and behavior cases |
| `tools/` | Local server, imports and operator commands |
| `infra/` | Existing CloudFormation stack and deployment ownership |

Logical directories need not become independently published packages or
require a monorepo framework. Use one lockfile and strict TypeScript. Separate browser-safe exports from
backend code. Pin and package AWS SDK v3 clients rather than depending on
the runtime's SDK version. Bundle HTTP servers and each worker separately.
Keep native image dependencies out of the HTTP, sender and inbound bundles.

## Compatibility contract

Preserve all existing DynamoDB and S3 resources, key formats, field names,
epoch-second TTL values, object tags and retention rules. Keep public
routes, statuses, response fields, OAuth resource identifiers, reply
addresses, standing addresses and imported ledgers compatible during rollout.
Existing accounts, active sessions, OAuth grants and in-flight verification
requests must continue working across the transition. Authentication and
signing implementations may change with a demonstrated compatible bridge.
No archive rewrite, token reset, subscriber re-registration or copied data.

Port the baseline's tests into a behavior manifest before removing them.
The initial snapshot has 28 Python modules and 652 test methods across 26
test modules; refresh the inventory after capture lands. Track every old
test as ported, covered by a named replacement, or explicitly obsolete.
Use only fictional data in fixtures and public repository artifacts.

Particular cross-language compatibility cases:

- Date-only arithmetic, February 29 rolling to March 1 in common years,
  DST, IANA zones, local send windows and birthday release boundaries.
- Python code-point text lengths and slices versus JavaScript UTF-16,
  accent-insensitive matching, tags, quoted search phrases and line endings.
- Token/code encoding, constant-time comparisons, token hashes, PKCE,
  refresh rotation and legacy serialized idempotency fingerprints.
- Python canonical JSON uses sorted keys and ASCII escaping in current
  capture hashes. Support legacy verification during transition; new
  versioned hashes need not perpetuate that serializer forever.
- DynamoDB plain document values, numeric representation, conditional
  expressions, transaction conditions, consistent reads and pagination.
- Legacy missing fields, revised capture records, unknown fields and
  conditional field-level updates that preserve concurrently added media.
- Signed media links, validated immutable upload versions and file ownership.
- Raw MIME retention, separate notes in writing order, replies bound to
  their email day, 72-hour expiry and authenticated late notices.
- Export JSON fields and Markdown structure, canonical media paths,
  provenance, import identity and deduplication after a note was deleted.

## Concurrency and authorization

Use request-scoped identity and authorization; only clients and safe
bounded caches persist globally. Cache keys include the owner. Durable
counters and single-use claims remain in DynamoDB.

The higher 100 requests/second transport ceiling is intentional. Preserve
the independent sign-in budgets. The Python implementation tolerates
read-then-increment counter overshoot under API Gateway's small burst;
the new server should reserve eligible narrow-to-total mail counters in
one conditional transaction, with bounded conflict retries. Refused
reservations consume no budget, and no SES send occurs without reservation.

Keep conditional single-use codes, session renewal, day-send claims,
OAuth grant checks and delegated capture transactions. Exercise revocation,
account deletion and concurrent append races. Await persisted writes and
accepted async invocations before acknowledging success. Do not rely on
work continuing after an HTTP response or on graceful shutdown.

Keep same-origin browser checks, the host-only secure session cookie,
subscriber ownership and opt-in processing. Origin OAC does not replace
subscriber authorization. Preserve private media and content-free logs.

## Sign-in architecture

Use an explicit typed AuthService and Hono request-local principal with
DynamoDB-backed opaque, hashed, revocable sessions. Keep email verification
for signup, recovery and fallback; retain the 14-day sliding session product
behavior and existing session rows during migration. Redesign service and
transaction boundaries instead of translating the Python router literally.

Optional passkeys are a useful later sign-in improvement, using maintained
SimpleWebAuthn verification rather than custom protocol cryptography. First
prove the native email/session cutover. Then, if passkeys are included,
enrollment requires recent email proof, challenges are purpose-bound and
single-use in DynamoDB, and settings allow credential revocation. Account
deletion removes credential and challenge indexes. Email fallback remains.
Enable this only when the retained rollback path also supports the new
credentials; a Python-only rollback cannot provide passkey sign-in.

Do not introduce Cognito account imports or a second identity store merely
to change languages. Evaluate a general auth framework against the actual
compatibility work it requires, not its convenience in a fresh application.

## Web redesign

Give one implementation agent ownership of web/. Prepare Image Gen desktop
and mobile concepts before coding, then implement text and controls natively
in React. Keep warm paper (#fffbf2), navy (#14163a), restrained cobalt and
orange, and the existing self-hosted Bricolage Grotesque/Martian Mono fonts.
Use open editorial layouts without decorative cards, boxes or shadows.

Today places the version and writing task first, followed by the day's
notes and quiet continuity information. A desktop navigation rail and
compact mobile navigation make Today, Archive, Search and Settings clearer.
Preserve draft recovery, recordings, attachments, optional place, private
media, note edits, capture provenance, settings, export and connection consent.
Cover landing/sign-in, archive/day/search and settings in the same system.

Desktop and mobile Today concept previews were generated during prep and
remain outside the repository in the task's generated-images directory.
Extract a small visual specification before implementation: open paper
surface, large navy version, restrained progress dots, writing before the
notes, labelled attachment/recording/place controls, orange save action,
and cobalt navigation. Use sans text for writing; mono for dates/metadata.
The generated previews' incidental decorative separators, paper texture
and any incorrectly counted dots are not requirements. Use a flat paper
color, preserve exactly 24 dots and avoid ornamental separators.

The finish line includes phone/tablet/desktop renders, keyboard and form
states, recording/upload failures, loading/empty/error states and dark mode.
Compare rendered pages with the concept, recording at least five concrete
fidelity checks. Use local fictional subscribers and mail; no live sign-in.
This redesign does not require SSR, a mobile app or unrelated product features.

## Infrastructure proof before implementation commitment

Complete a bounded isolated-stack rehearsal using fictional data before
relying on production cutover assumptions. This occurs after the session
handoff and within Jamie's resolved cloud/deployment authority.

1. Obtain an isolated current AWS CLI/SDK with `lambda-web` support. The
   installed CLI observed during prep is 2.37.3 and rejects `lambda-web`.
   Do not replace global tooling or credentials merely to pass the probe.
   Official CLI 2.37.13 and @aws-sdk/client-lambda-web 3.1150.0 are available
   at prep time. Install the pinned CLI in task-local XDG destinations,
   verify package signatures and command models offline, and refresh the
   version choice at implementation time. AWS MCP support remains unproved;
   test its new-service model with a metadata-only call after the handoff.
2. Validate CloudFormation WebFunction, WebFunctionRevision and
   WebFunctionEndpoint schemas with pinned supported cfn-lint tooling.
3. Prove complete resource-policy ownership for Web Functions. The new
   API uses Put/Get/DeleteResourcePolicy; AddPermission is unsupported.
   AWS::Lambda::ResourcePolicy's inspected registry schema requires
   ResourceArn but rejects the new web-function ARN in its pattern. Check
   for a corrected registry; otherwise use a narrowly scoped, stack-owned
   custom policy resource or gated idempotent deploy operation with explicit
   ownership, deletion, rollback and read-back. Do not assume native support.
4. Prove regional CloudFront OAC with endpoint IamAuth, origin type lambda,
   sigv4, and always-amz-auth signing. Scope permission to the distribution
   and endpoint. Verify caller Authorization reaches MCP unmodified.
   Put Authorization into the dynamic cache policy, including GET and HEAD;
   an origin-request policy alone is insufficient. The rehearsal showed
   CloudFront rejects a header whitelist with MaxTTL=0. Use MinTTL=0,
   DefaultTTL=0, MaxTTL=1 and mandatory no-store on every application answer,
   with zero error-cache lifetimes. Preserve trusted
   viewer address, Origin, cookies and MCP headers while excluding viewer Host.
5. Provide a versioned source-artifact S3 bucket. The old code bucket is
   deliberately unversioned with 90-day expiry; retain source versions
   needed by deployed revisions and explicit rollback revisions.
   Losing a revision's source version or service access permanently fails
   that revision. Use a protected prefix/bucket and explicit object VersionId;
   record git SHA, artifact hash/version, revision configuration and weights.
6. Prove Node24 startup, framework routing, cookies, bodies, custom-domain
   forwarding and direct-origin rejection. Check telemetry does not log
   tokens, raw query strings, email addresses or note content.
7. Verify alarm/dashboard adaptation for Web Function metrics and the
   structured `message` wrapper, including the sign-in-total filter.
   Use AWS/Lambda/Web request/status-class metrics for the HTTP endpoints.
   console.info(object) puts fields under message; the sign-in filter must
   use $.message.event rather than the existing $.event. Centralize logging
   and prove alarms still recognize the expected outcomes without content.
8. Demonstrate revision promotion and rollback with harmless fixture
   requests. Clean up temporary resources when their evidence is saved.

Use bare FunctionName and explicit dependencies for function, revision and
endpoint resources; launch guidance warns ARN normalization can break provider
read-back/rollback. Supply explicit revision weights and prove revision creation
does not promote traffic. Retention of a CF resource alone is not protection
against AWS cleanup of unused revisions; protect the rollback revision or retain
the complete source/configuration needed to recreate it.

Start HomeRegion in us-east-1. Plan endpoint rate limit 100, the default
per-environment concurrency ceiling 64, and bounded environment counts
selected by load tests. Set explicit request deadlines and external-service
budgets. Keep existing workers' reserved concurrency, retry and failure
queues. Multi-region and server rendering are future feature decisions.

## Agent execution and file ownership

Use up to four concurrent agents including the coordinator. Each wave has
explicit ownership; root alone changes dependency manifests, lockfiles,
shared build configuration, CI, integration wiring and deployment files.
Agents request shared-contract changes through root rather than editing
another lane. Implementation agents work in separate managed worktrees
and deliver reviewed commits; root integrates in dependency order.

| Wave | Coordinator | Agent A | Agent B | Agent C |
| --- | --- | --- | --- | --- |
| Prep | Plan and questions | API/domain audit | Infra/release audit | Worker/test audit |
| Foundation | Workspace/build, AWS rehearsal | Domain and contracts | Store/auth ports and request-shape tests | Fixtures/fakes and parity cases |
| Application | Integration, local harness and CI | API/OAuth/MCP/capture | Mail parser/composer/sender/events | React redesign |
| Completion | Cutover tooling and integration | Media/weather/processing | Export/import/operator tools | Browser/docs and failure review |
| Release | Merge/deploy/rollback and evidence | Auth/data review | Mail/media review | Infra/operational review |

Rebalance completed lanes as needed; task boundaries stay explicit. A
reviewer should inspect code it did not author. No agent independently
merges, deploys, changes production routing or modifies live data.

## Worker replacement details

Use maintained MIME parsing/composition, explicit application quote and
signature stripping, and header-only proof before parsing untrusted bodies.
Inspect raw duplicate From header lines, not only a parser's normalized
address result. Preserve auto-reply exclusions and DMARC/DKIM alignment.

Preserve the guarded link fetch's validated DNS-to-socket connection,
public-address checks, redirects, TLS hostname verification, byte cap and
single wall-clock deadline. A normal unrestricted fetch is not equivalent.

Use Sharp for orientation-aware thumbnails with bounded decoding and
Linux Arm64 binaries. Strip EXIF/GPS while preserving the allowed ICC
profile. Package optional native dependencies reproducibly without
enabling general npm install scripts. Test the packaged artifact on the
target platform. Keep thumbnails in the existing describe stream consumer:
there must not be a third reader on the stream.

Port export zip creation with streaming/bounded file handling, preserving
export ownership and replacement behavior. Treat Day One zips as untrusted
with entry/expanded-size/path limits. Every real import or backfill still
requires its own explicit authorization; migration does not run one.

## Delivery sequence and acceptance gates

1. **Handoff and baseline:** Jamie says the MCP session is done; capture
   work is landed and validated on main, with an understood deploy state.
   Refresh prep and implementation worktrees and freeze the contract.
2. **Platform rehearsal and foundation in parallel:** root proves AWS
   tooling, OAC/policy lifecycle, server deployment, telemetry and revision
   rollback in isolation while agents port independent behavior. Platform
   uncertainty blocks production cutover, not independent implementation.
3. **Foundation:** shared domain and store behavior pass the parity
   manifest, exact AWS request tests and concurrent-claim tests.
4. **HTTP surface:** native API/OAuth/MCP and local Node harness pass all
   API and auth cases plus Playwright against fictional mail and media.
5. **Workers and tools:** all worker/import/export/operator parity cases
   pass, along with Linux Arm64 image packaging and rendered email checks.
6. **Integration:** complete canonical gates, responsive browser flows,
   simultaneous-user isolation, failure paths, IAM review and docs/contract
   checks. Migration browser suites become required for migration PRs.
7. **Release:** create focused PRs, attach each to this task, wait for
   validate on an up-to-date branch, auto-rebase merge, and deploy only
   from a clean validated origin/main under Jamie's confirmed release authority.
8. **Observe and retire:** inspect metadata-only production health,
   routing, alarms, queues, natural requests and the next eligible sender
   run. Report natural acceptance as pending until it occurs. Retain a
   tested old route/runtime rollback while this evidence develops.
   Retire obsolete Python/API Gateway/secret resources only afterward.

Jamie selected staged, compatible releases. Build shared code first;
switch HTTP while old workers still understand the records; replace workers
in place; retire old code last. During CloudFront edge propagation both
implementations must interoperate with shared sessions, grants and records.

First publish Python worker versions and route existing triggers and
internal/self invokes through stable aliases. CloudFormation updates runtime,
handler and code sequentially, so invoking $LATEST during runtime replacement
can see mismatched configuration. Publish a complete Node version before
moving an alias; retain the compatible Python version for rollback. Preserve
the same two stream mapping UUIDs, one sender schedule and receipt rule, no
parallel production senders, no live shadow writes and no extra stream readers.

| Stage | HTTP | Worker aliases | UI | Rollback |
| --- | --- | --- | --- | --- |
| Baseline controls | Python origin | Retained Python versions | Current | Existing origin and alias versions |
| Native HTTP | Web Functions, shared sessions/grants | Python | Compatible current UI | Prior CloudFront origin |
| Native workers | Web Functions | Node versions in bounded groups | Compatible current UI | Previous alias versions |
| Redesign | Web Functions | Node | Redesigned React | Previous UI artifact |
| Retirement | Web Functions | Node | Redesigned React | Retained native revisions/artifacts |

Record enabled resources, additive fields, exact rollback targets and
acceptance evidence for every deployment; a partially migrated main branch
must not silently enable the next stage on an ordinary deploy.

## Rollback and completion

Before the first HTTP switch, record the old origin routing, function
artifact/configuration references and the validated baseline commit using
metadata only. Pre-land and rehearse a gated rollback operation using
explicit approved artifact/version references, so an outage does not require
writing a new PR before restoring service. Retain the old origin secret and
configuration until its rollback window ends. Keep deploy.sh's validated-main
rule; do not use break-glass to deploy an arbitrary old commit.

New Web Function releases keep an explicitly retained previous revision
and switch endpoint weights for rollback. Worker rollback restores known
compatible artifacts without reversing or copying user data. Any rollback
must preserve established sessions, notes and grants created after cutover.

Stop a release on failed verification, unexplained IAM widening, required
data replacement, uncertain rollback, or a repeatable launch-tooling gap.
Continue independent repair/preparation and leave a precise blocking report.
Do not force a release to meet an assumed overnight deadline.

Completion means TypeScript application and operator tooling, native HTTP
servers deployed, existing feature/data/auth contracts preserved, required
gates green, production routing verified, rollback tested, and temporary
resources cleaned up. Tooling such as cfn-lint may still use Python; the
application no longer does. Natural production acceptance is reported
separately when observed.

The final cleanup is a dedicated release: retire Python code/layers/dev
tools, API Gateway, old HTTP functions, origin-secret machinery, temporary
bridges/flags, obsolete permissions/alarms/docs and unused dependencies
after normal production-cycle evidence and the Python rollback window.
Retain normal rollback between validated TypeScript revisions. Do not keep
two architectures indefinitely or rewrite subscriber archives for tidiness.

## Primary platform references

- [Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)
- [Revisions and source artifacts](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions.html)
- [CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html)
- [Scaling](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html)
- [Logging](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-logging.html)
- [CloudFormation revisions](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-webfunctionrevision.html)
- [Resource policies](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-resourcepolicy.html)
- [Worker configuration/code updates](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-function.html)
- [Source object requirements](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html)
- [CLI releases](https://raw.githubusercontent.com/aws/aws-cli/v2/CHANGELOG.rst)
- [CloudFormation registry schemas](https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip)
- [Hono Node server](https://hono.dev/docs/getting-started/nodejs)
- [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server)
- [Sharp Lambda packaging](https://sharp.pixelplumbing.com/install/)
- [MailParser](https://nodemailer.com/extras/mailparser)
