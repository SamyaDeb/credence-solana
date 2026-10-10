// D3: the hedge figures the Underwrite page shows are stated functions of stored fields (lib/hedge.ts).
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { HEDGE_DISCLOSURE, bookView, capOf } from '../src/lib/hedge';

const t = (s: string) => [...Buffer.from(s.padEnd(8, '\0'))];
const n = (x: number | bigint) => ({ toString: () => String(x) });

describe('hedge book view', () => {
  it('caps round down, as the program computes them', () => {
    expect(capOf(1_000_000_000n, 300)).toBe(30_000_000n);
    expect(capOf(1_000_000_001n, 300)).toBe(30_000_000n);
    expect(capOf(0n, 300)).toBe(0n);
  });

  it('decodes a stored book: state name, legs, notional, evidence', () => {
    const legs = [{ ticker: t('NVDAx'), notional: n(30_000_000), entryWad: n(1), exitWad: n(2) }, { ticker: t('SPYx'), notional: n(40_000_000), entryWad: n(3), exitWad: n(4) }, ...Array(6).fill({ ticker: t(''), notional: n(0), entryWad: n(0), exitWad: n(0) })];
    const v = bookView(PublicKey.default, {
      group: 20261009, state: 1, nLegs: 2, legs, margin: n(30_000_000), equityAtOpen: n(1_000_000_000), pnl: n(4_800_000), settledPnl: n(0),
      venue: Array(20).fill(0xab), reportedAt: n(1_791_811_860), earliestReport: n(1_791_811_800), reporter: PublicKey.default, evidence: Array(32).fill(7),
    });
    expect(v.stateName).toBe('reported');
    expect(v.legs.map((l) => l.ticker)).toEqual(['NVDAx', 'SPYx']);
    expect(v.notional).toBe(70_000_000n);
    expect(v.evidence).toBe('07'.repeat(32));
    expect(v.venue).toBe('0x' + 'ab'.repeat(20));
  });

  it('the disclosure says what is trusted and avoids the banned words', () => {
    expect(HEDGE_DISCLOSURE).toMatch(/trust assumption/);
    expect(HEDGE_DISCLOSURE).toMatch(/guardian can void/);
    expect(HEDGE_DISCLOSURE).not.toMatch(/insurance|risk-free|\blive\b/i);
  });
});
