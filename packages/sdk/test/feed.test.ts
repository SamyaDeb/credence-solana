import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { CLOSURE, FEED_BLOCKING_MASK, FEED_FLAGS, closureTypeAfter, decodeFeed, feedClosure, feedProblems, flagNames, pdas, pushAccount } from '../src/index';

// The account bytes the Rust crank wrote in programs/credence-core/tests/gap_feed.rs (c3_sdk_golden_fixture keeps the
// file current). The expected values are that test's printed output.
const data = readFileSync(new URL('./fixtures/gap-feed-SPYx.bin', import.meta.url));
const key = pdas.feed('SPYx');

describe('GapFeed decoding (golden against the program)', () => {
  const f = decodeFeed(key, data);
  it('decodes every field the program wrote', () => {
    expect(key.toBase58()).toBe('EUszAWeSJMfa9NYESxztJ2zMBdz41o91zj69kbG9e4kB');
    expect([f.ticker, f.lender, f.closureId, f.closureType]).toEqual(['SPYx', 'kamino', 20261009, CLOSURE.WEEKEND]);
    expect(f.closePrice).toBe(781_520_000_000_000_000_000n);
    expect(f.fairPrice).toBe(750_000_000_000_000_000_000n);
    expect(f.lenderPrice).toBe(781_520_000_000_000_000_000n);
    expect(f.impliedGapFair).toBe(-40_331_661_377_827_823n);
    expect(f.impliedGapLender).toBe(0n);
    expect([f.pLt5, f.pLt8, f.pLt12]).toEqual([2_666_666_666_666_667n, 333_333_333_333_334n, 0n]);
    expect(f.closeTs).toBe(1_791_576_000);
    expect(f.nextOpen).toBe(1_791_811_800);
    expect(f.updates).toBe(1);
    expect(f.nScenarios).toBe(3000);
  });
  it('names the flags: a lender price older than the input age is informational; the first sighting is not "frozen"', () => {
    expect(f.flags).toBe(0x20000);
    expect(f.flagNames).toEqual(['LENDER_STALE']);
    expect(f.blocked).toBe(false);
    expect(f.lenderFrozen).toBe(false);
    expect(f.lenderSinceTs).toBe(f.lastUpdateTs);
  });
  it('rejects a different account type', () => {
    const bad = Buffer.from(data);
    bad[0] ^= 0xff;
    expect(() => decodeFeed(key, bad)).toThrow();
  });
});

describe('flags', () => {
  it('blocking flags are the low half, informational the high half', () => {
    for (const [name, bit] of Object.entries(FEED_FLAGS)) {
      const blocking = (bit & FEED_BLOCKING_MASK) !== 0;
      expect(blocking, name).toBe(!['LENDER_FROZEN', 'LENDER_STALE', 'EARNINGS_ASSET'].includes(name));
    }
    expect(flagNames(FEED_FLAGS.PAUSED | FEED_FLAGS.NO_CLOSE)).toEqual(['NO_CLOSE', 'PAUSED']);
  });
  it('feedProblems mirrors the consumer program', () => {
    const f = decodeFeed(key, data);
    const at = f.lastUpdateTs + 60;
    expect(feedProblems(f, at, 3600)).toEqual([]);
    expect(feedProblems(f, f.lastUpdateTs + 3601, 3600)[0]).toMatch(/last update/);
    expect(feedProblems({ ...f, updates: 0 }, at, 3600)).toContain('never updated');
    expect(feedProblems({ ...f, flags: FEED_FLAGS.MISSING_FAIR, blocked: true }, at, 3600).join()).toMatch(/MISSING_FAIR/);
    expect(feedProblems(f, f.nextOpen, 10 ** 9)).toContain('the closure has opened');
  });
});

describe('feedClosure (same cases as calendar::feed_closure in Rust)', () => {
  const s = (date: number, open: number, close: number) => ({ date, open, close });
  // Opens spaced as in the Rust test; dates chosen so the types are real: Thu→Fri overnight, Fri→Mon weekend.
  const v = [s(20261008, 1_000, 2_000), s(20261009, 3_000, 4_000), s(20261012, 10_000, 11_000)];
  it('follows the open plus the five-minute settlement window', () => {
    expect(feedClosure(v, 0)).toEqual({ id: 20261008, type: CLOSURE.OVERNIGHT });
    expect(feedClosure(v, 3_000 + 299)).toEqual({ id: 20261008, type: CLOSURE.OVERNIGHT });
    expect(feedClosure(v, 3_000 + 300)).toEqual({ id: 20261009, type: CLOSURE.WEEKEND });
    expect(feedClosure(v, 10_000 + 299)).toEqual({ id: 20261009, type: CLOSURE.WEEKEND });
    expect(feedClosure(v, 10_000 + 300)).toBeNull();
  });
  it('types a holiday weekend (Friday to Tuesday) and a midweek holiday', () => {
    expect(closureTypeAfter([{ date: 20261009 }, { date: 20261013 }], 0)).toBe(CLOSURE.HOLIDAY_WEEKEND);
    expect(closureTypeAfter([{ date: 20261008 }, { date: 20261012 }], 0)).toBe(CLOSURE.HOLIDAY_WEEKEND); // Thu → Mon spans the weekend
    expect(closureTypeAfter([{ date: 20261007 }, { date: 20261008 }], 0)).toBe(CLOSURE.OVERNIGHT);
  });
});

describe('addresses', () => {
  it("Pyth's push account for SPYx's Crypto.SPYX/USD feed is the mainnet account", () => {
    const feedId = Buffer.from('2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14', 'hex');
    expect(pushAccount(feedId).toBase58()).toBe('27Tv3HxU34AKxZ8MgfFAA1gCbWa96msMG5BvSWAHkBfj');
  });
  it('feed PDAs differ per ticker and are stable', () => {
    expect(pdas.feed('SPYx').equals(pdas.feed('SPYx'))).toBe(true);
    expect(pdas.feed('SPYx').equals(pdas.feed('SPYx.J'))).toBe(false);
    expect(pdas.feed('SPYx')).toBeInstanceOf(PublicKey);
  });
});

describe('wadPct (A-135: it printed every percentage 100x too large)', () => {
  const W = 10n ** 18n;
  it('formats WAD fractions as percentages', async () => {
    const { wadPct } = await import('../src/index');
    expect(wadPct((W * 123n) / 10_000n)).toBe('1.23%');
    expect(wadPct(W / 20n)).toBe('5.00%');
    expect(wadPct(2_666_666_666_666_667n)).toBe('0.27%');
    expect(wadPct(9_420_468_650_103_632n)).toBe('0.94%');
    expect(wadPct(0n)).toBe('0.00%');
    expect(wadPct(W)).toBe('100.00%');
    expect(wadPct(-40_331_661_377_827_823n)).toBe('-4.03%');
  });
});
