# Native HTTP release operations

`infra/template.yaml` adds Node 24 Lambda Web Functions alongside the existing
Python HTTP API. The first deploy creates the retained, versioned source bucket,
log groups, OAC, metric filters and alarms with native compute disabled. Existing
mail/storage resources, event triggers and legacy HTTP resources remain intact.
`tools/web-platform.ts` owns the two complete function resource policies; neither
CloudFormation nor another deployment writer may also own those policies.

The current CloudFormation `AWS::Lambda::ResourcePolicy` registry schema rejects
`web-function/` ARNs. The explicit deployment owner uses the Web Functions
Get/Put/DeleteResourcePolicy API instead. Its grant permits only this stack's
CloudFront distribution to invoke the exact `live` endpoint. `rollback` has
IamAuth, no grant, and rate zero. There is never a public endpoint.

## First activation

1. Run the normal green-main deployment with `NativeWebFunctionsEnabled=false`,
   `NativeHttpRouting=legacy`, and established `WorkerAliasesReady=true`.
2. Build standalone `index.js` Node 24 bundles and a `package.json` with
   `type=module`. Upload each zip to `NativeSourceBucketName` at its immutable
   SHA-256 key (`native/app/<hash>.zip`, `native/mcp/<hash>.zip`). Record the exact
   S3 VersionId, source commit/build ID, artifact hash and build configuration in
   a private release receipt outside this public repository.
3. Deploy with `NativeWebFunctionsEnabled=true`, both key/version/build-ID
   parameter triples, and legacy routing. Review the change set: the retained
   table/mail bucket, existing schedule, receipt rule and both stream UUIDs must
   remain unchanged. The app/MCP execution roles keep their separate existing
   service grants, adding only their own native main/local logs. Runtime-provided
   `AWS_REGION` is not overridden.
4. Use Node 24 and the cloud-engineer child-process credential chain:

   ```sh
   AWS_PROFILE=cloud-engineer node --import tsx tools/web-platform.ts policy-install --receipt-dir /private/release-receipts
   AWS_PROFILE=cloud-engineer node --import tsx tools/web-platform.ts policy-verify --receipt-dir /private/release-receipts
   ```

   The tool verifies caller role/account/region, stack/function/endpoint identity,
   disabled auto deployment, IamAuth, active state, and full policies. Journals are
   mode 600 in a mode 700 directory. It saves intent before mutation, uses CAS
   tokens on subsequent mutations, and recovers unknown responses only from its
   own matching journal/readback. An unowned, changed or stale policy is refused.
   The service provides no absence CAS token for an initial policy creation;
   that first write is bounded by the fresh private function, sole owner and local
   release lock. There is no blind SDK mutation retry.
5. Complete API/MCP parity and staging load checks with fictional data, including
   Authorization on GET/POST/HEAD, Origin, secure cookies, viewer address,
   no-store on every response/error, shutdown and parallel request isolation.
   The isolated rehearsal proves the platform plumbing; it does not replace
   application acceptance. No production sign-ins or subscriber writes for QA.
6. Only after both policy readbacks and acceptance, deploy
   `NativeOriginPoliciesReady=true`, `NativeHttpRouting=native`. CloudFront then
   uses the provider-returned endpoint domain names and regional SigV4 OAC.
   Inspect distribution completion and count-only native error/throttle metrics.
   The static React origin and the legacy API stay available for rollback.

## Later revisions

Before changing any artifact, run `prepare` and apply **all four returned pin
parameters** to the next CloudFormation deployment:

```sh
AWS_PROFILE=cloud-engineer node --import tsx tools/web-platform.ts prepare --receipt-dir /private/release-receipts
```

`prepare` reads control-plane metadata only and saves a receipt. It requires one
100% live revision and one 100% rollback revision, with auto deployment disabled.
Empty revision-ID parameters are for first creation only. Leaving them empty
while replacing a revision makes the endpoint's GetAtt follow that new revision,
even though auto deployment is disabled. Pinning prevents candidate publication
from promoting traffic. After acceptance, explicitly move live to the candidate
and rollback to the previous live ID. Read back both endpoints and policies.
CloudFormation owns endpoint routing; do not silently make an out-of-band
UpdateWebFunctionEndpoint call and leave stack parameters stale.

