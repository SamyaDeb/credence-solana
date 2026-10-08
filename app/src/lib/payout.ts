// The Phase 1 payout rule (plan/02 §2), ported from credence-core `pricing::realized_payout` for the loss table:
//   payout = min(cap, max(0, D − ⌊C′ × g⌋)),  g = settle / close rounded UP (WAD), C′ × g rounded DOWN
// with risk-core's gap factor at d = 0, κ = 0 (g is the ratio itself). Every operation is the Rust one on bigints;
// test/payout-golden.test.ts checks it against vectors written by programs/credence-core/tests/golden_app.rs.
import { WAD } from './credence';

const divCeil = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function realizedPayout(coveredValue: bigint, debt: bigint, cap: bigint, closeWad: bigint, settleWad: bigint): bigint {
  if (closeWad <= 0n || settleWad <= 0n) throw new Error('BadPrice');
  const ratio = divCeil(settleWad * WAD, closeWad);
  // gap_factor_at(move, down, 0, 0) = mul_wad_down(base, WAD) = base, with base = 1 + move (up) or 1 − move (down,
  // move = 1 − ratio ≤ 1 so no saturation): the ratio itself.
  const g = ratio;
  const covered = (coveredValue * g) / WAD;
  const loss = debt > covered ? debt - covered : 0n;
  return loss < cap ? loss : cap;
}

/** Settlement price for a gap of `bps` basis points from `closeWad` (the loss table's convention). */
export const gapped = (closeWad: bigint, bps: number) => (closeWad * BigInt(10_000 + bps)) / 10_000n;

/** Payout for a hypothetical gap of `bps` from any close (the ratio is all that matters). */
export const payoutAtGap = (coveredValue: bigint, debt: bigint, cap: bigint, bps: number) =>
  realizedPayout(coveredValue, debt, cap, WAD, gapped(WAD, bps));
