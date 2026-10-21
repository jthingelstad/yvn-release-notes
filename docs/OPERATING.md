# Operating Release Notes

How to run the product day to day. `AGENTS.md` has the rules these steps
follow; where a step needs Jamie's go, that rule is there too.
`infra/NATIVE-WEB.md` is how a release works and how to roll one back.

## Deploying

- **From GitHub** (the normal path): merging to main deploys it. `deploy`
  (`.github/workflows/deploy.yml`) follows each green `validate` push run on
  main. It builds the bundle in a job with no credentials or token
  permissions (`scripts/build-release.sh`), then runs `scripts/release.sh` as
  `ReleaseNotesGitHubDeploy` through OIDC: the code uploaded, one stack
  update that takes every function and endpoint to the commit, the endpoint
  grants confirmed, the web app synced, then the probe. Every merge releases
  everything, in about five minutes. "Run workflow" on main releases main's
  tip again. Runs share the `production-deploy` concurrency group (never
  cancelled; a newer waiting run replaces an older waiting one) and refuse
  unless main is still the commit they built. The `production` environment
  has no reviewers but admits only main, and the deploy role trusts only its
  OIDC subject. The role ARN is the environment secret
  `RELEASE_DEPLOY_ROLE_ARN` (the deploy stack's `DeployRoleArn` output), so
  the public log masks it.
- **Rolling back** is reverting the merge (`infra/NATIVE-WEB.md`). A failed
  stack update rolls itself back; a failed probe leaves the release live and
  the run red, so read it and revert.
- **From the Mac**: `./deploy.sh` (cloud-engineer profile, us-east-1) is for
  the admin id, the Turnstile mode, the code bucket's and receipt rule set's
  first setup, and GitHub being down. It runs from a clean checkout of
  `origin/main` with a green `validate` run by GitHub Actions and refuses
  anything else. `--break-glass` is for GitHub being down, never a red check:
  it skips only the fetch and the check lookups, so HEAD must still be a clean
  checkout of `origin/main` as last fetched. It builds a bundle from a
  `git archive` of HEAD with `scripts/build-release.sh` (`npm run verify`
  again, the web app, the code zips), so nothing git ignores goes in and a
  failed build stops the deploy, then hands it to `scripts/release.sh`. Their
  comments have the rest (the code bucket, cache lifetimes, the
  invalidation). A Mac build zips the same files with different bytes than
  the Linux runner, so its zips are new keys; that is harmless.
- **The admin id** (`AdminUserId`, product updates):
  `./deploy.sh --admin-user-id=ID` (an explicit empty id disables `/admin/`).
  The Turnstile mode works the same way (Turnstile, below). Every other
  release keeps both as they are.

## Node, tests and the local harness

- **Node 24** everywhere (`.node-version`, the workflows; `engines` says 24
  or later). This Mac's default `node` is newer, so put Homebrew's
  `/opt/homebrew/opt/node@24/bin` first on PATH for npm here; `deploy.sh`
  does that itself and refuses any other major. Moving to a new major
  changes all of those together, with `@types/node`.
- Tests and builds: `npm ci --ignore-scripts`, then `npm run verify`
  (format, lint, browser and server types, unit tests, both builds).
  `npm run test:server` runs Node's test suite alone. Pinned
  `pipx run --spec cfn-lint==1.57.2 cfn-lint infra/template.yaml infra/github-deploy-role.yaml infra/backup.yaml`
  checks CloudFormation; Python is a dependency of this linter, not an
  application runtime. `sh scripts/test-workflows.sh` checks the workflows.
- Locally: `npm run build`, then
  `node --import tsx tools/dev-server.ts --fake-places --fake-links`. It
  serves `dist/web` and the real Hono HTTP/MCP API against in-memory fakes,
  captures mail at `/dev-mail/`, and starts with fictional ada@example.com.
  Fake places/weather and link titles prevent external fetches.
  `--dayone ZIP` imports into those fakes first. For hot reload, start it
  with `--port 8790`, then `npm run dev` (Vite on 5173, forwarding `/api` and
  development routes). `/dev-runtime/` identifies the harness; Playwright
  starts its own, never reusing another server.
- Browser tests: `e2e/` drives sign-up in Chromium against the dev server,
  reading sign-in codes and links from its `/dev-mail/`. Locally:
  `npx playwright install chromium` once, then `npm run e2e` (it builds
  first). The expected number comes from `/api/sample`, never a fixed
  string. The dev server's sign-in limits still apply (20 emails an hour
  from one network), so `--repeat-each` past about 4 trips them. On GitHub
  the `e2e` workflow runs on PRs that change `web/` or `e2e/`, on the `e2e`
  label and by hand (`AGENTS.md`, Testing).

