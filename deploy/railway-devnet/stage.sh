#!/usr/bin/env bash
# Assembles the devnet keeper/monitor build context in <dir>. The program on devnet is a devnet-only build at another
# address (its declare_id differs from the repo's), so its IDL is passed in, and assets.json carries the devnet stand-in
# mints (a JSON map ticker → mint, plus USDC) and no Jupiter Lend aliases (Jupiter Lend is not on devnet).
# Usage: deploy/railway-devnet/stage.sh <dir> <devnet IDL json> <mints json>
#        then: cd <dir> && railway up --service keeper   (and --service monitor)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: stage.sh <dir> <idl> <mints>}"; IDL="${2:?idl}"; MINTS="${3:?mints}"
cd "$ROOT"
rm -rf "$OUT" && mkdir -p "$OUT/target/idl"
rsync -a --relative --exclude node_modules scripts/package.json scripts/pnpm-lock.yaml scripts/src keeper/package.json \
  keeper/pnpm-lock.yaml keeper/src deploy/railway-devnet "$OUT/"
rsync -a --exclude alerts --exclude fork --exclude live --exclude shadow data "$OUT/"
cp "$IDL" "$OUT/target/idl/credence_core.json"
python3 - "$OUT/data/onchain/assets.json" "$MINTS" <<'EOF'
import json, sys
p, m = sys.argv[1], json.load(open(sys.argv[2]))
a = json.load(open(p))
for x in a:
    x['mint'] = m[x['ticker']]
    x.pop('jupiter', None)
json.dump(a, open(p, 'w'), indent=1)
EOF
cp deploy/railway-devnet/Dockerfile "$OUT/Dockerfile"
du -sh "$OUT"
