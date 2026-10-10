// Yield vault (W3) as the app shows it, all from the chain:
//   supply rate       klend's current rate on the vault's USDC reserve: the borrow rate on the reserve's own curve at its
//                     utilisation (linear between curve points, klend `BorrowRateCurve::get_borrow_rate`), times the
//                     utilisation, times (1 − protocol take rate). An APR; klend compounds per slot, so the APY is a few
//                     basis points higher.
//   LP APY split      supply rate × lent / NAV  +  premiums of the last settled weekend / NAV × 52  +  the backstop's
//                     realised P&L to date (an amount, not annualised: it comes in lumps).
// The valuation instructions (refresh_reserve + value_yield) go first in any transaction that prices shares while
// USDC is lent, so the program sees this slot's valuation (INV-5).
import { type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { type CoreProgram, pdas } from './core';
import { type ReserveState, decodeReserve, refreshReserveIx } from './kamino';
import type { VaultView } from './vault';

type Curve = { utilizationRateBps: number; borrowRateBps: number }[];

/** klend's borrow rate (fraction per year) at utilisation `u` on `points`, linear between points. */
export function borrowRate(points: Curve, u: number): number {
  const bps = Math.max(0, Math.min(10_000, u * 10_000));
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (bps <= b.utilizationRateBps) {
      const span = b.utilizationRateBps - a.utilizationRateBps;
      const t = span > 0 ? (bps - a.utilizationRateBps) / span : 1;
      return (a.borrowRateBps + t * (b.borrowRateBps - a.borrowRateBps)) / 10_000;
    }
  }
  return points[points.length - 1].borrowRateBps / 10_000;
}

/** Utilisation and supply APR of a klend reserve from its state (as of its last refresh). */
export function supplyRate(r: ReserveState): { utilisation: number; borrowApr: number; supplyApr: number } {
  const avail = Number(r.liquidity.totalAvailableAmount.toString());
  const borrowed = Number(BigInt(r.liquidity.borrowedAmountSf.toString()) >> 60n);
  const u = avail + borrowed > 0 ? borrowed / (avail + borrowed) : 0;
  const points = (r.config.borrowRateCurve.points as { utilizationRateBps: number; borrowRateBps: number }[]).map((p) => ({ utilizationRateBps: Number(p.utilizationRateBps), borrowRateBps: Number(p.borrowRateBps) }));
  const borrowApr = borrowRate(points, u) + Number(r.config.hostFixedInterestRateBps ?? 0) / 10_000;
  const take = Number(r.config.protocolTakeRatePct) / 100;
  return { utilisation: u, borrowApr, supplyApr: borrowApr * u * (1 - take) };
}

const DEFAULT = '11111111111111111111111111111111';

export async function loadYieldReserve(conn: Connection, v: VaultView) {
  if (v.yieldReserve.toBase58() === DEFAULT) return null;
  const a = await conn.getAccountInfo(v.yieldReserve, 'confirmed');
  return a ? { key: v.yieldReserve, state: decodeReserve(a.data as Buffer) } : null;
}

/** refresh_reserve + value_yield, when anything is lent (else nothing). */
export async function valuationIxs(conn: Connection, prog: CoreProgram, v: VaultView): Promise<TransactionInstruction[]> {
  if (v.lentCtokens === 0n) return [];
  const r = await loadYieldReserve(conn, v);
  if (!r) return [];
  const vault = await prog.account.vault.fetch(pdas.vault(), 'confirmed');
  return [
    refreshReserveIx(r.key, r.state),
    await prog.methods.valueYield().accountsPartial({ vault: pdas.vault(), kusdc: vault.kusdc as PublicKey, reserve: r.key }).instruction(),
  ];
}

/** The LP APY split (module docs). `lastWeekendPremium`: net premiums of the last settled weekend, USDC base units. */
export function apySplit(v: VaultView, nav: bigint, supplyApr: number, lastWeekendPremium: bigint) {
  const navN = Number(nav);
  const supply = navN > 0 ? (supplyApr * Number(v.lentValue)) / navN : 0;
  const premiums = navN > 0 ? (Number(lastWeekendPremium) / navN) * 52 : 0;
  return { supply, premiums, total: supply + premiums, lentShare: navN > 0 ? Number(v.lentValue) / navN : 0 };
}
