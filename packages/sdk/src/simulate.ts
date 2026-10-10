// Simulation helpers: nothing is signed or sent here.
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction, type SimulatedTransactionResponse } from '@solana/web3.js';
import { toError } from './errors';

export { TxError } from './errors';
export const CU_PRICE_MICROLAMPORTS = 1_000;

/** simulateTransaction without signatures (the wallet has not signed yet). */
export async function simulate(conn: Connection, tx: Transaction): Promise<SimulatedTransactionResponse> {
  const msg = tx.compileMessage();
  // web3.js v1 `simulateTransaction(message)` with sigVerify off and the latest blockhash.
  const r = await conn.simulateTransaction(msg as never, undefined, false as never);
  return r.value;
}

/** Simulates read-only instructions and returns the return data of the last instruction from `program` (used for
 * `quote_cover`). `payer` only pays the (simulated) fee. A failure throws the typed error (CoreError, ProgramError, TxError). */
export async function simulateReturn(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[], cuLimit = 1_400_000) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ...ixs];
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...all);
  const r = await simulate(conn, tx);
  if (r.err) throw toError(r.err, r.logs, all.map((i) => i.programId));
  const rd = r.returnData;
  return { data: rd ? Buffer.from(rd.data[0], 'base64') : null, programId: rd?.programId ?? null, cu: r.unitsConsumed ?? 0, logs: r.logs ?? [] };
}
