// The public Weekend view's data (W6): the shadow keeper's summary and, once the weekend has settled, the results tool's
// output (scripts/src/shadow-results.ts). Pure, so it is tested; scripts/src/site-snapshot.ts only reads the files.

/** The shadow keeper's last phase (keeper/src/shadow-model.ts `Phase`): it writes 'done' after the Monday window. */
export const SHADOW_LAST_PHASE = 'done';

type Totals = Record<string, number>;
export type ShadowSummary = { at: string; phase: string; totals: Totals; close?: Record<string, { price: number }> };
/** The part of results.json the site shows. Every number in it comes from the file (computed off-chain from mainnet data). */
export type ResultsView = {
  headline: string;
  prices: Record<string, { scopeClose: number | null; scopeOpen: number | null; gap: number | null; firstMoveAt: string | null }>;
  premiumsUsd: number | null;
  shield: { acted: boolean; policies: number; rawUsd: number; cappedUsd: number };
  liquidations: { count: number; covered: number; backstopBonusUsd: number };
  payouts: { paying: number; totalUsd: number; lossRatio: number | null };
};

export function resultsView(r: any): ResultsView | null {
  if (!r?.payouts?.settled) return null; // before the open there is nothing to report
  return {
    headline: r.headline,
    prices: Object.fromEntries(Object.entries(r.prices as Record<string, any>).map(([k, p]) => [k, { scopeClose: p.scopeClose, scopeOpen: p.scopeOpen, gap: p.gap, firstMoveAt: p.scopeFirstMove?.at ?? null }])),
    premiumsUsd: r.coverage.premiumsUsd,
    shield: { acted: r.shield.acted, policies: r.shield.policiesAdvanced, rawUsd: r.shield.rawTotalUsd, cappedUsd: r.shield.cappedTotalUsd },
    liquidations: { count: r.liquidations.count, covered: r.liquidations.covered, backstopBonusUsd: r.liquidations.backstop.bonusUsd },
    payouts: { paying: r.payouts.paying, totalUsd: r.payouts.totalUsd, lossRatio: r.payouts.lossRatio },
  };
}

export function weekendFromSummary(s: ShadowSummary, closure: string, results: unknown = null) {
  const t = s.totals;
  return {
    asOf: s.at, source: `shadow keeper summary.json (closure ${closure}), read only`, closure: Number(closure), phase: s.phase, final: s.phase === SHADOW_LAST_PHASE,
    watched: t.watched, covered: t.covered, shieldAdvances: t.shieldAdvances, shieldAdvancedUsd: t.shieldAdvancedUsd, liquidatable: t.liquidatable,
    liquidatableCovered: t.liquidatableCovered, savedByShield: t.savedByShield, payouts: t.payouts, payoutsUsd: t.payoutsUsd, premiumsUsd: t.premiumsUsd,
    coveredDebtUsd: t.coveredDebtUsd, close: Object.fromEntries(Object.entries(s.close ?? {}).map(([k, v]) => [k, v.price])),
    results: resultsView(results),
  };
}
