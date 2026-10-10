// shapeProblem with `release: true`: an owner's buy over a book leg starts with one release_book_leg, and nothing else is let in.
import { Keypair, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { IDL, KLEND, PROGRAM_ID, REFRESH_RESERVE, assembleTx, encodeTx, shapeProblem } from '../src';

const disc = (n: string) => Buffer.from((IDL.instructions as { name: string; discriminator: number[] }[]).find((i) => i.name === n)!.discriminator);
const owner = Keypair.generate().publicKey;
const ix = (programId: typeof PROGRAM_ID, data: Buffer) => new TransactionInstruction({ programId, data, keys: [{ pubkey: owner, isSigner: true, isWritable: true }] });
const release = () => ix(PROGRAM_ID, disc('release_book_leg'));
const refresh = () => ix(KLEND, REFRESH_RESERVE);
const buy = () => ix(PROGRAM_ID, Buffer.concat([disc('buy_cover'), Buffer.alloc(16)]));
const b64 = (ixs: TransactionInstruction[]) => encodeTx(assembleTx(owner, '11111111111111111111111111111111', ixs, 400_000));

describe('shapeProblem({ release })', () => {
  it('allows one release first, only when asked', () => {
    const tx = b64([release(), refresh(), buy()]);
    expect(shapeProblem(tx, 'kamino', owner, { release: true })).toBeNull();
    expect(shapeProblem(tx, 'kamino', owner)).toMatch(/only klend refresh|exactly one/);
  });
  it('a plain buy still passes without the option, and fails with it (release expected)', () => {
    const tx = b64([refresh(), buy()]);
    expect(shapeProblem(tx, 'kamino', owner)).toBeNull();
    expect(shapeProblem(tx, 'kamino', owner, { release: true })).toMatch(/release_book_leg/);
  });
  it('refuses a second release, a release with data, and a release after the refreshes', () => {
    expect(shapeProblem(b64([release(), release(), refresh(), buy()]), 'kamino', owner, { release: true })).toMatch(/only klend refresh/);
    expect(shapeProblem(b64([ix(PROGRAM_ID, Buffer.concat([disc('release_book_leg'), Buffer.alloc(8)])), refresh(), buy()]), 'kamino', owner, { release: true })).toMatch(/release_book_leg/);
    expect(shapeProblem(b64([refresh(), release(), buy()]), 'kamino', owner, { release: true })).toMatch(/release_book_leg/);
  });
});
