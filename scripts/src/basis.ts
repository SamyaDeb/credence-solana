// σ_b, the Liquidation Shield's basis σ (W1), per asset for the loader (audit A-69).
type Study = { pooledSigmaB?: number; assets?: Record<string, { sigmaBUsed?: number }> } | null;

/** The basis study's σ_b for `ticker` when it measured one (own weekends, or the pooled value it assigned). Otherwise
 * the larger of the pooled σ_b and every measured asset's σ_b × (σ_ticker / σ_measured): the basis error grows with the
 * asset's own volatility, so an unmeasured volatile asset is never loaded below a measured calmer one. 1% without a
 * study. Conservative: a larger σ_b prices a larger shield loading and reserves more. */
export function basisSigmaFor(ticker: string, study: Study, weekendSigma: Record<string, number>): number {
  if (!study) return 0.01;
  const own = study.assets?.[ticker]?.sigmaBUsed;
  if (typeof own === 'number' && own > 0) return own;
  let b = study.pooledSigmaB && study.pooledSigmaB > 0 ? study.pooledSigmaB : 0.01;
  const s = weekendSigma[ticker];
  if (s > 0) {
    for (const [m, v] of Object.entries(study.assets ?? {})) {
      const sm = weekendSigma[m];
      if (typeof v.sigmaBUsed === 'number' && v.sigmaBUsed > 0 && sm > 0) b = Math.max(b, (v.sigmaBUsed * s) / sm);
    }
  }
  return b;
}
