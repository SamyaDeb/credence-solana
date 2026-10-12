#!/bin/sh
# Devnet keeper and monitor (deploy/railway-devnet): one image, the role picked by ROLE.
#   ROLE=keeper   the keeper loop (keeper/src/index.ts); KEEPER_KEYPAIR holds the keeper's key (a JSON byte array)
#   ROLE=monitor  one monitor pass (scripts/src/monitor.ts), run by Railway's cron; it signs nothing, so its wallet is a
#                 throwaway key made here
# RPC_URL is the devnet endpoint; USDC_MINT the devnet stand-in mint the program was initialised with.
set -e
cd /app
case "$ROLE" in
  keeper)
    [ -n "$KEEPER_KEYPAIR" ] || { echo "KEEPER_KEYPAIR is not set"; exit 1; }
    umask 077
    printf '%s' "$KEEPER_KEYPAIR" > /tmp/keeper.json
    export KEEPER_WALLET=/tmp/keeper.json
    cd keeper && exec node_modules/.bin/tsx src/index.ts
    ;;
  monitor)
    mkdir -p "$HOME/.config/solana"
    [ -f "$HOME/.config/solana/id.json" ] || node -e "const { Keypair } = require('/app/scripts/node_modules/@solana/web3.js'); process.stdout.write(JSON.stringify([...Keypair.generate().secretKey]))" > "$HOME/.config/solana/id.json"
    cd scripts && exec node_modules/.bin/tsx src/monitor.ts
    ;;
  *)
    echo "ROLE must be keeper or monitor"; exit 1
    ;;
esac
