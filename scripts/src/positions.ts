// Task 3.3: every obligation in both Kamino xStocks markets with USDC debt against SPYx, QQQx or NVDAx, whether
// Phase 1 cover accepts it (one xStock deposit + one USDC borrow), and its weekend risk at
// −5/−8/−12%.
//
// W4 (task B1) adds the obligations with PYUSD debt and the multi-collateral rule of buy_cover_multi: every deposit a
// covered xStock or a stablecoin (USDC, PYUSD), at most 8, at least one xStock; one USDC or PYUSD borrow at borrow
// factor 100%; no elevation group when it has more than one deposit or a PYUSD debt (the multi path uses each
// reserve's own LT). `eligibleB1` counts what Phase 1 or W4 cover accepts, `excludedB1ByReason` what is left.
//
// Values are brought to the present, not taken from each obligation's last refresh (which can be days old): debt
// accrues to the reserve's cumulative borrow rate, collateral is priced at the reserve's last refreshed price, and
// C′ = Σ collateral value × liquidation threshold (the obligation's own LT ratio when it is in an elevation group).
// The last-refresh ratio is kept as `debtToCoveredLastRefresh`.
//
// Reconciliation: for every reserve of the two markets, the sum over ALL obligations (deposits converted from cTokens
// at the reserve's exchange rate, borrows with interest) is compared with the reserve's own totals and with the
// Kamino API (`/kamino-market/<market>/reserves/metrics`).
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
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD',
};
/** Stablecoins buy_cover_multi accepts as deposits (S′, they do not move) and as the one borrow (W4). */
const STABLES = new Set(['USDC', 'PYUSD']);
const COVERED = new Set(['SPYx', 'QQQx', 'NVDAx']);
const DEFAULT = '11111111111111111111111111111111';
const SF = 2 ** 60;
const usd = (sf: { toString(): string }) => Number(BigInt(sf.toString())) / SF;
const SHOCKS = [-0.05, -0.08, -0.12];

type ReserveInfo = {
  market: string; symbol: string; mint: string; ltPct: number; borrowFactorPct: number; decimals: number;
  /** Reserve's last refreshed price, USD per token. */
  priceUsd: number;
  /** Cumulative borrow rate (U256 scaled by 2^60) and the cToken → liquidity rate (liquidity base units per cToken). */
  rateBsf: bigint; exchangeRate: number;
  /** Reserve totals in tokens: supplied liquidity (available + borrowed − fees) and borrowed. */
  totalSupply: number; totalBorrow: number;
};

const bsf = (v: { value: { toString(): string }[] }) =>
  v.value.reduce((acc, limb, i) => acc + (BigInt(limb.toString()) << BigInt(64 * i)), 0n);

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
      const dec = Number(r.liquidity.mintDecimals.toString());
      const sfToBase = (x: { toString(): string }) => Number(BigInt(x.toString()) >> 60n);
      const borrowedBase = sfToBase(r.liquidity.borrowedAmountSf);
      const fees = sfToBase(r.liquidity.accumulatedProtocolFeesSf) + sfToBase(r.liquidity.accumulatedReferrerFeesSf)
        + sfToBase(r.liquidity.pendingReferrerFeesSf);
      const supplyBase = Number(r.liquidity.totalAvailableAmount.toString()) + borrowedBase - fees;
      const cSupply = Number(r.collateral.mintTotalSupply.toString());
      out[a.pubkey] = {
        market,
        symbol: MINTS[mint] ?? name,
        mint,
        ltPct: r.config.liquidationThresholdPct,
        borrowFactorPct: Number(r.config.borrowFactorPct.toString()),
        decimals: dec,
        priceUsd: usd(r.liquidity.marketPriceSf),
        rateBsf: bsf(r.liquidity.cumulativeBorrowRateBsf),
        exchangeRate: cSupply > 0 ? supplyBase / cSupply : 1,
        totalSupply: supplyBase / 10 ** dec,
        totalBorrow: borrowedBase / 10 ** dec,
      };
    }
  }
  return out;
}

type ApiReserve = { reserve: string; liquidityToken: string; totalSupply: string; totalBorrow: string };

async function kaminoApi(market: Address): Promise<ApiReserve[]> {
  const r = await fetch(`https://api.kamino.finance/kamino-market/${market}/reserves/metrics?env=mainnet-beta`);
  if (!r.ok) throw new Error(`Kamino API ${r.status}`);
  return (await r.json()) as ApiReserve[];
}

