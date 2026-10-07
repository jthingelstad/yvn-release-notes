#!/usr/bin/env bash
# Deploy the Release Notes stack. Runs as the host's cloud-engineer identity;
# never needs a console or SSO login.
#
#   ./deploy.sh
#
# 1. Package src/ (standard library only, nothing to install) and upload it
#    to the code bucket, keyed by content hash.
# 2. Deploy infra/template.yaml as stack yvn-release-notes.
# 3. Make the stack's receipt rule set the account's active one. SES allows
#    one active set per region; refuse rather than replace someone else's.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-cloud-engineer}"
export AWS_REGION=us-east-1 AWS_PAGER=""
STACK=yvn-release-notes
cd "$(dirname "$0")"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ARN=$(aws sts get-caller-identity --query Arn --output text)
[[ "$ACCOUNT" == 999153317627 && "$ARN" == *assumed-role/ProjectsCloudEngineer/* ]] \
  || { echo "refusing: caller is $ARN" >&2; exit 1; }

# The handlers' JSON log lines go to stdout; the test report goes to stderr.
PYTHONPATH=src python3 -m unittest discover -s tests -q >/dev/null \
  || { echo "tests failed; not deploying" >&2; exit 1; }

CODE_BUCKET="$STACK-code-$ACCOUNT"
if ! aws s3api head-bucket --bucket "$CODE_BUCKET" 2>/dev/null; then
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

aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file infra/template.yaml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "CodeBucket=$CODE_BUCKET" "CodeKey=$KEY" \
  --tags Application=YourVersionNumber Project=yvn-release-notes ManagedBy=cloudformation \
         Environment=production Repository=jthingelstad/yvn-release-notes

ACTIVE=$(aws ses describe-active-receipt-rule-set --query Metadata.Name --output text 2>/dev/null || true)
if [[ -z "$ACTIVE" || "$ACTIVE" == None ]]; then
  aws ses set-active-receipt-rule-set --rule-set-name "$STACK"
  echo "activated receipt rule set $STACK"
elif [[ "$ACTIVE" != "$STACK" ]]; then
  echo "WARNING: receipt rule set '$ACTIVE' is active, not $STACK. Replies will not arrive." >&2
fi

aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
