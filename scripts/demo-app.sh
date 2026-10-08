#!/usr/bin/env bash
# The app on a fresh mainnet fork (task 4.5): starts a surfpool fork of mainnet, deploys credence_core, loads the real
# data (config, sets, gap factors, calendar, vault), funds two demo LPs and opens the next four weekends
# (keeper/src/app-step.ts setup), then builds and serves the app on http://localhost:${PORT:-3000}.
# In the app: Connect → Demo burner wallet → Fund (fork) → Demo mode → Create position → My weekend risk → Buy →
# Demo mode → Friday close → Monday open → Settle. Repeat for the next weekend on the same fork.
#
# Needs only .env (MAINNET_RPC, server side only). Usage: scripts/demo-app.sh      APP_DEV=1 scripts/demo-app.sh (next dev)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source scripts/env.sh
set -a; source .env; set +a
: "${MAINNET_RPC:?set MAINNET_RPC in .env}"
PORT="${PORT:-3000}"
START=$(date +%s)

[ -f target/deploy/credence_core.so ] && [ -f target/idl/credence_core.json ] || anchor build --arch v0
[ -d scripts/node_modules ] || (cd scripts && pnpm install --frozen-lockfile)
[ -d keeper/node_modules ] || (cd keeper && pnpm install --frozen-lockfile)
[ -d app/node_modules ] || (cd app && pnpm install --frozen-lockfile)
SURFPOOL=$(scripts/fork/surfpool.sh)

export RPC_URL=http://127.0.0.1:8899
rpc() { curl -s -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\"}" "$RPC_URL"; }
if [ -n "$(rpc getHealth 2>/dev/null)" ]; then echo "something is already serving $RPC_URL; stop it first" >&2; exit 1; fi
if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is in use; stop it or set PORT" >&2; exit 1; fi
mkdir -p .fork
rm -f .fork/app-demo.json
# The datasource URL holds the API key: pass it through the environment, never on the command line.
SURFPOOL_DATASOURCE_RPC_URL="$MAINNET_RPC" "$SURFPOOL" start --no-tui --no-studio --no-deploy \
  --port 8899 --ws-port 8900 --log-path .fork/surfpool-logs > .fork/surfpool.log 2>&1 &
FORK=$!
cleanup() { kill "$FORK" 2>/dev/null || true; [ -n "${APP:-}" ] && kill "$APP" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
for _ in $(seq 1 60); do rpc getSlot | grep -q result && break; sleep 0.5; done
rpc getSlot | grep -q result || { echo "surfpool did not start; see .fork/surfpool.log" >&2; exit 1; }
echo "fork up (surfpool pid $FORK, $RPC_URL)"

(cd keeper && pnpm -s tsx src/deploy-fork.ts)
(cd scripts && pnpm -s tsx src/load-onchain.ts)
(cd keeper && pnpm -s tsx src/app-step.ts setup)

# The app never sees MAINNET_RPC: only the fork's URL.
export NEXT_PUBLIC_RPC_URL="$RPC_URL"
unset MAINNET_RPC PYTH_API_KEY SURFPOOL_DATASOURCE_RPC_URL
cd app
if [ "${APP_DEV:-0}" = 1 ]; then
  pnpm -s dev -p "$PORT" &
else
  pnpm -s build >/dev/null
  pnpm -s start -p "$PORT" &
fi
APP=$!
for _ in $(seq 1 120); do curl -s -o /dev/null "http://localhost:$PORT/api/fork/status" && break; sleep 0.5; done
echo "fork + data + app ready in $(( $(date +%s) - START )) s: http://localhost:$PORT  (Ctrl-C stops the app and the fork)"
wait "$APP"
