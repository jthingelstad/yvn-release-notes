# Lambda Web Functions platform rehearsal

On 2026-10-13, an isolated us-east-1 stack exercised a standalone Node 24
Hono server with fictional request values and a logs-only execution role.
It referenced no production resources and had no database, mail, model,
secret or subscriber-data permissions. Cleanup completed: the owned policy was conditionally removed, compute
resources were deleted before their source object versions, the temporary
stack and bucket were deleted, and account Web Function count returned to zero.

The signed AWS CLI 2.37.13 was installed in task-local XDG directories,
leaving the host installation untouched. The pinned SDK service client was
`@aws-sdk/client-lambda-web@3.1150.0`. The AWS MCP sandbox's service model
rejected `lambda-web`; the task-local native SDK handled the rehearsal.

The rehearsal proved:

- CloudFormation creates the function, immutable revisions and regional
  endpoints using bare FunctionName and explicit function dependencies.
- Endpoints stayed IamAuth throughout. Unsigned direct-origin requests were
  rejected with 403; CloudFront OAC requests reached the server.
- Regional OAC accepts origin type `lambda`, protocol `sigv4`, and signing
  behavior `always-amz-auth`. Application Authorization survives on GET,
  HEAD and POST. Cookies, Origin and CloudFront-Viewer-Address also arrive.
- Responses retain Secure/HttpOnly/SameSite cookies and Cache-Control:
  no-store; concurrent fictional Ada/Bob requests retain separate identity.
- Creating a candidate revision does not promote it. Endpoint read-back
  showed autoDeploymentMode Disabled. Explicit 90/10 routing produced 37
  baseline and 3 candidate responses in a 40-request sample. Promotion to
  candidate 100% and rollback to baseline 100% both passed fixture checks.
- `console.info(object)` produces a structured `message` object. A filter
  on `$.message.event` and `$.message.limit` counted the synthetic sign-in
  limit event. Native ExecutedRequests metrics appeared in AWS/Lambda/Web.
- The full function resource policy was installed by one explicit owner,
  restricted to the rehearsal CloudFront distribution and live endpoint,
  read back, and deleted using its recorded revision ID.

## Measured admission, not a capacity promise

The revision configured maxConcurrencyPerEnvironment 64 and endpoint rate
limit 100. Lambda dynamically chooses a lower concurrency limit when needed;
those settings do not guarantee 64 concurrent requests in each environment.
The table records 40-request microbursts against a tiny health handler.

| Environment cap | Admission result |
| --- | --- |
| 2 | 29 HTTP 200, 11 HTTP 429 |
| 2, repeat | 27 HTTP 200, 13 HTTP 429 |
| 4 | 30 HTTP 200, 10 HTTP 429 |
| 2, paced at about 5 requests/second | 40 HTTP 200, no errors |

CloudWatch attributed the observed throttles to
EndpointActiveEnvironmentThrottles. The captured error header was
`Platform.EndpointMaxEnvThrottle`. This was not a measured request-rate or
account-quota bottleneck. Increasing the environment cap alone did not
eliminate the microburst errors. Choose the production cap using bounded
application load tests, including cold starts, I/O waits and realistic
request arrival patterns; this fixture does not benchmark the full product.
[Scaling documentation](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html)

## Launch details that matter for production

CloudFront rejects a cache policy whose three TTLs are zero when its header
allowlist includes Authorization. The accepted policy uses MinTTL 0,
DefaultTTL 0 and MaxTTL 1, with Authorization keyed and forwarded. Every
application response, including errors, must centrally set no-store. The
zero minimum lets that response directive prevent caching.

The live CloudFormation resource registry requires ResourceArn for
AWS::Lambda::ResourcePolicy, but its ARN pattern accepts event functions
and rejects Web Function ARNs. Until corrected and rehearsed, use one
explicit, revision-checked policy owner through LambdaWeb Put/Get/Delete
ResourcePolicy. Do not mix native permission resources or other full-policy
writers with that owner. Preinstall and verify policies before changing
production origins.
[Policy documentation](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-permissions.html)

Retain the exact versioned S3 objects and Lambda service read permission
needed by active and rollback revisions. Removing either permanently fails
an affected revision; restoring the object or policy does not reactivate it.
Recreate a new revision from the saved artifact and configuration instead.
Do not reuse the current unversioned, 90-day-expiring code prefix.
[Source artifact documentation](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html)

CloudFormation Retain alone does not prevent the service from cleaning up
unused revisions near its per-function limit. A restricted rollback endpoint
must keep the rollback revision referenced; retain its artifact/configuration
as well. Rollback endpoint rateLimit 0 rejects new requests but protects the
revision reference.
[Revision documentation](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions.html)

Observe status-class metrics in AWS/Lambda/Web and separate throttling metrics
in AWS/Lambda/Web/Usage. Sparse error metrics need missing-data handling.
Native request metrics have no revision dimension; include a build identifier
in content-free application telemetry.
[Metrics documentation](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring-metrics.html)
