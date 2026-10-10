// Curator book flow (C2) as unsigned instructions: openBook → addBookLegs (batches, resumable from chain state) →
// sealBook, and voidBookLeg / claimBookRefund. The SDK never signs or sends; the payer's wallet does.
// A whole book does not fit one simulated instruction: quote it with `bookQuote*` (quote.ts), then buy it in batches.
import { PublicKey, SystemProgram, TransactionInstruction, AddressLookupTableProgram } from '@solana/web3.js';
import { jlTick, jlVaultState } from './build';
import { type CoreProgram, KLEND, TOKEN, USDC_MINT, XSTOCKS_MARKETS, ata, big, bn, pdas, ticker8 } from './core';
import { assertNoJupiterWithKlend } from './guard';
import { type ObligationState, type ReserveState, borrows, deposits, refreshIxs } from './kamino';

export const BOOK_STATE = { OPEN: 0, SEALED: 1, VOIDED: 2 } as const;
/** Legs per v0 transaction with a lookup table of the shared accounts (measured, plan/09 "Phase C, C2"). */
export const KAMINO_LEGS_PER_TX = 6;
export const JUPITER_LEGS_PER_TX = 3;

export function bookAddresses(payer: PublicKey, closureId: number, bookId: number) {
  const book = pdas.book(payer, closureId, bookId);
  return { book, escrow: pdas.bookEscrow(book), payerUsdc: ata(payer, USDC_MINT) };
}

export type BookView = {
  key: PublicKey; payer: PublicKey; payerUsdc: PublicKey; escrow: PublicKey; state: number; closureId: number; bookId: number; createdAt: number; expiresAt: number;
  legsAdded: number; legsLive: number; legsDone: number; escrowed: bigint; premium: bigint; fee: bigint; refundOwed: bigint; refunded: bigint; advanced: bigint; paidOut: bigint;
};
const bookView = (key: PublicKey, b: Record<string, unknown>): BookView => ({
  key, payer: b.payer as PublicKey, payerUsdc: b.payerUsdc as PublicKey, escrow: b.escrow as PublicKey, state: Number(b.state), closureId: Number(b.closureId), bookId: Number(b.bookId),
  createdAt: Number(big(b.createdAt as never)), expiresAt: Number(big(b.expiresAt as never)), legsAdded: Number(b.legsAdded), legsLive: Number(b.legsLive), legsDone: Number(b.legsDone),
  escrowed: big(b.escrowed as never), premium: big(b.premium as never), fee: big(b.fee as never), refundOwed: big(b.refundOwed as never), refunded: big(b.refunded as never),
  advanced: big(b.advanced as never), paidOut: big(b.paidOut as never),
});

/** The book at `key`, or null if it was never opened. */
export async function readBook(prog: CoreProgram, key: PublicKey): Promise<BookView | null> {
  const b = await prog.account.book.fetchNullable(key);
  return b ? bookView(key, b) : null;
}

