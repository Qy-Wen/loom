#!/usr/bin/env bash
# Sync pi/packages/durable and packages/codemode together from main (or an explicit ref).
# Run on vendor-clean; native Windows uses sync.mjs directly via pnpm vendor:sync.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec node "$HERE/sync.mjs" "$@"
