#!/usr/bin/env bash
# Sync pi's packages/agent source into vendor-pi-agent/src.
#
# Shallow-clones pi from GitHub at the given ref into a temp dir, copies the
# agent source over, records provenance in UPSTREAM, then cleans up. Does NOT
# require a local pi checkout and does NOT touch any repo you already have.
#
# Usage: sync.sh [ref]          (ref defaults to v0.85.1)
set -euo pipefail

REF="${1:-v0.85.1}"
REPO="https://github.com/earendil-works/pi.git"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "cloning $REPO @ $REF ..."
git clone --depth 1 --branch "$REF" --quiet "$REPO" "$TMP"
UPSTREAM_SHA="$(git -C "$TMP" rev-parse HEAD)"

# Copy source, dropping tests / testing harness / benchmarks to stay lean.
rsync -a --delete \
  --exclude='**/*.test.ts' \
  --exclude='**/testing/**' \
  --exclude='benchmark/**' \
  "$TMP/packages/agent/src/" "$HERE/src/"

# No timestamp: ref + commit fully identify the vendored version, and keeping
# UPSTREAM deterministic makes re-syncing the same version a true no-op.
cat > "$HERE/UPSTREAM" <<EOF
repo: $REPO
directory: packages/agent
ref: $REF
commit: $UPSTREAM_SHA
EOF

echo "synced pi/packages/agent @ $REF ($UPSTREAM_SHA) -> $HERE/src"
