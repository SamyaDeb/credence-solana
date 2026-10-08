// Every transaction the app sends goes through `sendTx` (engineering rules for the app, plan/prompts/phase1-day4.md):
//   1. compute-unit limit and price set
//   2. simulateTransaction before signing; a failure is decoded into the program's CoreError message
//   3. the wallet only signs; the app sends through its own Connection (so the fork works whatever network the wallet
//      is set to)
//   4. signature and consumed CU returned after confirmation
import {
  ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction,
  type SimulatedTransactionResponse,
} from '@solana/web3.js';
import { IDL, KLEND, PROGRAM_ID } from './credence';

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

export class TxError extends Error {
  constructor(message: string, readonly logs: string[] = [], readonly stage: 'simulate' | 'send' = 'simulate') {
    super(message);
  }
}

/** Builds the transaction with a compute-unit limit and price, simulates it, then signs and sends it. */
export async function sendTx(
  conn: Connection,
  signer: AppSigner,
  ixs: TransactionInstruction[],
  opts: { cuLimit?: number; extraSigners?: { publicKey: PublicKey; secretKey: Uint8Array }[] } = {},
): Promise<TxResult> {
  const cuLimit = opts.cuLimit ?? 400_000;
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS }),
    ...ixs,
  ];
  const programs = all.map((i) => i.programId);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(...all);

  const sim = await simulate(conn, tx);
  if (sim.err) throw new TxError(decodeError(sim.err, sim.logs, programs), sim.logs ?? [], 'simulate');

  if (opts.extraSigners?.length) tx.partialSign(...opts.extraSigners.map((s) => ({ publicKey: s.publicKey, secretKey: s.secretKey })));
  const signed = await signer.signTransaction(tx);
  const signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  const got = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const logs = got?.meta?.logMessages ?? [];
  const err = res.value.err ?? got?.meta?.err;
  if (err) throw new TxError(decodeError(err, logs, programs), logs, 'send');
  return { signature, cu: got?.meta?.computeUnitsConsumed ?? 0, logs };
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
