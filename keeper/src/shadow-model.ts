// Pure parts of the shadow keeper (W6): account decoders, position valuation, the weekend timeline, and klend's
// liquidation rule. No RPC, no keys; unit-tested in app/test/shadow-model.test.ts.
//
// Units: USD amounts are JS numbers for the logs; anything that goes to the program's pricing (`shadow_quote`) is a
// decimal string of USDC base units (6 decimals) or a WAD price, built here with the program's rounding direction.

/** klend's `Fraction` scale: `_sf` fields are value × 2^60. */
export const SF = 2 ** 60;
export const WAD = 10n ** 18n;

/** Pyth `PriceUpdateV2` (pro-compatible push account): verification level, price, confidence, publish time. */
export function decodePush(d: Buffer) {
  const full = d[40] === 1;
  const o = full ? 41 : 42;
  const expo = d.readInt32LE(o + 48);
  const raw = d.readBigInt64LE(o + 32);
  return {
    full,
    feedId: d.subarray(o, o + 32).toString('hex'),
    price: Number(raw) * 10 ** expo,
    /** WAD, rounded down (expo is −8 for these feeds). */
    priceWad: raw > 0n && expo <= 0 && expo >= -18 ? raw * 10n ** BigInt(18 + expo) : 0n,
    conf: Number(d.readBigUInt64LE(o + 40)) * 10 ** expo,
    confRaw: d.readBigUInt64LE(o + 40),
    priceRaw: raw,
    publishTime: Number(d.readBigInt64LE(o + 52)),
  };
}

/** One Scope `DatedPrice` (chain `chain` of `OraclePrices`): price, its WAD value (rounded down) and Scope's time. */
export function decodeScope(d: Buffer, chain: number) {
  const o = 8 + 32 + chain * 56;
  const value = d.readBigUInt64LE(o);
  const exp = Number(d.readBigUInt64LE(o + 8));
  return {
    price: Number(value) / 10 ** exp,
    priceWad: exp <= 18 ? value * 10n ** BigInt(18 - exp) : 0n,
    ts: Number(d.readBigUInt64LE(o + 24)),
  };
}

/** The weekend's fixed times (Unix seconds), from the XNYS calendar's Friday session and the next one. */
export type Timeline = {
  closureId: number;
  bell: number;
  close: number;
  /** Shield window: from Sunday 20:00 ET (the overnight session) to the deadline, Monday 07:00 ET. */
  shieldStart: number;
  shieldDeadline: number;
  open: number;
  /** Kamino Scope settlement read (`post_settlement`, SCOPE): refreshed in [open + 60 s, open + 6 min]. */
  settleFrom: number;
  settleTo: number;
  /** The shadow run stops logging here (Monday 14:30 UTC for a 13:30 UTC open). */
  end: number;
};

/** Defaults relative to the open: 09:30 ET → 20:00 ET the evening before is 13.5 h, → 07:00 ET is 2.5 h. */
export const SHIELD_START_BEFORE_OPEN = 13.5 * 3600;
export const SHIELD_DEADLINE_BEFORE_OPEN = 2.5 * 3600;

export function timeline(sessions: { date: number; open: number; close: number }[], closureId: number): Timeline {
  const i = sessions.findIndex((s) => s.date === closureId);
  if (i < 0 || i + 1 >= sessions.length) throw new Error(`closure ${closureId} is not a session with a next session`);
  const { close } = sessions[i];
  const { open } = sessions[i + 1];
  return {
    closureId,
    bell: close - 15 * 60,
    close,
    shieldStart: open - SHIELD_START_BEFORE_OPEN,
    shieldDeadline: open - SHIELD_DEADLINE_BEFORE_OPEN,
    open,
    settleFrom: open + 60,
    settleTo: open + 6 * 60,
    end: open + 3600,
  };
}

export type Phase = 'pre-bell' | 'after-bell' | 'weekend' | 'shield-window' | 'pre-market' | 'settlement' | 'post-open' | 'done';

export function phase(t: Timeline, now: number): Phase {
  if (now < t.bell) return 'pre-bell';
  if (now < t.close + 15 * 60) return 'after-bell';
  if (now < t.shieldStart) return 'weekend';
  if (now < t.shieldDeadline) return 'shield-window';
  if (now < t.open) return 'pre-market';
  if (now <= t.settleTo) return 'settlement';
  if (now < t.end) return 'post-open';
  return 'done';
}

/** Shield parameters the shadow run assumes (W1 defaults), recorded in meta.json. WAD strings for `shadow_quote`. */
export const SHIELD = {
  alpha: 0.5,
  buffer: 0.02,
  health: 0.02,
  /** Weekend pushes are deviation-driven (plan/09): a push hours old means the price has stayed inside the band. */
  maxAgeSecs: 36 * 3600,
  maxConfBps: 50,
};
export const toWad = (x: number) => (BigInt(Math.round(x * 1e9)) * 10n ** 9n).toString();

/** Fair value from a push update, or the reason the shield may not use it (W1 checks). */
export function fairValue(p: ReturnType<typeof decodePush>, feedId: string, now: number) {
  if (!p.full) return { ok: false as const, why: 'not Full-verified' };
  if (p.feedId !== feedId) return { ok: false as const, why: 'wrong feed' };
  if (now - p.publishTime > SHIELD.maxAgeSecs) return { ok: false as const, why: `older than ${SHIELD.maxAgeSecs} s` };
  if (p.priceRaw <= 0n) return { ok: false as const, why: 'price ≤ 0' };
  if (p.confRaw * 10_000n > p.priceRaw * BigInt(SHIELD.maxConfBps)) return { ok: false as const, why: 'confidence too wide' };
  return { ok: true as const, priceWad: p.priceWad, price: p.price, publishTime: p.publishTime };
}

