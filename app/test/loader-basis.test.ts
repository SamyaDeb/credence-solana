// Audit A-69: σ_b (the Liquidation Shield's basis σ) for an asset the basis study has not measured. It was a flat 1%,
// below the study's pooled 1.33% and NVDAx's 1.86%, so the shield on TSLAx, MSTRx or HOODx (weekend σ 2.5–4.9%) was
// under-loaded and under-reserved. Now: the measured value when there is one, else the larger of the pooled σ_b and
// every measured asset's σ_b scaled by the ratio of weekend σ.
import { describe, expect, it } from 'vitest';
import { basisSigmaFor } from '../../scripts/src/basis';
import study from '../../data/shield-basis.json';
import assets from '../../data/onchain/assets.json';

const sigma = Object.fromEntries((assets as { ticker: string; sigmaWad: string }[]).map((a) => [a.ticker, Number(a.sigmaWad) / 1e18]));

describe('basisSigmaFor', () => {
  it('keeps a measured σ_b', () => {
    expect(basisSigmaFor('SPYx', study, sigma)).toBeCloseTo(0.0033944582239505854, 12);
    expect(basisSigmaFor('QQQx', study, sigma)).toBeCloseTo(0.013337754162357603, 12); // pooled, recorded in the study
  });
  it('never goes below the pooled σ_b and scales with weekend σ for unmeasured assets', () => {
    for (const t of ['TSLAx', 'GOOGLx', 'AAPLx', 'MSTRx', 'HOODx']) {
      const b = basisSigmaFor(t, study, sigma);
      expect(b).toBeGreaterThanOrEqual(study.pooledSigmaB);
      expect(b).toBeGreaterThanOrEqual(0.01855448801656433 * sigma[t] / sigma.NVDAx - 1e-12);
    }
    expect(basisSigmaFor('MSTRx', study, sigma)).toBeGreaterThan(0.03);
  });
  it('falls back to the pooled σ_b without σ data, and to 1% without a study', () => {
    expect(basisSigmaFor('XYZx', study, {})).toBeCloseTo(study.pooledSigmaB, 12);
    expect(basisSigmaFor('XYZx', null, {})).toBe(0.01);
  });
});
