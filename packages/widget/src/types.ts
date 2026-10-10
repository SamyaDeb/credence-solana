import type { PublicKey, VersionedTransaction } from '@solana/web3.js';

/** What the host's wallet adapter gives us: a key and a way to ask the person to sign one transaction. Nothing else. */
export type WalletLike = {
  publicKey: PublicKey | null;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
};

/** Fork-only upkeep the host may provide (it talks to its own fork tooling; the widget never learns where). Both are optional. */
export type ForkUpkeep = {
  /** Before klend's refreshes are simulated: restamp Scope's price chains to the fork clock (prices unchanged). */
  scopeFresh?: (chains: { price: number; twap: number | null }[]) => Promise<void>;
  /** Before the wallet is asked: mark the accounts the transaction names as local-only on the fork. */
  offline?: (keys: string[]) => Promise<void>;
};
