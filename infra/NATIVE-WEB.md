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
