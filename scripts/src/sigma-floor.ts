// Day 5 step 0: the σ floor. Long-run WEEKEND gap volatility per asset, 2016-01-04 → 2026-09-25 (the calibration
// window), from Yahoo daily bars: r = ln(Monday open / Friday close) over every plain weekend (Friday and the next
// Monday both sessions, nothing closed in between; holiday weekends excluded, as in the WEEKEND closure type).
// σ = root mean square of r (zero mean, the calibration's convention). Yahoo bars are split-adjusted, not
// dividend-adjusted; SPY and QQQ go ex-dividend on Fridays' sessions, so no dividend lands inside a weekend gap.
//
// σ_used = max(σ_recent, σ_floor) is applied off-chain by gen-onchain.ts / load-onchain.ts: σ is an asset parameter
// (`update_asset`, then `compute_gap_factors`), so the floor is a config change, not a program change.
//
// Also writes every non-overnight closure's real gap (open / previous close − 1) per asset, for the app's "N of 564
// weekends since 2016 would have paid" line: the same 564 closures as the joint set (opens 2016-04-25 → 2026-09-21,
// at least one calendar day without a session in between, holiday weekends and mid-week holidays included).
// Usage: pnpm tsx src/sigma-floor.ts   → data/sigma/sigma-floor.json, data/sigma/closure-gaps.json
import { writeFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const START = Date.parse('2016-01-01T00:00:00Z') / 1000;
const END = Date.parse('2026-09-26T00:00:00Z') / 1000;
// W16 (task B4): every Kamino xStock. HOOD listed 2021-07-29, so its window is shorter.
const ASSETS = { SPYx: 'SPY', QQQx: 'QQQ', NVDAx: 'NVDA', TSLAx: 'TSLA', GOOGLx: 'GOOGL', AAPLx: 'AAPL', MSTRx: 'MSTR', HOODx: 'HOOD' } as const;
const DAY = 86_400;

async function bars(symbol: string): Promise<{ date: string; open: number; close: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${START}&period2=${END}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const r = (await res.json()).chart.result[0];
  const q = r.indicators.quote[0];
  return r.timestamp
    .map((t: number, i: number) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), open: q.open[i], close: q.close[i] }))
    .filter((b: { open: number | null; close: number | null }) => b.open && b.close);
}

const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);

/** ln(Monday open / Friday close) over every plain weekend (Friday and the next Monday both sessions). */
function weekendGaps(b: { date: string; open: number; close: number }[]) {
  const gaps: { friday: string; r: number }[] = [];
  for (let i = 1; i < b.length; i++) {
    const prev = new Date(b[i - 1].date + 'T00:00:00Z');
    const days = (Date.parse(b[i].date) - prev.getTime()) / 1000 / DAY;
    if (prev.getUTCDay() === 5 && days === 3) gaps.push({ friday: b[i - 1].date, r: Math.log(b[i].open / b[i - 1].close) });
  }
  return gaps;
}

// W16 (task B4): MSTR and HOOD have no calibrated sets. They are priced on a proxy's sets (COIN, the closest
// crypto-linked name with calibration) with σ × (their weekend σ / COIN's over the last 104 weekends), the method
// QQQ uses with SPY.
const POOLED: Record<string, string> = { MSTRx: 'COIN', HOODx: 'COIN' };

const out: Record<string, unknown> = {};
const closureGaps: Record<string, { open: string; gap: number }[]> = {};
for (const [ticker, symbol] of Object.entries(ASSETS)) {
  const b = await bars(symbol);
  const gaps = weekendGaps(b);
  closureGaps[ticker] = [];
  for (let i = 1; i < b.length; i++) {
    const days = (Date.parse(b[i].date) - Date.parse(b[i - 1].date)) / 1000 / DAY;
    if (days > 1 && b[i].date >= '2016-04-25' && b[i].date <= '2026-09-21')
      closureGaps[ticker].push({ open: b[i].date, gap: Number((b[i].open / b[i - 1].close - 1).toFixed(6)) });
  }
  const rs = gaps.map((g) => g.r);
  const worst = gaps.reduce((a, g) => (g.r < a.r ? g : a));
  out[ticker] = {
    symbol,
    weekends: gaps.length,
    from: gaps[0].friday,
    to: gaps[gaps.length - 1].friday,
    sigma: rms(rs),
    sigmaWad: BigInt(Math.round(rms(rs) * 1e18)).toString(),
    sigmaLast104: rms(rs.slice(-104)),
    worst,
  };
  const proxy = POOLED[ticker];
  if (proxy) {
    // Both over the same 104 weekends (the last ones both traded).
    const pg = new Map(weekendGaps(await bars(proxy)).map((g) => [g.friday, g.r]));
    const both = gaps.filter((g) => pg.has(g.friday)).slice(-104);
    const ratio = rms(both.map((g) => g.r)) / rms(both.map((g) => pg.get(g.friday)!));
    (out[ticker] as Record<string, unknown>).pooled = { proxy, weekends: both.length, from: both[0].friday, to: both[both.length - 1].friday, sigmaRatio: Number(ratio.toFixed(4)) };
  }
  console.log(ticker, out[ticker]);
}
writeFileSync(
  `${ROOT}data/sigma/sigma-floor.json`,
  JSON.stringify({ kind: 'credence.sigma-floor.v1', generatedBy: 'scripts/src/sigma-floor.ts', source: 'Yahoo daily bars (split-adjusted), plain weekends only', window: ['2016-01-04', '2026-09-25'], assets: out }, null, 2) + '\n',
);
writeFileSync(
  `${ROOT}data/sigma/closure-gaps.json`,
  JSON.stringify({ kind: 'credence.closure-gaps.v1', generatedBy: 'scripts/src/sigma-floor.ts', source: 'Yahoo daily bars (split-adjusted): Monday (or post-holiday) open / previous close − 1', closures: Object.fromEntries(Object.entries(closureGaps).map(([t, g]) => [t, g.length])), gaps: closureGaps }) + '\n',
);
