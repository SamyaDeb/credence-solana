'use client';
// The Gap Cover backtest (task 3.4): today's model book and σ replayed through 2016–2026's dated weekend closures of the
// joint stress set, priced and paid with the program's own pricing code (programs/credence-core/examples/backtest.rs).
import { useEffect, useMemo, useState } from 'react';

type W = { date: string; type: string; lpReturn: number; pnlUsd: number; premiumUsd: number; payoutUsd: number; r: Record<string, number> };
type Data = {
  method: string; generatedBy: string; caveats: string[]; sigmaWad: Record<string, string>;
  summary: {
    book: { policies: number; perAsset: number; debtUsdEach: number; debtUsdTotal: number; debtToCoveredRange: [number, number]; premiumUsdPerWeekend: number; utilisation: number; capEqualsDebt: boolean };
    closures: { dated: number; nonOvernight: number; premiumOnly: number; synthetic: number };
    totals: { annualReturnOnEquity: number; lossRatio: number; payoutsUsd: number; premiumsUsd: number; pnlUsd: number };
    vaultEquityUsd: number; weekends: { withLoss: number; withPayout: number };
    worstWeekend: W & { payoutUsd: Record<string, number> }; worstSynthetic: W & { payoutUsd: Record<string, number> };
  };
  dated: W[]; synthetic: W[];
};

const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const pc = (x: number, dp = 2) => `${x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(dp)}%`;

export function BacktestChart() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { fetch('/api/data/backtest').then((r) => r.json()).then((j) => (j.error ? setErr(j.error) : setD(j))).catch((e) => setErr(String(e))); }, []);
  if (err) return <div className="panel err">{err}</div>;
  if (!d) return <div className="panel muted">Loading backtest…</div>;
  const s = d.summary;
  const worst = s.worstWeekend;
  const worstMove = Object.entries(worst.r).sort((a, b) => a[1] - b[1])[0];
  return (
    <div className="panel" data-testid="backtest">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Backtest: LP return per weekend, 2016–2026</h2>
        <span className="sim">historical replay, not live results</span>
      </div>
      <p className="muted" style={{ margin: '6px 0 16px', fontSize: 13.5 }}>
        {s.book.policies} policies ({s.book.perAsset} each on SPYx, QQQx, NVDAx), {usd(s.book.debtUsdEach)} debt each at D/C′ {s.book.debtToCoveredRange[0]}–{s.book.debtToCoveredRange[1]},
        cap = debt, against a {usd(s.vaultEquityUsd)} vault, bought every weekend at today&apos;s premiums and σ and paid with the program&apos;s own payout rule.
      </p>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="k">Return on LP equity</div><div className="v">{pc(s.totals.annualReturnOnEquity)}<small>/ yr</small></div><div className="s">premiums − payouts, {s.closures.nonOvernight} weekends</div></div>
        <div className="stat"><div className="k">Total, 10 years</div><div className="v accent">+{pc(s.totals.pnlUsd / s.vaultEquityUsd)}</div><div className="s">{usd(s.totals.pnlUsd)} on {usd(s.vaultEquityUsd)}; loss ratio {pc(s.totals.lossRatio, 1)}</div></div>
        <div className="stat"><div className="k">Worst weekend</div><div className="v bad">{pc(worst.lpReturn)}</div><div className="s">{worst.date}: {worstMove[0]} {pc(worstMove[1], 1)}, paid {usd(worst.payoutUsd.total)}</div></div>
        <div className="stat"><div className="k">Worst synthetic stress</div><div className="v bad">{pc(s.worstSynthetic.lpReturn)}</div><div className="s">all three assets at z = −9.2 (the 40-year stress)</div></div>
      </div>
      <Bars rows={d.dated} worst={worst.date} />
      <div className="note" style={{ marginTop: 10, lineHeight: 1.6 }}>
        <b>Parameters:</b> θ 100%, c 10%, η 1, β 97.5%, u_max 50%, min premium 5 USDC, fee 0 (the deployed config, Day 5); σ per weekend = max(recent, 2016–2026 long-run),  SPYx {pc(Number(d.sigmaWad.SPYx) / 1e18)}, QQQx {pc(Number(d.sigmaWad.QQQx) / 1e18)}, NVDAx {pc(Number(d.sigmaWad.NVDAx) / 1e18)}.
        Shown: the {s.closures.dated} dated weekends of the joint stress set; {s.closures.premiumOnly} calmer weekends earn premium only ({pc(d.dated.find((x) => x.payoutUsd === 0)?.lpReturn ?? 0, 4)} each).
        Source: {d.generatedBy}. <b>Data licence:</b> Alpaca SIP data, Jan 2016 to Sept 25, 2026, free personal licence, not cleared for commercial use (data/README.md); reused from the EVM Credence prototype.
        <br /><b>Caveats:</b> {d.caveats.join('; ')}.
      </div>
    </div>
  );
}

function Bars({ rows, worst }: { rows: W[]; worst: string }) {
  const W = 1180, H = 260, padL = 54, padR = 12, padT = 14, padB = 30;
  const { min } = useMemo(() => ({ min: Math.min(...rows.map((r) => r.lpReturn)) }), [rows]);
  const lo = Math.floor(Math.min(min, -0.005) * 1.08 * 200) / 200; // whole 0.5% steps
  const hi = 0.0025;
  const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB);
  const bw = (W - padL - padR) / rows.length;
  const ticks = Array.from({ length: Math.round(-lo / 0.005) + 1 }, (_, k) => -k * 0.005);
  const years = rows.map((r, i) => ({ i, y: r.date.slice(0, 4) })).filter((r, k, a) => k === 0 || a[k - 1].y !== r.y);
  const wi = rows.findIndex((r) => r.date === worst);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }} role="img" aria-label="LP return per weekend">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#3a4450' : '#1d242c'} />
          <text x={padL - 8} y={y(t) + 4} fill="#8b96a3" fontSize="11" textAnchor="end">{pc(t, 1)}</text>
        </g>
      ))}
      {years.map((yr) => (
        <text key={yr.y} x={padL + yr.i * bw} y={H - 10} fill="#5d6874" fontSize="11">{yr.y}</text>
      ))}
      {rows.map((r, i) => {
        const v = r.lpReturn;
        const top = y(Math.max(v, 0)); const bot = y(Math.min(v, 0));
        return <rect key={r.date} x={padL + i * bw} y={top} width={Math.max(bw - 0.6, 0.8)} height={Math.max(bot - top, 0.8)}
          fill={i === wi ? '#ff7a7a' : v < 0 ? '#c76a6a' : '#5ee0b0'} opacity={v < 0 ? 0.95 : 0.6}><title>{`${r.date}: ${pc(v, 3)} (premium ${usd(r.premiumUsd)}, payout ${usd(r.payoutUsd)})`}</title></rect>;
      })}
      {wi >= 0 && <text x={padL + wi * bw + 6} y={y(rows[wi].lpReturn) + 4} fill="#ff7a7a" fontSize="11">worst: {rows[wi].date}</text>}
    </svg>
  );
}
