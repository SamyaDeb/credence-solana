// Owner buys (unsigned instructions): every lender and closure type behind one call, with the refreshes, the Jupiter
// accounts, a slippage-bounded `max_premium`, and `release_book_leg` first when a curator's book holds the position.
// The program prices and checks everything; the SDK only assembles accounts. It never holds a key and never sends.
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { type JlAsset, type JlPosition, type Leg, jupiterBuy, kaminoBuy, kaminoMultiBuy } from './build';
import { type Asset, type EpochView, type Row } from './cover';
import { type CoreProgram, TOKEN, USDC_MINT, ata, bn, pdas } from './core';
import { assertNoJupiterWithKlend } from './guard';
import { type ObligationState, type ReserveState, borrows, deposits, refreshIxs } from './kamino';

export const DEFAULT_KEY = PublicKey.default;

/** `max_premium` for a quoted premium: the quote plus `slippageBps`, rounded up (the buyer's bound, so never down). */
export const withSlippage = (premium: bigint, slippageBps: number): bigint => {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new RangeError('slippageBps must be an integer in 0..10000');
  return (premium * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
};

export type BuyCommon = { buyer: PublicKey; feeAccount: PublicKey; maxPayout: bigint; maxPremium: bigint };
/** What a book leg looks like to an owner: the position's policy for this epoch, if any. */
export type BookLegRef = { policy: PublicKey; book: PublicKey; rentPayer: PublicKey };

export type BuyRequest = BuyCommon & (
  | { kind: 'kamino'; side?: 'down' | 'up'; asset: Asset; epoch: EpochView; obligation: PublicKey; o: ObligationState; reserves: Map<string, ReserveState> }
  | { kind: 'kamino-multi'; closureId: number; legs: Leg[]; obligation: PublicKey; o: ObligationState; reserves: Map<string, ReserveState>; borrowReserve: PublicKey; sleeve: PublicKey | null }
  | { kind: 'jupiter'; asset: JlAsset; epoch: Pick<EpochView, 'key' | 'closureId'>; position: PublicKey; pos: JlPosition; nftAccount: PublicKey }
) & {
  /** Set when `readBookLeg` found this position's policy held by a book: `release_book_leg` goes first. */
  release?: BookLegRef & { releaseAsset: PublicKey; releaseEpoch: PublicKey; closureId: number; positionTokenAccount: PublicKey | null };
};

/** `buy_cover_up` (Kamino shorts, paid to the wallet): the refreshes + the UP buy. */
async function kaminoUpBuy(prog: CoreProgram, a: BuyCommon & { asset: Asset; epoch: EpochView; obligation: PublicKey; o: ObligationState; reserves: Map<string, ReserveState> }) {
  const [bor] = borrows(a.o);
  const policy = pdas.policy(a.epoch.key, a.obligation);
  const buy: TransactionInstruction = await prog.methods
    .buyCoverUp(a.asset.tickerBytes, a.epoch.closureId, bn(a.maxPayout), bn(a.maxPremium))
    .accountsPartial({ buyer: a.buyer, asset: a.asset.key, scenarios: pdas.scen(a.asset.ticker, a.epoch.closureType ?? 2), epoch: a.epoch.key, earnings: pdas.earnings(a.asset.ticker),
      loss: pdas.loss(a.epoch.closureId), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: a.feeAccount, buyerUsdc: ata(a.buyer, USDC_MINT),
      obligation: a.obligation, borrowReserve: bor, policy, tokenProgram: TOKEN })
    .instruction();
  return { ixs: [...refreshIxs(a.obligation, a.o, a.reserves), buy], policy };
}

/** `release_book_leg`: the position's owner takes it out of a curator's book before the bell (owner precedence). */
export async function releaseBookLegIx(prog: CoreProgram, a: { owner: PublicKey; epoch: PublicKey; closureId: number; ticker: string; position: PublicKey; leg: BookLegRef;
  asset?: PublicKey; positionTokenAccount?: PublicKey | null }): Promise<TransactionInstruction> {
  return prog.methods.releaseBookLeg().accountsPartial({
    owner: a.owner, epoch: a.epoch, policy: a.leg.policy, loss: pdas.loss(a.closureId), book: a.leg.book, asset: a.asset ?? pdas.asset(a.ticker),
    position: a.position, positionTokenAccount: a.positionTokenAccount ?? null, rentPayer: a.leg.rentPayer,
  }).instruction();
}

/** The book leg that holds `position`'s policy for `epoch`, or null (no policy, or an owner policy). */
export async function readBookLeg(prog: CoreProgram, epoch: PublicKey, position: PublicKey): Promise<BookLegRef | null> {
  const key = pdas.policy(epoch, position);
  const p = await prog.account.policy.fetchNullable(key);
  if (!p || !p.book || (p.book as PublicKey).equals(DEFAULT_KEY)) return null;
  return { policy: key, book: p.book as PublicKey, rentPayer: p.rentPayer as PublicKey };
}

/** The instructions of one owner buy, in order: [release_book_leg,] the lender's refreshes, the buy. Throws
 * `MixedLenderError` if a transaction would mix klend with Jupiter Lend. */
export async function buyCover(prog: CoreProgram, r: BuyRequest): Promise<{ ixs: TransactionInstruction[]; policy: PublicKey }> {
  let built: { ixs: TransactionInstruction[]; policy: PublicKey };
  let ticker: string;
  let position: PublicKey;
  let epochKey: PublicKey;
  let closureId: number;
  if (r.kind === 'kamino') {
    const a = { buyer: r.buyer, feeAccount: r.feeAccount, maxPayout: r.maxPayout, maxPremium: r.maxPremium, asset: r.asset, epoch: r.epoch, obligation: r.obligation, o: r.o, reserves: r.reserves };
    built = r.side === 'up' ? await kaminoUpBuy(prog, a) : await kaminoBuy(prog, a);
    [ticker, position, epochKey, closureId] = [r.asset.ticker, r.obligation, r.epoch.key, r.epoch.closureId];
  } else if (r.kind === 'kamino-multi') {
    built = await kaminoMultiBuy(prog, { buyer: r.buyer, feeAccount: r.feeAccount, maxPayout: r.maxPayout, maxPremium: r.maxPremium, closureId: r.closureId, legs: r.legs,
      obligation: r.obligation, o: r.o, reserves: r.reserves, borrowReserve: r.borrowReserve, sleeve: r.sleeve });
    [ticker, position, epochKey, closureId] = [r.legs[0].ticker, r.obligation, r.legs[0].epoch, r.closureId];
  } else {
    built = await jupiterBuy(prog, { buyer: r.buyer, feeAccount: r.feeAccount, maxPayout: r.maxPayout, maxPremium: r.maxPremium, asset: r.asset, epoch: r.epoch, position: r.position, pos: r.pos, nftAccount: r.nftAccount });
    [ticker, position, epochKey, closureId] = [r.asset.ticker, r.position, r.epoch.key, r.epoch.closureId];
  }
  const ixs = [...built.ixs];
  if (r.release) {
    const rel = await releaseBookLegIx(prog, { owner: r.buyer, epoch: r.release.releaseEpoch ?? epochKey, closureId: r.release.closureId ?? closureId, ticker, position,
      leg: r.release, asset: r.release.releaseAsset, positionTokenAccount: r.release.positionTokenAccount });
    ixs.unshift(rel);
  }
  return { ixs: assertNoJupiterWithKlend(ixs), policy: built.policy };
}

export type { Row };
export { deposits, borrows };
