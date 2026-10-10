// Gap tokens (D2): typed builders and readers. RESEARCH PROTOTYPE, NOT OFFERED: fully collateralized, fork-proven only, and a
// legal review comes before any offer. Unsigned instructions only; the SDK never holds a key and never sends.
//
// One decoder for the series account. The payouts of a settled series are the account's own fields (`downMicro`, `upMicro`,
// the pools); `gapSplit` / `gapBand` below are a display port of `risk-core::gap_token` (vector-tested against the Rust in
// test/gap.test.ts) used only to draw the payout curve of a band before any settlement.
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { type CoreProgram, TOKEN, TOKEN_2022, USDC_MINT, WAD, ata, big, bn, createAtaIx, pdas, ticker8, tickerStr } from './core';
import { PROGRAM_ID } from './core';

export const GAP_DISCLAIMER = 'research prototype, not offered';
export const GAP_STATE = { OPEN: 0, SETTLED: 1, EXPIRED: 2 } as const;
export const GAP_STATE_NAME = ['open', 'settled', 'expired'] as const;
export const GAP_SIDE = { DOWN: 0, UP: 1 } as const;
export const GAP_EXPIRY_SECS = 14 * 86_400;
export const SET_MICRO = 1_000_000;

const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const gapPdas = {
  series: (t: string, closureId: number) => pda([Buffer.from('gseries'), Buffer.from(ticker8(t)), u32le(closureId)]),
  down: (series: PublicKey) => pda([Buffer.from('gdown'), series.toBuffer()]),
  up: (series: PublicKey) => pda([Buffer.from('gup'), series.toBuffer()]),
  collateral: (series: PublicKey) => pda([Buffer.from('gcoll'), series.toBuffer()]),
};