export async function readBooksOf(prog: CoreProgram, payer: PublicKey): Promise<BookView[]> {
  // Book is zero-copy: `payer` follows the 8-byte discriminator and the 256-scenario loss vector.
  const rows = (await prog.account.book.all()) as { publicKey: PublicKey; account: Record<string, unknown> }[];
  return rows.map((r) => bookView(r.publicKey, r.account)).filter((b) => b.payer.equals(payer)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function openBook(prog: CoreProgram, a: { payer: PublicKey; closureId: number; bookId: number; epoch: PublicKey }): Promise<{ ix: TransactionInstruction; book: PublicKey }> {
  const { book, escrow, payerUsdc } = bookAddresses(a.payer, a.closureId, a.bookId);
  const ix = await prog.methods.openBook(a.closureId, a.bookId).accountsPartial({ payer: a.payer, epoch: a.epoch, book, escrow, usdcMint: USDC_MINT, payerUsdc, tokenProgram: TOKEN }).instruction();
  return { ix, book };
}

export type BookLegSpec =
  | { kind: 'kamino'; ticker: string; obligation: PublicKey; o: ObligationState; reserves: Map<string, ReserveState> }
  | { kind: 'jupiter'; ticker: string; position: PublicKey; vaultId: number; tick: number; vaultConfig: PublicKey; cache: PublicKey };

const policyOf = (ticker: string, closureId: number, position: PublicKey) => pdas.policy(pdas.epoch(ticker, closureId), position);
export const legPosition = (l: BookLegSpec) => (l.kind === 'kamino' ? l.obligation : l.position);

/** One add-leg instruction (without the lender's refreshes; `addBookLegs` adds those once per batch). */
export async function addBookLegIx(prog: CoreProgram, a: { payer: PublicKey; book: PublicKey; closureId: number; leg: BookLegSpec }): Promise<TransactionInstruction> {
  const { payer, book, closureId, leg } = a;
  const t = leg.ticker;
  const base = { payer, asset: pdas.asset(t), scenarios: pdas.scen(t), epoch: pdas.epoch(t, closureId), loss: pdas.loss(closureId), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
    book, escrow: pdas.bookEscrow(book), payerUsdc: ata(payer, USDC_MINT), policy: policyOf(t, closureId, legPosition(leg)), tokenProgram: TOKEN };
  if (leg.kind === 'kamino') {
    const [dep] = deposits(leg.o);
    const [bor] = borrows(leg.o);
    return prog.methods.addBookLeg(ticker8(t), closureId).accountsPartial({ ...base, obligation: leg.obligation, depositReserve: dep, borrowReserve: bor }).instruction();
  }
  return prog.methods.addBookLegJl(ticker8(t), closureId).accountsPartial({ ...base, position: leg.position, vaultConfig: leg.vaultConfig, vaultState: jlVaultState(leg.vaultId),
    positionTick: jlTick(leg.vaultId, leg.tick), cache: leg.cache }).instruction();
}

/**
 * Splits legs into transactions: Kamino legs `kaminoPerTx` at a time (the reserves' refreshes once, then each
 * obligation's refresh, then the adds), Jupiter legs `jupiterPerTx` at a time (no refreshes). Each element is the
 * instruction list of one v0 transaction; send them with the book's lookup table. A transaction never mixes lenders
 * (`assertNoJupiterWithKlend`). A batch that fails (a position changed since the scan) can be retried leg by leg:
 * `addBookLegs(prog, {..., legs: [leg]})`.
 */
export async function addBookLegs(prog: CoreProgram, a: { payer: PublicKey; book: PublicKey; closureId: number; legs: BookLegSpec[]; kaminoPerTx?: number; jupiterPerTx?: number }): Promise<TransactionInstruction[][]> {
  const kPer = a.kaminoPerTx ?? KAMINO_LEGS_PER_TX;
  const jPer = a.jupiterPerTx ?? JUPITER_LEGS_PER_TX;
  const kamino = a.legs.filter((l): l is Extract<BookLegSpec, { kind: 'kamino' }> => l.kind === 'kamino');
  const jupiter = a.legs.filter((l): l is Extract<BookLegSpec, { kind: 'jupiter' }> => l.kind === 'jupiter');
  const txs: TransactionInstruction[][] = [];
  for (let i = 0; i < kamino.length; i += kPer) {
    const batch = kamino.slice(i, i + kPer);
    const ixs: TransactionInstruction[] = [];
    // The reserves are refreshed once per batch (every refresh_reserve of the first obligation), then one
    // refresh_obligation per obligation (the last instruction of its refresh list).
    const first = refreshIxs(batch[0].obligation, batch[0].o, batch[0].reserves);
    ixs.push(...first.slice(0, -1));
    const seen = new Set(ixs.map((x) => x.keys[0].pubkey.toBase58()));
    for (const l of batch) {
      const r = refreshIxs(l.obligation, l.o, l.reserves);
      for (const x of r.slice(0, -1)) if (!seen.has(x.keys[0].pubkey.toBase58())) { seen.add(x.keys[0].pubkey.toBase58()); ixs.push(x); }
      ixs.push(r[r.length - 1]);
    }
    for (const l of batch) ixs.push(await addBookLegIx(prog, { payer: a.payer, book: a.book, closureId: a.closureId, leg: l }));
    txs.push(assertNoJupiterWithKlend(ixs));
  }
  for (let i = 0; i < jupiter.length; i += jPer) {
    const ixs: TransactionInstruction[] = [];
    for (const l of jupiter.slice(i, i + jPer)) ixs.push(await addBookLegIx(prog, { payer: a.payer, book: a.book, closureId: a.closureId, leg: l }));
    txs.push(assertNoJupiterWithKlend(ixs));
  }
  return txs;
}

export type LegStatus = 'pending' | 'in-this-book' | 'covered-elsewhere';
/**
 * Resume from chain state: which of `legs` the book already holds (its policy exists with `book` = this book), which
 * are covered by an owner or another book (adding them would fail), and which are still to add.
 */
export async function bookLegStatus(prog: CoreProgram, a: { book: PublicKey; closureId: number; legs: BookLegSpec[] }): Promise<{ leg: BookLegSpec; status: LegStatus }[]> {
  const keys = a.legs.map((l) => policyOf(l.ticker, a.closureId, legPosition(l)));
  const infos = await prog.provider.connection.getMultipleAccountsInfo(keys, 'confirmed');
  return Promise.all(a.legs.map(async (leg, i) => {
    if (!infos[i]) return { leg, status: 'pending' as const };
    const p = await prog.account.policy.fetchNullable(keys[i]);
    return { leg, status: p?.book && (p.book as PublicKey).equals(a.book) ? ('in-this-book' as const) : ('covered-elsewhere' as const) };
  }));
}

/** Shared accounts of a book's add-leg transactions, for its address lookup table (deduplicated). */
export function bookLookupAddresses(a: { payer: PublicKey; book: PublicKey; closureId: number; tickers: string[]; extra?: PublicKey[] }): PublicKey[] {
  const keys = [pdas.config(), pdas.vault(), pdas.vaultUsdc(), pdas.shares(), pdas.loss(a.closureId), a.book, pdas.bookEscrow(a.book), ata(a.payer, USDC_MINT), TOKEN, SystemProgram.programId, KLEND,
    ...a.tickers.flatMap((t) => [pdas.asset(t), pdas.scen(t), pdas.epoch(t, a.closureId)]), ...Object.keys(XSTOCKS_MARKETS).map((m) => new PublicKey(m)), ...(a.extra ?? [])];
  return [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
}

/** Create + extend instructions for a lookup table (the authority signs; wait one slot after the last extend before using it). */
export function lookupTableIxs(authority: PublicKey, recentSlot: number, addresses: PublicKey[]) {
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority, payer: authority, recentSlot });
  const extend: TransactionInstruction[] = [];
  for (let i = 0; i < addresses.length; i += 20) extend.push(AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority, payer: authority, addresses: addresses.slice(i, i + 20) }));
  return { create, extend, table };
}

