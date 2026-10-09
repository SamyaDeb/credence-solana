// W11 (task B3): does an earnings release need a σ bump, and how big? Release times are SEC EDGAR's: every 8-K with
// Item 2.02 ("Results of Operations and Financial Condition") and its acceptance time, from data.sec.gov's submissions
// JSON (public, official). Prices are Yahoo daily bars (split-adjusted), 2016-01-04 → 2026-09-25, the calibration
// window. A closure (previous close → next open) contains a release when the 8-K was accepted after the previous
// session's 16:00 ET and before the next session's 09:30 ET. Per asset: r = ln(open / previous close) over
// one-night closures with and without a release; σ = root mean square (zero mean, the calibration's convention);
// the multiplier a release needs = σ_release / σ_night, and how often each kind moved more than 2 and 3 normal σ.
// Also counts releases that fell inside a WEEKEND or HOLIDAY_WEEKEND closure (Friday after the close, Monday before
// the open), with their σ against the plain weekends'. Item 2.02 is what the company files as a results release:
// Tesla files its quarterly delivery reports under it too (Monday or Friday mornings), which is most of its weekends.
// Usage: pnpm tsx src/earnings-backtest.ts   → data/backtest/earnings-backtest.json
import { writeFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const START = Date.parse('2016-01-01T00:00:00Z') / 1000;
const END = Date.parse('2026-09-26T00:00:00Z') / 1000;
// Single stocks only (an index ETF has no earnings). CIKs from EDGAR's company search.
const ASSETS = {
  NVDAx: { symbol: 'NVDA', cik: 1045810 }, TSLAx: { symbol: 'TSLA', cik: 1318605 }, GOOGLx: { symbol: 'GOOGL', cik: 1652044 },
  AAPLx: { symbol: 'AAPL', cik: 320193 }, MSTRx: { symbol: 'MSTR', cik: 1050446 }, HOODx: { symbol: 'HOOD', cik: 1783879 },
} as const;
const SEC_UA = 'Credence research (credence.invalid)';
const DAY = 86_400_000;

type Bar = { date: string; open: number; close: number };

async function bars(symbol: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${START}&period2=${END}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const r = (await res.json()).chart.result[0];
  const q = r.indicators.quote[0];
  return r.timestamp
    .map((t: number, i: number) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), open: q.open[i], close: q.close[i] }))
    .filter((b: { open: number | null; close: number | null }) => b.open && b.close);
}

async function secJson(path: string) {
  const res = await fetch(`https://data.sec.gov/submissions/${path}`, { headers: { 'user-agent': SEC_UA } });
  if (!res.ok) throw new Error(`SEC ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Acceptance times (unix ms) of every 8-K with Item 2.02 since 2016. */
async function releases(cik: number): Promise<number[]> {
  const id = `CIK${String(cik).padStart(10, '0')}`;
  const top = await secJson(`${id}.json`);
  const parts = [top.filings.recent];
  for (const f of top.filings.files ?? []) if (f.filingTo >= '2016-01-01') parts.push(await secJson(f.name));
  const out: number[] = [];
  for (const r of parts)
    for (let i = 0; i < r.form.length; i++)
      if (r.form[i] === '8-K' && String(r.items[i]).split(',').includes('2.02') && r.filingDate[i] >= '2016-01-01')
        out.push(Date.parse(r.acceptanceDateTime[i]));
  return out.sort((a, b) => a - b);
}

/** New York wall-clock time (ms) of `date` at hh:mm. */
function nyTime(date: string, hh: number, mm: number): number {
  const guess = Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const ny = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' UTC').getTime();
  return guess + (guess - ny);
}

const rms = (xs: number[]) => (xs.length ? Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length) : 0);
const r4 = (x: number) => Number(x.toFixed(4));

const out: Record<string, unknown> = {};
for (const [ticker, { symbol, cik }] of Object.entries(ASSETS)) {
  const [b, rel] = await Promise.all([bars(symbol), releases(cik)]);
  const night: number[] = [];
  const release: { open: string; accepted: string; r: number }[] = [];
  const longer: { open: string; accepted: string; r: number; days: number }[] = [];
  const plainLonger: number[] = [];
  for (let i = 1; i < b.length; i++) {
    const from = nyTime(b[i - 1].date, 16, 0);
    const to = nyTime(b[i].date, 9, 30);
    const r = Math.log(b[i].open / b[i - 1].close);
    const hit = rel.find((t) => t > from && t < to);
    const days = Math.round((Date.parse(b[i].date) - Date.parse(b[i - 1].date)) / DAY);
    if (hit !== undefined && days > 1) longer.push({ open: b[i].date, accepted: new Date(hit).toISOString(), r: r4(r), days });
    else if (days > 1) plainLonger.push(r);
    if (days !== 1) continue;
    if (hit !== undefined) release.push({ open: b[i].date, accepted: new Date(hit).toISOString(), r: r4(r) });
    else night.push(r);
  }
  const sN = rms(night);
  const sR = rms(release.map((x) => x.r));
  const beyond = (xs: number[], k: number) => xs.filter((x) => Math.abs(x) > k * sN).length / Math.max(xs.length, 1);
  out[ticker] = {
    symbol, cik, from: b[0].date, to: b[b.length - 1].date, releases8K: rel.length,
    nights: night.length, releaseNights: release.length,
    sigmaNight: r4(sN), sigmaRelease: r4(sR), multiplier: Number((sR / sN).toFixed(2)),
    beyond2Sigma: { night: r4(beyond(night, 2)), release: r4(beyond(release.map((x) => x.r), 2)) },
    beyond3Sigma: { night: r4(beyond(night, 3)), release: r4(beyond(release.map((x) => x.r), 3)) },
    weekends: { plain: plainLonger.length, withRelease: longer.length, sigmaPlain: r4(rms(plainLonger)), sigmaRelease: r4(rms(longer.map((x) => x.r))),
      multiplier: longer.length ? Number((rms(longer.map((x) => x.r)) / rms(plainLonger)).toFixed(2)) : null },
    worstRelease: release.reduce((a, x) => (x.r < a.r ? x : a), release[0] ?? { open: '', accepted: '', r: 0 }),
    inWeekendClosures: longer,
    release,
  };
  console.log(`${ticker}: ${release.length} release nights of ${night.length + release.length}, σ night ${(sN * 100).toFixed(2)}%, release ${(sR * 100).toFixed(2)}% (×${(sR / sN).toFixed(2)}); weekends with a release ${longer.length} of ${longer.length + plainLonger.length}, σ ${(rms(longer.map((x) => x.r)) * 100).toFixed(2)}% vs ${(rms(plainLonger) * 100).toFixed(2)}%`);
}

writeFileSync(`${ROOT}data/backtest/earnings-backtest.json`, JSON.stringify({
  kind: 'credence.earnings-backtest.v1', generatedBy: 'scripts/src/earnings-backtest.ts',
  source: 'SEC EDGAR submissions (8-K Item 2.02 acceptance times); Yahoo daily bars (split-adjusted)',
  window: '2016-01-04 → 2026-09-25', assets: out,
}, null, 1) + '\n');
