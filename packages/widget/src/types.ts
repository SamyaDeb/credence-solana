import type { PublicKey, VersionedTransaction } from '@solana/web3.js';

/** What the host's wallet adapter gives us: a key and a way to ask the person to sign one transaction. Nothing else. */
export type WalletLike = {
  publicKey: PublicKey | null;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
};
