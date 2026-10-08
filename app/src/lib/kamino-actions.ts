// Kamino actions from the app: the server route builds klend-sdk's instructions for the wallet (api/kamino/build, no
// keys), the wallet signs them here. Account creation goes in its own transactions (packed to the 1,232-byte limit),
// then the refreshes and the action in one transaction.
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

export type KaminoActionName = 'deposit' | 'withdraw' | 'borrow' | 'repay';
type WireIx = { programId: string; data: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };

const toIx = (w: WireIx) => new TransactionInstruction({
  programId: new PublicKey(w.programId),
  data: Buffer.from(w.data, 'base64'),
  keys: w.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
});

export async function buildKaminoAction(p: { action: KaminoActionName; owner: PublicKey; reserve: PublicKey; amount: bigint; obligation?: PublicKey }) {
  const r = await fetch('/api/kamino/build', {
    method: 'POST',
    body: JSON.stringify({ action: p.action, owner: p.owner.toBase58(), reserve: p.reserve.toBase58(), amount: p.amount.toString(), obligation: p.obligation?.toBase58() }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return { setup: (j.setup as WireIx[]).map(toIx), main: (j.main as WireIx[]).map(toIx), labels: j.labels as { setup: string[]; lending: string[] } };
}

/** Splits instructions into as few transactions as fit (1,232 bytes each with a compute budget, no lookup tables). */
export function pack(ixs: TransactionInstruction[], payer: PublicKey): TransactionInstruction[][] {
  const fits = (b: TransactionInstruction[]) => {
    const tx = new Transaction({ feePayer: payer, blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 0 })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...b);
    try { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232; } catch { return false; }
  };
  const out: TransactionInstruction[][] = [];
  let batch: TransactionInstruction[] = [];
  for (const ix of ixs) {
    if (fits([...batch, ix])) batch.push(ix);
    else { if (batch.length) out.push(batch); batch = [ix]; }
  }
  if (batch.length) out.push(batch);
  return out;
}