Immutable revisions have Retain policies, and the separate zero-rate endpoint
keeps the last-good revision referenced. Retain alone does not protect an unused
revision from Lambda's cleanup near its revision quota. Never delete a source
object version, remove its source-bucket read grant, or garbage-collect a live or
rollback reference. The source bucket intentionally has **no expiration rules**.
Deleting source bytes/readability permanently fails the revision; restoring the
bytes does not reactivate it. Recovery then requires a fresh revision built from
the saved immutable artifact/configuration, with deliberate promotion.

## Rollback and retirement

For an application regression, explicitly set each live revision ID to the
protected last-good ID; do not change native artifact keys or rollback pins.
For platform/routing failure, set `NativeHttpRouting=legacy` and wait for the
existing CloudFront distribution to finish deploying. Existing Python API/MCP
functions, API Gateway, secret-origin proof and worker aliases remain usable.
Do not reset `WorkerAliasesReady=false` after worker conversion; select each
retained complete Python version on its stable alias instead.

Policy retirement is a separate ordered operation after legacy routing has
completed:

```sh
AWS_PROFILE=cloud-engineer node --import tsx tools/web-platform.ts policy-remove --receipt-dir /private/release-receipts
```

It conditionally deletes only the exact policy it owns and confirms absence.
It refuses native routing, another owner's policy, or a changed CAS revision.
Keep journals until retirement is confirmed, including interrupted removals.
Remove compute/endpoint resources only after that step. Retained source versions
and revision receipts remain available; this tool never deletes source objects.

## Telemetry and capacity

Native HTTP loggers must call `console.info(fieldsObject)`, with safe content-free
fields. Web Functions wraps it under `message`, so native filters use
`$.message.event` and `$.message.limit`. Event workers retain raw stdout JSON and
existing `$.event` filters. Both signin filters contribute to the unchanged
`ReleaseNotes/SignInTotalLimited` alarm; native `mcp-error` filters emit
`ReleaseNotes/McpFailures` because an EMF object nested under message is not EMF.
No URL/query, tokens, cookies, addresses, note text or place data may be logged.

Initial live ceilings are rate 100 and eight environments per endpoint, with 64
as the per-environment concurrency **upper bound**. The service can choose a lower
admission concurrency. Rehearsal burst results and platform throttle reasons are
in [rehearsal/README.md](rehearsal/README.md); these are not product throughput
claims. Alarms distinguish HTTP 5xx (`AWS/Lambda/Web`) from environment/rate
throttling (`AWS/Lambda/Web/Usage`, including ExecutionRegion). Sparse metrics use
missing-data=notBreaching. Budget and capacity changes follow measured fictional
application staging workloads.

Official references:
[Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html),
[source retention](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html),
[revision cleanup](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions.html),
[resource permissions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-permissions.html),
[CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html),
[metrics](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring-metrics.html).

## Event notification bridge before worker conversion

The six established worker aliases already point at complete Python versions.
Events initially remains unqualified. Before creating its alias/SNS replacement,
`events.py` and the Node event worker share the exact transaction: guarded
PROFILE update, monthly TALLY ADD, and `USER#/MAILEVENT#<SHA256 SNS MessageId>`
receipt with a 30-day TTL. This temporary bridge closes the old stop/tally split.
The receipt has no mail content and is deleted with the account. A duplicate
notification cannot stop an account again after its owner restarts; ops notices
remain at least once and scrubbed.

The first bridge deploy passes `EventsAliasesReady=false` and the new zip's
base64 SHA-256 as `EventsPythonCodeSha256`. It updates the unqualified handler and
creates the retained, hash-pinned complete Python version, alias permission and
async config. Verify both code hashes, Python runtime/handler, complete config
and published version before the second pass sets `EventsAliasesReady=true`.
CloudFormation replaces the SNS subscription; overlapping qualified/unqualified
notifications share receipts and apply once. Keep the original unqualified grant
until accepted requests drain. Subsequent releases preserve the original
`EventsPythonCodeSha256` parameter forever; changing it would replace the retained
Python baseline publication resource. Tests use fictional events and SDK fakes;
never send a test bounce/complaint to a live subscriber to prove the bridge.

## Complete native Event worker publications