/** `seal_book(max_premium)`. `maxPremium` bounds what the seal may charge: use `defaultSealMax`. */
export async function sealBook(prog: CoreProgram, a: { payer: PublicKey; book: PublicKey; closureId: number; maxPremium: bigint; feeAccount: PublicKey }): Promise<TransactionInstruction> {
  return prog.methods.sealBook(bn(a.maxPremium)).accountsPartial({ payer: a.payer, book: a.book, escrow: pdas.bookEscrow(a.book), payerUsdc: ata(a.payer, USDC_MINT), loss: pdas.loss(a.closureId),
    vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: a.feeAccount, tokenProgram: TOKEN }).instruction();
}

/** The most the seal may charge (audit A-89): the escrow (an upper bound of the premium at each add's utilisation) + 10%. */
export const defaultSealMax = (escrowed: bigint) => (escrowed * 11n) / 10n;

/** `void_book_leg`: anyone, on an OPEN book past its expiry; releases the leg's capacity. */
export async function voidBookLeg(prog: CoreProgram, a: { caller: PublicKey; closureId: number; ticker: string; policy: PublicKey; book: PublicKey; rentPayer: PublicKey; extra?: { ticker: string }[] }): Promise<TransactionInstruction> {
  // A multi-collateral leg passes its further legs' [asset, epoch].
  const rest = (a.extra ?? []).flatMap((e) => [{ pubkey: pdas.asset(e.ticker), isSigner: false, isWritable: false }, { pubkey: pdas.epoch(e.ticker, a.closureId), isSigner: false, isWritable: true }]);
  return prog.methods.voidBookLeg().accountsPartial({ caller: a.caller, epoch: pdas.epoch(a.ticker, a.closureId), policy: a.policy, loss: pdas.loss(a.closureId), book: a.book,
    asset: pdas.asset(a.ticker), rentPayer: a.rentPayer }).remainingAccounts(rest).instruction();
}

/** `claim_book_refund`: anyone; refunds go only to the payer's recorded USDC account. A VOIDED book still holding its escrow passes it. */
export async function claimBookRefund(prog: CoreProgram, a: { caller: PublicKey; book: BookView; escrowLive: boolean }): Promise<TransactionInstruction> {
  return prog.methods.claimBookRefund().accountsPartial({ caller: a.caller, book: a.book.key, escrow: a.book.state === BOOK_STATE.VOIDED && a.escrowLive ? a.book.escrow : null,
    payer: a.book.payer, payerUsdc: a.book.payerUsdc, vaultUsdc: pdas.vaultUsdc() }).instruction();
}
