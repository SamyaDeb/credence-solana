#!/usr/bin/env bash
# W6 shadow keeper, unattended: runs keeper/src/shadow.ts for one weekend and restarts it after a crash (state.json
# resumes where it stopped), under caffeinate so the Mac stays awake. Read-only: it needs MAINNET_RPC and no key.
# Logs: data/shadow/<closure>/runner.log (process output) and heartbeat.jsonl (one line per tick).
# Usage: nohup scripts/live/shadow.sh 20261009 > /dev/null 2>&1 &
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
CLOSURE="${1:-20261009}"
DIR="data/shadow/$CLOSURE"
LOG="$DIR/runner.log"
mkdir -p "$DIR"
caffeinate -i -w $$ &
if [ ! -x target/release/examples/shadow_quote ]; then
  source scripts/env.sh >> "$LOG" 2>&1
  cargo build -p credence-core --example shadow_quote --release >> "$LOG" 2>&1
fi
while :; do
  echo "$(date -u +%FT%TZ) start shadow $CLOSURE ($(git rev-parse --short HEAD))" >> "$LOG"
  (cd keeper && ./node_modules/.bin/tsx src/shadow.ts --closure "$CLOSURE") >> "$LOG" 2>&1
  code=$?
  echo "$(date -u +%FT%TZ) shadow exited $code" >> "$LOG"
  grep -q '"phase": "done"' "$DIR/summary.json" 2>/dev/null && break
  sleep 30
done
