// GET: eligible near-threshold positions from the latest mainnet scan (task 3.3, data/positions), for the
// "Use a real mainnet position" button. Values are from the scan (each obligation's last klend refresh on mainnet).
import { fail, json, latest, readJson } from '@/lib/server/fork';

type P = { obligation: string; market: string; owner: string; eligible: boolean; deposits: { symbol: string; tokens: number; valueUsd: number }[];
  debtUsd: number; debtToCovered: number; repayNeededUsd: Record<string, number> };

export async function GET() {
  try {
    const f = latest('data/positions', /^positions-\d+\.json$/);
    if (!f) throw new Error('no data/positions scan (run scripts/src/positions.ts)');
    const scan = readJson<{ summary: { generatedAt: string; eligiblePhase1: number; withUsdcDebtAgainstSpyQqqNvda: number }; positions: P[] }>(f);
    const rows = scan.positions
      .filter((p) => p.eligible && p.debtToCovered >= 0.85 && p.debtToCovered < 1 && p.debtUsd >= 25)
      .sort((a, b) => b.debtUsd - a.debtUsd)
      .slice(0, 12)
      .map((p) => ({ obligation: p.obligation, owner: p.owner, market: p.market, symbol: p.deposits[0].symbol, tokens: p.deposits[0].tokens,
        collateralUsd: p.deposits[0].valueUsd, debtUsd: p.debtUsd, debtToCovered: p.debtToCovered, repayAtMinus8: p.repayNeededUsd['-8%'] }));
    return json({ file: f, generatedAt: scan.summary.generatedAt, eligible: scan.summary.eligiblePhase1, total: scan.summary.withUsdcDebtAgainstSpyQqqNvda, rows });
  } catch (e) {
    return fail(e);
  }
}
