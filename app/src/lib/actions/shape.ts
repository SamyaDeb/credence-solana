// The last check before a transaction leaves the server: exactly the programs the Action may call. Kamino: compute
// budget, klend's refreshes and one credence_core buy. Jupiter Lend: compute budget and one credence_core buy (Jupiter's
// own program is allowed but never needed). Never Jupiter's program with klend (klend restricts Jupiter's Vaults
// program, and the Action never combines lenders). One signer: the wallet named in the POST, as fee payer.
import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { IDL, KLEND, PROGRAM_ID } from '@/lib/credence';
import { JL_VAULTS } from './build';

export type Lender = 'kamino' | 'jupiter';

const BUYS = ['buy_cover', 'buy_cover_multi', 'buy_cover_jl'];
const BUY_DISCS = (IDL.instructions as { name: string; discriminator: number[] }[])
  .filter((i) => BUYS.includes(i.name))
  .map((i) => Buffer.from(i.discriminator).toString('hex'));

export const ALLOWED: Record<Lender, string[]> = {
  kamino: [ComputeBudgetProgram.programId.toBase58(), PROGRAM_ID.toBase58(), KLEND.toBase58()],
  jupiter: [ComputeBudgetProgram.programId.toBase58(), PROGRAM_ID.toBase58(), JL_VAULTS.toBase58()],
};

export type Shape = { programs: string[]; payer: string; signers: number; lookups: number; buys: number };

export function txShape(b64: string): Shape {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  const m = tx.message;
  const keys = m.staticAccountKeys;
  const ixs = m.compiledInstructions;
  return {
    programs: ixs.map((i) => keys[i.programIdIndex].toBase58()),
    payer: keys[0].toBase58(),
    signers: m.header.numRequiredSignatures,
    lookups: m.addressTableLookups.length,
    buys: ixs.filter((i) => keys[i.programIdIndex].equals(PROGRAM_ID) && BUY_DISCS.includes(Buffer.from(i.data.subarray(0, 8)).toString('hex'))).length,
  };
}

/** Why this transaction must not be returned, or null. */
export function shapeProblem(b64: string, lender: Lender, account: PublicKey): string | null {
  const s = txShape(b64);
  const cb = ComputeBudgetProgram.programId.toBase58();
  const bad = s.programs.filter((p) => !ALLOWED[lender].includes(p));
  if (bad.length) return `unexpected program ${bad[0]}`;
  if (s.programs.includes(KLEND.toBase58()) && s.programs.includes(JL_VAULTS.toBase58())) return 'klend and Jupiter Lend in one transaction';
  if (s.programs[0] !== cb || s.programs[1] !== cb) return 'compute-unit limit and price must come first';
  if (s.programs.filter((p) => p === cb).length !== 2) return 'compute budget instructions repeated';
  const core = s.programs.filter((p) => p === PROGRAM_ID.toBase58()).length;
  if (core !== 1 || s.buys !== 1) return 'exactly one credence_core buy';
  if (s.programs[s.programs.length - 1] !== PROGRAM_ID.toBase58()) return 'the buy must be the last instruction';
  if (s.payer !== account.toBase58() || s.signers !== 1) return 'the wallet must be the only signer and the fee payer';
  if (s.lookups) return 'no address lookup tables';
  return null;
}
