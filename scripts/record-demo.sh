#!/usr/bin/env bash
# Raw demo-video capture (task 5.3): run against a FRESH scripts/demo-app.sh (vault lifetime numbers start clean).
# Writes docs/video/raw/demo-raw.webm (1920×1080, git-ignored); then edit it and add the voice-over.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/app"
node scripts/sync-idl.mjs
rm -rf ../docs/video/raw/.playwright
npx playwright test -c playwright.record.config.ts
mkdir -p ../docs/video/raw
mv "$(find ../docs/video/raw/.playwright -name '*.webm' | head -1)" ../docs/video/raw/demo-raw.webm
echo "wrote docs/video/raw/demo-raw.webm"
