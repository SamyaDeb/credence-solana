// GET: the weekend risk of Kamino's xStocks borrowers — every obligation in the two xStocks markets with SPYx, QQQx or
// NVDAx collateral and debt — and what a Monday gap of −5/−8/−12% would do to it. Public read-only mode: read live
// from mainnet through MAINNET_RPC (getProgramAccounts on klend, filtered by market; cached 10 minutes), each
// obligation at its last klend refresh. Fork mode: the committed mainnet scan (data/positions, scripts/src/positions.ts).
// At a gap g only the covered xStocks' share of the liquidation-threshold value C′ moves: C′(g) = C′_other + C′_x (1 + g).
import { Obligation, Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';
import { KLEND, XSTOCKS_MARKETS } from '@/lib/credence';
import { IS_MAINNET } from '@/lib/network';
import { fail, json, latest, readJson } from '@/lib/server/fork';

export const dynamic = 'force-dynamic';
const SF = 2 ** 60;
const GAPS = [-0.05, -0.08, -0.12];
type Row = { obligation: string; market: string; symbol: string; debtUsd: number; coveredUsd: number; xShare: number; eligible: boolean };
let cache: { at: number; body: unknown } | null = null;

function summarise(rows: Row[], source: string, asOf: string) {
  const at = (r: Row, g: number) => r.coveredUsd * (1 - r.xShare) + r.coveredUsd * r.xShare * (1 + g);
  const shocks = GAPS.map((g) => {
    const hit = rows.filter((r) => r.debtUsd > at(r, g));
    return { gap: g, positions: hit.length, debtUsd: hit.reduce((a, r) => a + r.debtUsd, 0), repayNeededUsd: hit.reduce((a, r) => a + (r.debtUsd - at(r, g)), 0) };
  });
  const near = rows.filter((r) => r.coveredUsd > 0 && r.debtUsd / r.coveredUsd >= 0.9 && r.debtUsd / r.coveredUsd < 1).length;
  const now = rows.filter((r) => r.debtUsd >= r.coveredUsd).length;
  const top = [...rows].filter((r) => r.coveredUsd > 0 && r.debtUsd < r.coveredUsd).sort((a, b) => b.debtUsd / b.coveredUsd - a.debtUsd / a.coveredUsd).slice(0, 8)
    .map((r) => ({ obligation: r.obligation, market: r.market, symbol: r.symbol, debtUsd: r.debtUsd, ratio: r.debtUsd / r.coveredUsd }));
  return { source, asOf, positions: rows.length, debtUsd: rows.reduce((a, r) => a + r.debtUsd, 0), eligible: rows.filter((r) => r.eligible).length,
    eligibleDebtUsd: rows.filter((r) => r.eligible).reduce((a, r) => a + r.debtUsd, 0), nearThreshold: near, liquidatableNow: now, shocks, top };
}

const MINTS: Record<string, string> = {
  XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: 'SPYx', Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ: 'QQQx',
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: 'NVDAx', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};
const COVERED = new Set(['SPYx', 'QQQx', 'NVDAx']);
const DEFAULT = '11111111111111111111111111111111';
const bsf = (v: { value: { toString(): string }[] }): bigint => v.value.reduce<bigint>((acc, limb, i) => acc + (BigInt(limb.toString()) << BigInt(64 * i)), 0n);

async function gpa(upstream: string, size: number, market: string) {
  const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [KLEND.toBase58(), { encoding: 'base64', commitment: 'confirmed',
      filters: [{ dataSize: size }, { memcmp: { offset: 32, bytes: market } }] }] }) });
  const j = (await r.json()) as { result?: { pubkey: string; account: { data: [string, string] } }[]; error?: { message: string } };
  if (!j.result) throw new Error(j.error?.message ?? 'getProgramAccounts failed');
  return j.result.map((a) => ({ key: a.pubkey, data: Buffer.from(a.account.data[0], 'base64') }));
}

/** The same method as scripts/src/positions.ts: positions with USDC debt against SPYx, QQQx or NVDAx in the two xStocks
 * markets, values brought to the present (debt accrued to each reserve's cumulative borrow rate, collateral at the
 * reserve's last price, C′ at each reserve's LT or the obligation's own ratio in an elevation group). */
