#!/usr/bin/env bash
# The release steps, shared by deploy.sh on the Mac and GitHub Actions
# (.github/workflows/deploy.yml and activate.yml). It deploys a bundle that
# scripts/build-release.sh made from a commit on main; the caller has already
# checked that the commit is main and green. This checks who is deploying,
# holds the deploy lock (tools/receipt-store.ts) for the whole run, runs the
# requested native phase, updates the stack through its CloudFormation service
# role, installs origin policies after an HTTP publication and syncs the web app.
#
#   scripts/release.sh --bundle DIR --commit SHA --repo DIR [phase] [options]
#     --native-http-phase=publish|activate|rollback
#     --native-worker-phase=publish|activate|rollback
#         one kind per run, except that both publications may run together
#     --only-changed    publish only artifacts whose content the stack lacks
#     --break-glass, --admin-user-id=ID, --turnstile-mode=MODE: the Mac only
#   scripts/release.sh --check-arguments [phase] [options]   validate, then stop
#
# Ordinary deploys omit native parameter overrides, so CloudFormation keeps the
# current flags, artifact versions and live/rollback pins. In GitHub Actions
# the log is public: identifiers are masked, and the stack outputs and native
# parameters go only to the private log in the receipts bucket (logs/).
set -euo pipefail
export AWS_REGION=us-east-1 AWS_PAGER=""
STACK=yvn-release-notes
REPOSITORY=jthingelstad/yvn-release-notes
ACTIONS=""
[[ "${GITHUB_ACTIONS:-}" == true ]] && ACTIONS=1
refuse() { echo "refusing: $*" >&2; exit 1; }
usage() {
  echo "usage: $0 --bundle DIR --commit SHA --repo DIR [--native-http-phase=publish|activate|rollback]" \
    "[--native-worker-phase=publish|activate|rollback] [--only-changed] [--break-glass]" \
    "[--admin-user-id=ID] [--turnstile-mode=off|observe|enforce|default]" >&2
  exit 2
}

BUNDLE="" COMMIT="" REPO="" CHECK_ONLY="" BREAK_GLASS="" ONLY_CHANGED=""
NATIVE_HTTP_PHASE="" NATIVE_WORKER_PHASE=""
ADMIN_USER_ID_SET="" ADMIN_USER_ID="" TURNSTILE_MODE_SET="" TURNSTILE_MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) [[ $# -ge 2 ]] || usage; BUNDLE=$2; shift ;;
    --commit) [[ $# -ge 2 ]] || usage; COMMIT=$2; shift ;;
    --repo) [[ $# -ge 2 ]] || usage; REPO=$2; shift ;;
    --check-arguments) CHECK_ONLY=1 ;;
    --break-glass) BREAK_GLASS=1 ;;
    --only-changed) ONLY_CHANGED=1 ;;
    --native-http-phase=publish|--native-http-phase=activate|--native-http-phase=rollback)
      [[ -z "$NATIVE_HTTP_PHASE" ]] || { echo "refusing: duplicate native HTTP phase" >&2; exit 2; }
      NATIVE_HTTP_PHASE="${1#*=}" ;;
    --native-worker-phase=publish|--native-worker-phase=activate|--native-worker-phase=rollback)
      [[ -z "$NATIVE_WORKER_PHASE" ]] || { echo "refusing: duplicate native worker phase" >&2; exit 2; }
      NATIVE_WORKER_PHASE="${1#*=}" ;;
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
if [[ -n "$NATIVE_HTTP_PHASE" && -n "$NATIVE_WORKER_PHASE" ]]; then
  [[ "$NATIVE_HTTP_PHASE" == publish && "$NATIVE_WORKER_PHASE" == publish ]] \
    || { echo "refusing: select one native release kind per deployment (only the two publications combine)" >&2; exit 2; }
fi
[[ -z "$ONLY_CHANGED" || "$NATIVE_HTTP_PHASE" == publish || "$NATIVE_WORKER_PHASE" == publish ]] \
  || { echo "refusing: --only-changed applies to a publication" >&2; exit 2; }
