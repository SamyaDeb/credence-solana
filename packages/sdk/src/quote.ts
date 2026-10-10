// Quotes. Single positions: the program's own `quote_cover` / `quote_cover_multi`, or the buy itself, run in a
// simulation and read from its return data. Books: the program's leg pricing + `risk-core::book_premium`, which do
// not fit one instruction, so the SDK asks the helper that runs them (`examples/book_quote.rs`):
//   (b) `bookQuoteHttp(url, request)` — the app's `/api/book-quote` (works in the browser and Node), or
//   (c) `bookQuoteLocal(...)` from `@credence/sdk/node` — spawns the helper (needs the repo and a Rust toolchain).
// Nothing here prices anything: the SDK re-implements no premium, loss, probability or tick math.
import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from '@solana/web3.js';
import { type Asset, type EpochView, type Quote, simulateQuote } from './cover';
import { type CoreProgram, bn, pdas, view } from './core';
import { toError } from './errors';
import { simulateReturn } from './simulate';

export type { Quote };
/** `quote_cover` for one xStock deposit and a USDC debt, priced as `buy_cover` prices it at `epoch`. */
export const quoteSingle = simulateQuote;

export type MultiQuote = { premium: bigint; worstLoss: bigint; utilAfterWad: bigint; groupWorstAfter: bigint; cu: number };

/** `quote_cover_multi(legs, stable, debt, max_payout)`: the premium of a multi-collateral position (legs: covered values, USDC base units). */
export async function quoteMulti(conn: Connection, prog: CoreProgram, payer: PublicKey, a: { assets: Asset[]; epochs: Pick<EpochView, 'closureId' | 'key'>[]; legs: bigint[]; stable: bigint; debt: bigint; maxPayout: bigint }): Promise<MultiQuote> {
  const ix = await prog.methods.quoteCoverMulti(a.legs.map(bn), bn(a.stable), bn(a.debt), bn(a.maxPayout))
    .accountsPartial({ config: pdas.config() })
    .remainingAccounts(a.assets.flatMap((s, i) => [
      { pubkey: s.key, isSigner: false, isWritable: false },
      { pubkey: pdas.scen(s.ticker), isSigner: false, isWritable: false },
      { pubkey: a.epochs[i].key, isSigner: false, isWritable: false },
    ])).instruction();
  const r = await simulateReturn(conn, payer, [ix]);
  if (!r.data || r.data.length < 32) throw new Error('quote_cover_multi returned no data');
  const v = view(r.data);
  return { premium: v.getBigUint64(0, true), worstLoss: v.getBigUint64(8, true), utilAfterWad: v.getBigUint64(16, true), groupWorstAfter: v.getBigUint64(24, true), cu: r.cu };
}

/** The simulated buy's premium for Jupiter Lend (and any buy whose quote is the buy itself): send the buy's instructions
 * with a `maxPremium` of `u64::MAX` and read the Policy's premium from the simulation. `policy` is the Policy PDA. */
export async function quoteByBuy(conn: Connection, prog: CoreProgram, payer: PublicKey, ixs: import('@solana/web3.js').TransactionInstruction[], policy: PublicKey): Promise<{ premium: bigint; maxPayout: bigint; cu: number }> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  const msg = tx.compileMessage();
  const r = await conn.simulateTransaction(msg as never, undefined, [policy] as never);
  if (r.value.err) throw toError(r.value.err, r.value.logs, tx.instructions.map((i) => i.programId));
  const acc = r.value.accounts?.[0];
  if (!acc) throw new Error('the simulation returned no policy');
  const p = prog.coder.accounts.decode('policy', Buffer.from(acc.data[0], 'base64')) as { premium: { toString(): string }; maxPayout: { toString(): string } };
  return { premium: BigInt(p.premium.toString()), maxPayout: BigInt(p.maxPayout.toString()), cu: r.value.unitsConsumed ?? 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Book quote
// ---------------------------------------------------------------------------------------------------------------

export type BookQuoteLeg = { id: string; standalone: string; extra: string; e: string; loading: string };
/** The reply of `examples/book_quote.rs` / `/api/book-quote`; amounts are decimal strings in USDC base units. */
export type BookQuote = { legs: BookQuoteLeg[]; book: { premium: string; expectedLoss?: string; base?: string; loading?: string } | null; sumStandalone: string; minPremium: string; missing: number; caveat?: string };

/** (b) POST `{ ids, target }` to the app's `/api/book-quote` (position ids from the scan, C1's format). */
export async function bookQuoteHttp(baseUrl: string, req: { ids: string[]; target?: string | null }, fetchImpl: typeof fetch = fetch): Promise<BookQuote> {
  const r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/book-quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  const j = (await r.json()) as BookQuote & { error?: string };
  if (!r.ok) throw new Error(`book quote failed: ${j.error ?? r.status}`);
  return j;
}
