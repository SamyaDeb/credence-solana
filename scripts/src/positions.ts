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
// W12 (task B2) adds Jupiter Lend: every position of its xStock vaults with debt (one asset, one debt per vault), its
// collateral and debt from Fluid's tick math (debt = ratio(tick) × (col + 1) >> 48, + 1; risk-core::fluid), eligible
// when the asset is covered and the debt is USDC; per-vault totals reconciled with the vault's on-chain state and
// Jupiter's API (`api.jup.ag/lend/v1/borrow/vaults`).
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

// ---- Jupiter Lend (W12) ------------------------------------------------------------------------------------------
const JL_VAULTS = address('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');
const JL_FACTORS = [18446744073709551616n, 18419115400608638658n, 18391528108445969703n, 18336477419114433396n, 18226869890870665593n,
  18009616477100071088n, 17582847377087825313n, 16759408633341240198n, 15226414841393184936n, 12568272644527235157n, 8563108841104354677n,
  3975055583337633975n, 856577552520149366n, 39775317560084773n, 85764505686420n, 398745188n];
/** Fluid's ratio_x48(tick) (risk-core::fluid::ratio_at_tick, golden-tested against @jup-ag/lend). */
function jlRatio(tick: number): bigint {
  const abs = Math.abs(tick);
  let f = abs & 1 ? JL_FACTORS[1] : JL_FACTORS[0];
  for (let b = 2; b < 16; b++) if (abs & (1 << (b - 1))) f = (f * JL_FACTORS[b]) >> 64n;
  let prec = 0n;
  if (tick > 0) { f = ((1n << 128n) - 1n) / f; if (f % 65536n !== 0n) prec = 1n; }
  return (f >> 16n) + prec;
}
const jlDisc = (n: number[]) => Buffer.from(n).toString('base64');
const JL_DISC = { config: jlDisc([99, 86, 43, 216, 184, 102, 119, 77]), state: jlDisc([228, 196, 82, 165, 98, 210, 235, 152]), position: jlDisc([170, 188, 143, 228, 122, 64, 247, 208]) };
const JL_MINTS: Record<string, string> = { ...MINTS, JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: 'JupUSD' };

