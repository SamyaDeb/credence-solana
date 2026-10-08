// Shadow keeper (W6): the weekend timeline, the fair-value checks, klend's liquidation rule, and the read-only
// guarantee (no signer and no send path anywhere in the shadow files).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SHIELD, decodePush, fairValue, liquidation, phase, timeline, usdc, value, type LiqParams,
} from '../../keeper/src/shadow-model';

const sessions = JSON.parse(readFileSync(new URL('../../data/onchain/calendar-XNYS.json', import.meta.url), 'utf8')).sessions;
const SPYX_FEED = '2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14';

/** A pro-compatible `PriceUpdateV2` (Full) with the given price (expo −8), confidence and publish time. */
function push(price: number, conf: number, publish: number, full = true, feed = SPYX_FEED) {
  const d = Buffer.alloc(134);
  d[40] = full ? 1 : 0;
  const o = full ? 41 : 42;
  Buffer.from(feed, 'hex').copy(d, o);
  d.writeBigInt64LE(BigInt(Math.round(price * 1e8)), o + 32);
  d.writeBigUInt64LE(BigInt(Math.round(conf * 1e8)), o + 40);
  d.writeInt32LE(-8, o + 48);
  d.writeBigInt64LE(BigInt(publish), o + 52);
  return decodePush(d);
}

const KLEND_LIKE: LiqParams = {
  closeFactorPct: 20, insolvencyLtvPct: 95, minFullLiquidationUsd: 2, maxAtOnceUsd: 500_000,
  collMinBonusBps: 200, collMaxBonusBps: 1000, collBadDebtBonusBps: 99,
  debtMinBonusBps: 0, debtMaxBonusBps: 10_000, debtBadDebtBonusBps: 0, emodeMaxBonusBps: 0,
};

describe('shadow timeline (closure 20261009)', () => {
  const t = timeline(sessions, 20261009);
  it('uses the calendar: Friday close 20:00 UTC, Monday open 13:30 UTC, shield window 00:00–11:00 UTC Monday', () => {
    expect(new Date(t.close * 1000).toISOString()).toBe('2026-10-09T20:00:00.000Z');
    expect(new Date(t.bell * 1000).toISOString()).toBe('2026-10-09T19:45:00.000Z');
    expect(new Date(t.shieldStart * 1000).toISOString()).toBe('2026-10-12T00:00:00.000Z'); // Sunday 20:00 ET
    expect(new Date(t.shieldDeadline * 1000).toISOString()).toBe('2026-10-12T11:00:00.000Z'); // Monday 07:00 ET
    expect(new Date(t.open * 1000).toISOString()).toBe('2026-10-12T13:30:00.000Z');
    expect(new Date(t.end * 1000).toISOString()).toBe('2026-10-12T14:30:00.000Z');
  });
  it('phases', () => {
    expect(phase(t, t.bell - 1)).toBe('pre-bell');
    expect(phase(t, t.close)).toBe('after-bell');
    expect(phase(t, t.close + 3600)).toBe('weekend');
    expect(phase(t, t.shieldStart)).toBe('shield-window');
    expect(phase(t, t.shieldDeadline)).toBe('pre-market');
    expect(phase(t, t.open + 61)).toBe('settlement');
    expect(phase(t, t.end)).toBe('done');
  });
  it('rejects a closure that is not a session', () => {
    expect(() => timeline(sessions, 20261010)).toThrow();
  });
});

describe('fair value checks (W1)', () => {
  const now = 1_791_800_000;
  it('accepts a Full, fresh, tight update and returns its WAD price', () => {
    const f = fairValue(push(718.5, 0.3, now - 3600), SPYX_FEED, now);
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.priceWad).toBe(718_500_000_000_000_000_000n);
  });
  it('refuses partial verification, the wrong feed, an old update and a wide confidence', () => {
    expect(fairValue(push(718.5, 0.3, now, false), SPYX_FEED, now).ok).toBe(false);
    expect(fairValue(push(718.5, 0.3, now, true, '00'.repeat(32)), SPYX_FEED, now).ok).toBe(false);
    expect(fairValue(push(718.5, 0.3, now - SHIELD.maxAgeSecs - 1), SPYX_FEED, now).ok).toBe(false);
    expect(fairValue(push(718.5, 718.5 * 0.0051, now), SPYX_FEED, now).ok).toBe(false); // > 50 bps
    expect(fairValue(push(718.5, 718.5 * 0.0049, now), SPYX_FEED, now).ok).toBe(true);
  });
});

