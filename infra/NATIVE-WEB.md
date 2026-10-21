# Native release operations

Release Notes runs its application API and MCP on separate private Node 24
Lambda Web Functions, and its seven Event workers on Node 24 Arm64. CloudFront
serves the React app from private S3 and signs requests to the native HTTP
origins with regional SigV4 OAC. The Python application, API Gateway, old HTTP
functions, origin-secret machinery and unqualified invocation grants/settings
were retired on 2026-10-13. Historical published snapshots may remain retained;
they are not supported rollback targets.

This is the current operating runbook. The staged migration and SES notification
bridge are historical records in [the rebuild plan](../docs/TYPESCRIPT-REBUILD.md)
and the [compatibility ledger](../docs/NATIVE-COMPATIBILITY.md). Do not repeat
their first-activation or Python alias procedures against the native-only stack.

## Release prerequisites

Use `./deploy.sh` from a clean checkout of `origin/main` with a successful GitHub
Actions `validate` run. Land changes through a pull request first. The script
uses the cloud-engineer profile in us-east-1, requires ProjectsCloudEngineer,
selects Homebrew's Node 24, and verifies/builds a `git archive` of the committed
tree. Ignored or uncommitted files cannot enter the release.

Every phase holds the same private full-shell deployment lock. An uncertain
CloudFormation update must finish before another phase runs. Investigate stale
locks and release drift; do not remove a lock merely to get a deployment through.
`--break-glass` is only for GitHub being unavailable: it skips fetch/check lookup,
but still requires clean HEAD to match the last-fetched `origin/main`, Node 24
and successful archived-tree verification. It never permits a red check.

Keep all four HTTP revision pins and all seven worker live-version pins
explicit. The stack has no routing or readiness flags (the migration's were
retired on 2026-10-20): CloudFront always routes to the Web Functions, and the
workers always serve their pinned `live` alias versions.

Private release receipts and policy journals live outside this public repository
in the directory selected by `deploy.sh` (`NATIVE_RECEIPT_DIR`). The directory is
mode 700 and files are mode 600. Keep them available across publish, activate,
rollback and retries; they establish ownership, exact source/build identity and
the prior native targets. Never commit their cloud identifiers or live data.

An ordinary `./deploy.sh` verifies the application and updates infrastructure
and static web assets while preserving native artifact versions and serving
pins. Publishing and activating backend code require the explicit phases below.
Every phase also deploys infrastructure and syncs the web app from current HEAD;
it is not a backend-only operation. Select one native release kind per invocation.

## HTTP publication and activation

```sh
./deploy.sh --native-http-phase=publish
# Review the candidate and complete acceptance before activation.
./deploy.sh --native-http-phase=activate
```

Publication runs `tools/native-release.ts prepare-http`, which calls
`tools/web-platform.ts prepare` to read and save both live and rollback pins.
All four pins are preserved while new app/MCP revisions are published. The
artifacts are standalone `index.js` Node 24 bundles with an ESM `package.json`,
uploaded to the retained versioned source bucket at immutable SHA-256 keys
(`native/app/<hash>.zip`, `native/mcp/<hash>.zip`). Exact S3 VersionIds and the
source commit/build ID bind each publication. Publication installs and verifies
both endpoint policies before it finishes; it does not promote candidate traffic.

Before activation, review the candidates and use fictional local/staging data
for API/MCP behavior, Authorization on GET/POST/HEAD, Origin, secure cookies,
viewer address, no-store on responses/errors, graceful shutdown and parallel
request isolation. The isolated [platform rehearsal](rehearsal/README.md) proves
platform plumbing; it does not replace application acceptance. No production
test sign-ins, subscriber-content reads or subscriber writes for release QA.

Activation uses the published app/MCP build identity from stack metadata, even
when current validated main has advanced. It requires that build to be a
validated ancestor of HEAD and the API/MCP candidates to share its identity.
`promote-http` verifies exact source/configuration and endpoint policies, saves
immutable promotion intent, and supplies CloudFormation overrides that move
each live endpoint to its candidate and each rollback endpoint to the prior live
revision. Endpoints remain IamAuth, auto deployment Disabled, with one 100%
revision each. CloudFormation owns endpoint routing; do not make out-of-band
UpdateWebFunctionEndpoint calls and leave stack parameters stale.

`tools/web-platform.ts` is the sole owner of the two complete function resource
policies. The reviewed CloudFormation ResourcePolicy schema rejects Web Function
ARNs, so the deployment owner uses the Web Functions resource-policy API. Each
grant permits only this stack's CloudFront distribution to invoke the exact
`live` endpoint. `rollback` has IamAuth, no grant and rate zero. Policy writes use
private ownership journals, fresh readback and CAS revisions; an unowned or
changed policy is refused. Neither CloudFormation nor another writer may also
own these policies.

## Event worker publication and activation

```sh
./deploy.sh --native-worker-phase=publish
# Review the complete published worker versions before activation.
./deploy.sh --native-worker-phase=activate
```

`prepare-workers` records the current Sender, Inbound, Events, Transcribe,
Describe, Export and Capture `live` aliases, including their native build/code
identities. All seven explicit `<Name>NativeLiveVersion` parameters preserve
those serving versions while publication updates `$LATEST` and creates complete
retained Node versions. Producers continue invoking qualified `live` aliases;
none should invoke `$LATEST` during publication.

