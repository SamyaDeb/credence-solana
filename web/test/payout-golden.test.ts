// The app's loss table must pay exactly what settle_policy pays: the TS port against the Rust vectors
// (programs/credence-core/tests/golden_app.rs writes and checks fixtures/payout-golden.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gapped, realizedPayout } from '@/lib/payout';

type V = { coveredValue: string; debt: string; cap: string; closeWad: string; settleWad: string; gapBps: number | null; payout: string };
const { vectors } = JSON.parse(readFileSync(new URL('./fixtures/payout-golden.json', import.meta.url), 'utf8')) as { vectors: V[] };

describe('realizedPayout = credence_core::pricing::realized_payout', () => {
  it(`matches all ${vectors.length} Rust vectors`, () => {
    expect(vectors.length).toBeGreaterThan(400);
    let paying = 0;
    for (const v of vectors) {
      const got = realizedPayout(BigInt(v.coveredValue), BigInt(v.debt), BigInt(v.cap), BigInt(v.closeWad), BigInt(v.settleWad));
      expect(got.toString(), JSON.stringify(v)).toBe(v.payout);
      if (got > 0n) paying++;
    }
    expect(paying).toBeGreaterThan(50);
  });
  it('uses the same gap convention as the vectors', () => {
    for (const v of vectors.filter((x) => x.gapBps !== null)) expect(gapped(BigInt(v.closeWad), v.gapBps!).toString()).toBe(v.settleWad);
  });
});
