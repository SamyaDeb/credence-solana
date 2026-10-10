// A curator's book as unsigned transactions: open → add legs in batches (resumable) → seal.
// The SDK builds; the payer's wallet signs and sends each one (with the book's lookup table for the add-leg batches).
//   RPC_URL=… PAYER=<pubkey> SPECS=./legs.json pnpm tsx examples/book-flow.ts      (see README "Books")
import { Connection, PublicKey } from '@solana/web3.js';
import {
  addBookLegs, bookAddresses, bookLegStatus, bookQuoteHttp, currentEpoch, chainNow, defaultSealMax, loadEpochs, openBook, program, readBook, sealBook, type BookLegSpec, pdas,
} from '@credence/sdk';

const conn = new Connection(process.env.RPC_URL ?? 'http://127.0.0.1:8899', 'confirmed');
const prog = program(conn);
const payer = new PublicKey(process.env.PAYER!);
const closureId = Number(process.env.CLOSURE_ID);
const legs: BookLegSpec[] = []; // decoded positions: see README ("Books") for how to fill this from the scan

// 1. What would the book cost? (the app's /api/book-quote runs the program's own pricing; not priced here)
if (process.env.APP_URL) console.log(await bookQuoteHttp(process.env.APP_URL, { ids: process.env.IDS!.split(','), target: '0.9' }));

// 2. Open (once), add what is not already in the book, seal.
const { book } = bookAddresses(payer, closureId, 1);
const existing = await readBook(prog, book);
if (!existing) {
  const epoch = currentEpoch(await loadEpochs(prog), 'SPYx', await chainNow(conn))!;
  console.log('open_book:', (await openBook(prog, { payer, closureId, bookId: 1, epoch: epoch.key })).ix.keys.length, 'accounts');
}
const todo = (await bookLegStatus(prog, { book, closureId, legs })).filter((l) => l.status === 'pending').map((l) => l.leg);
const batches = await addBookLegs(prog, { payer, book, closureId, legs: todo }); // 6 Kamino or 3 Jupiter legs per transaction
console.log(`${batches.length} add-leg transactions for ${todo.length} legs`);
const vault = await prog.account.vault.fetch(pdas.vault());
const b = existing ?? (await readBook(prog, book));
if (b) console.log('seal_book:', (await sealBook(prog, { payer, book, closureId, maxPremium: defaultSealMax(b.escrowed), feeAccount: vault.feeAccount })).keys.length, 'accounts');
