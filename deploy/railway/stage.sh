#!/usr/bin/env bash
# Assembles the Railway data host's build context (deploy/railway/Dockerfile) in <dir>: only what the read-only jobs need,
# with the prebuilt SDK (its build needs target/idl from `anchor build`) and the repo's data/ as the volume's seed.
# Usage: deploy/railway/stage.sh <dir>     then: cd <dir> && railway up --service credence-data
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: stage.sh <dir>}"
cd "$ROOT"
[ -f packages/sdk/dist/index.js ] || (cd packages/sdk && pnpm build)
rm -rf "$OUT" && mkdir -p "$OUT"
copy() { rsync -a --exclude node_modules "$@"; }
copy --relative Cargo.toml Cargo.lock crates "$OUT/"
rsync -a --relative --exclude tests --exclude 'fixtures' programs "$OUT/"
copy --relative scripts/package.json scripts/pnpm-lock.yaml scripts/src keeper/package.json keeper/pnpm-lock.yaml keeper/src \
  packages/sdk/package.json packages/sdk/pnpm-lock.yaml packages/sdk/dist \
  app/src/lib/scan-summary.ts app/src/lib/site/weekend.ts docs/audit deploy/railway/runner.ts "$OUT/"
mkdir -p "$OUT/seed" && rsync -a --exclude alerts --exclude fork data "$OUT/seed/"
cp deploy/railway/Dockerfile "$OUT/Dockerfile"
git rev-parse --short HEAD > "$OUT/COMMIT"
du -sh "$OUT"
