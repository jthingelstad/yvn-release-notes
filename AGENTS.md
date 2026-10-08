# Agent guide: yvn-release-notes

**Release Notes** is a daily email from Your Version Number. Each subscriber
gets one email a day whose subject is their version number ("You're 5.2.113
today"). Whatever they reply becomes the release notes for that version.

It is a separate product from `~/Projects/yourversionnumber.com` on purpose.
That site stores nothing, anywhere, ever (its convention 1), and it stays that
way. Everything that stores data lives here.

## Why this is allowed when server-side cards were not

The site's server-side cards were torn down on 2026-09-14 because they were an
unauthenticated public write endpoint holding other people's names and notes.
Release Notes avoids both problems:

- **Every write is authenticated.** Notes only arrive by email, through a reply
  address that names the person and day with 120 random bits, and only from
  the subscriber's own address with a DMARC or aligned DKIM pass.
- **Each subscriber's data is their own.** People keep notes about themselves
  because they asked to.

Keep it that way. Do not add a public endpoint that writes without proving the
caller owns the address it is writing for.

## Shape

```
SES inbound (in.yourversionnumber.com MX)
  -> S3 raw/<messageId>                 the message, untouched
  -> Lambda yvn-release-notes-inbound  token -> person + day, auth checks, text -> DynamoDB

EventBridge, every quarter hour
  -> Lambda yvn-release-notes-sender   anyone whose local send time has come -> one email
```

- `src/release_notes/version.py`: the version arithmetic, ported from the site's
  `computeVersion`. `tests/fixtures/versions.json` is generated from the site's
  own function by `scripts/gen-version-fixtures.mjs` (needs the sibling
  checkout). If the site's arithmetic changes, regenerate and re-test.
- `parse.py`: MIME to note text, quote and signature stripping. Standard
  library only.
- `send.py`, `inbound.py`: the two handlers. `store.py`: the one table and its
  key layout (documented at the top of the file).
- `infra/template.yaml`: the whole stack. `deploy.sh` packages, deploys and
  activates the receipt rule set.

**Standard library only.** No `requirements.txt`; `boto3` comes from the Lambda
runtime and is imported lazily so the tests run without it.

## Rules

- **A note belongs to the day of the email it answers**, not the day it
  arrived. A Thursday reply to Tuesday's email is Tuesday's note.
- **Raw mail is the source of truth.** Phase 1 stores text only. Photos, audio
  and any other attachments stay inside the raw message in S3 (tagged
  `outcome=note`, kept indefinitely) and are listed on the note so a later
  phase can extract them. Never expire `outcome=note` objects. Ignored mail is
  tagged `outcome=ignored` and expires in 30 days.
- **No note text or email addresses in logs.** Log user ids, dates and
  outcomes only.
- **No open or click tracking**, consistent with Jamie's email tracking policy.
- **The email is plain text plus HTML** (`compose.py`). The HTML wears the
  site's birthday front door: cobalt digits, tangerine dots, the three part
  tiles, the ask on a sun-yellow sticky note, its own dark mode. It loads
  **nothing remote**: no images, no web fonts, no stylesheets
  (`tests/test_compose.py` enforces it). Preview by writing `html_body()` to a
  file and screenshotting it; for phone width use a 390px iframe in a wider
  window, since headless Chrome will not lay out below ~500px.
- **No model processing of notes** (summaries, prompts, anything) without an
  explicit opt-in from each subscriber. Jamie, as the operator, can read every
  note. Any privacy copy must say so plainly.
- **Times:** each subscriber has an IANA `tz` and a `send_time` on a quarter
  hour (default 06:00, Jamie 2026-10-07: the email opens the day and replies
  come in through it). The field is per subscriber already; letting people pick
  their own hour is phase 2. The day and the version are computed in their zone.
- Never verify with a write against live data. `sender` takes
  `{"dry_run": true, "now": "<ISO UTC>"}` and writes nothing. `now` is
  refused on a real send: stored times are always the real clock.

## Landing changes

- **Work reaches `main` only through a pull request** (2026-10-07, the same
  model as the clash-royale repos): a branch, `gh pr create --fill`,
  `gh pr merge --auto --rebase --delete-branch`. GitHub merges it once the
  `validate` check is green on a branch up to date with main. The `main`
  ruleset requires that check, rebase merges and linear history, with 0
  approvals and no bypass, Jamie's account included (agents push as it).
- `validate` (`.github/workflows/validate.yml`) runs the workflow lint, the
  unit tests and cfn-lint. Workflows stay SHA-pinned with `permissions: {}`,
  per-job grants and `persist-credentials: false`;
  `sh scripts/test-workflows.sh` checks that. Dependabot moves the pins
  monthly in one PR, which is reviewed like any other: it does not
  auto-merge, because a merged action runs with the repository's token.
- The repository is public. Never commit subscriber data, note text, DNS
  values or anything from the live table or bucket, including in tests and
  fixtures (the tests use a fictional subscriber at example.com).

## Operating

- Deploy: `./deploy.sh` (cloud-engineer profile, us-east-1), from a clean
  checkout of `origin/main` with a green `validate`; it refuses anything
  else (`--break-glass` is for GitHub being down, never a red check). It
  runs the tests again first.
- Tests: `PYTHONPATH=src python3 -m unittest discover -s tests`
- Add a subscriber (phase 1 has no sign-up): `scripts/add_subscriber.py EMAIL YYYY-MM-DD`
- Send someone today's email now, outside their window: invoke the sender
  with `{"send_now": "<user id>"}` (add `"dry_run": true` first to see it).
  Still once per local day; never fake the clock with `now` to do it.
- Alarms go to SNS `yvn-release-notes-alarms`, which is subscribed to the sysadmin
  `projects-ops-alerts` queue. The queue's policy must list the topic.
- DNS for `yourversionnumber.com` is at Namecheap; Jamie applies records by
  hand. The stack needs: the three DKIM CNAMEs (stack outputs `DkimRecord1-3`),
  an MX on the inbound subdomain to SES inbound, and an MX plus SPF on the
  MAIL FROM subdomain. DMARC is Jamie's own record. All were live on
  2026-10-07. Read current values from DNS or the stack, not from this repo.

## Phases

1. **Jamie only, text only** (this): sender, inbound, storage, subscribers added by hand.
2. **Open sign-up** by email (a `mailto:` from the site; the sender's own DKIM
   or a confirmation reply proves the address), STOP/unsubscribe with
   `List-Unsubscribe`, DELETE and EXPORT by email. Bounces pause a subscriber.
3. **Around it:** photos and audio from the raw mail; "on this version last
   year" (5.2.113 is exactly a year after 5.1.113); a yearly "release notes
   for 5.2" collection on the birthday; a web reader behind sign-in by email;
   weather from a home location (Open-Meteo, no key, CC BY 4.0) - ON HOLD,
   Jamie 2026-10-07: "Let's wait to do anything with weather".
