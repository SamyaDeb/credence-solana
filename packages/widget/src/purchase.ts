// The only file that asks a wallet to sign or sends a transaction, and only when a person pressed the button.
import type { Connection } from '@solana/web3.js';
import { type CredenceEvent, encodeTx, parseEvents, shapeProblem } from '@credence/sdk';
import type { Built } from './build';
import { assertSupportedCluster } from './cluster';
import type { WalletLike } from './types';

export type PurchaseResult = { signature: string; cu: number; events: CredenceEvent[] };

export async function purchase(conn: Connection, wallet: WalletLike, built: Built): Promise<PurchaseResult> {
  if (!wallet.publicKey || !wallet.publicKey.equals(built.buyer)) throw new Error('the connected wallet is not the wallet this purchase was built for');
  await assertSupportedCluster(conn);
  // Re-check the exact bytes the wallet is about to be shown.
  const problem = shapeProblem(encodeTx(built.tx), 'kamino', built.buyer, { release: built.release });
  if (problem) throw new Error(`the transaction was not sent to your wallet: ${problem}`);
  const signed = await wallet.signTransaction(built.tx);
  if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(built.tx.message.serialize()))) throw new Error('the wallet returned a different transaction than the one built; nothing was sent');
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  } catch (e) {
    // The blockhash is fixed when the transaction is built; a slow wallet prompt can outlive it. Say so and let them press Buy again.
    if (/blockhash|expired|block height/i.test((e as Error).message ?? '')) throw new Error('the wallet took too long and the transaction expired before it was sent: press Buy cover again');
    throw e;
  }
  const done = await conn.confirmTransaction({ signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, 'confirmed');
  if (done.value.err) throw new Error(`the transaction was confirmed with an error, so no cover was bought (signature ${signature})`);
  const t = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return { signature, cu: t?.meta?.computeUnitsConsumed ?? built.cu, events: parseEvents(t?.meta?.logMessages ?? []) };
}
