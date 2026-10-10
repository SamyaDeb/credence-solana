// GET: the Gap Cover backtest (task 3.4, data/backtest/gap-cover-backtest.json), trimmed for the chart.
import { fail, json, readJson } from '@/lib/server/fork';
import { throttle } from '@/lib/server/limit';

type W = { date: string; type: string; lpReturn: number; pnlUsd: number; premiumUsd: number; payoutUsd: Record<string, number>; r: Record<string, number> };

export async function GET(req: Request) {
  const limited = throttle(req, 'read');
  if (limited) return limited;
  try {
    const d = readJson<{ method: string; generatedBy: string; caveats: string[]; sigmaWad: Record<string, string>; summary: Record<string, unknown>;
      dated: W[]; synthetic: W[] }>('data/backtest/gap-cover-backtest.json');
    const slim = (w: W) => ({ date: w.date, type: w.type, lpReturn: w.lpReturn, pnlUsd: w.pnlUsd, premiumUsd: w.premiumUsd, payoutUsd: w.payoutUsd.total, r: w.r });
    const book = { ...(d.summary.book as Record<string, unknown>) };
    delete book.premiumByRatio;
    return json({ method: d.method, generatedBy: d.generatedBy, caveats: d.caveats, sigmaWad: d.sigmaWad, summary: { ...d.summary, book },
      dated: d.dated.map(slim).sort((a, b) => a.date.localeCompare(b.date)), synthetic: d.synthetic.map(slim) });
  } catch (e) {
    return fail(e);
  }
}
