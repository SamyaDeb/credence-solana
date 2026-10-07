#!/usr/bin/env bash
# Task 2.6 timer: waits for the Oct 9 close (20:00 UTC) + 2 min, then stores the real Friday close from the recorded
# Pyth push updates (tests/live.rs) and logs to data/live/close-checkpoint.log. Needs record-prices.ts running.
# Usage: nohup scripts/live/close-checkpoint.sh > /dev/null 2>&1 &
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
LOG=data/live/close-checkpoint.log
TARGET=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "2026-10-09T20:02:00" +%s)
echo "$(date -u +%FT%TZ) waiting until 2026-10-09T20:02:00Z" >> "$LOG"
while [ "$(date -u +%s)" -lt "$TARGET" ]; do sleep 30; done
source scripts/env.sh >> "$LOG" 2>&1
echo "$(date -u +%FT%TZ) running live_close" >> "$LOG"
cargo test -p credence-core --test live -- --ignored live_close --nocapture >> "$LOG" 2>&1
echo "$(date -u +%FT%TZ) exit $?" >> "$LOG"