async function main() {
  const res = await reserves();
  const positions: Record<string, unknown>[] = [];
  const scanned: Record<string, number> = {};
  // Σ over all obligations per reserve, tokens (deposits at the exchange rate, borrows with accrued interest).
  const sums: Record<string, { deposits: number; borrows: number }> = {};
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
      // Present values per deposit and borrow (tokens and USD).
      const depNow = deps.map((d) => {
        const r = res[d.depositReserve];
        const tokens = Number(d.depositedAmount.toString()) * r.exchangeRate / 10 ** r.decimals;
        return { reserve: d.depositReserve, symbol: r.symbol, tokens, valueUsd: tokens * r.priceUsd, lastRefreshUsd: usd(d.marketValueSf) };
      });
      const borNow = bors.map((b) => {
        const r = res[b.borrowReserve];
        const own = bsf(b.cumulativeBorrowRateBsf);
        const amountSf = own > 0n ? BigInt(b.borrowedAmountSf.toString()) * r.rateBsf / own : BigInt(b.borrowedAmountSf.toString());
        const tokens = Number(amountSf >> 60n) / 10 ** r.decimals;
        return { reserve: b.borrowReserve, symbol: r.symbol, tokens, valueUsd: tokens * r.priceUsd, bfValueUsd: tokens * r.priceUsd * r.borrowFactorPct / 100 };
      });
      for (const d of depNow) (sums[d.reserve] ??= { deposits: 0, borrows: 0 }).deposits += d.tokens;
      for (const b of borNow) (sums[b.reserve] ??= { deposits: 0, borrows: 0 }).borrows += b.tokens;

      const covDeps = depNow.filter((d) => COVERED.has(d.symbol));
      const usdcBor = borNow.filter((b) => b.symbol === 'USDC');
      const stableBor = borNow.filter((b) => STABLES.has(b.symbol));
      if (covDeps.length === 0 || stableBor.length === 0) continue; // not "USDC or PYUSD debt against SPYx/QQQx/NVDAx"
      const usdcUniverse = usdcBor.length > 0; // the Phase 1 population (task 3.3)

      const reasons: string[] = [];
      if (deps.length !== 1) reasons.push('multi-collateral');
      if (bors.length !== 1) reasons.push('multi-borrow');
      if (bors.some((b) => res[b.borrowReserve].borrowFactorPct !== 100)) reasons.push('borrow-factor');
      if (!usdcUniverse || bors.some((b) => res[b.borrowReserve].symbol !== 'USDC')) reasons.push('not-usdc-debt');
      const eligible = usdcUniverse && reasons.length === 0;
      // W4: buy_cover (single xStock / USDC, as Phase 1) or buy_cover_multi.
      const reasonsB1: string[] = [];
      if (!eligible) {
        const other = depNow.filter((d) => !COVERED.has(d.symbol) && !STABLES.has(d.symbol)).map((d) => d.symbol);
        if (other.length) reasonsB1.push(`deposit-not-covered:${[...new Set(other)].sort().join('+')}`);
        if (deps.length > 8) reasonsB1.push('more-than-8-deposits');
        if (bors.length !== 1) reasonsB1.push('multi-borrow');
        else if (!STABLES.has(res[bors[0].borrowReserve].symbol)) reasonsB1.push('borrow-not-usdc-or-pyusd');
        if (bors.some((b) => res[b.borrowReserve].borrowFactorPct !== 100)) reasonsB1.push('borrow-factor');
        if (o.elevationGroup !== 0) reasonsB1.push('elevation-group');
      }
      const eligibleB1 = eligible || reasonsB1.length === 0;
      // LT per deposit: the reserve's, or in an elevation group the obligation's own unhealthy / deposited ratio.
      const ltGroup = usd(o.depositedValueSf) > 0 ? usd(o.unhealthyBorrowValueSf) / usd(o.depositedValueSf) : 0;
      const lt = (r: string) => (o.elevationGroup !== 0 ? ltGroup : res[r].ltPct / 100);
      const debtUsd = borNow.reduce((x, b) => x + b.bfValueUsd, 0);
      const coveredUsd = depNow.reduce((x, d) => x + d.valueUsd * lt(d.reserve), 0);
      const covX = covDeps.reduce((x, d) => x + d.valueUsd * lt(d.reserve), 0);
      // Weekend risk: repay needed to restore health at a gap r on the covered xStock(s) (others unchanged):
      // max(0, D − C′_other − C′_x(1 + r)).
      const loss = Object.fromEntries(
        SHOCKS.map((r) => [`${Math.round(r * 100)}%`, Math.max(0, debtUsd - (coveredUsd - covX) - covX * (1 + r))]),
      );
      positions.push({
        obligation: a.pubkey,
        market,
        owner: o.owner,
        elevationGroup: o.elevationGroup,
        eligible,
        excludedBecause: reasons,
        usdcDebt: usdcUniverse,
        eligibleB1,
        excludedB1Because: reasonsB1,
        deposits: depNow.map((d) => ({ symbol: d.symbol, reserve: d.reserve, tokens: d.tokens, valueUsd: d.valueUsd })),
        borrows: borNow.map((b) => ({ symbol: b.symbol, reserve: b.reserve, tokens: b.tokens, valueUsd: b.valueUsd })),
        depositedUsd: depNow.reduce((x, d) => x + d.valueUsd, 0),
        debtUsd,
        coveredValueUsd: coveredUsd,
        debtToCovered: coveredUsd > 0 ? debtUsd / coveredUsd : null,
        debtToCoveredLastRefresh: usd(o.unhealthyBorrowValueSf) > 0 ? usd(o.borrowFactorAdjustedDebtValueSf) / usd(o.unhealthyBorrowValueSf) : null,
        repayNeededUsd: loss,
        lastUpdateSlot: o.lastUpdate.slot.toString(),
      });
    }
  }

  // Reconciliation with the reserves and the Kamino API.
  const reconciliation: Record<string, unknown>[] = [];
  for (const [market, m] of Object.entries(MARKETS)) {
    const api = await kaminoApi(m);
    for (const x of api) {
      const r = res[x.reserve];
      const s = sums[x.reserve] ?? { deposits: 0, borrows: 0 };
      if (!r) continue;
      const rel = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : 1) : (a - b) / b);
      reconciliation.push({
        market, reserve: x.reserve, symbol: r.symbol,
        supply: { obligations: s.deposits, reserve: r.totalSupply, kaminoApi: Number(x.totalSupply), obligationsVsApi: rel(s.deposits, Number(x.totalSupply)) },
        borrow: { obligations: s.borrows, reserve: r.totalBorrow, kaminoApi: Number(x.totalBorrow), obligationsVsApi: rel(s.borrows, Number(x.totalBorrow)) },
      });
    }
  }

  positions.sort((x, y) => (y.debtToCovered as number) - (x.debtToCovered as number));
  const usdcPositions = positions.filter((p) => p.usdcDebt);
  const elig = positions.filter((p) => p.eligible);
  const eligB1 = positions.filter((p) => p.eligibleB1);
  const byReasonB1: Record<string, number> = {};
  for (const p of positions) for (const r of p.excludedB1Because as string[]) byReasonB1[r] = (byReasonB1[r] ?? 0) + 1;
  const sum = (xs: Record<string, unknown>[], k: string) => xs.reduce((s, p) => s + (p[k] as number), 0);
  const byReason: Record<string, number> = {};
  const onlyReason: Record<string, number> = {};
  for (const p of usdcPositions) {
    const rs = p.excludedBecause as string[];
    for (const r of rs) byReason[r] = (byReason[r] ?? 0) + 1;
    if (rs.length === 1) onlyReason[rs[0]] = (onlyReason[rs[0]] ?? 0) + 1;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    scannedObligations: scanned,
    withUsdcDebtAgainstSpyQqqNvda: usdcPositions.length,
    byMarket: Object.fromEntries(Object.keys(MARKETS).map((m) => [m, usdcPositions.filter((p) => p.market === m).length])),
    eligiblePhase1: elig.length,
    excluded: usdcPositions.length - elig.length,
    w4: {
      withUsdcOrPyusdDebtAgainstCovered: positions.length,
      pyusdDebt: positions.filter((p) => !p.usdcDebt).length,
      eligibleB1: eligB1.length,
      eligibleB1ByMarket: Object.fromEntries(Object.keys(MARKETS).map((m) => [m, eligB1.filter((p) => p.market === m).length])),
      newlyEligible: { multiCollateral: eligB1.filter((p) => !p.eligible && (p.deposits as unknown[]).length > 1).length, pyusdDebt: eligB1.filter((p) => !p.eligible && !p.usdcDebt).length },
      excludedB1: positions.length - eligB1.length,
      excludedB1ByReason: byReasonB1,
      // How many excluded positions hold each asset that is not covered yet (a position counts once per asset).
      excludedB1ByUncoveredAsset: Object.fromEntries(Object.entries(Object.keys(byReasonB1).filter((k) => k.startsWith('deposit-not-covered:'))
        .reduce((acc: Record<string, number>, k) => { for (const a of k.split(':')[1].split('+')) acc[a] = (acc[a] ?? 0) + byReasonB1[k]; return acc; }, {}))
        .sort((x, y) => y[1] - x[1])),
      debtUsdEligibleB1: sum(eligB1, 'debtUsd'),
    },
    excludedByReason: byReason,
    excludedByThatReasonAlone: onlyReason,
    debtUsd: { all: sum(positions, 'debtUsd'), eligible: sum(elig, 'debtUsd') },
    depositedUsd: { all: sum(positions, 'depositedUsd'), eligible: sum(elig, 'depositedUsd') },
    eligibleRepayNeededUsd: Object.fromEntries(SHOCKS.map((r) => {
      const k = `${Math.round(r * 100)}%`;
      return [k, elig.reduce((s, p) => s + (p.repayNeededUsd as Record<string, number>)[k], 0)];
    })),
    liquidatableNow: elig.filter((p) => (p.debtToCovered as number) >= 1).length,
    nearThreshold: elig.filter((p) => (p.debtToCovered as number) >= 0.95 && (p.debtToCovered as number) < 0.99).map((p) => ({
      obligation: p.obligation, market: p.market, deposit: (p.deposits as { symbol: string }[])[0].symbol,
      debtUsd: p.debtUsd, debtToCovered: p.debtToCovered, debtToCoveredLastRefresh: p.debtToCoveredLastRefresh,
      repayNeededAtMinus8Usd: (p.repayNeededUsd as Record<string, number>)['-8%'],
    })),
    reconciliation: reconciliation.filter((x) => ['SPYx', 'QQQx', 'NVDAx', 'USDC', 'PYUSD'].includes(x.symbol as string)),
  };
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const dir = join(ROOT, 'data/positions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `positions-${day}.json`), JSON.stringify({ summary, reconciliation, positions }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
