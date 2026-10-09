// Curator book cover (C2) keeper job: everything a book needs that is not a leg's shield or settlement (those run in
// jobs.ts `shields` / `settlePolicies`, which route book legs to `shield_book_leg*` / `settle_book_leg*` /
// `close_out_book_leg`):
//   - an OPEN book past `expires_at` (the bell at the latest): `void_book_leg` on each of its legs (capacity released);
//   - refunds: `claim_book_refund` when a VOIDED book still holds its escrow or a book has `refund_owed`;
//   - rent: `close_book_leg` on finished legs once their group has released, `close_book` once a book is done.
// Nothing here can pay a wallet other than the book's own payer (its escrow and refunds), and nothing needs it to sign.
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { BOOK, type Chain, DEFAULT_KEY, POLICY, chainNow, fmtTime, log, pdas, send, tickerStr } from './chain.js';

type Pk = InstanceType<typeof web3.PublicKey>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = { publicKey: Pk; account: any };
export type Report = { sent: string[]; failed: string[]; waiting: string[] };
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());

/** A policy that is a book leg (`book` ≠ default). */
export const isLeg = (pol: { book?: Pk }) => !!pol.book && pol.book.toBase58() !== DEFAULT_KEY;

/** The tickers of a policy's legs, leg 0 first (as jobs.ts `legTickers`). */
function tickers(pol: any): string[] {
  const nl = Number(pol.nLegs ?? 0);
  if (nl === 0) return [tickerStr(pol.ticker as number[])];
  return Array.from({ length: nl }, (_, i) => tickerStr((pol.legTickers as number[]).slice(8 * i, 8 * i + 8)));
}

/** remaining accounts of release/void for a multi-collateral leg: legs 1.. as [asset, epoch (writable)]. */
export function legRest(pol: any, closureId: number) {
  return tickers(pol).slice(1).flatMap((t) => [
    { pubkey: pdas.asset(t), isSigner: false, isWritable: false },
    { pubkey: pdas.epoch(t, closureId), isSigner: false, isWritable: true },
  ]);
}

async function tryTx(r: Report, what: string, f: () => Promise<{ cu: number }>) {
  try {
    const { cu } = await f();
    r.sent.push(what);
    log(`  ok   ${what} (${cu} CU)`);
    return true;
  } catch (e) {
    r.failed.push(what);
    log(`  FAIL ${what}: ${(e as Error).message.split('\n').slice(0, 4).join(' | ')}`);
    return false;
  }
}

/** Every book account, keyed by address. */
export async function allBooks(c: Chain): Promise<Map<string, Row>> {
  return new Map(((await c.program.account.book.all()) as Row[]).map((b) => [b.publicKey.toBase58(), b]));
}

export async function booksJob(c: Chain): Promise<Report> {
  const r: Report = { sent: [], failed: [], waiting: [] };
  const books = await allBooks(c);
  if (books.size === 0) return r;
  const now = await chainNow(c);
  const legs = ((await c.program.account.policy.all()) as Row[]).filter((p) => isLeg(p.account));
  const epochs = new Map(((await c.program.account.epoch.all()) as Row[]).map((e) => [e.publicKey.toBase58(), e]));
  for (const [key, b] of books) {
    const bk = b.account;
    const id = `book ${key.slice(0, 8)} (${bk.closureId})`;
    const mine = legs.filter((p) => p.account.book.toBase58() === key);
    // 1. Unsealed past its expiry: void each live leg.
    if ((bk.state === BOOK.OPEN && now >= n(bk.expiresAt)) || bk.state === BOOK.VOIDED) {
      for (const p of mine.filter((x) => x.account.state === POLICY.ACTIVE)) {
        const pol = p.account;
        const e = epochs.get(pol.epoch.toBase58())!;
        await tryTx(r, `void_book_leg ${id} ${tickers(pol).join('+')} ${pol.obligation.toBase58().slice(0, 8)} (unsealed at ${fmtTime(n(bk.expiresAt))})`, async () =>
          send(c, [await c.program.methods.voidBookLeg()
            .accountsPartial({ caller: c.payer.publicKey, epoch: e.publicKey, policy: p.publicKey, loss: pdas.loss(e.account.closureId), book: b.publicKey,
              asset: pdas.asset(tickers(pol)[0]), rentPayer: pol.rentPayer })
            .remainingAccounts(legRest(pol, e.account.closureId)).instruction()]));
      }
    } else if (bk.state === BOOK.OPEN) {
      r.waiting.push(`${id}: open, ${bk.legsLive} legs, expires ${fmtTime(n(bk.expiresAt))}`);
    }
    // 2. Refunds: the escrow of a voided book, and refunds owed.
    const fresh = (await c.program.account.book.fetch(b.publicKey)) as any;
    const escrowLive = (await c.conn.getAccountInfo(fresh.escrow)) !== null;
    if ((fresh.state === BOOK.VOIDED && escrowLive) || n(fresh.refundOwed) > 0) {
      await tryTx(r, `claim_book_refund ${id}: escrow ${fresh.state === BOOK.VOIDED && escrowLive ? 'back' : 'closed'}, refund ${(n(fresh.refundOwed) / 1e6).toFixed(6)} USDC`, async () =>
        send(c, [await c.program.methods.claimBookRefund()
          .accountsPartial({ caller: c.payer.publicKey, book: b.publicKey, escrow: fresh.state === BOOK.VOIDED && escrowLive ? fresh.escrow : null,
            payer: fresh.payer, payerUsdc: fresh.payerUsdc, vaultUsdc: pdas.vaultUsdc() })
          .instruction()]));
    }
    // 3. Rent (opt-in, BOOK_CLOSE_RENT=1: closing drops the records the app shows): finished legs of a released group,
    // then the book.
    if (process.env.BOOK_CLOSE_RENT !== '1') continue;
    for (const p of mine.filter((x) => x.account.state !== POLICY.ACTIVE)) {
      const e = epochs.get(p.account.epoch.toBase58())!;
      const l = await c.program.account.lossVector.fetch(pdas.loss(e.account.closureId));
      if (l.settled !== 1) continue;
      await tryTx(r, `close_book_leg ${id} ${p.account.obligation.toBase58().slice(0, 8)} (rent to the payer)`, async () =>
        send(c, [await c.program.methods.closeBookLeg()
          .accountsPartial({ caller: c.payer.publicKey, epoch: e.publicKey, policy: p.publicKey, loss: pdas.loss(e.account.closureId), rentPayer: p.account.rentPayer })
          .instruction()]));
    }
    const done = (await c.program.account.book.fetch(b.publicKey)) as any;
    if (done.state !== BOOK.OPEN && done.legsDone === done.legsAdded && n(done.refundOwed) === 0 && n(done.escrowed) === 0) {
      await tryTx(r, `close_book ${id}`, async () =>
        send(c, [await c.program.methods.closeBook().accountsPartial({ caller: c.payer.publicKey, book: b.publicKey, payer: done.payer }).instruction()]));
    }
  }
  return r;
}
