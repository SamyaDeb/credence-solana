// Task 1.5: generate the on-chain data for Phase 1 (SPYx, QQQx, NVDAx; WEEKEND) into data/onchain/. W11 (B3) adds the
// OVERNIGHT and HOLIDAY_WEEKEND sets and each type's σ; W16 (B4) the eight xStocks of plan/10 (TSLAx, GOOGLx, AAPLx on their own
// calibration; MSTRx and HOODx pooled on COIN's sets with a σ ratio, as QQQx on SPY's).
// Deterministic: same inputs → same files and hashes. Hash = SHA-256 of the little-endian i16 values, exactly what
// `finalize_scenario_set` / `finalize_joint_set` check on-chain.
// Usage: pnpm tsx src/gen-onchain.ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const DATA = join(ROOT, 'data');
const OUT = join(DATA, 'onchain');
const N_ONCHAIN = 3000; // full calibrated sets (task 1.6: fits compute; down-sampling overcharged)
const K = 256;
const WEEKEND = 2;

/** QQQ has no calibration of its own. */
const QQQ_SIGMA_RATIO = 1.3311; // std of QQQ / SPY Fri-close→Mon-open gaps, last 104 weekends to 2026-09-25 (Yahoo)
const FLOOR = JSON.parse(readFileSync(join(new URL('../../', import.meta.url).pathname, 'data/sigma/sigma-floor.json'), 'utf8'));
/** σ ratio to the source's for pooled assets (none of their own calibration): data/sigma/sigma-floor.json `pooled`. */
const RATIO: Record<string, number> = { QQQx: QQQ_SIGMA_RATIO, MSTRx: FLOOR.assets.MSTRx.pooled.sigmaRatio, HOODx: FLOOR.assets.HOODx.pooled.sigmaRatio };
const NONE = '11111111111111111111111111111111'; // no reserve in that market
const feeds = (equity: string, xstock: string, redemption: string) => ({ equity, xstock, redemption });

