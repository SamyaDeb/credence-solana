// How likely a policy is to pay anything this weekend, shown next to every premium (Day 5 step 0). Two numbers:
// - the model's: the share of the asset's on-chain WEEKEND scenario set (the set `quote_cover` prices with) whose gap
//   factor g = 1 + σ z / 1000 leaves C′ × g below the debt, i.e. the probability the premium was priced on;
// - history's: how many real market closures since Apr 2016 opened with a gap that would have paid this position
//   (open / previous close − 1 of the underlying, data/sigma/closure-gaps.json, Yahoo daily bars).
export { decodeScenarioZ, loadScenarioZ, modelPays } from '@credence/sdk';

/** Real closures whose opening gap would have paid: C′ × (1 + gap) < D. */
export function historyPays(gaps: number[], coveredValue: bigint, debt: bigint): number {
  const breakEven = Number(debt) / Number(coveredValue) - 1;
  return gaps.filter((g) => g < breakEven).length;
}

export type History = { source: string; closures: Record<string, number>; from: string; to: string; gaps: Record<string, number[]> };

export async function loadHistory(): Promise<History> {
  const r = await fetch('/api/data/history');
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j as History;
}

/** "0.63%", "<0.01%", or "0%" for the line next to a premium. */
export function oddsPct(p: number): string {
  if (p === 0) return '0%';
  if (p < 0.0001) return '<0.01%';
  return `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;
}
