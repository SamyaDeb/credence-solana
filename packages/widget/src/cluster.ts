// On connect: refuse mainnet (the program is not deployed there) and refuse a program or IDL that is not this widget's.
// Both run before the widget reads a position or builds anything.
import type { Connection } from '@solana/web3.js';
import { checkProgram, type ProgramCheck } from '@credence/sdk';
import { ProgramMismatchError, UnsupportedClusterError } from './errors';

/** Solana mainnet-beta's genesis hash. */
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

export async function assertSupportedCluster(conn: Connection): Promise<void> {
  if ((await conn.getGenesisHash()) === MAINNET_GENESIS) throw new UnsupportedClusterError();
}

export async function assertProgram(conn: Connection): Promise<ProgramCheck> {
  try { return await checkProgram(conn); } catch (e) { throw new ProgramMismatchError((e as Error).message); }
}