Artifacts use `native/workers/<name>/<sha256>.zip` in the retained versioned
source bucket. `<Name>NodeCodeKey`, `<Name>NodeCodeVersion` and the base64
`<Name>NodeCodeSha256` identify the exact zip. `NativeWorkerBuildId`, `APP_VERSION`
and version descriptions bind the complete configuration to its committed build.
Describe alone includes the pinned Linux Arm64 Sharp runtime closure; no worker
uses the retired Pillow layer.

Activation selects the published worker build from stack metadata and validates
all seven immutable candidates before emitting their explicit live-version pins.
It checks native runtime, handler, Arm64 architecture, active state, code/build
identity and ownership/environment contracts, and invokes only
`{"self_test":true}` on exact published versions. These probes are content-free,
including Describe's native codec probe. Never invoke a real sender, process a
subscriber's note or send a test bounce/complaint as release QA.

The sender schedule, SES receipt action, SNS subscription, transcription
completion rule, both DynamoDB stream mappings and internal invocations keep
their stable qualified entry points. Read back all seven aliases and both stream
mapping identities/enabled states after activation. Preserve their qualified
invocation grants, async retry/destination settings, data resources and roles.
CloudFormation has no alias RevisionId compare-and-swap; the coordinator uses
serialized deployment and fresh alias readback to refuse concurrent drift.

## Native rollback and interrupted releases

Run the phase for the affected backend from clean, validated current main:

```sh
./deploy.sh --native-http-phase=rollback
```

or, for the worker group:

```sh
./deploy.sh --native-worker-phase=rollback
```

The script resolves the published backend build identity from stack metadata,
then `tools/native-release.ts` loads that build's immutable promotion receipt and
recorded prior native release. HTTP rollback restores the prior four revision
pins and re-verifies the endpoint policies. Worker rollback restores the prior
seven alias versions, verifying their recorded build and code hash and running
the same content-free published-version probes. Neither rollback rewrites subscriber data or changes
the published source artifact/build parameters. Static assets still come from
current HEAD; these flags do not restore an earlier UI build.

The tooling refuses missing/mismatched receipts, changed build identities,
unowned policies and routing/alias drift. A recorded baseline with no serving
revisions (HTTP) or no build and code hash (workers), as the first adoption's
receipts have, is refused before any rollback intent. No release step removes an
endpoint policy or disables compute; a rollback only moves pins and aliases.

For an interrupted phase, first establish whether CloudFormation is still
updating and read back the actual pins/aliases. Retry the matching phase with
its existing receipts only after the stack is idle and the coordinator accepts
the recorded state. Do not discard promotion intent or fabricate replacement
receipts. After a rollback, a subsequent publication needs a new validated
commit/build identity; the same build's promotion intent remains immutable.

## Source retention and recovery

Immutable HTTP revisions and worker versions have Retain policies. The
zero-rate rollback endpoints keep last-good HTTP revisions referenced; Retain
alone does not protect unused revisions from Lambda's cleanup near its quota.
Never delete a source object version, remove its Lambda service read grant, or
garbage-collect a live/rollback reference. The native source bucket intentionally
has no expiration rules; it is separate from the expiring template code prefix.

Deleting source bytes or their readability permanently fails the HTTP revision;
restoring them does not reactivate it. Recovery requires a fresh revision from
the saved immutable artifact/configuration, verified policies and deliberate
publication/activation. Native rollback requires a healthy protected prior
revision and its dependencies. A platform/routing outage without a usable native
baseline requires investigation and a reviewed native repair; retired API
Gateway and Python resources cannot provide a fallback.

## Verification, telemetry and capacity

After a release or rollback, confirm CloudFormation has completed, CloudFront
has finished any distribution update, HTTP endpoints/policies and worker aliases
match the receipts, and protected rollback revisions remain active. Check public
`/api/health` and the unauthenticated `/mcp` challenge without signing in. Inspect
count-only alarms, failure-queue depth, native requests and the next eligible
natural sender cycle. Report unobserved real flows as pending; never manufacture
subscriber traffic, imports, backfills or acceptance events.

Native HTTP loggers call `console.info(fieldsObject)` with safe content-free
fields. Web Functions wraps it under `message`, so filters use `$.message.event`
and `$.message.limit`. Event workers retain raw stdout JSON/EMF with
`LogFormat=Text` and `$.event` filters. The native sign-in filter contributes to
`ReleaseNotes/SignInTotalLimited`; native `mcp-error` filters emit
`ReleaseNotes/McpFailures` because nested EMF is not EMF. No URL/query, tokens,
cookies, addresses, note text or place data may be logged.

Live endpoint ceilings are rate 100 and eight environments, with 64 as the
per-environment concurrency upper bound; the service may choose lower admission
concurrency. Rehearsal burst results are not product throughput claims. Alarms
distinguish HTTP 5xx (`AWS/Lambda/Web`) from environment/rate throttling
(`AWS/Lambda/Web/Usage`, including ExecutionRegion). Sparse metrics use
missing-data=notBreaching. Budget/capacity changes follow measured fictional
application staging workloads.

Official references:
[Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html),
[source retention](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html),
[revision cleanup](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions.html),
[resource permissions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-permissions.html),
[CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html),
[metrics](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring-metrics.html).