describe("klend's liquidation rule (estimate)", () => {
  it('healthy positions are not liquidatable', () => {
    expect(liquidation(value(10, 100, 0.75, 700), 10, KLEND_LIKE)).toBeNull(); // D/C′ 0.933
  });
  it('bonus = LTV − unhealthy LTV clamped to [min, max]; close factor 20%', () => {
    // collateral 1,000, LT 75% → C′ 750; debt 760 → LTV 0.76, unhealthy 0.75 → 1% → clamped to the 2% minimum.
    const l = liquidation(value(10, 100, 0.75, 760), 10, KLEND_LIKE)!;
    expect(l.bonusBps).toBe(200);
    expect(l.repayUsd).toBeCloseTo(152, 6);
    expect(l.seizeUsd).toBeCloseTo(155.04, 6);
    expect(l.seizeTokens).toBeCloseTo(1.5504, 6);
    expect(l.full).toBe(false);
    // debt 900 → LTV 0.90 → 15% → clamped to the 10% maximum; e-mode max 5% caps it further.
    expect(liquidation(value(10, 100, 0.75, 900), 10, KLEND_LIKE)!.bonusBps).toBe(1000);
    expect(liquidation(value(10, 100, 0.75, 900), 10, { ...KLEND_LIKE, emodeMaxBonusBps: 500 })!.bonusBps).toBe(500);
  });
  it('full liquidation at the insolvency LTV or below the small-debt threshold; bad-debt bonus at LTV ≥ 1', () => {
    expect(liquidation(value(10, 100, 0.75, 960), 10, KLEND_LIKE)!.full).toBe(true);
    expect(liquidation(value(0.01, 100, 0.75, 0.9), 0.01, KLEND_LIKE)!.full).toBe(true);
    const bad = liquidation(value(10, 100, 0.75, 1_050), 10, KLEND_LIKE)!;
    expect(bad.bonusBps).toBe(99);
    expect(bad.seizeUsd).toBe(1_000); // capped at the collateral
  });
  it('never pays a bonus that would leave the obligation insolvent (≤ 1/LTV − 1)', () => {
    const l = liquidation(value(10, 100, 0.75, 940), 10, { ...KLEND_LIKE, collMaxBonusBps: 2000, insolvencyLtvPct: 99 })!;
    expect(l.bonusBps).toBe(Math.round((1 / 0.94 - 1) * 1e4));
  });
});

describe('amounts handed to the program pricing', () => {
  it('covered value rounds down, debt rounds up (USDC base units)', () => {
    expect(usdc(1.0000019, 'down')).toBe('1000001');
    expect(usdc(1.0000011, 'up')).toBe('1000002');
    expect(usdc(-3, 'up')).toBe('0');
  });
});

describe('the shadow keeper cannot send a transaction', () => {
  // Code only: comments may name what the file does not do.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  const files = ['shadow.ts', 'shadow-model.ts'].map((f) => code(readFileSync(new URL(`../../keeper/src/${f}`, import.meta.url), 'utf8')));
  it('no signer, wallet or send method appears in the shadow files', () => {
    for (const src of files) {
      for (const bad of [/Keypair/, /\bWallet\b/, /KEEPER_WALLET/, /id\.json/, /sendTransaction/, /sendRawTransaction/, /sendAndConfirm/, /signTransaction/, /\.sign\(/, /simulateTransaction/, /from '\.\/chain/, /requestAirdrop/]) {
        expect(src).not.toMatch(bad);
      }
    }
  });
  it('the RPC wrapper exposes reads only', () => {
    const cls = files[0].slice(files[0].indexOf('class ReadOnlyRpc'), files[0].indexOf('class Quote'));
    const methods = [...cls.matchAll(/^ {2}(?:async )?(\w+)\(/gm)].map((m) => m[1]).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['accounts', 'obligations', 'reserves', 'slot']);
    expect(cls).toMatch(/readonly #c: Connection/); // private: nothing outside the class can reach the Connection
  });
});
