#!/usr/bin/env bash
# Starts a local mainnet fork with Kamino's xStocks market, our programs, and a USDC-funded probe vault.
# Usage: scripts/fork/start.sh   (reads MAINNET_RPC from .env; ledger in test-ledger/, logs in test-ledger/validator.log)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
set -a; source .env; source scripts/fork/accounts.env; set +a
: "${MAINNET_RPC:?set MAINNET_RPC in .env}"

PROBE_ID=$(solana-keygen pubkey target/deploy/kamino_probe-keypair.json)
CORE_ID=$(solana-keygen pubkey target/deploy/credence_core-keypair.json)
PROBE_AUTH=$(solana find-program-derived-address "$PROBE_ID" string:vault_auth | awk '{print $1}')
PROBE_USDC=$(solana find-program-derived-address ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL \
  pubkey:"$PROBE_AUTH" pubkey:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA pubkey:"$USDC_MINT" | awk '{print $1}')
mkdir -p .fork
(cd scripts && pnpm -s tsx src/make-token-account.ts "$ROOT/.fork/probe-usdc.json" \
  "$PROBE_USDC" "$USDC_MINT" "$PROBE_AUTH" 1000000000000)   # 1,000,000 USDC

SLOT=$(curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' "$MAINNET_RPC" \
  | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["result"])')
echo "probe=$PROBE_ID auth=$PROBE_AUTH usdc=$PROBE_USDC warp_slot=$SLOT"

exec solana-test-validator --reset --quiet --ledger test-ledger --url "$MAINNET_RPC" \
  --warp-slot "$SLOT" \
  --clone-upgradeable-program "$KLEND" --clone-upgradeable-program "$FARMS" \
  --clone "$MARKET" --clone "$SCOPE_PRICES" \
  --clone "$USDC_MINT" --clone "$USDC_RESERVE" --clone "$USDC_SUPPLY_VAULT" \
  --clone "$USDC_DEBT_FARM" --clone "$FARMS_GLOBAL_CONFIG" \
  --clone "$SPYX_MINT" --clone "$SPYX_RESERVE" --clone "$SPYX_SUPPLY_VAULT" \
  --clone "$QQQX_MINT" --clone "$QQQX_RESERVE" --clone "$NVDAX_MINT" --clone "$NVDAX_RESERVE" \
  --clone "$OBLIGATION" --clone "$OBLIGATION_FARM_USER_STATE" \
  --account "$PROBE_USDC" .fork/probe-usdc.json \
  --upgradeable-program "$PROBE_ID" target/deploy/kamino_probe.so "$(solana address)" \
  --upgradeable-program "$CORE_ID" target/deploy/credence_core.so "$(solana address)" \
  "$@"