## Operator tools

All run with node@24 on PATH and the cloud-engineer profile. The ones that
write need Jamie's go for a live run (`AGENTS.md`, Operating).

- Send someone today's email now, outside their window: invoke the sender
  with `{"send_now": "<user id>"}` (add `"dry_run": true` first to see it).
  Still once per local day; never fake the clock with `now` to do it.
- `node --import tsx tools/read-notes.ts EMAIL [YYYY-MM-DD]` prints someone's
  release notes, from before the web app had a reader. It prints note text:
  only for the subscriber's own notes, never to check something.
- The fill-in scripts for notes from before a feature
  (`tools/extract-media.ts`, `tools/fill-link-titles.ts`,
  `tools/fill-weather.ts`) take `EMAIL [--dry-run]` and default to planning
  only. Run the dry run first; `--write` is the live run.
- Thumbnails for photos kept before they existed: invoke the describe
  function with `{"thumbs_all": "*", "dry_run": true}` (or one user id) to
  count them; the real run drops `dry_run`. It hands itself on near its
  time limit and skips any photo that has one.
- The badges baseline (once, at the Badges launch):
  `node --import tsx tools/badges-baseline.ts` counts what every subscriber
  has already earned and is not yet `seen`; `--write` adds it, so nobody's
  first email with the badge line lists everything at once. Counts only,
  never a name or address.
- One row per subscriber (address, state, sign-up day, send time, last
  email, last note, notes, 30-day reply rate):
  `node --import tsx tools/subscribers.ts`. Reads keys and a few fields,
  never note text; it prints addresses, so its output stays on this Mac.
  The monthly counts: `node --import tsx tools/tally.ts`. Both read only.
- Day One imports: `node --import tsx tools/import-dayone.ts EMAIL ZIP...`
  prints what an import would do, as counts (`--plan-out` to a folder
  outside the repo for the full plan, note text included;
  `--weather-sample N` to check the weather archive for N days). `--write`
  imports through the Node AWS SDK.

## Turnstile

