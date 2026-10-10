// Risk numbers for a position, from the program's own rules. Moved from the app (lib/payout.ts, lib/odds.ts) so there is one
// implementation: the app and the widget both read it here.
//   payout = min(cap, max(0, D − ⌊C′ × g⌋)),  g = settle / close rounded UP (WAD), C′ × g rounded DOWN
// ported from credence-core `pricing::realized_payout`, vector-tested against the Rust (test/risk.test.ts).
import type { Connection } from '@solana/web3.js';
import { WAD, pdas } from './core';

const divCeil = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function realizedPayout(coveredValue: bigint, debt: bigint, cap: bigint, closeWad: bigint, settleWad: bigint): bigint {
  if (closeWad <= 0n || settleWad <= 0n) throw new Error('BadPrice');
  const ratio = divCeil(settleWad * WAD, closeWad);
  // gap_factor_at(move, down, 0, 0) = mul_wad_down(base, WAD) = base: the ratio itself.
  const covered = (coveredValue * ratio) / WAD;
  const loss = debt > covered ? debt - covered : 0n;
  return loss < cap ? loss : cap;
}

/** Settlement price for a gap of `bps` basis points from `closeWad` (the loss table's convention). */
export const gapped = (closeWad: bigint, bps: number) => (closeWad * BigInt(10_000 + bps)) / 10_000n;

/** Payout for a hypothetical gap of `bps` from any close (the ratio is all that matters). */
export const payoutAtGap = (coveredValue: bigint, debt: bigint, cap: bigint, bps: number) =>
  realizedPayout(coveredValue, debt, cap, WAD, gapped(WAD, bps));

/** ScenarioSet (zero-copy): 8 discriminator, hash 32, ticker 8, n u16 at 48, …, z: [i16; N_SCEN] at 56, ascending. */
export function decodeScenarioZ(data: Uint8Array): Int16Array {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = v.getUint16(48, true);
  const z = new Int16Array(n);
  for (let i = 0; i < n; i++) z[i] = v.getInt16(56 + 2 * i, true);
  return z;
}

export async function loadScenarioZ(conn: Connection, ticker: string, closureType = 2): Promise<Int16Array> {
  const a = await conn.getAccountInfo(pdas.scen(ticker, closureType));
  if (!a) throw new Error(`no ScenarioSet for ${ticker}`);
  return decodeScenarioZ(a.data);
}

/** Pays iff D > C′ × g, with g = 1 + σ z / 1000 (WAD) floored at 0: D × 1000 × WAD > C′ × max(0, 1000 × WAD + σ z). */
export function modelPays(z: Int16Array, sigmaWad: bigint, coveredValue: bigint, debt: bigint): { count: number; n: number; p: number } {
  let count = 0;
  for (const zi of z) {
    const g = 1000n * WAD + sigmaWad * BigInt(zi);
    if (debt * 1000n * WAD > coveredValue * (g > 0n ? g : 0n)) count++;
    else break; // ascending z: the rest pay nothing
  }
  return { count, n: z.length, p: z.length ? count / z.length : 0 };
}

/** The Monday gaps the widget and the Action show: −5%, −8%, −12% (basis points). */
export const GAP_STEPS_BPS = [-500, -800, -1200] as const;

export type RiskView = {
  debt: bigint;
  coveredValue: bigint;
  /** D / C′ in WAD (1e18 = at the liquidation line), or null when nothing is covered. */
  debtOverCoveredWad: bigint | null;
  /** The share of the asset's weekend scenarios in which the position ends up liquidatable (the policy would pay). */
  pays: { count: number; n: number; p: number };
  /** What a Monday open at each gap would need repaid to stay clear of liquidation (USDC base units). */
  repay: { bps: number; amount: bigint }[];
};

/** Everything the risk table shows, from a position's C′ and D and the asset's scenario set: no arithmetic outside the
 * rules above. */
export function riskView(snap: { coveredValue: bigint; debt: bigint }, z: Int16Array, sigmaWad: bigint): RiskView {
  return {
    debt: snap.debt,
    coveredValue: snap.coveredValue,
    debtOverCoveredWad: snap.coveredValue > 0n ? (snap.debt * WAD) / snap.coveredValue : null,
    pays: modelPays(z, sigmaWad, snap.coveredValue, snap.debt),
    repay: GAP_STEPS_BPS.map((bps) => ({ bps, amount: payoutAtGap(snap.coveredValue, snap.debt, snap.debt, bps) })),
  };
}
