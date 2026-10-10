// @vitest-environment node
// c4b_program_mismatch, the half that derives PDAs (web3.js's PDA search needs Node's Uint8Array, not jsdom's).
import { PROGRAM_ID, pdas } from '@credence/sdk';
import { describe, expect, it } from 'vitest';
import { ProgramMismatchError, loadPosition } from '../src';
import { fakeConn } from './fakes';

const POSITION = '11111111111111111111111111111112';
describe('c4b_program_mismatch: a Config account whose layout differs', () => {
  it('is refused with the reason, before the position is read', async () => {
    const conn = fakeConn({ accounts: { [PROGRAM_ID.toBase58()]: { executable: true }, [pdas.config().toBase58()]: { data: Buffer.alloc(100) } } });
    await expect(loadPosition(conn, { position: POSITION, lender: 'kamino' })).rejects.toBeInstanceOf(ProgramMismatchError);
    await expect(loadPosition(conn, { position: POSITION, lender: 'kamino' })).rejects.toThrow(/different discriminator|bytes/);
    expect(conn.calls).not.toContain(`getAccountInfo:${POSITION}`);
  });
});
