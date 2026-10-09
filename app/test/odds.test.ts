// The "chance it pays" line next to each premium. The model count must equal the backtest's
// (programs/credence-core/examples/backtest.rs, demoPosition.probabilityPays) for the demo position, SPYx $50k at
// D/C′ 0.96, on the same WEEKEND set; the history count is the real SPY opening gaps below −4% (Mar 9 and 16, 2020).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeScenarioZ, historyPays, modelPays } from '@/lib/odds';

const root = new URL('../../', import.meta.url).pathname;
const read = (p: string) => JSON.parse(readFileSync(root + p, 'utf8'));
const z = Int16Array.from(read('data/onchain/SPYx-WEEKEND.json').z as number[]);
const D = 50_000_000_000n;
const C = BigInt(Math.floor(50_000e6 / 0.96));

describe('pay odds', () => {
  it('model count matches the backtest at the deployed and the floored σ', () => {
    expect(modelPays(z, 6_419_879_000_000_000n, C, D).count).toBe(3); // 0.100%
    expect(modelPays(z, BigInt(read('data/sigma/sigma-floor.json').assets.SPYx.sigmaWad), C, D).count).toBe(19); // 0.633%
  });
  it('nothing pays far from the threshold; everything pays past it', () => {
    expect(modelPays(z, 6_419_879_000_000_000n, 100_000n, 10_000n).count).toBe(0);
    expect(modelPays(z, 6_419_879_000_000_000n, 100_000n, 200_000n).count).toBe(z.length);
  });
  it('history: SPY opened below −4% twice since Apr 2016', () => {
    const gaps = (read('data/sigma/closure-gaps.json').gaps.SPYx as { gap: number }[]).map((g) => g.gap);
    expect(historyPays(gaps, C, D)).toBe(2);
  });
  it('decodes a ScenarioSet account by offset', () => {
    const buf = new Uint8Array(56 + 2 * 4);
    const v = new DataView(buf.buffer);
    v.setUint16(48, 3, true);
    [-5, 0, 7].forEach((x, i) => v.setInt16(56 + 2 * i, x, true));
    expect([...decodeScenarioZ(buf)]).toEqual([-5, 0, 7]);
  });
});
