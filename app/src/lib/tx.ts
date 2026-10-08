// Every transaction the app sends goes through `sendTx` (engineering rules for the app):
//   1. compute-unit limit and price set
//   2. simulateTransaction before signing; a failure is decoded into the program's CoreError message
//   3. the wallet only signs; the app sends through its own Connection (so the fork works whatever network the wallet
//      is set to)
//   4. signature and consumed CU returned after confirmation
import {
  ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction,
  type SimulatedTransactionResponse,
} from '@solana/web3.js';
import { IDL, KLEND, PROGRAM_ID, RPC_URL } from './credence';

export type AppSigner = {
  publicKey: PublicKey;
  kind: 'phantom' | 'burner';
  signTransaction: (tx: Transaction) => Promise<Transaction>;
};

export type TxResult = { signature: string; cu: number; logs: string[] };

export const CU_PRICE_MICROLAMPORTS = 1_000;

/** Turns a failed simulation or transaction into one readable line: the CoreError name and message for credence_core,
 * the klend error number otherwise, else the last program log. */
export function decodeError(err: unknown, logs: string[] | null | undefined, ixPrograms: PublicKey[] = []): string {
  const anchorLog = (logs ?? []).find((l) => l.includes('AnchorError'));
  const custom = (() => {
    const e = err as { InstructionError?: [number, { Custom?: number } | string] } | null;
    if (e && Array.isArray(e.InstructionError)) {
      const [ix, inner] = e.InstructionError;
      if (inner && typeof inner === 'object' && typeof inner.Custom === 'number') return { ix, code: inner.Custom };
      return { ix, code: null as number | null, raw: JSON.stringify(inner) };
    }
    return null;
  })();
  if (custom && custom.code !== null) {
    const prog = ixPrograms[custom.ix];
    if (!prog || prog.equals(PROGRAM_ID)) {
      const e = IDL.errors.find((x) => x.code === custom.code);
      if (e) return `CoreError::${e.name} (${e.code}): ${e.msg}`;
    }
    if (prog?.equals(KLEND)) return `Kamino klend error ${custom.code} in instruction ${custom.ix}${anchorLog ? ` — ${anchorLog.replace(/^Program log: /, '')}` : ''}`;
    return `custom error ${custom.code} in instruction ${custom.ix}${prog ? ` (${prog.toBase58().slice(0, 8)}…)` : ''}`;
  }
  if (anchorLog) return anchorLog.replace(/^Program log: /, '');
  const last = [...(logs ?? [])].reverse().find((l) => /failed|Error/.test(l));
  return last ?? (custom ? `instruction ${custom.ix}: ${'raw' in custom ? custom.raw : ''}` : JSON.stringify(err));
}

/** Surfpool's errors can quote its datasource URL, API key included: never show one. */
export const redact = (s: string) => s.replace(/(api[-_]?key|apikey|token|key)=[^&\s"')]+/gi, '$1=***').replace(/(https?:\/\/)[^\s"')]*helius[^\s"')]*/gi, '$1<mainnet rpc>');

export class TxError extends Error {
  constructor(message: string, readonly logs: string[] = [], readonly stage: 'simulate' | 'send' = 'simulate') {
    super(redact(message));
  }
}

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

/** simulateTransaction without signatures (the wallet has not signed yet). */
export async function simulate(conn: Connection, tx: Transaction): Promise<SimulatedTransactionResponse> {
  const msg = tx.compileMessage();
  // web3.js v1 `simulateTransaction(message)` with sigVerify off and the fork's latest blockhash.
  const r = await conn.simulateTransaction(msg as never, undefined, false as never);
  return r.value;
}

/** Simulates read-only instructions and returns the return data of the last instruction from `program` (used for
 * `quote_cover`). `payer` only pays the (simulated) fee. */
export async function simulateReturn(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[], cuLimit = 1_400_000) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ...ixs];
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...all);
  const r = await simulate(conn, tx);
  if (r.err) throw new TxError(decodeError(r.err, r.logs, all.map((i) => i.programId)), r.logs ?? []);
  const rd = r.returnData;
  return { data: rd ? Buffer.from(rd.data[0], 'base64') : null, programId: rd?.programId ?? null, cu: r.unitsConsumed ?? 0, logs: r.logs ?? [] };
}
