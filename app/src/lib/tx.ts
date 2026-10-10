// Every transaction the app sends goes through `sendTx` (engineering rules for the app):
//   1. compute-unit limit and price set
//   2. simulateTransaction before signing; a failure is decoded into the program's CoreError message
//   3. the wallet only signs; the app sends through its own Connection (so the fork works whatever network the wallet
//      is set to)
//   4. signature and consumed CU returned after confirmation
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { CU_PRICE_MICROLAMPORTS, TxError, decodeError, simulate } from '@credence/sdk';
import { RPC_URL } from './credence';

// Decoding, simulation and the typed errors are the SDK's; re-exported so the app's imports are unchanged.
export { CU_PRICE_MICROLAMPORTS, TxError, decodeError, redact, simulate, simulateReturn } from '@credence/sdk';

export type AppSigner = {
  publicKey: PublicKey;
  kind: 'phantom' | 'burner';
  signTransaction: (tx: Transaction) => Promise<Transaction>;
};

export type TxResult = { signature: string; cu: number; logs: string[] };

/** Builds the transaction with a compute-unit limit and price, simulates it, then signs and sends it. The limit is the
 * simulated consumption + 10% + 10k (capped at 1.4M) unless `cuLimit` is given. */
export async function sendTx(
  conn: Connection,
  signer: AppSigner,
  ixs: TransactionInstruction[],
  opts: { cuLimit?: number; extraSigners?: { publicKey: PublicKey; secretKey: Uint8Array }[] } = {},
): Promise<TxResult & { cuLimit: number }> {
  const build = (limit: number, blockhash: string, lastValidBlockHeight: number) => new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS }),
    ...ixs,
  );
  const programs = [ComputeBudgetProgram.programId, ComputeBudgetProgram.programId, ...ixs.map((i) => i.programId)];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

  const sim = await simulate(conn, build(opts.cuLimit ?? 1_400_000, blockhash, lastValidBlockHeight));
  if (sim.err) throw new TxError(decodeError(sim.err, sim.logs, programs), sim.logs ?? [], 'simulate');
  const cuLimit = opts.cuLimit ?? Math.min(1_400_000, Math.ceil((sim.unitsConsumed ?? 200_000) * 1.1) + 10_000);
  const tx = build(cuLimit, blockhash, lastValidBlockHeight);

  if (opts.extraSigners?.length) tx.partialSign(...opts.extraSigners.map((s) => ({ publicKey: s.publicKey, secretKey: s.secretKey })));
  await prepareFork(ixs);
  const signed = await signer.signTransaction(tx);
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  } catch (e) {
    throw new TxError(`the fork rejected the transaction: ${(e as Error).message.split('\n').slice(0, 2).join(' ')}`, [], 'send');
  }
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  const got = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const logs = got?.meta?.logMessages ?? [];
  const err = res.value.err ?? got?.meta?.err;
  if (err) throw new TxError(decodeError(err, logs, programs), logs, 'send');
  return { signature, cu: got?.meta?.computeUnitsConsumed ?? 0, logs, cuLimit };
}

/** FORK ONLY: marks the accounts this transaction will create as local-only on surfpool (see /api/fork/offline). */
async function prepareFork(ixs: TransactionInstruction[]) {
  if (!/127\.0\.0\.1|localhost/.test(RPC_URL)) return;
  const keys = [...new Set(ixs.flatMap((i) => [i.programId, ...i.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()))];
  const r = await fetch('/api/fork/offline', { method: 'POST', body: JSON.stringify({ keys }) });
  if (!r.ok) throw new TxError(`fork preparation failed: ${(await r.json()).error}`, [], 'send');
}