if [[ -n "$ADMIN_USER_ID_SET" ]]; then
  [[ "$NATIVE_HTTP_PHASE" == publish && ( -z "$ADMIN_USER_ID" || "$ADMIN_USER_ID" =~ ^[A-Za-z0-9_-]{1,80}$ ) ]] \
    || { echo "refusing: administrator assignment requires native HTTP publication and a valid subscriber id (empty disables access)" >&2; exit 2; }
fi
# The sign-in Turnstile mode rides an HTTP publication, as the admin id does;
# "default" clears it back to the code's DEFAULT_TURNSTILE_MODE (observe).
if [[ -n "$TURNSTILE_MODE_SET" ]]; then
  [[ "$NATIVE_HTTP_PHASE" == publish && "$TURNSTILE_MODE" =~ ^(off|observe|enforce|default)$ ]] \
    || { echo "refusing: Turnstile mode requires native HTTP publication and one of off, observe, enforce, default" >&2; exit 2; }
  [[ "$TURNSTILE_MODE" == default ]] && TURNSTILE_MODE=""
fi
# These are Jamie's settings and the Mac's escape hatch, never a workflow's.
if [[ -n "$ACTIONS" && ( -n "$BREAK_GLASS" || -n "$ADMIN_USER_ID_SET" || -n "$TURNSTILE_MODE_SET" ) ]]; then
  echo "refusing: --break-glass, --admin-user-id and --turnstile-mode are for deploy.sh on the Mac" >&2
  exit 2
fi
[[ -z "$CHECK_ONLY" ]] || exit 0

