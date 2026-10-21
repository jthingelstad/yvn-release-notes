#!/usr/bin/env bash
# The release, shared by deploy.sh on the Mac and GitHub Actions
# (.github/workflows/deploy.yml). It deploys a bundle that
# scripts/build-release.sh made from a commit on main; the caller has already
# checked that the commit is main and green. One run releases everything:
#
#   1. upload the code zips, each named by its SHA-256 (tools/native-artifacts.ts)
#   2. one stack update: every function, version and revision of this build,
#      and `live` (each worker alias and each web endpoint) moved to them
#   3. the web endpoints' CloudFront grants (tools/web-platform.ts)
#   4. the inbound mail check and the web app sync
#   5. the probe (tools/release-probe.ts): every worker's self-test, both
#      endpoints' revisions and the API's health through CloudFront
#
# A failed stack update rolls itself back and nothing changed. A failed probe
# leaves the release serving: roll back by reverting the merge, which releases
# the previous code the same way. CloudFormation runs one update at a time, but
# the web sync and the probe come after it: GitHub queues its own releases
# (`production-deploy`), deploy.sh waits for those, and a release whose stack
# another release is updating, or has replaced, stops before syncing the web
# app or probing. So two web syncs can overlap only if a whole stack update
# fits inside one sync's seconds, which a real update never does.
#
#   scripts/release.sh --bundle DIR --commit SHA [--admin-user-id=ID] [--turnstile-mode=MODE]
#   scripts/release.sh --check-arguments [options]   validate, then stop
#
# --admin-user-id and --turnstile-mode are Jamie's settings, the Mac's alone;
# every other release keeps their current values. In GitHub Actions the log is
# public, so cloud identifiers are masked.
set -euo pipefail
export AWS_REGION=us-east-1 AWS_PAGER=""
STACK=yvn-release-notes
REPO=$(cd "$(dirname "$0")/.." && pwd)
ACTIONS=""
[[ "${GITHUB_ACTIONS:-}" == true ]] && ACTIONS=1
refuse() { echo "refusing: $*" >&2; exit 1; }
usage() {
  echo "usage: $0 --bundle DIR --commit SHA [--admin-user-id=ID] [--turnstile-mode=off|observe|enforce|default]" >&2
  exit 2
}

BUNDLE="" COMMIT="" CHECK_ONLY="" BREAK_GLASS=""
ADMIN_USER_ID_SET="" ADMIN_USER_ID="" TURNSTILE_MODE_SET="" TURNSTILE_MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) [[ $# -ge 2 ]] || usage; BUNDLE=$2; shift ;;
    --commit) [[ $# -ge 2 ]] || usage; COMMIT=$2; shift ;;
    --check-arguments) CHECK_ONLY=1 ;;
    # deploy.sh's own flag, accepted here so it can pass its arguments through.
    --break-glass) BREAK_GLASS=1 ;;
    --admin-user-id=*)
      [[ -z "$ADMIN_USER_ID_SET" ]] || { echo "refusing: duplicate administrator assignment" >&2; exit 2; }
      ADMIN_USER_ID_SET=1
      ADMIN_USER_ID="${1#*=}" ;;
    --turnstile-mode=*)
      [[ -z "$TURNSTILE_MODE_SET" ]] || { echo "refusing: duplicate Turnstile mode" >&2; exit 2; }
      TURNSTILE_MODE_SET=1
      TURNSTILE_MODE="${1#*=}" ;;
    *) usage ;;
  esac
  shift
done
if [[ -n "$ADMIN_USER_ID_SET" && -n "$ADMIN_USER_ID" && ! "$ADMIN_USER_ID" =~ ^[A-Za-z0-9_-]{1,80}$ ]]; then
  echo "refusing: the administrator must be a valid subscriber id (empty disables access)" >&2
  exit 2
