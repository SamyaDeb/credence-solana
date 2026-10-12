// The "Use a real mainnet position" candidates from a positions scan (scripts/src/positions.ts): eligible positions near
// the threshold, largest debt first. Pure, no imports: the app route and the Railway data host (deploy/railway/runner.ts)
// both use it.
type P = { obligation: string; market: string; owner: string; eligible: boolean; deposits: { symbol: string; tokens: number; valueUsd: number }[];
  debtUsd: number; debtToCovered: number; repayNeededUsd: Record<string, number> };
export type ScanFile = { summary: { generatedAt: string; eligiblePhase1: number; withUsdcDebtAgainstSpyQqqNvda: number }; positions: P[] };

export function candidates(file: string, scan: ScanFile) {
  const rows = scan.positions
    .filter((p) => p.eligible && p.debtToCovered >= 0.85 && p.debtToCovered < 1 && p.debtUsd >= 25)
    .sort((a, b) => b.debtUsd - a.debtUsd)
    .slice(0, 12)
    .map((p) => ({ obligation: p.obligation, owner: p.owner, market: p.market, symbol: p.deposits[0].symbol, tokens: p.deposits[0].tokens,
      collateralUsd: p.deposits[0].valueUsd, debtUsd: p.debtUsd, debtToCovered: p.debtToCovered, repayAtMinus8: p.repayNeededUsd['-8%'] }));
  return { file, generatedAt: scan.summary.generatedAt, eligible: scan.summary.eligiblePhase1, total: scan.summary.withUsdcDebtAgainstSpyQqqNvda, rows };
}
