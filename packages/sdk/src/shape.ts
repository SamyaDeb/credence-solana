// The last check before a transaction leaves the server: exactly the programs the Action may call. Kamino: compute
// budget, klend's refreshes and one credence_core buy. Jupiter Lend: compute budget and one credence_core buy (Jupiter's
// own program is never needed, so it is refused). Never Jupiter's program with klend (klend restricts Jupiter's Vaults
// program, and the Action never combines lenders). One signer: the wallet named in the POST, as fee payer.
import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { IDL, KLEND, PROGRAM_ID } from './core';
import { REFRESH_RESERVE } from './kamino';
import { JL_VAULTS } from './build';

export type Lender = 'kamino' | 'jupiter';

/** Each lender's own buys: Kamino buy_cover / buy_cover_multi, Jupiter Lend buy_cover_jl (audit A-127). */
const BUYS: Record<Lender, string[]> = { kamino: ['buy_cover', 'buy_cover_multi'], jupiter: ['buy_cover_jl'] };
const discs = (names: string[]) => (IDL.instructions as { name: string; discriminator: number[] }[])
  .filter((i) => names.includes(i.name))
  .map((i) => Buffer.from(i.discriminator).toString('hex'));
const BUY_DISCS: Record<Lender, string[]> = { kamino: discs(BUYS.kamino), jupiter: discs(BUYS.jupiter) };
const RELEASE_DISC = Buffer.from((IDL.instructions as { name: string; discriminator: number[] }[]).find((i) => i.name === 'release_book_leg')!.discriminator);
const ALL_BUY_DISCS = [...BUY_DISCS.kamino, ...BUY_DISCS.jupiter];

/** Programs a transaction may name. Jupiter Lend's program is never needed: buy_cover_jl reads its accounts itself. */
export const ALLOWED: Record<Lender, string[]> = {
  kamino: [ComputeBudgetProgram.programId.toBase58(), PROGRAM_ID.toBase58(), KLEND.toBase58()],
  jupiter: [ComputeBudgetProgram.programId.toBase58(), PROGRAM_ID.toBase58()],
};

/** klend's refresh_reserve and refresh_obligation (sha256("global:<name>")[..8], as lib/kamino.ts builds them): the
 * only klend instructions allowed (no deposit, borrow, withdraw or repay can ride along with a buy, audit A-111). */
const KLEND_REFRESH = [REFRESH_RESERVE, Buffer.from([33, 132, 147, 228, 151, 192, 72, 89])].map((d) => d.toString('hex'));
/** ComputeBudget SetComputeUnitLimit (2) then SetComputeUnitPrice (3), nothing else (no heap frame, no data limit). */
const CU_LIMIT = 2, CU_PRICE = 3;

export type Shape = { programs: string[]; payer: string; signers: number; lookups: number; buys: number; ixs: { program: string; data: Buffer }[] };

export function txShape(b64: string): Shape {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  const m = tx.message;
  const keys = m.staticAccountKeys;
  const ixs = m.compiledInstructions.map((i) => ({ program: keys[i.programIdIndex].toBase58(), data: Buffer.from(i.data) }));
  return {
    programs: ixs.map((i) => i.program),
    payer: keys[0].toBase58(),
    signers: m.header.numRequiredSignatures,
    lookups: m.addressTableLookups.length,
    buys: ixs.filter((i) => i.program === PROGRAM_ID.toBase58() && ALL_BUY_DISCS.includes(i.data.subarray(0, 8).toString('hex'))).length,
    ixs,
  };
}

/** Why this transaction must not be returned (or signed), or null. Checked per instruction (A-111): compute-unit limit
 * then price; for Kamino only klend's refreshes; then exactly one credence_core buy, last. */
export function shapeProblem(b64: string, lender: Lender, account: PublicKey, opts: { release?: boolean } = {}): string | null {
  let s = txShape(b64);
  // An owner's buy over a curator's book leg starts with credence_core `release_book_leg` (no data, no other program): allowed
  // only when the caller says so, and exactly once, straight after the compute budget pair.
  if (opts.release) {
    const first = s.ixs[2];
    if (!first || first.program !== PROGRAM_ID.toBase58() || !first.data.subarray(0, 8).equals(RELEASE_DISC) || first.data.length !== 8) return 'expected release_book_leg right after the compute budget';
    s = { ...s, programs: [...s.programs.slice(0, 2), ...s.programs.slice(3)], ixs: [...s.ixs.slice(0, 2), ...s.ixs.slice(3)] };
  }
  const cb = ComputeBudgetProgram.programId.toBase58();
  const bad = s.programs.filter((p) => !ALLOWED[lender].includes(p));
  if (bad.length) return `unexpected program ${bad[0]}`;
  if (s.ixs.length < 3 || s.ixs[0].program !== cb || s.ixs[0].data[0] !== CU_LIMIT || s.ixs[1].program !== cb || s.ixs[1].data[0] !== CU_PRICE) {
    return 'compute-unit limit and price must come first';
  }
  if (s.programs.filter((p) => p === cb).length !== 2) return 'compute budget instructions repeated';
  for (const ix of s.ixs.slice(2, -1)) {
    if (ix.program !== KLEND.toBase58() || !KLEND_REFRESH.includes(ix.data.subarray(0, 8).toString('hex')) || ix.data.length !== 8) {
      return `only klend refresh instructions may precede the buy (found a ${ix.program === KLEND.toBase58() ? 'klend instruction' : 'foreign instruction'})`;
    }
  }
  const core = s.programs.filter((p) => p === PROGRAM_ID.toBase58()).length;
  if (core !== 1 || s.buys !== 1) return 'exactly one credence_core buy';
  if (s.programs[s.programs.length - 1] !== PROGRAM_ID.toBase58()) return 'the buy must be the last instruction';
  if (!BUY_DISCS[lender].includes(s.ixs[s.ixs.length - 1].data.subarray(0, 8).toString('hex'))) return `the buy is not a ${lender === 'kamino' ? 'Kamino' : 'Jupiter Lend'} buy`;
  if (s.payer !== account.toBase58() || s.signers !== 1) return 'the wallet must be the only signer and the fee payer';
  if (s.lookups) return 'no address lookup tables';
  return null;
}
