// The risk numbers the widget shows are the SDK's, and the SDK's payout rule is the program's: the Rust vectors
// (programs/credence-core/tests/golden_app.rs) against realizedPayout, then riskView against its parts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WAD } from '../src/core';
import { gapped, modelPays, payoutAtGap, realizedPayout, riskView, decodeScenarioZ, GAP_STEPS_BPS } from '../src/risk';

type V = { coveredValue: string; debt: string; cap: string; closeWad: string; settleWad: string; gapBps: number | null; payout: string };
const { vectors } = JSON.parse(readFileSync(new URL('../../../app/test/fixtures/payout-golden.json', import.meta.url), 'utf8')) as { vectors: V[] };

describe('realizedPayout = credence_core::pricing::realized_payout', () => {
  it('matches every Rust vector', () => {
    expect(vectors.length).toBeGreaterThan(400);
    for (const v of vectors) expect(realizedPayout(BigInt(v.coveredValue), BigInt(v.debt), BigInt(v.cap), BigInt(v.closeWad), BigInt(v.settleWad)).toString(), JSON.stringify(v)).toBe(v.payout);
  });
  it('gapped uses the vectors’ convention', () => {
    for (const v of vectors.filter((x) => x.gapBps !== null)) expect(gapped(BigInt(v.closeWad), v.gapBps!).toString()).toBe(v.settleWad);
  });
});

describe('riskView', () => {
  const z = new Int16Array(Array.from({ length: 2000 }, (_, i) => i - 1000)); // ascending
  const sigma = WAD / 50n;                                                    // 2%
  const snap = { coveredValue: 10_000_000_000n, debt: 9_500_000_000n };
  it('is exactly its parts: D/C′, modelPays, payoutAtGap at −5/−8/−12', () => {
    const r = riskView(snap, z, sigma);
    expect(GAP_STEPS_BPS).toEqual([-500, -800, -1200]);
    expect(r.debt).toBe(snap.debt);
    expect(r.coveredValue).toBe(snap.coveredValue);
    expect(r.debtOverCoveredWad).toBe((snap.debt * WAD) / snap.coveredValue);
    expect(r.pays).toEqual(modelPays(z, sigma, snap.coveredValue, snap.debt));
    expect(r.repay.map((x) => x.amount)).toEqual(GAP_STEPS_BPS.map((g) => payoutAtGap(snap.coveredValue, snap.debt, snap.debt, g)));
    // at 95% of the threshold: −5% needs nothing, −8% and −12% need repayment
    expect(r.repay[0].amount).toBe(0n);
    expect(r.repay[1].amount).toBe(300_000_000n);
    expect(r.repay[2].amount).toBe(700_000_000n);
  });
  it('a position with nothing covered has no ratio, not a division by zero', () => {
    expect(riskView({ coveredValue: 0n, debt: 5n }, z, sigma).debtOverCoveredWad).toBeNull();
  });
  it('decodes a ScenarioSet as the program lays it out', () => {
    const d = new Uint8Array(56 + 6); const v = new DataView(d.buffer);
    v.setUint16(48, 3, true); [-5, 0, 7].forEach((x, i) => v.setInt16(56 + 2 * i, x, true));
    expect([...decodeScenarioZ(d)]).toEqual([-5, 0, 7]);
  });
});