fi
# "default" clears the mode back to the code's DEFAULT_TURNSTILE_MODE (observe).
if [[ -n "$TURNSTILE_MODE_SET" ]]; then
  [[ "$TURNSTILE_MODE" =~ ^(off|observe|enforce|default)$ ]] \
    || { echo "refusing: the Turnstile mode is one of off, observe, enforce, default" >&2; exit 2; }
  [[ "$TURNSTILE_MODE" == default ]] && TURNSTILE_MODE=""
fi
# These are Jamie's settings and the Mac's escape hatch, never a workflow's.
if [[ -n "$ACTIONS" && ( -n "$BREAK_GLASS" || -n "$ADMIN_USER_ID_SET" || -n "$TURNSTILE_MODE_SET" ) ]]; then
  echo "refusing: --break-glass, --admin-user-id and --turnstile-mode are for deploy.sh on the Mac" >&2
  exit 2
fi
[[ -z "$CHECK_ONLY" ]] || exit 0

[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || usage
[[ -n "$BUNDLE" && -f "$BUNDLE/release/index.js" && -f "$BUNDLE/template.yaml" && -d "$BUNDLE/web" && \
   -f "$BUNDLE/artifacts/manifest.json" ]] || refuse "no complete release bundle at ${BUNDLE:-(none)}"
BUNDLE=$(cd "$BUNDLE" && pwd)
[[ "$(cat "$BUNDLE/commit")" == "$COMMIT" ]] || refuse "the bundle was built from another commit"
NODE_MAJOR=$(cat "$REPO/.node-version")
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "$NODE_MAJOR" ]] \
  || refuse "node is $(node -v), want $NODE_MAJOR"

