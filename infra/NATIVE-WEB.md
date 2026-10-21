# Releases

Release Notes runs its application API and MCP on separate private Node 24
Lambda Web Functions, and its seven Event workers on Node 24 Arm64. CloudFront
serves the React app from private S3 and signs requests to the two HTTP origins
with regional SigV4 OAC. The Python application, API Gateway, old HTTP
functions, origin-secret machinery and unqualified invocation grants/settings
were retired on 2026-10-13. Old Python function versions may remain as retained
snapshots; nothing serves them.

This is how a release works. `AGENTS.md` has the rules and `docs/OPERATING.md`
the everyday operations.

## One release

Merging to main releases it: `deploy` (`.github/workflows/deploy.yml`) follows
each green `validate` run on main, builds the bundle in a job with no
credentials and runs `scripts/release.sh` as `ReleaseNotesGitHubDeploy`.
`./deploy.sh` runs the same script from the Mac. Every release takes
everything to its commit (Jamie, 2026-10-20, of the phased release it
replaced: "I did think the deploy got obnoxiously complex"):

1. **Upload** the nine code zips (API, MCP and the seven workers) to the
   stack's source bucket, each at `native/app/<sha256>.zip`,
   `native/mcp/<sha256>.zip` or `native/workers/<name>/<sha256>.zip`. A key is
   written once (If-None-Match) and never changed; one already there is
   checked, not sent again (`tools/native-artifacts.ts`).
2. **One stack update** with `BuildId` (the commit) and the nine `<Name>Code`
   hashes. `BuildId` is every function's `APP_VERSION` and every revision's
   and version's description, so each release builds a new revision of both
   Web Functions and a new version of every worker, and moves `live` to them:
   each endpoint by `!GetAtt <Kind>Revision.RevisionId`, each alias by
   `!GetAtt <Name>NodeVersion.Version`. Explicit endpoint weights keep auto
   deployment Disabled, so an endpoint serves only the revision the stack
   names. Once the update succeeds CloudFormation deletes the revisions and
   versions it replaced; a failed update rolls back to the previous release
   whole.
3. **The endpoint grants** are confirmed (below).
4. **The inbound mail rule set** is checked and **the web app** synced.
5. **The probe** (`tools/release-probe.ts`): every worker's `live` alias is the
   version the stack published and answers `{"self_test":true}` with this
   build on Node 24 Arm64; each endpoint serves an active revision of this
   build; `/api/health` answers through CloudFront. It reads no subscriber
   data, and nothing invokes a real sender or note as release QA.

A failed probe turns the run red, but the release stays live.

## Rolling back

Revert the merge, through a pull request like any other change. Its release
takes everything back to the earlier code in about five minutes: the build
usually makes the same zips, already in the bucket under their hashes, and the
web app comes from the same commit. There is no other rollback path. If GitHub
is down, `./deploy.sh --break-glass` releases the reverted main from the Mac.

CloudFormation runs one stack update at a time, and the workflow queues
GitHub's releases (`production-deploy`, never cancelled). The web sync and
the probe come after the stack update, so the Mac's `deploy.sh` refuses
while a GitHub release is queued or running and again if main moved while it
built, and every release stops before its web sync (and again after it) if
another release has since replaced the stack's `BuildId`. A release that dies mid-update leaves CloudFormation to finish or
roll back on its own; once the stack is idle, release main again ("Run
workflow" on `deploy`, or re-run the failed run).

## The endpoint grants

`tools/web-platform.ts` owns the two Web Function resource policies, which
CloudFormation cannot hold. Each lets only this distribution invoke the `live`
endpoint. A release installs a missing one and confirms an existing one is
exactly that grant; one that differs stops the release for a person to look
at. Nothing removes or rewrites a grant: CloudFront reaches the API only
through them.

## The source bucket

The source bucket has no expiration rules, and objects under `native/` are
never deleted: deleting a zip permanently fails the revision built from it
(restoring it does not bring that revision back), and a revert needs the old
zips. The template copies in the code bucket's `code/templates/` are separate
and expire after 90 days.

## Verification, telemetry and capacity

The probe covers each release. Beyond it, check the unauthenticated `/mcp`
challenge without signing in, the count-only alarms, failure-queue depth, HTTP
requests and the next natural sender cycle. Report unobserved real flows as
pending; never manufacture subscriber traffic, imports, backfills or acceptance
events.

The HTTP loggers call `console.info(fieldsObject)` with safe content-free
fields. Web Functions wraps it under `message`, so filters use `$.message.event`
and `$.message.limit`. Event workers retain raw stdout JSON/EMF with
`LogFormat=Text` and `$.event` filters. The sign-in filter contributes to
`ReleaseNotes/SignInTotalLimited`; the `mcp-error` filters emit
`ReleaseNotes/McpFailures` because nested EMF is not EMF. No URL/query, tokens,
cookies, addresses, note text or place data may be logged.

Live endpoint ceilings are rate 100 and eight environments, with 64 as the
per-environment concurrency upper bound; the service may choose lower admission
concurrency. The rehearsal's burst results below are not throughput claims. Alarms
distinguish HTTP 5xx (`AWS/Lambda/Web`) from environment/rate throttling
(`AWS/Lambda/Web/Usage`, including ExecutionRegion). Sparse metrics use
missing-data=notBreaching. Budget/capacity changes follow measured fictional
application staging workloads.

## What the 2026-10-13 platform rehearsal established

An isolated us-east-1 stack ran a standalone Node 24 Hono server with fictional
requests and a logs-only role, then was deleted. What still governs this stack:

- Endpoints stay IamAuth: unsigned direct-origin requests get 403, CloudFront
  OAC requests (origin type `lambda`, `sigv4`, `always-amz-auth`) arrive with
  the application's Authorization intact on GET, HEAD and POST, and with
  cookies, Origin and CloudFront-Viewer-Address.
- A new revision serves nothing until an endpoint routes to it (auto
  deployment Disabled). Promotion to 100% and back passed; a 90/10 split
  served 37 and 3 of 40 requests.
- CloudFront rejects a cache policy whose three TTLs are zero when its
  header allowlist includes Authorization. The stack's policy uses MinTTL 0,
  DefaultTTL 0, MaxTTL 1, so every response, errors included, must set
  no-store.
- The `AWS::Lambda::ResourcePolicy` registry schema rejects Web Function ARNs,
  hence one owner through the LambdaWeb resource-policy API
  (`tools/web-platform.ts`). The AWS MCP sandbox's service model rejected
  `lambda-web`; the pinned `@aws-sdk/client-lambda-web` handles it.
- Request metrics have no revision dimension, so telemetry carries the build.
- 40-request microbursts against a health handler were throttled at
  environment caps 2 and 4 (11 to 13 HTTP 429s; EndpointActiveEnvironmentThrottles,
  header `Platform.EndpointMaxEnvThrottle`), while about 5 requests a second at
  cap 2 had no errors. Raising the cap alone did not remove the burst errors;
  choose caps from bounded application load tests.

Official references:
[Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html),
[source retention](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html),
[revision cleanup](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions.html),
[resource permissions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-permissions.html),
[CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html),
[metrics](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring-metrics.html),
[scaling](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html).