- Set it from the Mac, as the admin id is: `./deploy.sh --turnstile-mode=enforce`
  (or `observe`, `off`, `default` to clear it back to the code's default).
- Read the observe numbers in Logs Insights on the web function's log group:
  `filter message.event = "turnstile" | stats count() by message.result, message.mode, message.codes`
  (add `| filter message.result != "pass"` to see what enforce would refuse).
  Why a page sent no token:
  `filter message.event = "turnstile" and message.result = "missing" | stats count() by message.client_reason`.
  Enforce once `missing` from real people (a sign-in code verified right
  after) is near zero. The function logs JSON under `message`, so a bare
  `event` matches nothing.
- `client_reason` is one of `script-blocked`, `script-empty`,
  `error:<code>`, `loading-timeout`, `solving-timeout`,
  `interactive-timeout`, `no-slot` (`web/src/lib/turnstile.ts`), with
  `client_wait_ms` beside it.
- The widget is "Release Notes sign-in" (managed, site key
  `0x4AAAAAAFW0y7cvQQshNAwH`, public, domain notes.yourversionnumber.com),
  made with the `cf` CLI. One token serves one address for five minutes and
  three uses (`TURNSTILE#`). The page loads Cloudflare's script only on
  focus or typing in the email field; tests and e2e stub it
  (`e2e/turnstile-stub.mjs`).

## Runtime secret

The credentials live in one Secrets Manager secret,
`yvn-release-notes-runtime` (stack parameter `RuntimeSecretName`), a JSON
object of `ANTHROPIC_API_KEY` (the describer) and `TURNSTILE_SECRET_KEY` (the
web function), as the Librarian keeps `weekly-thing-librarian-runtime`. Jamie
keeps it by hand in the console: the stack does not own it and no deploy
writes it. Rotate a key by editing the secret: Turnstile picks a new value up
when a container starts (an empty one is looked for again every five
minutes, and until then every check records `unconfigured` and goes ahead);
the describer reads it on each run.

## Alarms, the dashboard and failures

- Alarms go to SNS `yvn-release-notes-alarms`, which is subscribed to the
  sysadmin `projects-ops-alerts` queue. The queue's policy must list the
  topic.
- SQS `yvn-release-notes-failed` holds what gave up after its retries: a
  bounce or complaint the events function could not apply (the SNS message,
  address included, so it never goes to the ops queue), an inbound email
  still failing after two retries (the SES event: addresses and subject,
  never the body, which stays in `raw/`) and a transcribe or describe stream batch
  (shard and sequence numbers only). Kept 14 days; alarm
  `yvn-release-notes-failed-queue` fires on anything in it. Apply a stuck
  bounce by hand; replay an inbound event, once its cause is fixed, by
  invoking the inbound function's `live` alias with
  `{"Records": [<the record>]}`. Then delete the message. Do not assume the
  owner heard: a failure the code caught leaves a `failed` mail log row and,
  on the third try, one email, but a timeout or crash, a failure before the
  address named anyone, a stopped owner or a day's fourth notice leaves no
  email, and the first two no row.
- The describe, transcribe and export functions each run at most two at
  once (reserved concurrency 2, 2026-10-09 audit). Throttled stream batches
  wait and are tried again without using up their retries, and throttled
  async events are tried for up to six hours, so a busy moment is slower,
  not lost.
- The dashboard: stack output `DashboardUrl`. Alarm
  `yvn-release-notes-overdue` fires when anyone's email is over half an hour
  late for two quarter hours (census `Overdue`); a send time moved past
  today's window also trips it, for that day.
- Alarm `yvn-release-notes-signin-total` fires when the hour's sign-in
  emails for everyone (200, `LIMIT_TOTAL` in `packages/backend/auth.ts`) are
  used up, counted from the web function's
  `{"event":"mail-limited","limit":"total"}` log line (renaming it silently
  breaks the alarm): nobody can sign in until the hour turns. The narrower
  limits are checked first and a refused request counts against none, so
  reaching the total takes many networks.

## DNS

DNS for `yourversionnumber.com` is at Namecheap; Jamie applies records by
hand. Read current values from DNS or the stack, never from this repo.

- The stack needs the three DKIM CNAMEs (stack outputs `DkimRecord1-3`), an
  MX on the inbound subdomain to SES inbound, and an MX plus SPF on the MAIL
  FROM subdomain. DMARC is Jamie's own record. All were live on 2026-10-07.
- The root domain's mail is Jamie's Fastmail (MX, SPF and `fm1-3._domainkey`,
  2026-10-08): notes@, postmaster@ and abuse@ reach Jamie. It is separate
  from the stack's records; the root SPF stays Fastmail-only, since SES
  mail's SPF is checked on the MAIL FROM subdomain. In Namecheap, Mail
  Settings stays "Custom MX"; any other choice rewrites the MX records, `in.`
  included.
- The web app adds two records: the ACM validation CNAME for
  `notes.yourversionnumber.com` and `notes` CNAME to the stack output
  `WebDistributionDomain`. The certificate lives outside the stack (an
  in-stack one would hold every deploy until DNS validated); `deploy.sh`
  finds it once ACM says ISSUED and only then attaches the alias.
