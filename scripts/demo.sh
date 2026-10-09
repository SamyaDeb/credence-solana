#!/usr/bin/env bash
# One command, one simulated weekend on a mainnet fork (task 3.2): starts a surfpool fork of mainnet,
# deploys credence_core, loads the real data (config, SPYx/QQQx/NVDAx sets, joint set, gap factors, XNYS calendar,
# vault), then keeper/src/demo.ts runs the weekend: LP deposits, epochs, cover on a real near-threshold Kamino
# obligation, queued LP requests, the Friday close from recorded Pyth updates, a simulated gap at the Monday open,
# settlement into the obligation through klend, and the queues. What is simulated is printed at the end and written to
# data/demo/demo-result.json.
#
# Then (W1) keeper/src/twin.ts: the twin positions, the Liquidation Shield, a plain liquidator, settlement.
# Then (W4) keeper/src/multi-demo.ts: a real Sentora SPYx + NVDAx / PYUSD obligation covered, shielded on both legs and
# settled in PYUSD from the vault's sleeve.
#
# Needs only .env (MAINNET_RPC). Usage: scripts/demo.sh        KEEP_FORK=1 scripts/demo.sh  (leave the fork running)
#                                       DEMO_GAP=-0.12 DEMO_OBLIGATION=<pubkey> scripts/demo.sh
#                                       FORK_PORT=8909 scripts/demo.sh   (another fork already on 8899)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source scripts/env.sh
set -a; source .env; set +a
: "${MAINNET_RPC:?set MAINNET_RPC in .env}"
START=$(date +%s)

# Rebuild when the program is missing or older than its sources (audit A-29: a stale build lacks new instructions).
if [ ! -f target/deploy/credence_core.so ] || [ ! -f target/idl/credence_core.json ] \
  || [ -n "$(find programs crates -name '*.rs' -newer target/deploy/credence_core.so | head -1)" ]; then
  anchor build --arch v0 --ignore-keys
fi
[ -d scripts/node_modules ] || (cd scripts && pnpm install --frozen-lockfile)
[ -d keeper/node_modules ] || (cd keeper && pnpm install --frozen-lockfile)
SURFPOOL=$(scripts/fork/surfpool.sh)

PORT=${FORK_PORT:-8899}
export RPC_URL=http://127.0.0.1:$PORT
rpc() { curl -s -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\"}" "$RPC_URL"; }
if rpc getHealth >/dev/null 2>&1 && [ -n "$(rpc getHealth)" ]; then
  echo "something is already serving $RPC_URL; stop it first" >&2
  exit 1
fi
mkdir -p .fork
# The datasource URL holds the API key: pass it through the environment, never on the command line.
SURFPOOL_DATASOURCE_RPC_URL="$MAINNET_RPC" "$SURFPOOL" start --no-tui --no-studio --no-deploy \
  --port $PORT --ws-port $((PORT + 1)) --log-path .fork/surfpool-logs > .fork/surfpool.log 2>&1 &
FORK=$!
if [ "${KEEP_FORK:-0}" != 1 ]; then trap 'kill $FORK 2>/dev/null' EXIT; fi
for _ in $(seq 1 60); do
  rpc getSlot | grep -q result && break
  sleep 0.5
done
rpc getSlot | grep -q result || { echo "surfpool did not start; see .fork/surfpool.log" >&2; exit 1; }
echo "fork up (surfpool pid $FORK, $RPC_URL)"

(cd keeper && pnpm -s tsx src/deploy-fork.ts)
(cd scripts && pnpm -s tsx src/load-onchain.ts)
(cd keeper && pnpm -s demo)
[ "${SKIP_TWIN:-0}" = 1 ] || (cd keeper && pnpm -s twin)
[ "${SKIP_MULTI:-0}" = 1 ] || (cd keeper && pnpm -s run multi-demo)
echo "demo finished in $(( $(date +%s) - START )) s"
if [ "${KEEP_FORK:-0}" = 1 ]; then echo "fork still running (pid $FORK) on $RPC_URL"; fi