const ASSETS = [
  {
    ticker: 'SPYx', source: 'SPY', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
    feeds: {
      equity: '19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
      xstock: '2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14',
      redemption: '9e916cc00d292da2367646ffd6537d6b8d0c3f15e2d5891ac44aed31291811a9',
    },
    kaminoReserves: ['UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d', '7Yh74hEtP75acqhQ5f2FqoHQny5TYiYBPVxkwN35rCSi'],
    // Jupiter Lend USDC vault (W12; data/jupiter/spike-20261009.json): its VaultConfig and Oracle.
    jupiter: { vaultConfig: '9ewVy9vTQ1R5Kgp5VDaygXU59z1k6H3AZhoaNyeKMYEr', oracle: 'DuX7B4gKvXPbBhQGXv4mD5FiFYf8C3EE8Pm5eh42mGiT' },
    // Kamino Scope chain (OraclePrices 3t4JZcue…): CappedFloored(MostRecentOf(Chainlink, Pyth Lazer)).
    scopeChain: 344,
  },
  {
    ticker: 'QQQx', source: 'SPY', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ',
    feeds: {
      equity: '9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d',
      xstock: '178a6f73a5aede9d0d682e86b0047c9f333ed0efe5c6537ca937565219c4054d',
      redemption: '5fe0ad9fd9bd888bbdfb609dbe8a6233248fa3dee25755f986f473c43938c7ca',
    },
    kaminoReserves: ['2jerdAXR8r2B6z3P7P6VgSiePQX7wqcpbEqdDbm8mgeB', 'w6diwHyXhRzmhRWwnz3jQPqTt35qFbBDcQP7T2VdgSm'],
    // Jupiter Lend USDC vault (W12; data/jupiter/spike-20261009.json): its VaultConfig and Oracle.
    jupiter: { vaultConfig: 'Fsn7PpTfBbdKi9MCjNWzq49uzJ2jSPsKRquMhHALjW6o', oracle: '8UJfPZinaPs6C4UKWb6CmeLgTbQThMyB7AJFYCFpHwoi' },
    // Kamino Scope chain (OraclePrices 3t4JZcue…): CappedFloored(MostRecentOf(Chainlink, Pyth Lazer)).
    scopeChain: 347,
  },
  {
    ticker: 'NVDAx', source: 'NVDA', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
    feeds: {
      equity: 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
      xstock: '4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f',
      redemption: 'b675c4e9f46d94afa9174a7df09966b77a2950970bb50a77ec8ad4fcfd8266f4',
    },
    kaminoReserves: ['7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q', '4WqQtjQbewk7ptnXsX3E3Tf3M4pa9YiBsgAqjsJDkspH'],
    // Jupiter Lend USDC vault (W12; data/jupiter/spike-20261009.json): its VaultConfig and Oracle.
    jupiter: { vaultConfig: 'Dnrc3CxMiDbcLPNaDVFZKf8SapkbQE6Az2obcKfWwBke', oracle: 'Fa1zDwJrXzZUyoUjmoojPrEQseYSW9M5xy2LmcDPPCHc' },
    // Kamino Scope chain (OraclePrices 3t4JZcue…): CappedFloored(MostRecentOf(Chainlink, Pyth Lazer)).
    scopeChain: 332,
  },
  // W16 (task B4): Kamino xStocks Market only (no Sentora reserve); data/onchain/xstock-reserves.json
  // (scripts/src/discover-xstocks.ts) and Pyth's Hermes catalogue (Equity.US.<T>/USD, Crypto.<T>X/USD,
  // Crypto.<T>X/<T>.RR).
  {
    ticker: 'TSLAx', source: 'TSLA', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
    feeds: feeds('16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1', '47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362', '997362625415627e9e3177f6c0d32f200d4a221ccadb3dddab80d6079d03ea24'),
    kaminoReserves: ['5iTiczqgUegqA3PpoNpotizMbY9n1sRWr3oL6igKvWuf', NONE],
    // Jupiter Lend TSLAx/USDC vault 77 (data/jupiter/spike-20261009.json).
    jupiter: { vaultConfig: '5f561RUPHDqRh98W62FdaYjHCqEvwzV7ePHXszdfQC5Z', oracle: 'Hxkqy3LBkuUcx3DPGSAaMV4Vfyh5rzX2i4n7yQNwAdTx' },
    scopeChain: 338,
  },
  {
    ticker: 'GOOGLx', source: 'GOOGL', mint: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN',
    feeds: feeds('5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6', 'b911b0329028cd0283e4259c33809d62942bd2716a58084e5f31d64c00b5424e', 'd54f066daee8cfbee2ecbefc8faa351c7c38b2c2a7cd8b704af20875974e3c68'),
    kaminoReserves: ['4wg6rEkGgHaEuxMduP46C1xFZ24Lnp5YgdNkZAHxFzsN', NONE],
    jupiter: null,
    scopeChain: 326,
  },
  {
    ticker: 'AAPLx', source: 'AAPL', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
    feeds: feeds('49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688', '978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675', '25babb83691a056fd65f879bfd7197eabd840aae741f69c87ccb31e204a979b2'),
    kaminoReserves: ['CKJbqakbPGyhziowm19LPYz636UszuezfkitmpRtcLSH', NONE],
    jupiter: null,
    scopeChain: 317,
  },
  {
    ticker: 'MSTRx', source: 'COIN', mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ',
    feeds: feeds('e1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09', '53f95ba4e23ed15ea56083e2ee9a5eec48055d6f59033d4bb95f1ca2a2349c28', '342df7ea9b8db28630933d55d0c9c1119525eb5be58d499ecc4e88faf061083a'),
    kaminoReserves: ['Cwy2WJoswCMyfPtWTrmiaDLXC3phz3qwr1TaT4kaSAyD', NONE],
    jupiter: null,
    scopeChain: 335,
  },
  {
    ticker: 'HOODx', source: 'COIN', mint: 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg',
    feeds: feeds('306736a4035846ba15a3496eed57225b64cc19230a50d14f3ed20fd7219b7849', 'dd49a9ac6df5cbfa9d8fc6371f7ae927a74d5c6763c1c01b4220d70314c647f9', 'd88c382daa11f3a377796bc3f9318e7fbffd69c5bbceb5e58548670a7ad23e7f'),
    kaminoReserves: ['4UBJu5Xp1aziV9frBQBhc1RnKrgXHAWHYejQytkYr8gq', NONE],
    jupiter: null,
    scopeChain: 320,
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

/** σ (a decimal) as a WAD, rounded up at 1e-12. */
function wadUp(sigma: number): bigint {
  return BigInt(Math.ceil(sigma * 1e12)) * 1_000_000n;
}

const max = (...xs: bigint[]) => xs.reduce((m, x) => (x > m ? x : m));

function main() {
  mkdirSync(OUT, { recursive: true });
  const scenFiles = readdirSync(join(DATA, 'scenarios'));
  const sigma = JSON.parse(readFileSync(join(DATA, 'sigma/sigma-ea391d6a1d0303cd.json'), 'utf8'));
  // σ floor (Day 5): σ_used = max(σ_recent, long-run 2016–2026 weekend σ), so a calm recent market does not price
  // crash regimes (Mar 2020, Apr 2025) as unlikely. data/sigma/sigma-floor.json from scripts/src/sigma-floor.ts.
  const floor = JSON.parse(readFileSync(join(DATA, 'sigma/sigma-floor.json'), 'utf8'));
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
    const ratio = RATIO[a.ticker];
    const recentSigma = ratio ? mulWadUp(baseSigma, ratio) : baseSigma;
    const floorSigma = BigInt(floor.assets[a.ticker].sigmaWad);
    // Audit A-72: a proxy-scaled σ (MSTRx, HOODx on COIN) can sit below the asset's own recent weekends, so pooled assets
    // with their own history also take its last-104-weekend RMS (data/sigma/sigma-floor.json `sigmaLast104`).
    const ownSigma = floor.assets[a.ticker].pooled ? wadUp(floor.assets[a.ticker].sigmaLast104) : 0n;
    const sigmaWad = max(recentSigma, ownSigma, floorSigma);
    const scen = {
      ticker: a.ticker, closureType: WEEKEND, n: zOn.length, sha256: sha256I16(zOn),
      source: { file: `data/scenarios/${f}`, n: z.length, contentHash: src.contentHash, symbol: a.source },
      method: zOn.length === z.length ? 'full calibrated set' : `min of each ${z.length / zOn.length}-point bucket`, z: zOn,
    };
    writeFileSync(join(OUT, `${a.ticker}-WEEKEND.json`), JSON.stringify(scen) + '\n');
    // W11 (task B3): the OVERNIGHT and HOLIDAY_WEEKEND sets, each with its own σ: the recent σ for that closure type
    // (pooled assets: the source's × the ratio), floored at the weekend floor × (σ_type / σ_weekend) of the same asset, so the floor
    // keeps each type's own scale.
    const sigmaByType: Record<string, string> = { WEEKEND: sigmaWad.toString() };
    for (const [name, ct] of [['OVERNIGHT', 1], ['HOLIDAY_WEEKEND', 3]] as const) {
      const ff = scenFiles.find((x) => x.startsWith(`${a.source}-XNAS-${ct}-`))!;
      const sr = JSON.parse(readFileSync(join(DATA, 'scenarios', ff), 'utf8'));
      const zt: number[] = sr.z;
      if (zt.some((v, i) => i > 0 && zt[i - 1] > v)) throw new Error(`${ff} not sorted`);
      const zo = downsampleMin(zt, N_ONCHAIN);
      const tSigma = BigInt(sigma.assets[a.source].sigmaWad[name]);
      const recent = ratio ? mulWadUp(tSigma, ratio) : tSigma;
      const floorT = (floorSigma * tSigma) / baseSigma;
      const ownT = (ownSigma * tSigma) / baseSigma;
      const st = max(recent, ownT, floorT);
      sigmaByType[name] = st.toString();
      writeFileSync(join(OUT, `${a.ticker}-${name}.json`), JSON.stringify({
        ticker: a.ticker, closureType: ct, n: zo.length, sha256: sha256I16(zo), sigmaWad: st.toString(),
        source: { file: `data/scenarios/${ff}`, n: zt.length, contentHash: sr.contentHash, symbol: a.source },
        method: zo.length === zt.length ? 'full calibrated set' : `min of each ${zt.length / zo.length}-point bucket`, z: zo,
      }) + '\n');
    }
    assets.push({
      ticker: a.ticker, mint: a.mint, feeds: a.feeds, kaminoReserves: a.kaminoReserves, scopeChain: a.scopeChain, jupiter: a.jupiter,
      sigmaWad: sigmaWad.toString(), dividendWad: '0', jointColumn: assets.length,
      sigmaSource: `max(recent: ${ratio ? `${a.source} WEEKEND σ × ${ratio}` : `${a.source} WEEKEND σ (data/sigma)`}, ${ownSigma ? `own: ${floor.assets[a.ticker].symbol} last-104-weekend σ, ` : ''}floor: ${floor.assets[a.ticker].symbol} ${floor.assets[a.ticker].from.slice(0, 4)}–2026 weekend σ (data/sigma/sigma-floor.json))`,
      sigmaRecentWad: recentSigma.toString(), ...(ownSigma ? { sigmaOwnWad: ownSigma.toString() } : {}), sigmaFloorWad: floorSigma.toString(),
      scenarioSha256: scen.sha256, sigmaByType,
    });
    console.log(`${a.ticker}: ${z.length} → ${zOn.length} z, min ${zOn[0]}, sha256 ${scen.sha256}, σ ${sigmaWad}`);
  }

  const V1 = ASSETS.slice(0, 3); // Phase 1's joint set, unchanged
  const columns = V1.map((a) => jointCol(a.source));
  if (columns.some((c) => c.length !== K)) throw new Error('joint column length');
  const jointOut = {
    version: 1, k: K, tickers: V1.map((a) => a.ticker), sha256: sha256I16(...columns),
    source: { file: `data/joint/${jointFile}`, contentHash: joint.contentHash },
    method: 'columns copied from the source joint set; QQQx uses the SPY column (beta 1)', columns,
  };
  writeFileSync(join(OUT, 'joint-v1.json'), JSON.stringify(jointOut) + '\n');

  // Joint set v2 (W11 + W16, tasks B3/B4): both tails, Kamino's eight xStocks.
  // - Down tail: the 192 worst closures of the source joint set (sorted worst first by basket z; the 64 mildest of v1's
  //   256 are dropped).
  // - Up tail: 64 comonotone scenarios, each asset at the same upper quantile of its own WEEKEND set, at the levels of
  //   the 64 best of the 564 non-overnight closures ((u + 0.5) / 564 from the top). The source set has no up weekends
  //   (its best SPY move is +0.88σ), so side UP cover (B3) would reserve nothing without them.
  // - Columns: QQQx = SPY (beta 1, as v1); MSTRx and HOODx have no joint history: COIN's column, the closest
  //   crypto-linked proxy in the source (their own σ prices the size; B4, plan/06).
  // One column per asset, in ASSETS order: an asset's jointColumn is its index (audit A-70; tests/data.rs checks it).
  const V2 = ASSETS.map((a) => [a.ticker, a.source] as const);
  const DOWN = 192, UP = 64, N_ALL = 564;
  const marginal = (sym: string) => {
    const f = scenFiles.find((x) => x.startsWith(`${sym}-XNAS-${WEEKEND}-`))!;
    return JSON.parse(readFileSync(join(DATA, 'scenarios', f), 'utf8')).z as number[];
  };
  const columnsV2 = V2.map(([, sym]) => {
    const down = jointCol(sym).slice(0, DOWN);
    const m = marginal(sym);
    const up = Array.from({ length: UP }, (_, u) => m[Math.min(m.length - 1, Math.floor((1 - (u + 0.5) / N_ALL) * m.length))]);
    return [...down, ...up];
  });
  if (columnsV2.some((c) => c.length !== K)) throw new Error('joint v2 column length');
  writeFileSync(join(OUT, 'joint-v2.json'), JSON.stringify({
    version: 2, k: K, tickers: V2.map(([t]) => t), sha256: sha256I16(...columnsV2), down: DOWN, up: UP,
    source: { file: `data/joint/${jointFile}`, contentHash: joint.contentHash, marginals: 'data/scenarios/*-XNAS-2-*.json' },
    method: 'first 192: the source joint set worst first; last 64: comonotone up tail from each asset\'s WEEKEND set at levels (u + 0.5)/564 from the top; QQQx = SPY, MSTRx = HOODx = COIN',
    columns: columnsV2,
  }) + '\n');
  console.log(`joint v2: ${V2.map(([t]) => t).join(',')} sha256 ${sha256I16(...columnsV2)} (192 down + 64 up)`);
  writeFileSync(join(OUT, 'assets.json'), JSON.stringify(assets, null, 2) + '\n');
  console.log(`joint v1: ${jointOut.tickers.join(',')} sha256 ${jointOut.sha256}`);
}

main();