[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || usage
if [[ -z "$REPO" ]] || ! git -C "$REPO" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  refuse "$COMMIT is not in the repository at ${REPO:-(none)}"
fi
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
RECEIPTS_BUCKET="yvn-rn-deploy-receipts-$ACCOUNT"
WORK=$(mktemp -d)
PRIVATE_LOG="$WORK/release.log"
RELEASE_LOCK=""
private() {
  # Stack details for the record: the Mac's terminal, but never a public log.
  cat >> "$PRIVATE_LOG"
  [[ -n "$ACTIONS" ]] || tail -n "+$((PRIVATE_LINES + 1))" "$PRIVATE_LOG"
  PRIVATE_LINES=$(wc -l < "$PRIVATE_LOG")
}
PRIVATE_LINES=0
cleanup() {
  if [[ -n "$RELEASE_LOCK" ]]; then
    "${RELEASE[@]}" lock release "$RELEASE_LOCK" >/dev/null \
      || echo "WARNING: the deploy lock was not released; inspect locks/deploy.lock in the receipts bucket" >&2
  fi
  if [[ -s "$PRIVATE_LOG" ]]; then
    aws s3api put-object --bucket "$RECEIPTS_BUCKET" --expected-bucket-owner "$ACCOUNT" \
      --key "logs/$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT:0:12}-${GITHUB_RUN_ID:-mac}.log" \
      --body "$PRIVATE_LOG" --server-side-encryption AES256 >/dev/null 2>&1 \
      || echo "note: the private release log was not saved" >&2
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
{
  echo "release of $COMMIT by ${GITHUB_RUN_ID:+GitHub Actions run }${GITHUB_RUN_ID:-the Mac} at $(date -u +%FT%TZ)"
  echo "phases: http=${NATIVE_HTTP_PHASE:-none} workers=${NATIVE_WORKER_PHASE:-none}${ONLY_CHANGED:+ (only changed)}"
} >> "$PRIVATE_LOG"
PRIVATE_LINES=$(wc -l < "$PRIVATE_LOG")

# Every release, CI or Mac, ordinary or native, holds this one lock. A held
# lock means another run, or one that died: look before deleting it, never guess.
RELEASE_LOCK=$("${RELEASE[@]}" lock acquire --commit "$COMMIT")
export RELEASE_LOCK

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

NATIVE_PARAMETER_FILES=()
validate_native_parameters() {
  # Only native keys accepted; an unrelated output cannot override infrastructure.
  node --input-type=module - "${NATIVE_PARAMETER_FILES[@]}" > "$WORK/native-parameters.args" <<'JS'
import { readFile } from 'node:fs/promises';
const names = ['Sender', 'Inbound', 'Events', 'Transcribe', 'Describe', 'Export', 'Capture'];
const allowed = new Set(['NativeWebFunctionsEnabled', 'NativeHttpRouting', 'NativeOriginPoliciesReady', 'NativeWorkersEnabled',
  'NativeWorkerAliasesReady', 'NativeWorkerBuildId', ...['App', 'Mcp'].flatMap(name => ['CodeKey', 'CodeVersion', 'BuildId', 'LiveRevisionId', 'RollbackRevisionId'].map(field => `Native${name}${field}`)),
  ...names.flatMap(name => ['NodeCodeKey', 'NodeCodeVersion', 'NodeCodeSha256', 'NativeLiveVersion'].map(field => name + field))]);
const parameters = new Map();
for (const file of process.argv.slice(2)) {
  const output = JSON.parse(await readFile(file, 'utf8'));
  if (!output || Object.keys(output).length !== 1 || !output.parameters || Array.isArray(output.parameters) || typeof output.parameters !== 'object') throw new Error('Invalid native parameter document');
  for (const [key, value] of Object.entries(output.parameters)) {
    if (!allowed.has(key) || typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid native parameter');
    parameters.set(key, value);
  }
}
if (!parameters.size) throw new Error('Native phase produced no parameters');
for (const [key, value] of [...parameters].sort(([a], [b]) => a.localeCompare(b))) process.stdout.write(`${key}=${value}\0`);
JS
}
stack_parameter() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text
}
validated_on_main() {
  # Only the workflow's own run counts, not any app's check named validate.
  [[ "$(gh api "repos/$REPOSITORY/commits/$1/check-runs?check_name=validate" \
    --jq '[.check_runs[] | select(.conclusion == "success" and .app.slug == "github-actions")] | length')" -gt 0 ]]
}
native_release() {
  local release_build="$COMMIT" parameter_name second_build
  case "$1" in
    promote-http|rollback-http) parameter_name=NativeAppBuildId ;;
    promote-workers|rollback-workers) parameter_name=NativeWorkerBuildId ;;
    *) parameter_name="" ;;
  esac
  # Promotion and rollback act on the published candidate, which may be older
  # than this commit: it must be in main's history and validated there.
  if [[ -n "$parameter_name" ]]; then
    release_build=$(stack_parameter "$parameter_name")
    [[ "$release_build" =~ ^[a-f0-9]{40}$ ]] || refuse "published native candidate has no committed build identity"
    git -C "$REPO" merge-base --is-ancestor "$release_build" "$COMMIT" \
      || refuse "published candidate is not in main's history"
    if [[ "$parameter_name" == NativeAppBuildId ]]; then
      second_build=$(stack_parameter NativeMcpBuildId)
      [[ "$release_build" == "$second_build" ]] || refuse "API and MCP candidates belong to different builds"
    fi
    [[ -n "$BREAK_GLASS" ]] || validated_on_main "$release_build" \
      || refuse "published native candidate was not validated on main"
  fi
  "${RELEASE[@]}" native-release "$1" --commit "$release_build" > "$WORK/native-release-$1.json"
  NATIVE_PARAMETER_FILES+=("$WORK/native-release-$1.json")
  validate_native_parameters
}
artifacts_changed() {
  [[ "$("${RELEASE[@]}" changed --kind "$1" --artifacts "$BUNDLE/artifacts")" == '{"changed":true}' ]]
}
publish_artifacts() {
  "${RELEASE[@]}" artifacts --kind "$1" --artifacts "$BUNDLE/artifacts" --commit "$COMMIT" > "$WORK/artifacts-$1.json"
  NATIVE_PARAMETER_FILES+=("$WORK/artifacts-$1.json")
}

