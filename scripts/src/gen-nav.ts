// D4 data generator (research prototype): the NAV_STRIKE scenario set and the joint column of the NAV asset ONyc.
//
// There is no calibration: over the 90 days of the lender's own price (data/nav/nav-assets.json) ONyc never fell on any day (89
// daily returns, daily σ 0.007%, worst 3-day +0.086%). So the set is an assumption, labelled as one:
//  - σ per strike (daily) is a FLOOR of 0.5%: about 70 times the observed daily σ and more than five times the largest daily
//    move seen in either direction;
//  - the 3,000 standardised gaps are the quantiles of a Student-t with 3 degrees of freedom scaled to unit variance, symmetric
//    (a heavy tail: the 1-in-6,000 closure is −9.3 σ = −4.7%), the shape a NAV restatement or a mark-down would have;
//  - the joint column (the 256 scenarios capacity is sized on) is SPYx's column of joint set v2, i.e. NAV stress is assumed to
//    arrive in exactly the weekends the equity book is worst: conservative for the vault, which holds equity-heavy cover.
// Output: data/nav/ONyc-NAV_STRIKE.json, data/nav/joint-v3.json.   pnpm -C scripts tsx src/gen-nav.ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SIGMA_WAD = '5000000000000000'; // 0.5% per daily strike
const N = 3000;
const hash = (cols: number[][]) => createHash('sha256').update(Buffer.concat(cols.map((c) => Buffer.from(Int16Array.from(c).buffer)))).digest('hex');

// Student-t(3) CDF, closed form.
const cdf = (x: number) => 0.5 + (1 / Math.PI) * ((x / Math.sqrt(3)) / (1 + (x * x) / 3) + Math.atan(x / Math.sqrt(3)));
function quantile(p: number): number {
  let [lo, hi] = [-1e6, 1e6];
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
const z = Array.from({ length: N }, (_, i) => Math.max(-32000, Math.min(32000, Math.round((quantile((i + 0.5) / N) / Math.sqrt(3)) * 1000))));
z.sort((a, b) => a - b);

const v2 = JSON.parse(readFileSync(join(ROOT, 'data/onchain/joint-v2.json'), 'utf8'));
const col: number[] = v2.columns[v2.tickers.indexOf('SPYx')];
mkdirSync(join(ROOT, 'data/nav'), { recursive: true });
writeFileSync(join(ROOT, 'data/nav/ONyc-NAV_STRIKE.json'), JSON.stringify({
  ticker: 'ONyc', closureType: 4, n: N, sigmaWad: SIGMA_WAD, sha256: hash([z]),
  method: 'ASSUMED, not calibrated: Student-t(3) quantiles at (i + 0.5)/3000, unit variance, in thousandths of σ; σ = 0.5% per daily strike (floor). See the header of scripts/src/gen-nav.ts',
  evidence: 'data/nav/nav-assets.json: 89 daily returns of the lender-oracle price, none negative, daily σ 0.007%',
  z,
}) + '\n');
writeFileSync(join(ROOT, 'data/nav/joint-v3.json'), JSON.stringify({
  version: 3, k: 256, tickers: ['ONyc'], sha256: hash([col]),
  method: "ASSUMED: ONyc's column is SPYx's column of joint set v2 (NAV stress arrives in the weekends the equity book is worst)", columns: [col],
}) + '\n');
console.log('z[0]', z[0], 'z[1]', z[1], 'median', z[N / 2], 'z[-1]', z[N - 1], 'sha', hash([z]).slice(0, 16), 'joint sha', hash([col]).slice(0, 16));
