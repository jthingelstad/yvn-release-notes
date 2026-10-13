#!/usr/bin/env bash
# Release the native Node 24 application from clean, validated origin/main.
# Explicit staged backends: --native-http-phase=publish|activate|rollback and
# --native-worker-phase=publish|activate|rollback. Ordinary deploys verify the
# committed tree and update infrastructure/static assets while preserving native
# artifact/version pins. Protected native source versions never expire.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-cloud-engineer}"
export AWS_REGION=us-east-1 AWS_PAGER=""
STACK=yvn-release-notes
cd "$(dirname "$0")"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ARN=$(aws sts get-caller-identity --query Arn --output text)
[[ "$ACCOUNT" == 999153317627 && "$ARN" == *assumed-role/ProjectsCloudEngineer/* ]] \
  || { echo "refusing: caller is $ARN" >&2; exit 1; }

BREAK_GLASS=""
NATIVE_HTTP_PHASE=""
NATIVE_WORKER_PHASE=""
ADMIN_USER_ID_SET=""
ADMIN_USER_ID=""
for arg in "$@"; do
  case "$arg" in
    --break-glass) BREAK_GLASS=1 ;;
    --native-http-phase=publish|--native-http-phase=activate|--native-http-phase=rollback)
      [[ -z "$NATIVE_HTTP_PHASE" ]] || { echo "refusing: duplicate native HTTP phase" >&2; exit 2; }
      NATIVE_HTTP_PHASE="${arg#*=}" ;;
    --native-worker-phase=publish|--native-worker-phase=activate|--native-worker-phase=rollback)
      [[ -z "$NATIVE_WORKER_PHASE" ]] || { echo "refusing: duplicate native worker phase" >&2; exit 2; }
      NATIVE_WORKER_PHASE="${arg#*=}" ;;
    --admin-user-id=*)
      [[ -z "$ADMIN_USER_ID_SET" ]] || { echo "refusing: duplicate administrator assignment" >&2; exit 2; }
      ADMIN_USER_ID_SET=1
      ADMIN_USER_ID="${arg#*=}" ;;
    *) echo "usage: $0 [--break-glass] [--native-http-phase=publish|activate|rollback] [--native-worker-phase=publish|activate|rollback] [--admin-user-id=ID]" >&2; exit 2 ;;
  esac
done
[[ -z "$NATIVE_HTTP_PHASE" || -z "$NATIVE_WORKER_PHASE" ]] \
  || { echo "refusing: select one native release kind per deployment" >&2; exit 2; }
if [[ -n "$ADMIN_USER_ID_SET" ]]; then
  [[ "$NATIVE_HTTP_PHASE" == publish && ( -z "$ADMIN_USER_ID" || "$ADMIN_USER_ID" =~ ^[A-Za-z0-9_-]{1,80}$ ) ]] \
    || { echo "refusing: administrator assignment requires native HTTP publication and a valid subscriber id (empty disables access)" >&2; exit 2; }
fi
[[ -n "$BREAK_GLASS" ]] || git fetch -q origin main
HEAD_SHA=$(git rev-parse HEAD)
[[ -z "$(git status --porcelain)" ]] || { echo "refusing: uncommitted changes" >&2; exit 1; }
[[ "$HEAD_SHA" == "$(git rev-parse origin/main)" ]] \
  || { echo "refusing: HEAD is not origin/main; land it through a pull request" >&2; exit 1; }
if [[ -z "$BREAK_GLASS" ]]; then
  # Only the workflow's own run counts, not any app's check named validate.
  GREEN=$(gh api "repos/jthingelstad/yvn-release-notes/commits/$HEAD_SHA/check-runs?check_name=validate" \
    --jq '[.check_runs[] | select(.conclusion == "success" and .app.slug == "github-actions")] | length')
  [[ "$GREEN" -gt 0 ]] || { echo "refusing: validate is not green on $HEAD_SHA" >&2; exit 1; }
fi

# Build with the Node that CI uses (.node-version). This Mac's default node
# can be newer; Homebrew's node@<major> is used when it is installed.
NODE_MAJOR=$(cat .node-version)
[[ -d "/opt/homebrew/opt/node@$NODE_MAJOR/bin" ]] && PATH="/opt/homebrew/opt/node@$NODE_MAJOR/bin:$PATH"
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "$NODE_MAJOR" ]] \
  || { echo "refusing: node is $(node -v), want $NODE_MAJOR (brew install node@$NODE_MAJOR)" >&2; exit 1; }

BUILD=$(mktemp -d)
DEPLOY_LOCK=""
cleanup() {
  rm -rf "$BUILD"
  if [[ -n "$DEPLOY_LOCK" ]]; then
    rm -f "$DEPLOY_LOCK/pid"
    rmdir "$DEPLOY_LOCK" || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
NATIVE_RECEIPT_DIR=/Users/otto/.codex/tmp/yvn-native-release-receipts
# All deployment phases share this ownership lock, including ordinary releases.
# A stale lock requires operator investigation; never guess that another run died.
node --input-type=module - "$NATIVE_RECEIPT_DIR" <<'JS'
import { mkdir, realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
const dir = process.argv[2];
await mkdir(dir, { recursive: true, mode: 0o700 });
const actual = await realpath(dir), repo = await realpath('.'), within = relative(repo, actual), info = await stat(actual);
if (!isAbsolute(dir) || within === '' || (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within)) ||
    (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('Deployment receipts must be private, owned and outside the repository');
JS
if ! mkdir -m 700 "$NATIVE_RECEIPT_DIR/deploy.lock" 2>/dev/null; then
  echo "refusing: another deployment owns $NATIVE_RECEIPT_DIR/deploy.lock (inspect a stale lock before removing it)" >&2
  exit 1
fi
DEPLOY_LOCK="$NATIVE_RECEIPT_DIR/deploy.lock"
printf '%s\n' "$$" > "$DEPLOY_LOCK/pid"
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
  || { echo "refusing: worker rules do not belong to this stack's account and region" >&2; exit 1; }

# The web app as committed, built before anything deploys: a file git
# ignores never reaches the bucket, and a build that fails stops here.
# The lockfile pins every package; none of their install scripts run.
mkdir "$BUILD/repo"
git archive HEAD | tar -x -f - -C "$BUILD/repo"
(cd "$BUILD/repo" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run verify >/dev/null) \
  || { echo "archived web/server verification failed; not deploying" >&2; exit 1; }
# Only explicit publication phases upload native code. Ordinary deployments
# omit native parameter overrides, so CloudFormation preserves previous flags,
# artifact versions and live/rollback pins instead of serving this fresh build.
NATIVE_PARAMETER_FILES=()
validate_native_parameters() {
  # Only native keys accepted; an unrelated output cannot override infrastructure.
  node --input-type=module - "${NATIVE_PARAMETER_FILES[@]}" > "$BUILD/native-parameters.args" <<'JS'
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
native_release() {
  local release_build="$HEAD_SHA" parameter_name second_build
  case "$1" in
    promote-http|rollback-http) parameter_name=NativeAppBuildId ;;
    promote-workers|rollback-workers) parameter_name=NativeWorkerBuildId ;;
    *) parameter_name="" ;;
  esac
  if [[ -n "$parameter_name" ]]; then
    release_build=$(aws cloudformation describe-stacks --stack-name "$STACK" \
      --query "Stacks[0].Parameters[?ParameterKey=='$parameter_name'].ParameterValue | [0]" --output text)
    [[ "$release_build" =~ ^[a-f0-9]{40}$ ]] \
      || { echo "refusing: published native candidate has no committed build identity" >&2; exit 1; }
    git merge-base --is-ancestor "$release_build" "$HEAD_SHA" \
      || { echo "refusing: published candidate is not in main's history" >&2; exit 1; }
    if [[ "$parameter_name" == NativeAppBuildId ]]; then
      second_build=$(aws cloudformation describe-stacks --stack-name "$STACK" \
        --query "Stacks[0].Parameters[?ParameterKey=='NativeMcpBuildId'].ParameterValue | [0]" --output text)
      [[ "$release_build" == "$second_build" ]] \
        || { echo "refusing: API and MCP candidates belong to different builds" >&2; exit 1; }
    fi
    if [[ -z "$BREAK_GLASS" ]]; then
      local candidate_green
      candidate_green=$(gh api "repos/jthingelstad/yvn-release-notes/commits/$release_build/check-runs?check_name=validate" \
        --jq '[.check_runs[] | select(.conclusion == "success" and .app.slug == "github-actions")] | length')
      [[ "$candidate_green" -gt 0 ]] \
        || { echo "refusing: published native candidate was not validated on main" >&2; exit 1; }
    fi
  fi
  (cd "$BUILD/repo" && node --import tsx tools/native-release.ts "$1" \
    --receipt-dir "$NATIVE_RECEIPT_DIR" --commit "$release_build") > "$BUILD/native-release.json"
  NATIVE_PARAMETER_FILES+=("$BUILD/native-release.json")
  validate_native_parameters
}
if [[ "$NATIVE_HTTP_PHASE" == publish ]]; then
  native_release prepare-http
  (cd "$BUILD/repo" && node --import tsx tools/native-artifacts.ts --kind http \
    --build-dir "$BUILD/repo" --receipt-dir "$NATIVE_RECEIPT_DIR" --commit "$HEAD_SHA") > "$BUILD/native-artifacts.json"
  NATIVE_PARAMETER_FILES+=("$BUILD/native-artifacts.json")
elif [[ "$NATIVE_HTTP_PHASE" == activate ]]; then
  native_release promote-http
elif [[ "$NATIVE_HTTP_PHASE" == rollback ]]; then
  native_release rollback-http
elif [[ "$NATIVE_WORKER_PHASE" == publish ]]; then
  native_release prepare-workers
  # The committed lock is installed again in a separate Linux Arm64 tree.
  # Only Sharp's runtime closure is copied; no host binaries or install scripts.
  mkdir "$BUILD/linux-arm64"
  cp "$BUILD/repo/package.json" "$BUILD/repo/package-lock.json" "$BUILD/linux-arm64/"
  (cd "$BUILD/linux-arm64" && npm ci --ignore-scripts --omit=dev --os=linux --cpu=arm64 --libc=glibc \
    --no-audit --no-fund --loglevel=error) \
    || { echo "Linux Arm64 runtime staging failed; not deploying" >&2; exit 1; }
  mkdir -p "$BUILD/native-modules/@img"
  for package in sharp @img/colour @img/sharp-linux-arm64 @img/sharp-libvips-linux-arm64 detect-libc semver; do
    [[ -d "$BUILD/linux-arm64/node_modules/$package" && ! -L "$BUILD/linux-arm64/node_modules/$package" ]] \
      || { echo "refusing: missing or linked native runtime package $package" >&2; exit 1; }
    cp -R "$BUILD/linux-arm64/node_modules/$package" "$BUILD/native-modules/$package"
  done
  (cd "$BUILD/repo" && node --import tsx tools/native-artifacts.ts --kind workers \
    --build-dir "$BUILD/repo" --native-modules "$BUILD/native-modules" \
    --receipt-dir "$NATIVE_RECEIPT_DIR" --commit "$HEAD_SHA") > "$BUILD/native-artifacts.json"
  NATIVE_PARAMETER_FILES+=("$BUILD/native-artifacts.json")
elif [[ "$NATIVE_WORKER_PHASE" == activate ]]; then
  native_release promote-workers
elif [[ "$NATIVE_WORKER_PHASE" == rollback ]]; then
  native_release rollback-workers
fi

NATIVE_PARAMETERS=()
if [[ ${#NATIVE_PARAMETER_FILES[@]} -gt 0 ]]; then
  validate_native_parameters
  while IFS= read -r -d '' parameter; do
    NATIVE_PARAMETERS+=("$parameter")
  done < "$BUILD/native-parameters.args"
fi

CODE_BUCKET="$STACK-code-$ACCOUNT"
if ! aws s3api head-bucket --bucket "$CODE_BUCKET" >/dev/null 2>&1; then
  aws s3api create-bucket --bucket "$CODE_BUCKET" >/dev/null
  aws s3api put-public-access-block --bucket "$CODE_BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-lifecycle-configuration --bucket "$CODE_BUCKET" --lifecycle-configuration \
    '{"Rules":[{"ID":"expire-old-code","Status":"Enabled","Filter":{"Prefix":"code/"},"Expiration":{"Days":90}}]}'
  aws s3api put-bucket-tagging --bucket "$CODE_BUCKET" --tagging \
    'TagSet=[{Key=Application,Value=YourVersionNumber},{Key=Project,Value=yvn-release-notes},{Key=ManagedBy,Value=repository},{Key=Environment,Value=production},{Key=Repository,Value=jthingelstad/yvn-release-notes}]'
fi
# Every run, so a bucket made before this has it too: plain HTTP refused, as
# the stack's buckets do. Keys are content hashes, never overwritten, so the
# bucket keeps no versions.
aws s3api put-bucket-policy --bucket "$CODE_BUCKET" --policy "$(printf '%s' \
  '{"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*",' \
  '"Action":"s3:*","Resource":["arn:aws:s3:::'"$CODE_BUCKET"'","arn:aws:s3:::'"$CODE_BUCKET"'/*"],' \
  '"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}')"

WEB="$BUILD/repo/dist/web"
WEB_DOMAIN=notes.yourversionnumber.com
WEB_CERT=$(aws acm list-certificates --certificate-statuses ISSUED \
  --query "CertificateSummaryList[?DomainName=='$WEB_DOMAIN'].CertificateArn | [0]" --output text)
[[ "$WEB_CERT" == None ]] && WEB_CERT="" && echo "note: no ISSUED certificate for $WEB_DOMAIN yet; deploying without the alias" >&2

PARAMETER_OVERRIDES=("WebDomain=$WEB_DOMAIN" "WebCertificateArn=$WEB_CERT"
  "SenderScheduleArn=$SENDER_SCHEDULE_ARN" "TranscribeDoneArn=$TRANSCRIBE_DONE_ARN")
if [[ -n "$ADMIN_USER_ID_SET" ]]; then
  PARAMETER_OVERRIDES+=("AdminUserId=$ADMIN_USER_ID")
fi
if [[ ${#NATIVE_PARAMETERS[@]} -gt 0 ]]; then
  PARAMETER_OVERRIDES+=("${NATIVE_PARAMETERS[@]}")
fi

# The template is over CloudFormation's 51,200-byte inline limit, so it
# goes up through the code bucket (expired with the code after 90 days).
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$BUILD/repo/infra/template.yaml" \
  --s3-bucket "$CODE_BUCKET" --s3-prefix code/templates \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${PARAMETER_OVERRIDES[@]}" \
  --tags Application=YourVersionNumber Project=yvn-release-notes ManagedBy=cloudformation \
         Environment=production Repository=jthingelstad/yvn-release-notes

# Publication establishes private endpoints before any CloudFront origin flip.
# Policy installation/read-back is complete before a separate activation run.
if [[ "$NATIVE_HTTP_PHASE" == publish ]]; then
  (cd "$BUILD/repo" && node --import tsx tools/web-platform.ts policy-install --receipt-dir "$NATIVE_RECEIPT_DIR")
  (cd "$BUILD/repo" && node --import tsx tools/web-platform.ts policy-verify --receipt-dir "$NATIVE_RECEIPT_DIR")
fi

ACTIVE=$(aws ses describe-active-receipt-rule-set --query Metadata.Name --output text 2>/dev/null || true)
if [[ -z "$ACTIVE" || "$ACTIVE" == None ]]; then
  aws ses set-active-receipt-rule-set --rule-set-name "$STACK"
  echo "activated receipt rule set $STACK"
elif [[ "$ACTIVE" != "$STACK" ]]; then
  echo "WARNING: receipt rule set '$ACTIVE' is active, not $STACK. Replies will not arrive." >&2
fi

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
WEB_BUCKET=$(output WebBucketName)
# The build's script, styles and fonts first, named by their content so
# they never change: cached for good. The bucket holds this build alone; a
# tab still open on an earlier one loads the app again when a page's code
# is gone (main.tsx). Then index.html, which every address serves (the
# CloudFront function) and which revalidates within a minute, and the rest
# (the Home Screen manifest, the icons and the font licences).
aws s3 sync "$WEB/assets/" "s3://$WEB_BUCKET/assets/" --delete --only-show-errors \
  --cache-control 'public, max-age=31536000, immutable'
aws s3 sync "$WEB/" "s3://$WEB_BUCKET/" --delete --only-show-errors --exclude '*' --include '*.html' \
  --cache-control 'public, max-age=60'
aws s3 sync "$WEB/" "s3://$WEB_BUCKET/" --delete --only-show-errors --exclude '*.html' --exclude 'assets/*' \
  --cache-control 'public, max-age=600'
aws cloudfront create-invalidation --distribution-id "$(output WebDistributionId)" --paths '/*' \
  --query Invalidation.Id --output text >/dev/null

aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
