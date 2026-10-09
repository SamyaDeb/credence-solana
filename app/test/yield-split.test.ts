// W3: klend's borrow-rate curve and the supply rate the app shows, and the APY split.
import { describe, expect, it } from 'vitest';
import { apySplit, borrowRate } from '@/lib/yield';

const CURVE = [
  { utilizationRateBps: 0, borrowRateBps: 0 }, { utilizationRateBps: 8_000, borrowRateBps: 800 },
  { utilizationRateBps: 9_000, borrowRateBps: 2_000 }, { utilizationRateBps: 10_000, borrowRateBps: 10_000 },
];

describe('yield vault figures', () => {
  it('interpolates klend\'s curve linearly between points and clamps at its ends', () => {
    expect(borrowRate(CURVE, 0)).toBe(0);
    expect(borrowRate(CURVE, 0.4)).toBeCloseTo(0.04, 12);
    expect(borrowRate(CURVE, 0.85)).toBeCloseTo(0.14, 12);
    expect(borrowRate(CURVE, 0.9021)).toBeCloseTo(0.2 + 0.021 * 0.8, 10); // 2.1% of the way from 20% to 100%
    expect(borrowRate(CURVE, 1.5)).toBe(1);
  });

  it('splits LP APY into supply and premiums on NAV', () => {
    const v = { lentValue: 1_500_000_000_000n } as never;
    const s = apySplit(v, 2_000_000_000_000n, 0.0442, 1_400_000_000n);
    expect(s.lentShare).toBeCloseTo(0.75, 12);
    expect(s.supply).toBeCloseTo(0.0442 * 0.75, 12);
    expect(s.premiums).toBeCloseTo((1_400 / 2_000_000) * 52, 12);
    expect(s.total).toBeCloseTo(s.supply + s.premiums, 12);
  });
});
