#!/usr/bin/env bash
# Pins the Solana toolchain so a clean clone builds the same binary (plan/07, plan/09 S1).
#
#   source scripts/env.sh        # in a shell, before `anchor build --arch v0`
#   scripts/env.sh               # just check; exits non-zero on a mismatch
#
# Uses Agave 4.3.x from agave-install's release directory when it is not already active, then fails fast unless
# `cargo-build-sbf` reports 4.3.x (platform-tools v1.57, rustc 1.95). Older releases (3.1.x: platform-tools v1.52,
# rustc 1.89) build a different binary and cannot build `risk-core`'s edition-2024 dependencies on 2.x.

REQUIRED_SBF_MINOR="4.3"
_rel="$HOME/.local/share/solana/install/releases/4.3.0/solana-release/bin"

_credence_check() {
  local v
  v=$(cargo-build-sbf --version 2>/dev/null | head -1 | awk '{print $2}')
  case "$v" in
    "$REQUIRED_SBF_MINOR".*) return 0 ;;
  esac
  if [ -x "$_rel/cargo-build-sbf" ]; then
    export PATH="$_rel:$PATH"
    v=$(cargo-build-sbf --version 2>/dev/null | head -1 | awk '{print $2}')
    case "$v" in
      "$REQUIRED_SBF_MINOR".*) return 0 ;;
    esac
  fi
  echo "error: cargo-build-sbf is '${v:-missing}', need $REQUIRED_SBF_MINOR.x." >&2
  echo "       run: agave-install init 4.3.0   (or see plan/07-repo-layout-and-setup.md)" >&2
  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _credence_check || exit 1
  cargo-build-sbf --version
else
  _credence_check
fi