# Only explicit publications upload native code, and only activation or
# rollback moves what serves. --only-changed (GitHub Actions) leaves out a
# kind whose packaged content is what the stack already publishes, so a merge
# that changes no code publishes nothing new.
PUBLISH_HTTP="" PUBLISH_WORKERS=""
if [[ "$NATIVE_HTTP_PHASE" == publish ]]; then
  if [[ -n "$ONLY_CHANGED" ]] && ! artifacts_changed http; then echo "HTTP artifacts unchanged; not publishing them"
  else PUBLISH_HTTP=1; fi
fi
if [[ "$NATIVE_WORKER_PHASE" == publish ]]; then
  if [[ -n "$ONLY_CHANGED" ]] && ! artifacts_changed workers; then echo "worker artifacts unchanged; not publishing them"
  else PUBLISH_WORKERS=1; fi
fi
[[ -z "$PUBLISH_HTTP" ]] || native_release prepare-http
[[ -z "$PUBLISH_WORKERS" ]] || native_release prepare-workers
[[ -z "$PUBLISH_HTTP" ]] || publish_artifacts http
[[ -z "$PUBLISH_WORKERS" ]] || publish_artifacts workers
case "$NATIVE_HTTP_PHASE" in
  activate) native_release promote-http ;;
  rollback) native_release rollback-http ;;
esac
case "$NATIVE_WORKER_PHASE" in
  activate) native_release promote-workers ;;
  rollback) native_release rollback-workers ;;
esac

NATIVE_PARAMETERS=()
if [[ ${#NATIVE_PARAMETER_FILES[@]} -gt 0 ]]; then
  validate_native_parameters
  while IFS= read -r -d '' parameter; do
    NATIVE_PARAMETERS+=("$parameter")
  done < "$WORK/native-parameters.args"
  printf 'native parameter %s\n' "${NATIVE_PARAMETERS[@]}" | private
  echo "native parameters: ${#NATIVE_PARAMETERS[@]} (in the private release log)"
fi

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
  # as the stack's buckets do. Keys are content hashes, never overwritten, so
  # the bucket keeps no versions.
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

PARAMETER_OVERRIDES=("WebDomain=$WEB_DOMAIN" "WebCertificateArn=$WEB_CERT"
  "SenderScheduleArn=$SENDER_SCHEDULE_ARN" "TranscribeDoneArn=$TRANSCRIBE_DONE_ARN")
if [[ -n "$ADMIN_USER_ID_SET" ]]; then
  PARAMETER_OVERRIDES+=("AdminUserId=$ADMIN_USER_ID")
fi
if [[ -n "$TURNSTILE_MODE_SET" ]]; then
  PARAMETER_OVERRIDES+=("TurnstileMode=$TURNSTILE_MODE")
fi
if [[ ${#NATIVE_PARAMETERS[@]} -gt 0 ]]; then
  PARAMETER_OVERRIDES+=("${NATIVE_PARAMETERS[@]}")
fi

# The template is over CloudFormation's 51,200-byte inline limit, so it goes up
# through the code bucket (expired with the code after 90 days). The stack acts
# through its own service role (infra/github-deploy-role.yaml), whoever deploys.
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$BUNDLE/template.yaml" \
  --s3-bucket "$CODE_BUCKET" --s3-prefix code/templates \
  --role-arn "arn:aws:iam::$ACCOUNT:role/ReleaseNotesCloudFormation" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${PARAMETER_OVERRIDES[@]}" \
  --tags Application=YourVersionNumber Project=yvn-release-notes ManagedBy=cloudformation \
         Environment=production Repository=jthingelstad/yvn-release-notes

# Publication establishes private endpoints before any CloudFront origin flip.
# Policy installation/read-back is complete before a separate activation run.
if [[ -n "$PUBLISH_HTTP" ]]; then
  "${RELEASE[@]}" platform policy-install >/dev/null
  "${RELEASE[@]}" platform policy-verify >/dev/null
  echo "origin policies installed and verified"
fi

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

aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text | private
echo "released $COMMIT"
