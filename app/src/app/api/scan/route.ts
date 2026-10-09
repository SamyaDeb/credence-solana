// GET: the weekend risk of Kamino's xStocks borrowers — every obligation in the two xStocks markets with SPYx, QQQx or
// NVDAx collateral and debt — and what a Monday gap of −5/−8/−12% would do to it. Public read-only mode: read live
// from mainnet through MAINNET_RPC (getProgramAccounts on klend, filtered by market; cached 10 minutes), each
// obligation at its last klend refresh. Fork mode: the committed mainnet scan (data/positions, scripts/src/positions.ts).
// At a gap g only the covered xStocks' share of the liquidation-threshold value C′ moves: C′(g) = C′_other + C′_x (1 + g).
// W12: the same for Jupiter Lend's xStock vaults (`lenders`: Kamino and Jupiter Lend side by side); eligibility is what
// Credence covers today on each (Kamino: Phase 1 + W4; Jupiter: SPYx/QQQx/NVDAx with USDC debt).
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
  const jl = await liveJupiter(upstream, rows);
  return withLenders(rows, jl, 'Solana mainnet, live (values brought to the present, as scripts/src/positions.ts)', new Date().toISOString());
}

/** The Kamino summary (top level, as before) plus both lenders side by side. */
function withLenders(kamino: Row[], jupiter: Row[], source: string, asOf: string) {
  return { ...summarise(kamino, source, asOf), lenders: [{ lender: 'Kamino', ...summarise(kamino, source, asOf) }, { lender: 'Jupiter Lend', ...summarise(jupiter, source, asOf) }] };
}

// Jupiter Lend (W12): Fluid tick math (risk-core::fluid, golden-tested against @jup-ag/lend).
const JL_VAULTS = 'jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi';
const JL_F = [18446744073709551616n, 18419115400608638658n, 18391528108445969703n, 18336477419114433396n, 18226869890870665593n, 18009616477100071088n,
  17582847377087825313n, 16759408633341240198n, 15226414841393184936n, 12568272644527235157n, 8563108841104354677n, 3975055583337633975n,
  856577552520149366n, 39775317560084773n, 85764505686420n, 398745188n];
function jlRatio(tick: number): bigint {
  const abs = Math.abs(tick);
  let f = abs & 1 ? JL_F[1] : JL_F[0];
  for (let b = 2; b < 16; b++) if (abs & (1 << (b - 1))) f = (f * JL_F[b]) >> 64n;
  let prec = 0n;
  if (tick > 0) { f = ((1n << 128n) - 1n) / f; if (f % 65536n !== 0n) prec = 1n; }
  return (f >> 16n) + prec;
}
async function jlGpa(upstream: string, disc: number[], extra: object[] = []) {
  const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [JL_VAULTS, { encoding: 'base64', commitment: 'confirmed',
      filters: [{ memcmp: { offset: 0, bytes: Buffer.from(disc).toString('base64'), encoding: 'base64' } }, ...extra] }] }) });
  const j = (await r.json()) as { result?: { pubkey: string; account: { data: [string, string] } }[]; error?: { message: string } };
  if (!j.result) throw new Error(j.error?.message ?? 'getProgramAccounts failed');
  return j.result.map((a) => ({ key: a.pubkey, data: Buffer.from(a.account.data[0], 'base64') }));
}
/** Jupiter Lend positions with debt on xStock collateral, priced at Kamino's xStock prices (the scan's other half). */
async function liveJupiter(upstream: string, kamino: Row[]): Promise<Row[]> {
  void kamino;
  const prices = new Map<string, number>();
  for (const [market] of Object.entries(XSTOCKS_MARKETS)) for (const a of await gpa(upstream, Reserve.layout.span + 8, market)) {
    const r = Reserve.decode(a.data);
    prices.set(r.liquidity.mintPubkey, Number(BigInt(r.liquidity.marketPriceSf.toString())) / SF);
  }
  const { PublicKey } = await import('@solana/web3.js');
  const pk = (b: Buffer) => new PublicKey(b).toBase58();
  const configs = (await jlGpa(upstream, [99, 86, 43, 216, 184, 102, 119, 77])).map(({ data: d }) => ({ id: d.readUInt16LE(8), lt: d.readUInt16LE(16) / 1000,
    supply: pk(d.subarray(154, 186)), borrow: pk(d.subarray(186, 218)) })).filter((v) => v.supply.startsWith('Xs'));
  const states = new Map((await jlGpa(upstream, [228, 196, 82, 165, 98, 210, 235, 152])).map(({ data: d }) => [d.readUInt16LE(8), d] as const));
  const rows: Row[] = [];
  for (const v of configs) {
    const st = states.get(v.id);
    const px = prices.get(v.supply);
    if (!st || !px) continue;
    const [supEx, borEx] = [st.readBigUInt64LE(99), st.readBigUInt64LE(107)];
    const sym = MINTS[v.supply] ?? v.supply.slice(0, 6);
    for (const { key, data: d } of await jlGpa(upstream, [170, 188, 143, 228, 122, 64, 247, 208], [{ memcmp: { offset: 8, bytes: Buffer.from([v.id & 255, v.id >> 8]).toString('base64'), encoding: 'base64' } }])) {
      const tick = d.readInt32LE(47), colRaw = d.readBigUInt64LE(55);
      if (d[46] !== 0 || tick <= -16383 || colRaw === 0n) continue;
      const col = Number((colRaw * supEx) / 10n ** 12n) / 1e9;
      const debt = Number(((((jlRatio(tick) * (colRaw + 1n)) >> 48n) + 1n) * borEx) / 10n ** 12n) / 1e9;
      rows.push({ obligation: key, market: 'Jupiter Lend', symbol: sym, debtUsd: debt, coveredUsd: col * px * v.lt, xShare: 1,
        eligible: COVERED.has(sym) && MINTS[v.borrow] === 'USDC' });
    }
  }
  return rows;
}

function fromFile() {
  const f = latest('data/positions', /^positions-\d+\.json$/);
  if (!f) throw new Error('no data/positions scan (run scripts/src/positions.ts)');
  const d = readJson<{ summary: { generatedAt: string }; positions: { obligation: string; market: string; eligible: boolean; eligibleB1?: boolean; deposits: { symbol: string; valueUsd: number }[];
    depositedUsd: number; debtUsd: number; coveredValueUsd: number }[];
    jupiterLend?: { positions: { position: string; asset: string; debtUsd: number; coveredValueUsd: number; eligibleB2: boolean }[] } }>(f);
  const rows = d.positions.filter((p) => p.debtUsd > 0).map((p) => {
    const x = p.deposits.filter((q) => COVERED.has(q.symbol));
    return { obligation: p.obligation, market: p.market, symbol: x.map((q) => q.symbol).join('+'), debtUsd: p.debtUsd, coveredUsd: p.coveredValueUsd,
      xShare: p.depositedUsd > 0 ? x.reduce((s2, q) => s2 + q.valueUsd, 0) / p.depositedUsd : 1, eligible: p.eligibleB1 ?? p.eligible };
  }).filter((r) => r.symbol);
  const jl: Row[] = (d.jupiterLend?.positions ?? []).map((p) => ({ obligation: p.position, market: 'Jupiter Lend', symbol: p.asset, debtUsd: p.debtUsd,
    coveredUsd: p.coveredValueUsd, xShare: 1, eligible: p.eligibleB2 }));
  return withLenders(rows, jl, `mainnet scan file ${f} (values brought to the scan time)`, d.summary.generatedAt);
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