async function jupiter(prices: Record<string, number>) {
  const acc = async (disc: string, extra: object[] = []) => rpc.getProgramAccounts(JL_VAULTS, {
    encoding: 'base64', filters: [{ memcmp: { offset: 0n, bytes: disc as never, encoding: 'base64' } }, ...(extra as never[])],
  }).send();
  const buf = (a: { account: { data: [string, string] } }) => Buffer.from(b64.encode(a.account.data[0]) as Uint8Array);
  const configs = (await acc(JL_DISC.config)).map((a) => ({ key: a.pubkey as string, d: buf(a as never) }))
    .map(({ key, d }) => ({ key, vaultId: d.readUInt16LE(8), lt: d.readUInt16LE(16) / 1000, supply: bs58(d.subarray(154, 186)), borrow: bs58(d.subarray(186, 218)) }))
    .filter((v) => v.supply.startsWith('Xs')); // xStock collateral (every xStock mint starts with Xs)
  const states = new Map((await acc(JL_DISC.state)).map((a) => { const d = buf(a as never); return [d.readUInt16LE(8), d]; }));
  let api: { id: number; totalSupply: string; totalBorrow: string; supplyToken: { decimals: number; address: string; symbol: string }; borrowToken: { decimals: number; address: string; symbol: string } }[] = [];
  try { api = (await (await fetch('https://api.jup.ag/lend/v1/borrow/vaults')).json()) as never; } catch { /* reconciliation then on-chain only */ }
  for (const a of api) for (const t of [a.supplyToken, a.borrowToken]) if (t?.address && !JL_MINTS[t.address]) JL_MINTS[t.address] = t.symbol;
  const positions: Record<string, unknown>[] = [];
  const reconciliation: Record<string, unknown>[] = [];
  let unpriced = 0;
  for (const v of configs) {
    const st = states.get(v.vaultId);
    if (!st) { reconciliation.push({ vaultId: v.vaultId, error: 'no VaultState' }); continue; }
    const supEx = st.readBigUInt64LE(99), borEx = st.readBigUInt64LE(107);
    const asset = JL_MINTS[v.supply] ?? v.supply, debtSym = JL_MINTS[v.borrow] ?? v.borrow;
    const pos = await acc(JL_DISC.position, [{ memcmp: { offset: 8n, bytes: jlDisc([v.vaultId & 255, v.vaultId >> 8]), encoding: 'base64' } }]);
    let colSum = 0, debtSum = 0;
    for (const a of pos) {
      const d = buf(a as never);
      const supplyOnly = d[46] !== 0, tick = d.readInt32LE(47), colRaw = d.readBigUInt64LE(55);
      const col = Number((colRaw * supEx) / 10n ** 12n) / 1e9;
      colSum += col;
      if (supplyOnly || tick <= -16383 || colRaw === 0n) continue;
      const debtRaw = ((jlRatio(tick) * (colRaw + 1n)) >> 48n) + 1n;
      const debt = Number((debtRaw * borEx) / 10n ** 12n) / 1e9;
      debtSum += debt;
      const px = prices[asset];
      if (!px) { unpriced += 1; continue; } // no price for this asset: not counted as liquidatable (audit A-60)
      const covered = col * px * v.lt;
      const reasons: string[] = [];
      if (!COVERED.has(asset)) reasons.push(`asset-not-covered:${asset}`);
      if (debtSym !== 'USDC') reasons.push(`debt-${debtSym}`);
      positions.push({ lender: 'Jupiter Lend', position: a.pubkey, vaultId: v.vaultId, asset, debt: debtSym, collateralTokens: col, debtUsd: debt,
        coveredValueUsd: covered, debtToCovered: covered > 0 ? debt / covered : null, eligibleB2: reasons.length === 0, excludedBecause: reasons,
        repayNeededUsd: Object.fromEntries(SHOCKS.map((r) => [`${Math.round(r * 100)}%`, Math.max(0, debt - covered * (1 + r))])) });
    }
    const a = api.find((x) => x.id === v.vaultId);
    const apiSupply = a ? Number(a.totalSupply) / 10 ** (a.supplyToken?.decimals ?? 8) : null; // token units
    const apiBorrow = a ? Number(a.totalBorrow) / 10 ** (a.borrowToken?.decimals ?? 6) : null;
    const stSupply = Number((st.readBigUInt64LE(23) * supEx) / 10n ** 12n) / 1e9, stBorrow = Number((st.readBigUInt64LE(31) * borEx) / 10n ** 12n) / 1e9;
    const rel = (x: number, y: number | null) => (y ? (x - y) / y : null);
    reconciliation.push({ vaultId: v.vaultId, asset, debt: debtSym, positions: pos.length,
      supply: { positions: colSum, vaultState: stSupply, jupiterApi: apiSupply, positionsVsState: rel(colSum, stSupply), positionsVsApi: rel(colSum, apiSupply) },
      borrow: { positions: debtSum, vaultState: stBorrow, jupiterApi: apiBorrow, positionsVsState: rel(debtSum, stBorrow), positionsVsApi: rel(debtSum, apiBorrow) } });
  }
  const elig = positions.filter((p) => p.eligibleB2);
  const byReason: Record<string, number> = {};
  for (const p of positions) for (const r of p.excludedBecause as string[]) byReason[r] = (byReason[r] ?? 0) + 1;
  return {
    summary: {
      vaults: configs.length, positionsWithDebt: positions.length, unpricedSkipped: unpriced, eligibleB2: elig.length, excludedB2: positions.length - elig.length, excludedB2ByReason: byReason,
      debtUsd: { all: positions.reduce((x, p) => x + (p.debtUsd as number), 0), eligible: elig.reduce((x, p) => x + (p.debtUsd as number), 0) },
      nearThreshold: elig.filter((p) => (p.debtToCovered as number) >= 0.95 && (p.debtToCovered as number) < 1).length,
      liquidatableNow: elig.filter((p) => (p.debtToCovered as number) >= 1).length,
    },
    reconciliation, positions,
  };
}

function bs58(b: Buffer): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + b.toString('hex')); let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = '1' + s; else break; }
  return s;
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
  // Jupiter Lend, priced at the Kamino reserves' last refreshed prices of the same xStocks.
  const prices: Record<string, number> = {};
  for (const r of Object.values(res)) if (COVERED.has(r.symbol) || r.symbol.endsWith('x')) prices[r.symbol] = r.priceUsd;
  const jl = await jupiter(prices);
  (summary as Record<string, unknown>).jupiterLend = jl.summary;
  (summary as Record<string, unknown>).bothLenders = {
    eligible: (summary.w4 as { eligibleB1: number }).eligibleB1 + jl.summary.eligibleB2,
    kamino: (summary.w4 as { eligibleB1: number }).eligibleB1, jupiterLend: jl.summary.eligibleB2,
  };
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const dir = join(ROOT, 'data/positions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `positions-${day}.json`), JSON.stringify({ summary, reconciliation, positions, jupiterLend: { reconciliation: jl.reconciliation, positions: jl.positions } }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
