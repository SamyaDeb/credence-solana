#!/usr/bin/env bash
# Installs the pinned surfpool (Solana Foundation, v1.6.0) into .tools/ and prints its path. Surfpool is a mainnet fork
# on LiteSVM with an RPC, time travel and account cheatcodes; the demo needs all three.
# Usage: SURFPOOL=$(scripts/fork/surfpool.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION=1.6.0
DIR="$ROOT/.tools/surfpool-$VERSION"
BIN="$DIR/surfpool"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET=surfpool-darwin-arm64.tar.gz; SHA=a890db2b1a0c77340a4cf90c9cfb7b2d30fbeb538120ad20c707426852b18c2d ;;
  Darwin-x86_64) ASSET=surfpool-darwin-x64.tar.gz; SHA= ;;
  Linux-x86_64) ASSET=surfpool-linux-x64.tar.gz; SHA= ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
if [ ! -x "$BIN" ]; then
  mkdir -p "$DIR"
  curl -sSfL -o "$DIR/$ASSET" "https://github.com/solana-foundation/surfpool/releases/download/v$VERSION/$ASSET"
  if [ -n "$SHA" ]; then
    echo "$SHA  $DIR/$ASSET" | shasum -a 256 -c - >&2
  else
    echo "warning: no pinned sha256 for $ASSET; got $(shasum -a 256 "$DIR/$ASSET" | cut -d' ' -f1)" >&2
  fi
  tar -xzf "$DIR/$ASSET" -C "$DIR"
fi
"$BIN" --version >&2
echo "$BIN"
