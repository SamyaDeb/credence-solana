// On connect: refuse mainnet (the program is not deployed there) and refuse a program or IDL that is not this widget's.
// Both run before the widget reads a position or builds anything.
import type { Connection } from '@solana/web3.js';
import { checkProgram, type ProgramCheck } from '@credence/sdk';
import { ProgramMismatchError, UnsupportedClusterError } from './errors';

/** Solana mainnet-beta's genesis hash. */
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** A surfpool fork keeps mainnet's genesis hash, so the hash alone cannot tell it from mainnet. A surfnet node says so in
 * `getVersion` (`surfnet-version`); a mainnet RPC does not, and a node that will not answer is treated as mainnet. A
 * dishonest RPC claiming to be a surfnet gains nothing: credence_core is not on mainnet, so `checkProgram` still refuses. */
async function isSurfnet(conn: Connection): Promise<boolean> {
  try { return 'surfnet-version' in (await conn.getVersion()); } catch { return false; }
}

export async function assertSupportedCluster(conn: Connection): Promise<void> {
  if ((await conn.getGenesisHash()) === MAINNET_GENESIS && !(await isSurfnet(conn))) throw new UnsupportedClusterError();
}

export async function assertProgram(conn: Connection): Promise<ProgramCheck> {
  try { return await checkProgram(conn); } catch (e) { throw new ProgramMismatchError((e as Error).message); }
}
