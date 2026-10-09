#!/usr/bin/env bash
# Dry run of docs/mainnet-runbook.md on a fresh surfpool fork of mainnet (W6). Never sends anything to mainnet.
# Usage: FORK_PORT=8909 scripts/runbook-dryrun.sh      (needs .env with MAINNET_RPC for the fork's lazy reads)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source scripts/env.sh
set -a; source .env; set +a
: "${MAINNET_RPC:?set MAINNET_RPC in .env}"
if [ ! -f target/deploy/credence_core.so ] || [ -n "$(find programs crates -name '*.rs' -newer target/deploy/credence_core.so | head -1)" ]; then
  anchor build --arch v0 --ignore-keys
fi
[ -d scripts/node_modules ] || (cd scripts && pnpm install --frozen-lockfile)
[ -d keeper/node_modules ] || (cd keeper && pnpm install --frozen-lockfile)
SURFPOOL=$(scripts/fork/surfpool.sh)
PORT=${FORK_PORT:-8899}
export RPC_URL=http://127.0.0.1:$PORT
rpc() { curl -s -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\"}" "$RPC_URL"; }
if [ -n "$(rpc getHealth 2>/dev/null)" ]; then echo "something is already serving $RPC_URL; stop it first" >&2; exit 1; fi
mkdir -p .fork
SURFPOOL_DATASOURCE_RPC_URL="$MAINNET_RPC" "$SURFPOOL" start --no-tui --no-studio --no-deploy \
  --port $PORT --ws-port $((PORT + 1)) --log-path .fork/surfpool-logs > .fork/surfpool.log 2>&1 &
FORK=$!
trap 'kill $FORK 2>/dev/null' EXIT
for _ in $(seq 1 60); do rpc getSlot | grep -q result && break; sleep 0.5; done
unset MAINNET_RPC PYTH_API_KEY
(cd scripts && pnpm -s tsx src/runbook-dryrun.ts)