/** A position's state at one price: tokens and debt are brought to the present by the caller. */
export type Valued = {
  /** Collateral, USD, at the price used. */
  collateralUsd: number;
  /** C′ = LT × collateral, USD. */
  coveredUsd: number;
  /** Debt (borrow factor 100% for eligible positions), USD. */
  debtUsd: number;
  /** D / C′: ≥ 1 means klend can liquidate (bf-adjusted debt ≥ unhealthy borrow value). */
  ratio: number;
};

export function value(tokens: number, price: number, lt: number, debtUsd: number): Valued {
  const collateralUsd = tokens * price;
  const coveredUsd = collateralUsd * lt;
  return { collateralUsd, coveredUsd, debtUsd, ratio: coveredUsd > 0 ? debtUsd / coveredUsd : Infinity };
}

/** USD → USDC base units as a decimal string. `down` for covered values (C′ rounds DOWN), up for debt. */
export const usdc = (usd: number, round: 'down' | 'up') =>
  BigInt(Math.max(0, round === 'down' ? Math.floor(usd * 1e6) : Math.ceil(usd * 1e6))).toString();

/** klend market and reserve parameters that decide a liquidation. Percentages as plain numbers, bonuses in bps. */
export type LiqParams = {
  /** Market `liquidation_max_debt_close_factor_pct`. */
  closeFactorPct: number;
  /** Market `insolvency_risk_unhealthy_ltv_pct`: at or above this LTV the whole debt can be liquidated. */
  insolvencyLtvPct: number;
  /** Market `min_full_liquidation_value_threshold` (USD): debt below it can be liquidated in full. */
  minFullLiquidationUsd: number;
  /** Market `max_liquidatable_debt_market_value_at_once` (USD). */
  maxAtOnceUsd: number;
  /** Collateral and debt reserve bonuses (bps): min, max, bad-debt. */
  collMinBonusBps: number; collMaxBonusBps: number; collBadDebtBonusBps: number;
  debtMinBonusBps: number; debtMaxBonusBps: number; debtBadDebtBonusBps: number;
  /** Elevation group `max_liquidation_bonus_bps` (0 = none). */
  emodeMaxBonusBps: number;
};

export type Liquidation = {
  bonusBps: number;
  /** Debt a liquidator may repay now, USD. */
  repayUsd: number;
  /** Collateral the liquidator receives, USD and tokens: repay × (1 + bonus), capped at the collateral. */
  seizeUsd: number;
  seizeTokens: number;
  /** Liquidator's gain at the price used, USD. */
  bonusUsd: number;
  full: boolean;
};

/**
 * klend's liquidation rule for a one-collateral, one-borrow obligation, as read from klend source (commit `a087609`,
 * `liquidation_operations.rs`; checked against real klend on LiteSVM in W2):
 * - LTV = debt / collateral value, unhealthy LTV = C′ / collateral value (= the liquidation threshold); liquidatable
 *   when LTV ≥ unhealthy LTV.
 * - bonus = clamp(LTV − unhealthy LTV, max(min bonuses), min(max bonuses, e-mode max)), and never more than keeps the
 *   obligation solvent (1/LTV − 1); at LTV ≥ 100% the bad-debt bonus applies.
 * - repayable = debt × close factor, or all of it when LTV ≥ the insolvency LTV or the debt is under the full
 *   liquidation threshold; capped by the market's at-once limit.
 */
export function liquidation(v: Valued, tokens: number, p: LiqParams): Liquidation | null {
  if (!(v.ratio >= 1) || v.collateralUsd <= 0) return null;
  const ltv = v.debtUsd / v.collateralUsd;
  const unhealthyLtv = v.coveredUsd / v.collateralUsd;
  let bonus: number;
  if (ltv >= 1) {
    bonus = Math.max(p.collBadDebtBonusBps, p.debtBadDebtBonusBps) / 1e4;
  } else {
    const lo = Math.max(p.collMinBonusBps, p.debtMinBonusBps) / 1e4;
    let hi = Math.min(p.collMaxBonusBps, p.debtMaxBonusBps) / 1e4;
    if (p.emodeMaxBonusBps > 0) hi = Math.min(hi, p.emodeMaxBonusBps / 1e4);
    bonus = Math.min(Math.max(ltv - unhealthyLtv, lo), Math.max(hi, lo));
    bonus = Math.min(bonus, 1 / ltv - 1);
  }
  const full = ltv >= p.insolvencyLtvPct / 100 || v.debtUsd < p.minFullLiquidationUsd;
  let repayUsd = full ? v.debtUsd : (v.debtUsd * p.closeFactorPct) / 100;
  if (p.maxAtOnceUsd > 0) repayUsd = Math.min(repayUsd, p.maxAtOnceUsd);
  const seizeUsd = Math.min(repayUsd * (1 + bonus), v.collateralUsd);
  const price = v.collateralUsd / tokens;
  return { bonusBps: Math.round(bonus * 1e4), repayUsd, seizeUsd, seizeTokens: seizeUsd / price, bonusUsd: seizeUsd - repayUsd, full };
}
