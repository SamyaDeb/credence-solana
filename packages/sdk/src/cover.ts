// Buying cover from the app (task 4.2). The quote is the program's own `quote_cover`, run in a simulation and read
// from its return data; `buy_cover` follows klend's refreshes in one transaction. Nothing here prices anything.
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { type CoreProgram, EPOCH, TOKEN, USDC_MINT, ata, big, bn, pdas, tickerStr, view } from './core';
import { type ObligationState, type ReserveState, borrows, deposits, refreshIxs } from './kamino';
import { simulateReturn } from './simulate';

export const BELL_BEFORE_CLOSE = 15 * 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row<T = any> = { publicKey: PublicKey; account: T };

export type Asset = { key: PublicKey; ticker: string; tickerBytes: number[]; mint: PublicKey; sigmaWad: bigint;
  settleSource: number; scopeChain: number; reserves: string[]; enabled: boolean; feedXstock: number[] };

/** Kamino's xStocks in display order (W16: all eight); a Jupiter alias `<T>.J` sorts after its xStock. */
const ORDER = ['SPYx', 'QQQx', 'NVDAx', 'TSLAx', 'GOOGLx', 'AAPLx', 'MSTRx', 'HOODx'];
const order = (t: string) => { const i = ORDER.indexOf(t.replace(/\.J$/, '')); return (i < 0 ? ORDER.length : i) * 2 + (t.endsWith('.J') ? 1 : 0); };

export async function loadAssets(prog: CoreProgram): Promise<Asset[]> {
  // Kamino assets only: a Jupiter Lend alias (`<T>.J`, lender 1, W12) has no Kamino reserves; its policies are bought
  // through buy_cover_jl (keeper / Demo → Jupiter Lend) and its positions appear in Risk's lender table.
  const rows = ((await prog.account.assetConfig.all()) as Row[]).filter(({ account: a }) => Number(big(a.lender ?? 0)) === 0);
  return rows.map(({ publicKey, account: a }) => ({
    key: publicKey,
    ticker: tickerStr(a.ticker),
    tickerBytes: a.ticker as number[],
    mint: a.mint as PublicKey,
    sigmaWad: big(a.sigmaWad),
    settleSource: Number(big(a.settleSource)),
    scopeChain: Number(big(a.scopeChain)),
    reserves: (a.kaminoReserves as PublicKey[]).map((k) => k.toBase58()),
    enabled: a.enabled === 1,
    feedXstock: a.feedXstock as number[],
  })).sort((x, y) => order(x.ticker) - order(y.ticker));
}

/** Kamino reserve → the covered asset whose reserve it is. */
export const reserveToAsset = (assets: Asset[]) =>
  new Map(assets.flatMap((a) => a.reserves.filter((r) => r !== PublicKey.default.toBase58()).map((r) => [r, a] as const)));

export type EpochView = { key: PublicKey; ticker: string; closureId: number; closureType?: number; state: number; saleOpen: number; bell: number;
  close: number; open: number; settleAfter: number; settledAt: number; closePriceWad: bigint; settlePriceWad: bigint;
  policyCount: number; policiesSettled: number; totalMaxPayout: bigint; totalPremium: bigint; totalPayout: bigint; worstLossSum: bigint };

export function epochView(r: Row): EpochView {
  const e = r.account;
  return {
    key: r.publicKey, ticker: tickerStr(e.ticker), closureId: e.closureId, closureType: e.closureType ?? 2, state: e.state,
    saleOpen: Number(big(e.saleOpen)), bell: Number(big(e.bell)), close: Number(big(e.close)), open: Number(big(e.open)),
    settleAfter: Number(big(e.settleAfter)), settledAt: Number(big(e.settledAt)),
    closePriceWad: big(e.closePriceWad), settlePriceWad: big(e.settlePriceWad),
    policyCount: e.policyCount, policiesSettled: e.policiesSettled, totalMaxPayout: big(e.totalMaxPayout),
    totalPremium: big(e.totalPremium), totalPayout: big(e.totalPayout), worstLossSum: big(e.worstLossSum),
  };
}

export async function loadEpochs(prog: CoreProgram): Promise<EpochView[]> {
  return ((await prog.account.epoch.all()) as Row[]).map(epochView).sort((a, b) => a.closureId - b.closureId || a.ticker.localeCompare(b.ticker));
}

/** Sales state of an epoch at chain time `now` (INV-3: sales close at the bell, 15 minutes before the close). */
export function salesState(e: EpochView, now: number): { label: 'open' | 'not yet open' | 'closed'; until?: number } {
  if (e.state !== EPOCH.OPEN || now >= e.bell) return { label: 'closed' };
  if (now < e.saleOpen) return { label: 'not yet open', until: e.saleOpen };
  return { label: 'open', until: e.bell };
}

/** The epoch a buyer would cover now: the earliest open epoch of the asset whose bell is still ahead. */
export const currentEpoch = (epochs: EpochView[], ticker: string, now: number) =>
  epochs.find((e) => e.ticker === ticker && e.state === EPOCH.OPEN && now < e.bell && now >= e.saleOpen);

