#!/usr/bin/env bash
# Demo-video capture: run against a FRESH scripts/demo-app.sh (vault lifetime numbers start clean). Records the shots in
# app/e2e-record/demo.spec.ts (1920×1080, real transactions on the fork), then cuts them with app/scripts/cut-demo.mjs:
# waits on transactions are sped up, everything else plays in real time for the voice-over.
# Writes docs/video/raw/demo-raw.webm (the capture), segments.json (the shot marks) and demo.mp4 (the cut, about 2:40).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/app"
node scripts/sync-idl.mjs
rm -rf ../docs/video/raw/.playwright
mkdir -p ../docs/video/raw
npx playwright test -c playwright.record.config.ts
mv "$(find ../docs/video/raw/.playwright -name '*.webm' | head -1)" ../docs/video/raw/demo-raw.webm
node scripts/cut-demo.mjs