export type GapSeriesView = {
  key: PublicKey; ticker: string; closureId: number; closureType: number; state: 'open' | 'settled' | 'expired';
  downMint: PublicKey; upMint: PublicKey; collateral: PublicKey;
  /** The band, WAD. */
  kWad: bigint; bell: number; expiresAt: number;
  setsOutstanding: bigint;
  /** DOWN's / UP's share of one set in millionths of a USDC; they add up to 1,000,000 once the rate is fixed. */
  downMicro: number; upMicro: number;
  closePriceWad: bigint; settlePriceWad: bigint; closeSource: number; settledAt: number;
  setsSettled: bigint; poolDown: bigint; poolUp: bigint; redeemedDown: bigint; redeemedUp: bigint; paidDown: bigint; paidUp: bigint;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gapSeriesView(key: PublicKey, s: any): GapSeriesView {
  return {
    key, ticker: tickerStr(s.ticker), closureId: s.closureId, closureType: s.closureType, state: GAP_STATE_NAME[s.state as 0 | 1 | 2] ?? 'open',
    downMint: s.downMint, upMint: s.upMint, collateral: s.collateral, kWad: big(s.kWad), bell: Number(big(s.bell)), expiresAt: Number(big(s.expiresAt)),
    setsOutstanding: big(s.setsOutstanding), downMicro: s.downMicro, upMicro: s.upMicro, closePriceWad: big(s.closePriceWad), settlePriceWad: big(s.settlePriceWad),
    closeSource: s.closeSource, settledAt: Number(big(s.settledAt)), setsSettled: big(s.setsSettled), poolDown: big(s.poolDown), poolUp: big(s.poolUp),
    redeemedDown: big(s.redeemedDown), redeemedUp: big(s.redeemedUp), paidDown: big(s.paidDown), paidUp: big(s.paidUp),
  };
}

export async function readGapSeries(prog: CoreProgram, t: string, closureId: number): Promise<GapSeriesView | null> {
  const key = gapPdas.series(t, closureId);
  const s = await prog.account.gapSeries.fetchNullable(key);
  return s ? gapSeriesView(key, s) : null;
}

/** Open series first (soonest closure first), then the settled and expired ones (latest first). */
export async function listGapSeries(prog: CoreProgram): Promise<GapSeriesView[]> {
  const rows = await prog.account.gapSeries.all();
  return rows.map((r: { publicKey: PublicKey; account: unknown }) => gapSeriesView(r.publicKey, r.account)).sort((a: GapSeriesView, b: GapSeriesView) => Number(a.state !== 'open') - Number(b.state !== 'open') || (a.state === 'open' ? a.closureId - b.closureId : b.closureId - a.closureId) || a.ticker.localeCompare(b.ticker));
}

/** USDC base units one token of `side` is worth at the fixed rate, as millionths of a USDC (read from the series, never computed). */
export const gapRate = (s: GapSeriesView, side: 0 | 1): number | null => (s.state === 'open' ? null : side === GAP_SIDE.DOWN ? s.downMicro : s.upMicro);

/** What the series still owes, per side, after the rate is fixed (INV-20: the collateral account holds at least the sum). `null`
 * before the rate is fixed: the pools are 0 then, and what backs the tokens is `setsOutstanding` (the collateral equals it). */
export const gapOwed = (s: GapSeriesView): { down: bigint; up: bigint } | null => (s.state === 'open' ? null : { down: s.poolDown - s.paidDown, up: s.poolUp - s.paidUp });

/** Where a holder's tokens live: Token-2022 associated accounts. */
export const gapAccounts = (s: Pick<GapSeriesView, 'downMint' | 'upMint'>, owner: PublicKey) => ({
  down: ata(owner, s.downMint, TOKEN_2022), up: ata(owner, s.upMint, TOKEN_2022), usdc: ata(owner, USDC_MINT),
});

/** Idempotent creation of the holder's two Token-2022 accounts (a mint needs both to exist). */
export const gapCreateAccountsIxs = (payer: PublicKey, owner: PublicKey, s: Pick<GapSeriesView, 'downMint' | 'upMint'>): TransactionInstruction[] => [
  createAtaIx(payer, owner, s.downMint, TOKEN_2022), createAtaIx(payer, owner, s.upMint, TOKEN_2022),
];

export async function gapInitSeries(prog: CoreProgram, a: { payer: PublicKey; ticker: string; closureId: number; closureType: number }): Promise<TransactionInstruction> {
  const series = gapPdas.series(a.ticker, a.closureId);
  return prog.methods.initGapSeries(ticker8(a.ticker), a.closureId).accountsPartial({
    payer: a.payer, config: pdas.config(), asset: pdas.asset(a.ticker), scenarios: pdas.scen(a.ticker, a.closureType), epoch: pdas.epoch(a.ticker, a.closureId),
    earnings: pdas.earnings(a.ticker), series, downMint: gapPdas.down(series), upMint: gapPdas.up(series), collateral: gapPdas.collateral(series), usdcMint: USDC_MINT,
    tokenProgram: TOKEN, token2022Program: TOKEN_2022, systemProgram: SystemProgram.programId,
  }).instruction();
}

type Holder = { user: PublicKey; series: Pick<GapSeriesView, 'key' | 'downMint' | 'upMint' | 'collateral'> };

/** Deposits `amount` USDC (base units) and mints `amount` of each side. Includes creating the holder's two token accounts. */
export async function gapMintSet(prog: CoreProgram, a: Holder & { amount: bigint }): Promise<TransactionInstruction[]> {
  const t = gapAccounts(a.series, a.user);
  const ix: TransactionInstruction = await prog.methods.mintGapSet(bn(a.amount)).accountsPartial({
    user: a.user, config: pdas.config(), series: a.series.key, downMint: a.series.downMint, upMint: a.series.upMint, collateral: a.series.collateral,
    userUsdc: t.usdc, userDown: t.down, userUp: t.up, tokenProgram: TOKEN, token2022Program: TOKEN_2022,
  }).instruction();
  return [...gapCreateAccountsIxs(a.user, a.user, a.series), ix];
}

/** Burns `amount` of DOWN and of UP for USDC. Always available. */
export async function gapMergeSet(prog: CoreProgram, a: Holder & { amount: bigint }): Promise<TransactionInstruction> {
  const t = gapAccounts(a.series, a.user);
  return prog.methods.mergeGapSet(bn(a.amount)).accountsPartial({
    user: a.user, series: a.series.key, downMint: a.series.downMint, upMint: a.series.upMint, collateral: a.series.collateral,
    userUsdc: t.usdc, userDown: t.down, userUp: t.up, tokenProgram: TOKEN, token2022Program: TOKEN_2022,
  }).instruction();
}

const settleAccts = (caller: PublicKey, s: Pick<GapSeriesView, 'key' | 'ticker' | 'closureId' | 'downMint' | 'upMint'>) => ({
  caller, series: s.key, epoch: pdas.epoch(s.ticker, s.closureId), downMint: s.downMint, upMint: s.upMint, token2022Program: TOKEN_2022,
});

/** Anyone: fixes the rate from the series' own settled (or voided) epoch. */
export const gapSettleSeries = (prog: CoreProgram, a: { caller: PublicKey; series: Pick<GapSeriesView, 'key' | 'ticker' | 'closureId' | 'downMint' | 'upMint'> }): Promise<TransactionInstruction> =>
  prog.methods.settleGapSeries().accountsPartial(settleAccts(a.caller, a.series)).instruction();

/** Anyone, 14 days after the epoch should have settled and has not: 0.5 per token. */
export const gapExpireSeries = (prog: CoreProgram, a: { caller: PublicKey; series: Pick<GapSeriesView, 'key' | 'ticker' | 'closureId' | 'downMint' | 'upMint'> }): Promise<TransactionInstruction> =>
  prog.methods.expireGapSeries().accountsPartial(settleAccts(a.caller, a.series)).instruction();

/** Burns `amount` tokens of `side` and pays their share at the fixed rate. Always available once the rate is fixed. */
export async function gapRedeem(prog: CoreProgram, a: Holder & { side: 0 | 1; amount: bigint }): Promise<TransactionInstruction> {
  const t = gapAccounts(a.series, a.user);
  return prog.methods.redeemGap(a.side, bn(a.amount)).accountsPartial({
    user: a.user, series: a.series.key, gapMint: a.side === GAP_SIDE.DOWN ? a.series.downMint : a.series.upMint, collateral: a.series.collateral,
    userUsdc: t.usdc, userGap: a.side === GAP_SIDE.DOWN ? t.down : t.up, tokenProgram: TOKEN, token2022Program: TOKEN_2022,
  }).instruction();
}

// ---------------------------------------------------------------------------------------------------------------------
// Display port of risk-core::gap_token (payout curve of a band before settlement). Vector-tested against the Rust.
// ---------------------------------------------------------------------------------------------------------------------
const BAND_M = 2_500_000_000_000_000_000n;
const BAND_MIN = 20_000_000_000_000_000n;
const BAND_MAX = 300_000_000_000_000_000n;
const BAND_STEP = 5_000_000_000_000_000n;
const MICRO_WAD = 1_000_000_000_000n;

/** The band for a closure's σ (WAD): 2.5 σ rounded up to 0.5%, clamped to [2%, 30%]. */
export function gapBand(sigmaWad: bigint): bigint {
  const raw = (sigmaWad * BAND_M) / WAD;
  const up = ((raw + BAND_STEP - 1n) / BAND_STEP) * BAND_STEP;
  return up < BAND_MIN ? BAND_MIN : up > BAND_MAX ? BAND_MAX : up;
}

/** `[down, up]` in millionths of a USDC for a gap `r` (WAD, signed) and band `k`. DOWN rounds down, UP is the complement. */
export function gapSplit(rWad: bigint, kWad: bigint): [number, number] {
  if (kWad <= 0n || kWad > BAND_MAX) throw new Error('InvalidInput');
  const x = rWad < -kWad ? -kWad : rWad > kWad ? kWad : rWad;
  const down = Number((((kWad - x) * WAD) / (2n * kWad)) / MICRO_WAD);
  return [down, SET_MICRO - down];
}
