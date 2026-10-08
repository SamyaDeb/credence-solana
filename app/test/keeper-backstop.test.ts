// W2: the keeper's auction price equals the program's (risk-core `dutch_price`, rounded up for the buyer), so a buy
// sent with the keeper's price as max_price never fails on PriceAboveMax; and the health test it uses to decide a
// liquidation is klend's own (borrow-factor-adjusted debt ≥ unhealthy borrow value).
import { describe, expect, it } from 'vitest';
import { healthOf, salePrice } from '../../keeper/src/backstop';

const big = (x: bigint | number) => ({ toString: () => String(x) });
const W = 10n ** 18n;

/** risk-core::dutch_price: start − ⌊(start − floor) × elapsed / duration⌋. */
function reference(start: bigint, floor: bigint, t0: number, dur: number, now: number) {
  const el = BigInt(Math.min(Math.max(now - t0, 0), dur));
  return start - ((start - floor) * el) / BigInt(dur);
}

describe('backstop keeper', () => {
  it('auction price equals the program\'s at every point of the decay and after it', () => {
    const start = 672_051_797_110_000_000_000n, floor = 625_930_595_350_000_000_000n;
    const inv = { startPriceWad: big(start), floorPriceWad: big(floor), saleStartedAt: 1_000, saleSecs: 7_200 };
    for (const t of [0, 1, 999, 1_000, 1_001, 2_800, 4_600, 8_199, 8_200, 8_201, 50_000]) {
      expect(salePrice(inv, t)).toBe(reference(start, floor, 1_000, 7_200, t));
    }
    expect(salePrice(inv, 1_000)).toBe(start);
    expect(salePrice(inv, 9_000)).toBe(floor);
    expect(salePrice(inv, 1_000 + 1_800)).toBe(start - ((start - floor) * 1_800n) / 7_200n);
  });

  it('liquidatable exactly when klend\'s adjusted debt reaches the unhealthy value', () => {
    const sf = (usd: number) => big(BigInt(Math.round(usd * 2 ** 20)) << 40n);
    const ob = (debt: number, unhealthy: number) => ({ borrowFactorAdjustedDebtValueSf: sf(debt), unhealthyBorrowValueSf: sf(unhealthy) }) as never;
    expect(healthOf(ob(50_065.48, 47_924.0)).ratio).toBeGreaterThan(1);
    expect(healthOf(ob(46_970.07, 47_924.0)).ratio).toBeLessThan(1);
    expect(healthOf(ob(1, 0)).ratio).toBe(Infinity);
    expect(W).toBe(10n ** 18n);
  });
});
