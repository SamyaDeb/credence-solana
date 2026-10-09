'use client';
// The weekend risk of Kamino's xStocks borrowers (api/scan): how many positions and how much debt a Monday gap of
// −5/−8/−12% would take past the liquidation threshold, and the repayment it would need. Live from mainnet in the
// public mode; from the committed mainnet scan on the fork.
import { useQuery } from '@tanstack/react-query';
import { num, pct, short, utc } from '@/lib/format';
import { H, Note } from '../ui';
import { ErrorNote, Loading } from './shared';

type Summary = {
  positions: number; debtUsd: number; eligible: number; eligibleDebtUsd: number; nearThreshold: number; liquidatableNow: number;
  shocks: { gap: number; positions: number; debtUsd: number; repayNeededUsd: number }[];
};
type Scan = {
  lenders?: (Summary & { lender: string })[];
  source: string; asOf: string; positions: number; debtUsd: number; eligible: number; eligibleDebtUsd: number; nearThreshold: number; liquidatableNow: number;
  shocks: { gap: number; positions: number; debtUsd: number; repayNeededUsd: number }[];
  top: { obligation: string; market: string; symbol: string; debtUsd: number; ratio: number }[];
};
const usd = (x: number) => `$${num(x, 0)}`;

export function RiskScan() {
  const q = useQuery<Scan>({ queryKey: ['scan'], staleTime: 300_000, queryFn: async () => { const r = await fetch('/api/scan'); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; } });
  return (
    <section data-testid="scan">
      <H right={q.data ? <small>{q.data.source} · {utc(Date.parse(q.data.asOf) / 1000).slice(0, 16)} UTC</small> : undefined}>xStocks borrowers this weekend: Kamino and Jupiter Lend</H>
      {q.error ? <ErrorNote error={q.error} what="the positions scan" /> : !q.data ? <Loading what="Scanning Kamino's xStocks markets" /> : (
        <>
          <div className="cx-figs">
            <div><div className="cx-fig-k">Positions with xStock collateral and debt</div><div className="cx-fig-v" data-testid="scan-positions">{num(q.data.positions, 0)}</div><div className="cx-fig-s">{usd(q.data.debtUsd)} of debt</div></div>
            <div><div className="cx-fig-k">Credence covers (Kamino)</div><div className="cx-fig-v">{num(q.data.eligible, 0)}</div><div className="cx-fig-s">{usd(q.data.eligibleDebtUsd)} of debt</div></div>
            <div><div className="cx-fig-k">Within 10% of liquidation</div><div className="cx-fig-v">{num(q.data.nearThreshold, 0)}</div><div className="cx-fig-s">Debt / C′ 0.90–1.00</div></div>
            <div><div className="cx-fig-k">Liquidatable at the last refresh</div><div className="cx-fig-v">{num(q.data.liquidatableNow, 0)}</div><div className="cx-fig-s">Debt / C′ ≥ 1</div></div>
          </div>
          <div className="cx-table-wrap" style={{ marginTop: 18 }}>
            <table className="cx-table is-keep" data-testid="scan-shocks">
              <thead><tr><th>If Monday opens</th><th className="is-num">Positions past the threshold</th><th className="is-num">Their debt</th><th className="is-num">Repay needed</th></tr></thead>
              <tbody>{q.data.shocks.map((s) => <tr key={s.gap}><td className="is-strong">{pct(s.gap, 0)}</td><td className="is-num">{num(s.positions, 0)}</td><td className="is-num">{usd(s.debtUsd)}</td><td className="is-num">{usd(s.repayNeededUsd)}</td></tr>)}</tbody>
            </table>
          </div>
          {q.data.lenders && (
            <div className="cx-table-wrap" style={{ marginTop: 18 }}>
              <table className="cx-table is-keep" data-testid="scan-lenders">
                <thead><tr><th>Lender</th><th className="is-num">Positions</th><th className="is-num">Debt</th><th className="is-num">Credence covers</th><th className="is-num">Within 10%</th><th className="is-num">Past the threshold at −8%</th></tr></thead>
                <tbody>{q.data.lenders.map((l) => {
                  const s8 = l.shocks.find((x) => Math.abs(x.gap + 0.08) < 1e-9);
                  return (
                    <tr key={l.lender} data-testid={`scan-lender-${l.lender.split(' ')[0]}`}>
                      <td className="is-strong">{l.lender}</td><td className="is-num">{num(l.positions, 0)}</td><td className="is-num">{usd(l.debtUsd)}</td>
                      <td className="is-num" data-testid={`scan-lender-${l.lender.split(' ')[0]}-eligible`}>{num(l.eligible, 0)}</td><td className="is-num">{num(l.nearThreshold, 0)}</td>
                      <td className="is-num">{s8 ? `${num(s8.positions, 0)} (${usd(s8.repayNeededUsd)})` : '—'}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
          {q.data.top.length > 0 && <p className="cx-hint">Closest to the threshold: {q.data.top.slice(0, 5).map((t) => `${t.symbol} ${short(t.obligation, 4)} ${t.ratio.toFixed(3)} (${usd(t.debtUsd)})`).join(' · ')}</p>}
          <Note icon="clock">At a gap only the xStock share of each position&apos;s liquidation-threshold value moves; stablecoin collateral does not. Kamino&apos;s xStock price itself stays frozen until Monday pre-market.</Note>
        </>
      )}
    </section>
  );
}
