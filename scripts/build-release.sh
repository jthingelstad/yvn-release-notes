#!/usr/bin/env bash
# Build a release from a committed tree, with no cloud credentials: install the
# locked packages (none of their install scripts run), verify, then package the
# native artifacts and gather everything scripts/release.sh deploys:
#   OUT/web            the web app (dist/web)
#   OUT/artifacts      native ZIPs and manifest.json, their content hashes
#   OUT/release        the bundled release tools (tools/release-cli.ts)
#   OUT/template.yaml  the stack, and OUT/commit, the commit built
# deploy.sh runs it on a git archive of HEAD; GitHub Actions runs it in a
# build job that holds no credentials (.github/workflows/build-release.yml).
#   scripts/build-release.sh SOURCE_DIR OUT_DIR COMMIT
set -euo pipefail
[[ $# -eq 3 ]] || { echo "usage: $0 SOURCE_DIR OUT_DIR COMMIT" >&2; exit 2; }
SRC=$(cd "$1" && pwd)
OUT=$2
COMMIT=$3
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "refusing: $COMMIT is not a commit" >&2; exit 2; }
[[ ! -e "$OUT" ]] || { echo "refusing: $OUT already exists" >&2; exit 1; }
NODE_MAJOR=$(cat "$SRC/.node-version")
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "$NODE_MAJOR" ]] \
  || { echo "refusing: node is $(node -v), want $NODE_MAJOR" >&2; exit 1; }
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

cd "$SRC"
npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
npm run verify

# Sharp's Linux Arm64 runtime for the describer: the committed lock installed
# again for Linux Arm64 in a separate tree, on any build host. Only Sharp's
# runtime closure is copied; no host binaries or install scripts.
cp package.json package-lock.json "$STAGE/"
(cd "$STAGE" && npm ci --ignore-scripts --omit=dev --os=linux --cpu=arm64 --libc=glibc \
  --no-audit --no-fund --loglevel=error) \
  || { echo "Linux Arm64 runtime staging failed" >&2; exit 1; }
mkdir -p "$STAGE/native-modules/@img"
for package in sharp @img/colour @img/sharp-linux-arm64 @img/sharp-libvips-linux-arm64 detect-libc semver; do
  [[ -d "$STAGE/node_modules/$package" && ! -L "$STAGE/node_modules/$package" ]] \
    || { echo "refusing: missing or linked native runtime package $package" >&2; exit 1; }
  cp -R "$STAGE/node_modules/$package" "$STAGE/native-modules/$package"
done

node --import tsx tools/release-cli.ts package --build-dir "$SRC" \
  --native-modules "$STAGE/native-modules" --out "$OUT/artifacts" >/dev/null
cp -R dist/web "$OUT/web"
cp -R dist/release "$OUT/release"
cp infra/template.yaml "$OUT/template.yaml"
printf '%s\n' "$COMMIT" > "$OUT/commit"
