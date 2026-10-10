// Transaction-shape guards, enforced by every SDK builder that returns a transaction.
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { IDL, KLEND } from './core';

/** Jupiter Lend's programs: vaults, liquidity, oracle. */
export const JUPITER_PROGRAMS: readonly PublicKey[] = [
  new PublicKey('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi'),
  new PublicKey('jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC'),
  new PublicKey('jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc'),
];

// sha256("global:<name>")[..8] of every credence_core instruction that CPIs into Jupiter Lend, from the IDL.
const jupiterDiscs: Buffer[] = (IDL.instructions as unknown as { name: string; discriminator: number[] }[])
  .filter((i) => /_jl$/.test(i.name))
  .map((i) => Buffer.from(i.discriminator));

/** True when `ix` is Jupiter's own program, passes one as an account, or is a credence_core `*_jl` instruction (which
 * CPIs into Jupiter Lend's `operate`). */
export function touchesJupiter(ix: TransactionInstruction): boolean {
  if (JUPITER_PROGRAMS.some((p) => ix.programId.equals(p))) return true;
  if (ix.keys.some((k) => JUPITER_PROGRAMS.some((p) => k.pubkey.equals(p)))) return true;
  return ix.programId.equals(new PublicKey(IDL.address)) && jupiterDiscs.some((d) => ix.data.subarray(0, 8).equals(d));
}

export class MixedLenderError extends Error {
  constructor() {
    super("Jupiter Lend's program must not share a transaction with klend: send them as separate transactions");
    this.name = 'MixedLenderError';
  }
}

/** Throws `MixedLenderError` when the instructions mix klend with Jupiter Lend. Returns `ixs` for chaining. */
export function assertNoJupiterWithKlend(ixs: TransactionInstruction[]): TransactionInstruction[] {
  const klend = ixs.some((i) => i.programId.equals(KLEND));
  if (klend && ixs.some(touchesJupiter)) throw new MixedLenderError();
  return ixs;
}
