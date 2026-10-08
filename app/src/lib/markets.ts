// What the Markets page shows per xStock, from accounts on the fork: Kamino's reserve figures (klend Reserve, decoded
// with klend-sdk's codegen), the market's state from credence_core's on-chain XNYS calendar, and the modelled tail gap
// from the asset's on-chain WEEKEND scenario set. Pure functions over decoded accounts; the hooks fetch.
import { PublicKey } from '@solana/web3.js';
import { WAD, view } from './credence';
import type { ReserveState } from './kamino';

/** The USDC reserve of Kamino's xStocks Market: the borrow every Phase 1 position has. */
export const XSTOCKS_USDC_RESERVE = new PublicKey('97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E');
export const XSTOCKS_MARKET = new PublicKey('5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua');

const SF = 2 ** 60;
const ONE_HUNDRED_PCT_BPS = 10_000;
/** klend-sdk's compounding granularity for APR → APY (2 slots/s × 86,400 × 365). */
export const SLOTS_PER_YEAR = 2 * 60 * 60 * 24 * 365;

/** klend-sdk `getBorrowRate`: linear interpolation on the reserve's borrow-rate curve, utilisation capped at 100%. */
export function curveRate(utilisation: number, curve: [number, number][]): number {
  const u = Math.min(utilisation, 1);
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x1 === u) return y1;
    if (u <= x1) {
      const [x0, y0] = curve[i - 1];
      return y0 + ((u - x0) * (y1 - y0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

/** The curve's points up to and including 100% utilisation (klend-sdk `truncateBorrowCurve`), as fractions. */
export function borrowCurve(r: ReserveState): [number, number][] {
  const out: [number, number][] = [];
  for (const p of r.config.borrowRateCurve.points) {
    out.push([p.utilizationRateBps / ONE_HUNDRED_PCT_BPS, p.borrowRateBps / ONE_HUNDRED_PCT_BPS]);
    if (p.utilizationRateBps === ONE_HUNDRED_PCT_BPS) break;
  }
  return out;
}

export const apy = (apr: number) => (1 + apr / SLOTS_PER_YEAR) ** SLOTS_PER_YEAR - 1;

/** A reserve's figures as of its last refresh (klend-sdk `getTotalSupply`, `calculateUtilizationRatio`; the borrow APR
 * is the configured curve at that utilisation plus the host's fixed rate). Token amounts in whole tokens. */
export function reserveFigures(r: ReserveState) {
  const dec = Number(r.liquidity.mintDecimals.toString());
  const unit = 10 ** dec;
  const sf = (x: { toString(): string }) => Number(BigInt(x.toString())) / SF;
  const available = Number(BigInt(r.liquidity.totalAvailableAmount.toString()));
  const borrowed = sf(r.liquidity.borrowedAmountSf);
  const fees = sf(r.liquidity.accumulatedProtocolFeesSf) + sf(r.liquidity.accumulatedReferrerFeesSf) + sf(r.liquidity.pendingReferrerFeesSf);
  const supply = available + borrowed - fees;
  const utilisation = supply > 0 ? borrowed / supply : 0;
  const borrowApr = curveRate(utilisation, borrowCurve(r)) + r.config.hostFixedInterestRateBps / ONE_HUNDRED_PCT_BPS;
  return {
    mint: new PublicKey(r.liquidity.mintPubkey),
    decimals: dec,
    ltPct: r.config.liquidationThresholdPct,
    maxLtvPct: r.config.loanToValuePct,
    supplyTokens: supply / unit,
    borrowedTokens: borrowed / unit,
    depositLimitTokens: Number(BigInt(r.config.depositLimit.toString())) / unit,
    utilisation,
    borrowApr,
    borrowApy: apy(borrowApr),
    /** klend's stored market price (USD per token, scaled fraction) at the last refresh. */
    marketPrice: sf(r.liquidity.marketPriceSf),
    /** Liquidity per collateral token (cToken), as klend converts deposits: total supply / cToken supply. */
    liquidityPerCollateral: Number(BigInt(r.collateral.mintTotalSupply.toString())) > 0 ? supply / Number(BigInt(r.collateral.mintTotalSupply.toString())) : 1,
    lastUpdateSlot: Number(r.lastUpdate.slot.toString()),
  };
}
export type ReserveFigures = ReturnType<typeof reserveFigures>;

export type Session = { date: number; open: number; close: number };

/** credence_core `Calendar` (zero-copy): 8 discriminator, hash 32, venue 8, n u16 at 48, finalized u8, bump u8, pad 4,
 * then sessions at 56, 24 bytes each {date u32, pad u32, open i64, close i64} (UTC seconds, ascending). */
export function decodeCalendar(data: Uint8Array): { venue: string; finalized: boolean; sessions: Session[] } {
  const v = view(data);
  const n = v.getUint16(48, true);
  const sessions: Session[] = [];
  for (let i = 0; i < n; i++) {
    const o = 56 + 24 * i;
    sessions.push({ date: v.getUint32(o, true), open: Number(v.getBigInt64(o + 8, true)), close: Number(v.getBigInt64(o + 16, true)) });
  }
  return { venue: String.fromCharCode(...data.subarray(40, 48)).replace(/\0+$/, ''), finalized: data[50] === 1, sessions };
}

export type MarketState = {
  state: 'open' | 'closed' | 'weekend' | 'holiday' | 'unknown';
  /** The session in progress, or the last one before `now`. */
  last?: Session;
  /** The next session to open. */
  next?: Session;
};

/** Where `now` (chain time) falls on the calendar: in a session, overnight (under a day closed), a plain weekend (two
 * to three days, Friday's close to Monday's open, half days included), or a holiday closure (any other length: a
 * midweek holiday, a long weekend). Beyond the calendar's range the state is unknown. */
export function marketState(sessions: Session[], now: number): MarketState {
  const i = sessions.findIndex((s) => now < s.close);
  if (i < 0) return { state: 'unknown', last: sessions.at(-1) };
  const cur = sessions[i];
  if (now >= cur.open) return { state: 'open', last: cur, next: sessions[i + 1] };
  const prev = sessions[i - 1];
  if (!prev) return { state: 'unknown', next: cur };
  const days = (cur.open - prev.close) / 86_400;
  return { state: days < 1 ? 'closed' : days >= 2 && days <= 3 ? 'weekend' : 'holiday', last: prev, next: cur };
}

/** The next closure longer than a night at or after `now` (a weekend or a holiday): the first session whose following
 * session opens more than a day later. */
export function nextWeekend(sessions: Session[], now: number): { friday: Session; monday: Session } | null {
  for (let i = 0; i + 1 < sessions.length; i++) {
    const s = sessions[i];
    if (s.close < now) continue;
    if ((sessions[i + 1].open - s.close) / 86_400 > 1) return { friday: s, monday: sessions[i + 1] };
  }
  return null;
}

/** The adverse gap at quantile `q` of the asset's WEEKEND scenario set (ascending z, thousandths of σ): σ × z_q / 1000. */
export function tailGap(z: Int16Array, sigmaWad: bigint, q = 0.01): number {
  if (z.length === 0) return 0;
  const k = Math.min(z.length - 1, Math.floor(q * z.length));
  return (Number(sigmaWad) / Number(WAD)) * (z[k] / 1000);
}

/** The reference position the Markets page quotes: $50,000 of USDC debt at D/C′ 0.96, cap = debt (the demo position). */
export const REF_DEBT = 50_000_000_000n;
export const REF_RATIO = 0.96;
export const refCovered = () => BigInt(Math.floor(Number(REF_DEBT) / REF_RATIO));