Worker preparation is separate from alias activation. Keep
`WorkerAliasesReady=true` and `EventsAliasesReady=true` permanently once the
Python alias passes and notification bridge have finished. CloudFormation rules
refuse native preparation or activation without both prerequisites; no producer
should invoke `$LATEST` while its runtime and code are being changed.

For each of Sender, Inbound, Events, Transcribe, Describe, Export and Capture,
record the current `live` version and complete Python configuration in a private
release receipt. Upload a standalone Node 24 Arm64 zip to the retained versioned
`NativeSourceBucket`, using the key `native/workers/<name>/<sha256>.zip`. Supply
`<Name>NodeCodeKey`, `<Name>NodeCodeVersion` and `<Name>NodeCodeSha256` (base64
SHA-256 of the exact zip). An exact S3 version is required, not just a key.
Describe's zip includes the pinned Linux Arm64 Sharp dependencies; its Node
configuration has no Pillow layer. Existing published Python versions keep their
original runtime, handler, environment and layer.

Set `NativeWorkersEnabled=true`, `NativeWorkerAliasesReady=false` and the
immutable source/configuration release token `NativeWorkerBuildId`. This updates
all seven `$LATEST` functions to `nodejs24.x` and `index.handler`, preserving their
roles, timeouts, reserved concurrency, destinations and environment contracts.
It then publishes retained `<Name>NodeVersion` resources after each complete
function update. `CodeSha256` prevents publication against a different zip;
`APP_VERSION` and the publication description bind each configuration release
to the build token. No existing Python publication property changes, and every
live alias remains on its Python version during this pass.

Before activation, read each `<Name>NativeCandidateVersion` output and verify
its published code hash, Node runtime, handler, Arm64 architecture, environment
names, role, log format, layer absence/presence and resource settings against the
release manifest. Use fictional local/staging requests and count-only production
control-plane checks. Do not invoke a real sender, process a subscriber's note or
send a test bounce as release QA. Review the change set: existing Python Version
resources and both stream mapping physical IDs must remain untouched.

For the activation pass, set every `<Name>NativeLiveVersion` explicitly to its
verified candidate ID, then set `NativeWorkerAliasesReady=true`. Only alias
version selection changes. The one schedule, SES receipt action, one SNS
subscription, transcribe completion rule, both existing stream mappings and
internal invocations continue using the same qualified `live` entry points.
Read back aliases and the exact two mapping UUIDs/enabled states. Their async
retry/destination settings and invocation grants are already attached to `live`.

Before a later artifact or configuration publication, preserve the currently
serving version in all seven explicit native live-version parameters. Keeping an
empty parameter would let a new publication move its alias during preparation.
Change the build token for every complete configuration publication, even when
source bytes are unchanged; publish, verify and activate in separate passes.
Use local ownership receipts and fresh alias read-back before each change set to
refuse concurrent release drift. CloudFormation updates do not provide an alias
`RevisionId` compare-and-swap; the release coordinator must serialize deployments
and verify the previous target immediately before and after each pass.

For a full worker rollback, leave `NativeWorkersEnabled=true` and both Python
alias prerequisites true, and set `NativeWorkerAliasesReady=false`. The aliases
return to the original retained complete Python versions while `$LATEST` remains
Node. An individual rollback can instead pin that worker's recorded Python
version in its explicit live-version parameter. Preserve the unchanged
`EventsPythonCodeSha256`, Python publication resources, Native source object
versions and candidate/live version receipts. Delete none of them during the
migration or while an alias or rollback receipt refers to them.

Native Event logs use raw stdout JSON/EMF with `LogFormat=Text`, preserving the
existing census and alarm conventions. Additive IAM authorizes the actual
transaction components: USER-scoped `ConditionCheckItem` for inbound/export/
processing and USER-scoped receipt Put/Delete for transcribe. Existing updates
cover its RATE quota. Inbound gains raw GetObjectTagging (so a delayed duplicate
cannot change a filed message's retention) and media PutObjectTagging/DeleteObject
for promotion/cleanup. Describe gains PutObjectTagging on thumbnail keys only.
No `dynamodb:TransactWriteItems` IAM action exists; transaction operations use
these component permissions. The private capture role remains unchanged.