read -r ACCOUNT ARN < <(aws sts get-caller-identity --query '[Account,Arn]' --output text)
[[ "$ACCOUNT" == 999153317627 ]] || refuse "unexpected AWS account"
if [[ -n "$ACTIONS" ]]; then
  echo "::add-mask::$ACCOUNT"
  # The deploy role only here; tools/release-identity.ts holds the same rule.
  [[ "$ARN" == *:assumed-role/ReleaseNotesGitHubDeploy/* || "$ARN" == *:assumed-role/ProjectsCloudEngineer/* ]] \
    || refuse "unexpected release identity"
else
  [[ "$ARN" == *:assumed-role/ProjectsCloudEngineer/* ]] || refuse "caller is $ARN"
fi
mask() { [[ -z "$ACTIONS" || -z "$1" ]] || echo "::add-mask::$1"; }
RELEASE=(node "$BUNDLE/release/index.js")

rule_arn() {
  local rule_name
  rule_name=$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id "$1" \
    --query StackResourceDetail.PhysicalResourceId --output text)
  aws events describe-rule --name "$rule_name" --query Arn --output text
}
SENDER_SCHEDULE_ARN=$(rule_arn SenderSchedule)
TRANSCRIBE_DONE_ARN=$(rule_arn TranscribeDone)
[[ "$SENDER_SCHEDULE_ARN" == arn:aws:events:us-east-1:"$ACCOUNT":rule/* && \
   "$TRANSCRIBE_DONE_ARN" == arn:aws:events:us-east-1:"$ACCOUNT":rule/* ]] \
  || refuse "worker rules do not belong to this stack's account and region"

CODE_BUCKET="$STACK-code-$ACCOUNT"
if [[ -n "$ACTIONS" ]]; then
  # The deploy role can use the code bucket but not create or reconfigure it.
  aws s3api head-bucket --bucket "$CODE_BUCKET" >/dev/null 2>&1 \
    || refuse "the code bucket is missing; one deploy.sh run on the Mac makes it"
  aws s3api get-bucket-policy --bucket "$CODE_BUCKET" --query Policy --output text | grep -q DenyInsecureTransport \
    || refuse "the code bucket allows plain HTTP; one deploy.sh run on the Mac sets its policy"
else
  if ! aws s3api head-bucket --bucket "$CODE_BUCKET" >/dev/null 2>&1; then
    aws s3api create-bucket --bucket "$CODE_BUCKET" >/dev/null
    aws s3api put-public-access-block --bucket "$CODE_BUCKET" --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws s3api put-bucket-lifecycle-configuration --bucket "$CODE_BUCKET" --lifecycle-configuration \
      '{"Rules":[{"ID":"expire-old-code","Status":"Enabled","Filter":{"Prefix":"code/"},"Expiration":{"Days":90}}]}'
    aws s3api put-bucket-tagging --bucket "$CODE_BUCKET" --tagging \
      'TagSet=[{Key=Application,Value=YourVersionNumber},{Key=Project,Value=yvn-release-notes},{Key=ManagedBy,Value=repository},{Key=Environment,Value=production},{Key=Repository,Value=jthingelstad/yvn-release-notes}]'
  fi
  # Every Mac run, so a bucket made before this has it too: plain HTTP refused,
  # as the stack's buckets do.
  aws s3api put-bucket-policy --bucket "$CODE_BUCKET" --policy "$(printf '%s' \
    '{"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*",' \
    '"Action":"s3:*","Resource":["arn:aws:s3:::'"$CODE_BUCKET"'","arn:aws:s3:::'"$CODE_BUCKET"'/*"],' \
    '"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}')"
fi

WEB_DOMAIN=notes.yourversionnumber.com
WEB_CERT=$(aws acm list-certificates --certificate-statuses ISSUED \
  --query "CertificateSummaryList[?DomainName=='$WEB_DOMAIN'].CertificateArn | [0]" --output text)
[[ "$WEB_CERT" == None ]] && WEB_CERT="" && echo "note: no ISSUED certificate for $WEB_DOMAIN yet; deploying without the alias" >&2
mask "$WEB_CERT"

# Code parameters (AppCode=<sha256> ...), one per zip; the tool checks each
# name and hash, so nothing else can ride along as an override.
CODE_LINE=$("${RELEASE[@]}" upload --artifacts "$BUNDLE/artifacts" --commit "$COMMIT")
read -r -a CODE_PARAMETERS <<< "$CODE_LINE"
for parameter in "${CODE_PARAMETERS[@]}"; do
  [[ "$parameter" =~ ^[A-Z][a-z]+Code=[a-f0-9]{64}$ ]] || refuse "unexpected code parameter"
done
[[ ${#CODE_PARAMETERS[@]} -eq 9 ]] || refuse "expected 9 code zips, got ${#CODE_PARAMETERS[@]}"
echo "code uploaded: ${#CODE_PARAMETERS[@]} zips"

PARAMETER_OVERRIDES=("BuildId=$COMMIT" "${CODE_PARAMETERS[@]}" "WebDomain=$WEB_DOMAIN" "WebCertificateArn=$WEB_CERT"
  "SenderScheduleArn=$SENDER_SCHEDULE_ARN" "TranscribeDoneArn=$TRANSCRIBE_DONE_ARN")
[[ -z "$ADMIN_USER_ID_SET" ]] || PARAMETER_OVERRIDES+=("AdminUserId=$ADMIN_USER_ID")
[[ -z "$TURNSTILE_MODE_SET" ]] || PARAMETER_OVERRIDES+=("TurnstileMode=$TURNSTILE_MODE")

# The template is over CloudFormation's 51,200-byte inline limit, so it goes up
# through the code bucket (expired after 90 days). The stack acts through its
# own service role (infra/github-deploy-role.yaml), whoever deploys.
if ! aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$BUNDLE/template.yaml" \
  --s3-bucket "$CODE_BUCKET" --s3-prefix code/templates \
  --role-arn "arn:aws:iam::$ACCOUNT:role/ReleaseNotesCloudFormation" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${PARAMETER_OVERRIDES[@]}" \
  --tags Application=YourVersionNumber Project=yvn-release-notes ManagedBy=cloudformation \
         Environment=production Repository=jthingelstad/yvn-release-notes; then
  # Which resources failed and why, newest first; the account is masked in CI.
  aws cloudformation describe-stack-events --stack-name "$STACK" --max-items 50 \
    --query "StackEvents[?ends_with(ResourceStatus, '_FAILED')].[Timestamp,LogicalResourceId,ResourceStatusReason]" \
    --output text >&2 || true
  refuse "the stack update failed and rolled back; nothing was released"
fi

"${RELEASE[@]}" policies >/dev/null
echo "endpoint grants confirmed"

ACTIVE=$(aws ses describe-active-receipt-rule-set --query Metadata.Name --output text 2>/dev/null || true)
if [[ -z "$ACTIVE" || "$ACTIVE" == None ]]; then
  if [[ -n "$ACTIONS" ]]; then
    echo "::warning::No SES receipt rule set is active, so replies will not arrive; deploy.sh on the Mac activates it."
  else
    aws ses set-active-receipt-rule-set --rule-set-name "$STACK"
    echo "activated receipt rule set $STACK"
  fi
elif [[ "$ACTIVE" != "$STACK" ]]; then
  echo "WARNING: receipt rule set '$ACTIVE' is active, not $STACK. Replies will not arrive." >&2
fi

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
# The stack's BuildId is the last release's commit. Another release (the Mac's
# while GitHub's ran, say) may be updating the stack, or have updated it since
# ours did. While it updates, wait for the stack to settle, up to 30 minutes:
# if its update rolls back, ours is still live and this run syncs it; if it
# lands, its web app is the one to serve, and its own run syncs it once its
# stack update is done, after ours has synced, and probes it.
still_ours() {
  local status live tries=0
  while :; do
    read -r status live < <(aws cloudformation describe-stacks --stack-name "$STACK" \
      --query "Stacks[0].[StackStatus, Parameters[?ParameterKey=='BuildId'].ParameterValue | [0]]" --output text)
    [[ "$status" == *_IN_PROGRESS ]] || break
    (( ++tries < 120 )) || refuse "$1: another release has been updating the stack for 30 minutes ($status)"
    (( tries > 1 )) || echo "$1: another release is updating the stack ($status); waiting for it to settle"
    sleep 15
  done
  [[ "$live" == "$COMMIT" ]] || refuse "$1: the stack now runs $live, released by another run${2:+; $2}"
}
still_ours "before the web sync"
WEB_BUCKET=$(output WebBucketName)
WEB_DISTRIBUTION=$(output WebDistributionId)
mask "$WEB_BUCKET"
mask "$WEB_DISTRIBUTION"
# The build's script, styles and fonts first, named by their content so they
# never change: cached for good. The bucket holds this build alone; a tab still
# open on an earlier one loads the app again when a page's code is gone
# (main.tsx). Then index.html, which every address serves (the CloudFront
# function) and which revalidates within a minute, and the rest (the Home
# Screen manifest, the icons and the font licences).
WEB="$BUNDLE/web"
aws s3 sync "$WEB/assets/" "s3://$WEB_BUCKET/assets/" --delete --only-show-errors \
  --cache-control 'public, max-age=31536000, immutable'
aws s3 sync "$WEB/" "s3://$WEB_BUCKET/" --delete --only-show-errors --exclude '*' --include '*.html' \
  --cache-control 'public, max-age=60'
aws s3 sync "$WEB/" "s3://$WEB_BUCKET/" --delete --only-show-errors --exclude '*.html' --exclude 'assets/*' \
  --cache-control 'public, max-age=600'
aws cloudfront create-invalidation --distribution-id "$WEB_DISTRIBUTION" --paths '/*' \
  --query Invalidation.Id --output text >/dev/null
echo "web app synced and invalidated"
still_ours "after the web sync" "re-run the newer release so its web app is whole"

"${RELEASE[@]}" probe --commit "$COMMIT" >/dev/null \
  || refuse "$COMMIT is live but failed its probe; revert the merge to roll back"
echo "released $COMMIT"
