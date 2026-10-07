// Task 3.3: every obligation in both Kamino xStocks markets with USDC debt against SPYx, QQQx or NVDAx, whether
// Phase 1 cover accepts it (one xStock deposit + one USDC borrow, plan/02 §2 rule 7), and its weekend risk at
// −5/−8/−12%. Values are klend's as of each obligation's last refresh (interest not accrued since).
//
// Usage: pnpm tsx src/positions.ts            → data/positions/positions-<yyyymmdd>.json (+ summary on stdout)
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { address, createSolanaRpc, getBase64Encoder, type Address } from '@solana/kit';
import { Obligation, Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const rpc = createSolanaRpc(process.env.MAINNET_RPC ?? '');
const b64 = getBase64Encoder();

const KLEND = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
export const MARKETS: Record<string, Address> = {
  xStocks: address('5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua'),
  Sentora: address('8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr'),
};
const MINTS: Record<string, string> = {
  XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: 'SPYx',
  Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ: 'QQQx',
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: 'NVDAx',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};
const COVERED = new Set(['SPYx', 'QQQx', 'NVDAx']);
const DEFAULT = '11111111111111111111111111111111';
const SF = 2 ** 60;
const usd = (sf: { toString(): string }) => Number(BigInt(sf.toString())) / SF;
const SHOCKS = [-0.05, -0.08, -0.12];

type ReserveInfo = { market: string; symbol: string; mint: string; ltPct: number; borrowFactorPct: number };

async function reserves(): Promise<Record<string, ReserveInfo>> {
  const out: Record<string, ReserveInfo> = {};
  for (const [market, m] of Object.entries(MARKETS)) {
    const accts = await rpc
      .getProgramAccounts(KLEND, {
        encoding: 'base64',
        filters: [{ dataSize: BigInt(Reserve.layout.span + 8) }, { memcmp: { offset: 32n, bytes: m as never, encoding: 'base58' } }],
      })
      .send();
    for (const a of accts) {
      const r = Reserve.decode(Buffer.from(b64.encode(a.account.data[0]) as Uint8Array));
      const mint = r.liquidity.mintPubkey;
      const name = Buffer.from(r.config.tokenInfo.name).toString('utf8').replace(/\0+$/, '');
      out[a.pubkey] = {
        market,
        symbol: MINTS[mint] ?? name,
        mint,
        ltPct: r.config.liquidationThresholdPct,
        borrowFactorPct: Number(r.config.borrowFactorPct.toString()),
      };
    }
  }
  return out;
}

async function main() {
  const res = await reserves();
  const positions: Record<string, unknown>[] = [];
  const scanned: Record<string, number> = {};
  for (const [market, m] of Object.entries(MARKETS)) {
    const accts = await rpc
      .getProgramAccounts(KLEND, {
        encoding: 'base64',
        filters: [{ dataSize: BigInt(Obligation.layout.span + 8) }, { memcmp: { offset: 32n, bytes: m as never, encoding: 'base58' } }],
      })
      .send();
    scanned[market] = accts.length;
    for (const a of accts) {
      const o = Obligation.decode(Buffer.from(b64.encode(a.account.data[0]) as Uint8Array));
      const deps = o.deposits.filter((d) => d.depositReserve !== DEFAULT);
      const bors = o.borrows.filter((b) => b.borrowReserve !== DEFAULT);
      const sym = (r: string) => res[r]?.symbol ?? '?';
      const covDeps = deps.filter((d) => COVERED.has(sym(d.depositReserve)));
      const usdcBor = bors.filter((b) => sym(b.borrowReserve) === 'USDC');
      if (covDeps.length === 0 || usdcBor.length === 0) continue; // not "USDC debt against SPYx/QQQx/NVDAx"

      const depositedUsd = usd(o.depositedValueSf);
      const debtUsd = usd(o.borrowFactorAdjustedDebtValueSf);
      const unhealthyUsd = usd(o.unhealthyBorrowValueSf);
      const reasons: string[] = [];
      if (deps.length !== 1) reasons.push('multi-collateral');
      if (bors.length !== 1) reasons.push('multi-borrow');
      if (usd(o.borrowFactorAdjustedDebtValueSf) !== usd(o.borrowedAssetsMarketValueSf)) reasons.push('borrow-factor');
      const eligible = reasons.length === 0;
      // Weekend risk: repay needed to restore health at a gap r on the covered xStock (others unchanged):
      // max(0, D − unhealthy_other − C′_x(1 + r)).
      const covUnhealthy = covDeps.reduce((s, d) => s + usd(d.marketValueSf) * res[d.depositReserve].ltPct / 100, 0);
      const loss = Object.fromEntries(
        SHOCKS.map((r) => [`${Math.round(r * 100)}%`, Math.max(0, debtUsd - (unhealthyUsd - covUnhealthy) - covUnhealthy * (1 + r))]),
      );
      positions.push({
        obligation: a.pubkey,
        market,
        owner: o.owner,
        elevationGroup: o.elevationGroup,
        eligible,
        excludedBecause: reasons,
        deposits: deps.map((d) => ({ symbol: sym(d.depositReserve), reserve: d.depositReserve, valueUsd: usd(d.marketValueSf) })),
        borrows: bors.map((b) => ({ symbol: sym(b.borrowReserve), reserve: b.borrowReserve, valueUsd: usd(b.marketValueSf) })),
        depositedUsd,
        debtUsd,
        coveredValueUsd: unhealthyUsd,
        debtToCovered: unhealthyUsd > 0 ? debtUsd / unhealthyUsd : null,
        repayNeededUsd: loss,
        lastUpdateSlot: o.lastUpdate.slot.toString(),
      });
    }
  }
  positions.sort((x, y) => (y.debtToCovered as number) - (x.debtToCovered as number));
  const elig = positions.filter((p) => p.eligible);
  const sum = (xs: Record<string, unknown>[], k: string) => xs.reduce((s, p) => s + (p[k] as number), 0);
  const byReason: Record<string, number> = {};
  for (const p of positions) for (const r of p.excludedBecause as string[]) byReason[r] = (byReason[r] ?? 0) + 1;
  const summary = {
    generatedAt: new Date().toISOString(),
    scannedObligations: scanned,
    withUsdcDebtAgainstSpyQqqNvda: positions.length,
    byMarket: Object.fromEntries(Object.keys(MARKETS).map((m) => [m, positions.filter((p) => p.market === m).length])),
    eligiblePhase1: elig.length,
    excluded: positions.length - elig.length,
    excludedByReason: byReason,
    debtUsd: { all: sum(positions, 'debtUsd'), eligible: sum(elig, 'debtUsd') },
    depositedUsd: { all: sum(positions, 'depositedUsd'), eligible: sum(elig, 'depositedUsd') },
    eligibleRepayNeededUsd: Object.fromEntries(SHOCKS.map((r) => {
      const k = `${Math.round(r * 100)}%`;
      return [k, elig.reduce((s, p) => s + (p.repayNeededUsd as Record<string, number>)[k], 0)];
    })),
    nearThreshold: elig.filter((p) => (p.debtToCovered as number) >= 0.9).map((p) => ({
      obligation: p.obligation, market: p.market, deposit: (p.deposits as { symbol: string }[])[0].symbol,
      debtUsd: p.debtUsd, debtToCovered: p.debtToCovered,
    })),
  };
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const dir = join(ROOT, 'data/positions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `positions-${day}.json`), JSON.stringify({ summary, positions }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
