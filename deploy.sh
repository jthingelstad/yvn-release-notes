#!/usr/bin/env bash
# Deploy the Release Notes stack. Runs as the host's cloud-engineer identity;
# never needs a console or SSO login.
#
#   ./deploy.sh                 deploy origin/main, once `validate` is green on it
#   ./deploy.sh --break-glass   skip the GitHub check (GitHub down, never a red check)
#
# 0. Refuse anything but a clean checkout of origin/main with a green
#    `validate` check: production runs only what main's gate passed.
# 1. Package src/ (standard library only, nothing to install) and upload it
#    to the code bucket, keyed by content hash.
# 2. Deploy infra/template.yaml as stack yvn-release-notes.
# 3. Make the stack's receipt rule set the account's active one. SES allows
#    one active set per region; refuse rather than replace someone else's.
# 4. Sync web/ to the web bucket and invalidate the distribution.
#
# The notes.yourversionnumber.com certificate is issued outside the stack, as
# Drop's is: an in-stack certificate would hold the whole deploy until the
# DNS validation record exists. Until ACM says ISSUED the distribution has no
# alias and answers on its cloudfront.net name only.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-cloud-engineer}"
export AWS_REGION=us-east-1 AWS_PAGER=""
STACK=yvn-release-notes
cd "$(dirname "$0")"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ARN=$(aws sts get-caller-identity --query Arn --output text)
[[ "$ACCOUNT" == 999153317627 && "$ARN" == *assumed-role/ProjectsCloudEngineer/* ]] \
  || { echo "refusing: caller is $ARN" >&2; exit 1; }

if [[ "${1:-}" != --break-glass ]]; then
  git fetch -q origin main
  HEAD_SHA=$(git rev-parse HEAD)
  [[ -z "$(git status --porcelain)" ]] || { echo "refusing: uncommitted changes" >&2; exit 1; }
  [[ "$HEAD_SHA" == "$(git rev-parse origin/main)" ]] \
    || { echo "refusing: HEAD is not origin/main; land it through a pull request" >&2; exit 1; }
  GREEN=$(gh api "repos/jthingelstad/yvn-release-notes/commits/$HEAD_SHA/check-runs?check_name=validate" \
    --jq '[.check_runs[] | select(.conclusion == "success")] | length')
  [[ "$GREEN" -gt 0 ]] || { echo "refusing: validate is not green on $HEAD_SHA" >&2; exit 1; }
fi

# The handlers' JSON log lines go to stdout; the test report goes to stderr.
PYTHONPATH=src python3 -m unittest discover -s tests -q >/dev/null \
  || { echo "tests failed; not deploying" >&2; exit 1; }

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

BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
(cd src && find release_notes -name '*.py' | sort | TZ=UTC zip -q -X -D "$BUILD/code.zip" -@)
KEY="code/$(shasum -a 256 "$BUILD/code.zip" | cut -c1-16).zip"
aws s3 cp "$BUILD/code.zip" "s3://$CODE_BUCKET/$KEY" --only-show-errors

WEB_DOMAIN=notes.yourversionnumber.com
WEB_CERT=$(aws acm list-certificates --certificate-statuses ISSUED \
  --query "CertificateSummaryList[?DomainName=='$WEB_DOMAIN'].CertificateArn | [0]" --output text)
[[ "$WEB_CERT" == None ]] && WEB_CERT="" && echo "note: no ISSUED certificate for $WEB_DOMAIN yet; deploying without the alias" >&2

# The template is over CloudFormation's 51,200-byte inline limit, so it
# goes up through the code bucket (expired with the code after 90 days).
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/template.yaml \
  --s3-bucket "$CODE_BUCKET" --s3-prefix code/templates \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "CodeBucket=$CODE_BUCKET" "CodeKey=$KEY" "WebDomain=$WEB_DOMAIN" "WebCertificateArn=$WEB_CERT" \
  --tags Application=YourVersionNumber Project=yvn-release-notes ManagedBy=cloudformation \
         Environment=production Repository=jthingelstad/yvn-release-notes

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
# Pages revalidate within a minute; versioned assets (?v=N) may sit longer.
aws s3 sync web/ "s3://$WEB_BUCKET/" --delete --only-show-errors --exclude '*' --include '*.html' \
  --cache-control 'public, max-age=60'
aws s3 sync web/ "s3://$WEB_BUCKET/" --delete --only-show-errors --exclude '*.html' --exclude '.DS_Store' \
  --cache-control 'public, max-age=600'
aws cloudfront create-invalidation --distribution-id "$(output WebDistributionId)" --paths '/*' \
  --query Invalidation.Id --output text >/dev/null

aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
