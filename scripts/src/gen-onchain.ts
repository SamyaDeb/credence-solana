// Task 1.5: generate the on-chain data for Phase 1 (SPYx, QQQx, NVDAx; WEEKEND) into data/onchain/.
// Deterministic: same inputs → same files and hashes. Hash = SHA-256 of the little-endian i16 values, exactly what
// `finalize_scenario_set` / `finalize_joint_set` check on-chain.
// Usage: pnpm tsx src/gen-onchain.ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const DATA = join(ROOT, 'data');
const OUT = join(DATA, 'onchain');
const N_ONCHAIN = 3000; // full calibrated sets (task 1.6: fits compute; down-sampling overcharged, plan/09)
const K = 256;
const WEEKEND = 2;

/** QQQ has no calibration of its own (see plan/09, Day 1 findings). */
const QQQ_SIGMA_RATIO = 1.3311; // std of QQQ / SPY Fri-close→Mon-open gaps, last 104 weekends to 2026-09-25 (Yahoo)

const ASSETS = [
  {
    ticker: 'SPYx', source: 'SPY', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
    feeds: {
      equity: '19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
      xstock: '2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14',
      redemption: '9e916cc00d292da2367646ffd6537d6b8d0c3f15e2d5891ac44aed31291811a9',
    },
    kaminoReserves: ['UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d', '11111111111111111111111111111111'],
  },
  {
    ticker: 'QQQx', source: 'SPY', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ',
    feeds: {
      equity: '9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d',
      xstock: '178a6f73a5aede9d0d682e86b0047c9f333ed0efe5c6537ca937565219c4054d',
      redemption: '5fe0ad9fd9bd888bbdfb609dbe8a6233248fa3dee25755f986f473c43938c7ca',
    },
    kaminoReserves: ['2jerdAXR8r2B6z3P7P6VgSiePQX7wqcpbEqdDbm8mgeB', '11111111111111111111111111111111'],
  },
  {
    ticker: 'NVDAx', source: 'NVDA', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
    feeds: {
      equity: 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
      xstock: '4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f',
      redemption: 'b675c4e9f46d94afa9174a7df09966b77a2950970bb50a77ec8ad4fcfd8266f4',
    },
    kaminoReserves: ['7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q', '11111111111111111111111111111111'],
  },
] as const;

export function sha256I16(...cols: number[][]): string {
  const h = createHash('sha256');
  for (const c of cols) {
    const b = Buffer.alloc(c.length * 2);
    c.forEach((v, i) => b.writeInt16LE(v, i * 2));
    h.update(b);
  }
  return h.digest('hex');
}

/**
 * Down-sample a sorted set to `n` points by taking the minimum (most adverse) of each equal-probability bucket.
 * Keeps probability mass equal per point (risk-core weights scenarios equally) and never makes a scenario milder,
 * so premiums and expected shortfall can only go up. Keeping every tail point instead would over-weight the tail.
 */
export function downsampleMin(z: number[], n: number): number[] {
  if (z.length <= n) return [...z];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.floor((i * z.length) / n);
    out.push(z[lo]); // z is ascending: the bucket minimum is its first element
  }
  return out;
}

function mulWadUp(wad: bigint, ratio: number): bigint {
  const r = BigInt(Math.round(ratio * 1e6));
  return (wad * r + 999_999n) / 1_000_000n;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const scenFiles = readdirSync(join(DATA, 'scenarios'));
  const sigma = JSON.parse(readFileSync(join(DATA, 'sigma/sigma-ea391d6a1d0303cd.json'), 'utf8'));
  const jointFile = readdirSync(join(DATA, 'joint')).find((f) => f.endsWith('.json'))!;
  const joint = JSON.parse(readFileSync(join(DATA, 'joint', jointFile), 'utf8'));
  const jointCol = (sym: string) => {
    const i = joint.assets.indexOf(`${sym}:XNAS`);
    if (i < 0) throw new Error(`${sym} not in joint set`);
    return joint.z[i] as number[];
  };

  const assets = [];
  for (const a of ASSETS) {
    const f = scenFiles.find((x) => x.startsWith(`${a.source}-XNAS-${WEEKEND}-`))!;
    const src = JSON.parse(readFileSync(join(DATA, 'scenarios', f), 'utf8'));
    const z: number[] = src.z;
    if (z.some((v, i) => i > 0 && z[i - 1] > v)) throw new Error(`${f} not sorted`);
    const zOn = downsampleMin(z, N_ONCHAIN);
    const baseSigma = BigInt(sigma.assets[a.source].sigmaWad.WEEKEND);
    const sigmaWad = a.ticker === 'QQQx' ? mulWadUp(baseSigma, QQQ_SIGMA_RATIO) : baseSigma;
    const scen = {
      ticker: a.ticker, closureType: WEEKEND, n: zOn.length, sha256: sha256I16(zOn),
      source: { file: `data/scenarios/${f}`, n: z.length, contentHash: src.contentHash, symbol: a.source },
      method: zOn.length === z.length ? 'full calibrated set' : `min of each ${z.length / zOn.length}-point bucket`, z: zOn,
    };
    writeFileSync(join(OUT, `${a.ticker}-WEEKEND.json`), JSON.stringify(scen) + '\n');
    assets.push({
      ticker: a.ticker, mint: a.mint, feeds: a.feeds, kaminoReserves: a.kaminoReserves,
      sigmaWad: sigmaWad.toString(), dividendWad: '0', jointColumn: assets.length,
      sigmaSource: a.ticker === 'QQQx' ? `SPY WEEKEND σ × ${QQQ_SIGMA_RATIO}` : `${a.source} WEEKEND σ (data/sigma)`,
      scenarioSha256: scen.sha256,
    });
    console.log(`${a.ticker}: ${z.length} → ${zOn.length} z, min ${zOn[0]}, sha256 ${scen.sha256}, σ ${sigmaWad}`);
  }

  const columns = ASSETS.map((a) => jointCol(a.source));
  if (columns.some((c) => c.length !== K)) throw new Error('joint column length');
  const jointOut = {
    version: 1, k: K, tickers: ASSETS.map((a) => a.ticker), sha256: sha256I16(...columns),
    source: { file: `data/joint/${jointFile}`, contentHash: joint.contentHash },
    method: 'columns copied from the source joint set; QQQx uses the SPY column (beta 1, see plan/09)', columns,
  };
  writeFileSync(join(OUT, 'joint-v1.json'), JSON.stringify(jointOut) + '\n');
  writeFileSync(join(OUT, 'assets.json'), JSON.stringify(assets, null, 2) + '\n');
  console.log(`joint v1: ${jointOut.tickers.join(',')} sha256 ${jointOut.sha256}`);
}

main();