/** Scope (price, TWAP) chains the reserves price from (65535 = unused). */
export function scopeChains(reserves: ReserveState[]): { price: number; twap: number | null }[] {
  const out = new Map<number, number | null>();
  for (const r of reserves) {
    const s = r.config.tokenInfo.scopeConfiguration;
    const twap = s.twapChain[0] !== 65535 ? s.twapChain[0] : null;
    for (const c of s.priceChain) if (c !== 65535) out.set(c, twap);
  }
  return [...out].map(([price, twap]) => ({ price, twap }));
}

export type Freshened = { now: number; pairs: { price: number; twap: number | null; value: number; twapAligned: boolean }[] };

/** FORK ONLY: moves the Scope chains' refresh time to the fork clock so klend accepts the prices (see the route). */
export async function freshenScope(pairs: { price: number; twap: number | null }[]): Promise<Freshened> {
  const r = await fetch('/api/fork/scope-fresh', { method: 'POST', body: JSON.stringify({ pairs }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j as Freshened;
}

export type Quote = { premium: bigint; worstLoss: bigint; utilAfterWad: bigint; groupWorstAfter: bigint; cu: number };

/** `quote_cover(covered_value, debt, max_payout)` in a simulation for `epoch`, priced as `buy_cover` prices it there
 * (the closure type's set and σ, the earnings bump, the length); the premium is the program's return data. */
export async function simulateQuote(conn: Connection, prog: CoreProgram, payer: PublicKey, asset: Asset,
  epoch: Pick<EpochView, 'closureId' | 'closureType'>, coveredValue: bigint, debt: bigint, maxPayout: bigint): Promise<Quote> {
  const group = epoch.closureId;
  const ix: TransactionInstruction = await prog.methods
    .quoteCover(bn(coveredValue), bn(debt), bn(maxPayout))
    .accountsPartial({ config: pdas.config(), asset: asset.key, scenarios: pdas.scen(asset.ticker, epoch.closureType ?? 2), vault: pdas.vault(),
      loss: pdas.loss(group), shareMint: pdas.shares(), epoch: pdas.epoch(asset.ticker, group), earnings: pdas.earnings(asset.ticker) })
    .instruction();
  const r = await simulateReturn(conn, payer, [ix]);
  if (!r.data || r.data.length < 32) throw new Error('quote_cover returned no data');
  const v = view(r.data);
  return { premium: v.getBigUint64(0, true), worstLoss: v.getBigUint64(8, true), utilAfterWad: v.getBigUint64(16, true),
    groupWorstAfter: v.getBigUint64(24, true), cu: r.cu };
}

/** refresh_reserve ×N, refresh_obligation, buy_cover: the one transaction the buy button sends. */
export async function buyCoverIxs(prog: CoreProgram, buyer: PublicKey, asset: Asset, epoch: EpochView, obligation: PublicKey,
  o: ObligationState, reserves: Map<string, ReserveState>, feeAccount: PublicKey, maxPayout: bigint, maxPremium: bigint) {
  const [dep] = deposits(o);
  const [bor] = borrows(o);
  const policy = pdas.policy(epoch.key, obligation);
  const buy: TransactionInstruction = await prog.methods
    .buyCover(asset.tickerBytes, epoch.closureId, bn(maxPayout), bn(maxPremium))
    .accountsPartial({
      buyer, asset: asset.key, scenarios: pdas.scen(asset.ticker, epoch.closureType ?? 2), epoch: epoch.key, earnings: pdas.earnings(asset.ticker), loss: pdas.loss(epoch.closureId),
      vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount, buyerUsdc: ata(buyer, USDC_MINT), obligation,
      depositReserve: dep, borrowReserve: bor, policy, tokenProgram: TOKEN,
    })
    .instruction();
  return { ixs: [...refreshIxs(obligation, o, reserves), buy], policy };
}

export type PolicyView = { key: PublicKey; owner: PublicKey; obligation: PublicKey; epoch: PublicKey; ticker: string; state: number;
  collateralValue: bigint; coveredValue: bigint; debt: bigint; ltWad: bigint; maxPayout: bigint; premium: bigint; fee: bigint;
  worstLoss: bigint; payout: bigint; createdAt: number };

export function policyView(r: Row): PolicyView {
  const p = r.account;
  return {
    key: r.publicKey, owner: p.owner, obligation: p.obligation, epoch: p.epoch, ticker: tickerStr(p.ticker), state: p.state,
    collateralValue: big(p.collateralValue), coveredValue: big(p.coveredValue), debt: big(p.debt), ltWad: big(p.liquidationThresholdWad),
    maxPayout: big(p.maxPayout), premium: big(p.premium), fee: big(p.fee), worstLoss: big(p.worstLoss), payout: big(p.payout),
    createdAt: Number(big(p.createdAt)),
  };
}

/** Policies owned by `owner` (Policy.owner is the first field, right after the 8-byte discriminator). */
export async function policiesOf(prog: CoreProgram, owner: PublicKey): Promise<PolicyView[]> {
  const rows = (await prog.account.policy.all([{ memcmp: { offset: 8, bytes: owner.toBase58() } }])) as Row[];
  return rows.map(policyView).sort((a, b) => b.createdAt - a.createdAt);
}
