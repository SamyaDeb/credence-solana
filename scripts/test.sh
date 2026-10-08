#!/usr/bin/env bash
# The LiteSVM suite from a clean clone. The real-klend tests (tests/klend.rs, scope.rs, settle.rs) load the mainnet
# klend + farms binaries, which are git-ignored (klend is BUSL-1.1: fetched from mainnet like `--clone` does, never
# committed). With MAINNET_RPC in .env this fetches them once and runs everything; without it, it runs the rest and
# says what it left out.
# Usage: scripts/test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source scripts/env.sh
FIX=programs/credence-core/tests/fixtures/programs
if [ ! -f "$FIX/klend.so" ] || [ ! -f "$FIX/farms.so" ]; then
  if [ -f .env ] && grep -q '^MAINNET_RPC=.' .env; then
    [ -d scripts/node_modules ] || (cd scripts && pnpm install --frozen-lockfile)
    (cd scripts && pnpm -s tsx src/fetch-klend-snapshot.ts --programs-only)
  else
    echo "no MAINNET_RPC in .env: skipping the real-klend tests (tests/klend.rs, scope.rs, settle.rs)" >&2
    TARGETS=()
    for t in programs/credence-core/tests/*.rs; do
      n=$(basename "$t" .rs)
      case "$n" in klend | scope | settle) ;; *) TARGETS+=(--test "$n") ;; esac
    done
    cargo test -p credence-core --lib "${TARGETS[@]}"
    exec cargo test -p credence-risk-core
  fi
fi
cargo test -p credence-core -p credence-risk-core
