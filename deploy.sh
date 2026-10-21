#!/usr/bin/env bash
# Release from the Mac: clean, validated origin/main, built from a git archive
# of HEAD and released by scripts/release.sh, the steps GitHub Actions runs
# too (.github/workflows/deploy.yml). This is the path for GitHub being down,
# and the one place for Jamie's own settings:
#   ./deploy.sh [--break-glass] [--admin-user-id=ID] [--turnstile-mode=MODE]
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-cloud-engineer}"
export AWS_REGION=us-east-1 AWS_PAGER=""
cd "$(dirname "$0")"
[[ "${GITHUB_ACTIONS:-}" != true ]] \
  || { echo "refusing: GitHub Actions releases through scripts/release.sh" >&2; exit 2; }
scripts/release.sh --check-arguments "$@"
BREAK_GLASS=""
for arg in "$@"; do [[ "$arg" != --break-glass ]] || BREAK_GLASS=1; done

read -r ACCOUNT ARN < <(aws sts get-caller-identity --query '[Account,Arn]' --output text)
[[ "$ACCOUNT" == 999153317627 && "$ARN" == *assumed-role/ProjectsCloudEngineer/* ]] \
  || { echo "refusing: caller is $ARN" >&2; exit 1; }

# --break-glass is for GitHub being down, never a red check: it skips only the
# fetch and the check lookups, so HEAD must still be origin/main as last fetched.
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
trap 'rm -rf "$BUILD"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The tree as committed, verified and packaged before anything deploys: a
# file git ignores never ships, and a failed build stops here.
mkdir "$BUILD/repo"
git archive HEAD | tar -x -f - -C "$BUILD/repo"
"$BUILD/repo/scripts/build-release.sh" "$BUILD/repo" "$BUILD/bundle" "$HEAD_SHA" >/dev/null \
  || { echo "archived build or verification failed; not deploying" >&2; exit 1; }
scripts/release.sh --bundle "$BUILD/bundle" --commit "$HEAD_SHA" "$@"
