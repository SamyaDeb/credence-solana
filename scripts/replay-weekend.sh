#!/usr/bin/env bash
# W6 real-weekend replay: a fresh surfpool mainnet fork, the program deployed and loaded as in scripts/demo.sh, then
# keeper/src/replay.ts (real Kamino positions covered through a curator book; the genuine captured Scope close, the
# recorded weekend Pyth pushes and the genuine captured Monday open; the keeper closes, shields and settles).
# Fork replay only: mainnet is read through the fork's lazy clone and nothing is ever sent to it.
#
# Usage: scripts/replay-weekend.sh 20261009
#   Reads  data/shadow/<closure>/ (a copy of the shadow folder), data/live/scope, data/live/pyth, data/live/events-*.jsonl
#          (REPLAY_SCOPE_DIR / REPLAY_PYTH_DIR / REPLAY_LIVE_DIR / REPLAY_SHADOW_DIR point at another checkout's copies)
#   Writes data/replay/<closure>/ (replay.json, replay.md); with no Monday-open capture yet: data/replay/<closure>-PLACEHOLDER/
#   REPLAY_OPEN_GAP=-0.08  a SYNTHETIC open, to test the payout path (data/replay/<closure>-SYNTHETIC/)
#   FORK_PORT=8999   KEEP_FORK=1   REPLAY_N=20 (the largest positions by debt, plus every position the shadow flagged)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CLOSURE="${1:-20261009}"
source scripts/env.sh
set -a; source .env; set +a
: "${MAINNET_RPC:?set MAINNET_RPC in .env}"
[ -f "${REPLAY_SHADOW_DIR:-data/shadow/$CLOSURE}/state.json" ] || { echo "no shadow folder: cp -R <shadow checkout>/data/shadow/$CLOSURE data/shadow/" >&2; exit 1; }
if [ ! -f target/deploy/credence_core.so ] || [ ! -f target/idl/credence_core.json ] \
  || [ -n "$(find programs crates -name '*.rs' -newer target/deploy/credence_core.so | head -1)" ]; then
  anchor build --arch v0 --ignore-keys
fi
[ -d scripts/node_modules ] || (cd scripts && pnpm install --frozen-lockfile)
[ -d keeper/node_modules ] || (cd keeper && pnpm install --frozen-lockfile)
SURFPOOL=$(scripts/fork/surfpool.sh)
PORT=${FORK_PORT:-8999}
export RPC_URL=http://127.0.0.1:$PORT REPLAY_CLOSURE="$CLOSURE"
rpc() { curl -s -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\"}" "$RPC_URL"; }
if [ -n "$(rpc getHealth 2>/dev/null)" ]; then echo "something is already serving $RPC_URL; stop it first (or set FORK_PORT)" >&2; exit 1; fi
mkdir -p .fork
# The datasource URL holds the API key: pass it through the environment, never on the command line.
SURFPOOL_DATASOURCE_RPC_URL="$MAINNET_RPC" "$SURFPOOL" start --no-tui --no-studio --no-deploy \
  --port $PORT --ws-port $((PORT + 1)) --log-path .fork/surfpool-logs > .fork/surfpool.log 2>&1 &
FORK=$!
if [ "${KEEP_FORK:-0}" != 1 ]; then trap 'kill $FORK 2>/dev/null' EXIT; fi
for _ in $(seq 1 60); do rpc getSlot | grep -q result && break; sleep 0.5; done
rpc getSlot | grep -q result || { echo "surfpool did not start; see .fork/surfpool.log" >&2; exit 1; }
echo "fork up (surfpool pid $FORK, $RPC_URL)"
(cd keeper && pnpm -s tsx src/deploy-fork.ts)
(cd scripts && pnpm -s tsx src/load-onchain.ts)
(cd keeper && pnpm -s tsx src/pin-klend.ts)
(cd keeper && pnpm -s run replay)