async function live() {
  const upstream = process.env.MAINNET_RPC;
  if (!upstream) throw new Error('MAINNET_RPC is not set on the server');
  const rows: Row[] = [];
  for (const [market, name] of Object.entries(XSTOCKS_MARKETS)) {
    const res = new Map<string, { symbol: string; lt: number; bf: number; dec: number; price: number; rate: bigint; exch: number }>();
    for (const a of await gpa(upstream, Reserve.layout.span + 8, market)) {
      const r = Reserve.decode(a.data);
      const sfBase = (x: { toString(): string }) => Number(BigInt(x.toString()) >> 60n);
      const supply = Number(r.liquidity.totalAvailableAmount.toString()) + sfBase(r.liquidity.borrowedAmountSf)
        - sfBase(r.liquidity.accumulatedProtocolFeesSf) - sfBase(r.liquidity.accumulatedReferrerFeesSf) - sfBase(r.liquidity.pendingReferrerFeesSf);
      const c = Number(r.collateral.mintTotalSupply.toString());
      res.set(a.key, { symbol: MINTS[r.liquidity.mintPubkey] ?? '', lt: r.config.liquidationThresholdPct / 100, bf: Number(r.config.borrowFactorPct.toString()),
        dec: Number(r.liquidity.mintDecimals.toString()), price: Number(BigInt(r.liquidity.marketPriceSf.toString())) / SF, rate: bsf(r.liquidity.cumulativeBorrowRateBsf),
        exch: c > 0 ? supply / c : 1 });
    }
    for (const a of await gpa(upstream, Obligation.layout.span + 8, market)) {
      const o = Obligation.decode(a.data);
      const deps = o.deposits.filter((d) => d.depositReserve !== DEFAULT && res.has(d.depositReserve));
      const bors = o.borrows.filter((b) => b.borrowReserve !== DEFAULT && res.has(b.borrowReserve));
      const dep = deps.map((d) => { const r = res.get(d.depositReserve)!; const t = Number(d.depositedAmount.toString()) * r.exch / 10 ** r.dec; return { r, reserve: d.depositReserve, value: t * r.price }; });
      const bor = bors.map((b) => {
        const r = res.get(b.borrowReserve)!; const own = bsf(b.cumulativeBorrowRateBsf);
        const amountSf = own > 0n ? BigInt(b.borrowedAmountSf.toString()) * r.rate / own : BigInt(b.borrowedAmountSf.toString());
        return { r, value: (Number(amountSf >> 60n) / 10 ** r.dec) * r.price * r.bf / 100 };
      });
      const x = dep.filter((d) => COVERED.has(d.r.symbol));
      if (!x.length || !bor.some((b) => b.r.symbol === 'USDC')) continue;
      const ltGroup = Number(BigInt(o.depositedValueSf.toString())) > 0 ? Number(BigInt(o.unhealthyBorrowValueSf.toString())) / Number(BigInt(o.depositedValueSf.toString())) : 0;
      const lt = (d: (typeof dep)[number]) => (o.elevationGroup !== 0 ? ltGroup : d.r.lt);
      const covered = dep.reduce((s2, d) => s2 + d.value * lt(d), 0);
      const coveredX = x.reduce((s2, d) => s2 + d.value * lt(d), 0);
      rows.push({ obligation: a.key, market: name, symbol: x.map((d) => d.r.symbol).join('+'), debtUsd: bor.reduce((s2, b) => s2 + b.value, 0), coveredUsd: covered,
        xShare: covered > 0 ? coveredX / covered : 1, eligible: deps.length === 1 && bors.length === 1 && bor.every((b) => b.r.bf === 100) });
    }
  }
  return summarise(rows, 'Solana mainnet, live (values brought to the present, as scripts/src/positions.ts)', new Date().toISOString());
}

function fromFile() {
  const f = latest('data/positions', /^positions-\d+\.json$/);
  if (!f) throw new Error('no data/positions scan (run scripts/src/positions.ts)');
  const d = readJson<{ summary: { generatedAt: string }; positions: { obligation: string; market: string; eligible: boolean; deposits: { symbol: string; valueUsd: number }[];
    depositedUsd: number; debtUsd: number; coveredValueUsd: number }[] }>(f);
  const rows = d.positions.filter((p) => p.debtUsd > 0).map((p) => {
    const x = p.deposits.filter((q) => COVERED.has(q.symbol));
    return { obligation: p.obligation, market: p.market, symbol: x.map((q) => q.symbol).join('+'), debtUsd: p.debtUsd, coveredUsd: p.coveredValueUsd,
      xShare: p.depositedUsd > 0 ? x.reduce((s2, q) => s2 + q.valueUsd, 0) / p.depositedUsd : 1, eligible: p.eligible };
  }).filter((r) => r.symbol);
  return summarise(rows, `mainnet scan file ${f} (values brought to the scan time)`, d.summary.generatedAt);
}

export async function GET() {
  try {
    if (!IS_MAINNET) return json(fromFile());
    if (!cache || Date.now() - cache.at > 600_000) cache = { at: Date.now(), body: await live() };
    return json(cache.body);
  } catch (e) {
    return fail(e, 502);
  }
}
