// The unsigned purchase: [release_book_leg,] klend's refreshes, buy_cover — built by the SDK, simulated, shape-checked.
// Nothing is signed here; purchase.ts is the only place a wallet is asked.
import { ComputeBudgetProgram, type Connection, type PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { assembleTx, buyCover, cuLimitFor, decodeError, encodeTx, pdas, shapeProblem } from '@credence/sdk';
import { assertSupportedCluster } from './cluster';
import type { ProtectState } from './load';
import type { WidgetQuote } from './quote';

export type Built = { tx: VersionedTransaction; buyer: PublicKey; cu: number; policy: PublicKey; quote: WidgetQuote; blockhash: string; lastValidBlockHeight: number; release: boolean };

export async function buildPurchase(conn: Connection, s: ProtectState, buyer: PublicKey, q: WidgetQuote): Promise<Built> {
  await assertSupportedCluster(conn);
  if (!s.epoch || !s.risk) throw new Error('no weekend epoch is on sale for this position');
  if (!buyer.equals(s.owner)) throw new Error("connect the obligation's owner wallet: the program only sells cover to the owner");
  const { prog, asset, o, reserves } = s.ctx;
  const vault = await prog.account.vault.fetch(pdas.vault());
  const release = s.bookLeg ? { ...s.bookLeg, releaseAsset: asset.key, releaseEpoch: s.epoch.key, closureId: s.epoch.closureId, positionTokenAccount: null } : undefined;
  const { ixs, policy } = await buyCover(prog, {
    kind: 'kamino', buyer, feeAccount: vault.feeAccount as PublicKey, maxPayout: q.maxPayout, maxPremium: q.maxPremium,
    asset, epoch: s.epoch, obligation: s.position, o, reserves, release,
  });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const probe = assembleTx(buyer, blockhash, ixs, 1_400_000);
  const sim = await conn.simulateTransaction(probe, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  if (sim.value.err) {
    const programs = [ComputeBudgetProgram.programId, ComputeBudgetProgram.programId, ...ixs.map((i) => i.programId)];
    throw new Error(decodeError(sim.value.err, sim.value.logs, programs));
  }
  const cu = sim.value.unitsConsumed ?? 0;
  const tx = assembleTx(buyer, blockhash, ixs, cuLimitFor(cu));
  await s.ctx.upkeep?.offline?.(tx.message.staticAccountKeys.map((k) => k.toBase58()));
  const problem = shapeProblem(encodeTx(tx), 'kamino', buyer, { release: !!release });
  if (problem) throw new Error(`the transaction was not sent to your wallet: ${problem}`);
  return { tx, buyer, cu, policy, quote: q, blockhash, lastValidBlockHeight, release: !!release };
}
