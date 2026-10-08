#!/usr/bin/env bash
# Raw demo-video capture (task 5.3): run against a FRESH scripts/demo-app.sh (vault lifetime numbers start clean).
# Writes docs/video/raw/demo-raw.webm (1920×1080, git-ignored); edit and add voice-over from docs/video/demo-script.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/app"
node scripts/sync-idl.mjs
rm -rf ../docs/video/raw/.playwright
npx playwright test -c playwright.record.config.ts
mkdir -p ../docs/video/raw
mv "$(find ../docs/video/raw/.playwright -name '*.webm' | head -1)" ../docs/video/raw/demo-raw.webm
echo "wrote docs/video/raw/demo-raw.webm"
