// Surfpool cheatcodes used by the demo (fork only; never on a real cluster). Surfpool forks mainnet lazily (accounts
// are cloned on first read) and runs the SVM in LiteSVM, so it can move the clock and overwrite accounts:
//   surfnet_writeProgram    deploy credence_core from target/deploy without hundreds of write transactions
//   surfnet_setAccount      inject recorded Pyth push updates; give the demo wallet a real obligation (owner field)
//   surfnet_setTokenAccount fund demo wallets with USDC
//   surfnet_timeTravel      jump to the Friday close and the Monday open
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Chain, ROOT, PROGRAM_ID } from './chain.js';

export async function rpc(c: Chain, method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(c.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export async function setAccount(c: Chain, key: string, a: { lamports: number; data: Buffer; owner: string; executable?: boolean }) {
  await rpc(c, 'surfnet_setAccount', [key, { lamports: a.lamports, data: a.data.toString('hex'), owner: a.owner, executable: a.executable ?? false }]);
}

/** Sets `owner`'s associated token account of `mint` to `amount` base units (created if missing). */
export async function setTokenBalance(c: Chain, owner: string, mint: string, amount: bigint, tokenProgram?: string) {
  await rpc(c, 'surfnet_setTokenAccount', tokenProgram ? [owner, mint, { amount: Number(amount) }, tokenProgram] : [owner, mint, { amount: Number(amount) }]);
}

/** Moves the fork's clock to `unix` seconds (forward only). */
export async function timeTravel(c: Chain, unix: number) {
  await rpc(c, 'surfnet_timeTravel', [{ absoluteTimestamp: unix * 1000 }]);
}

/** Deploys target/deploy/credence_core.so at the program id, upgrade authority `authority`. */
export async function deployProgram(c: Chain, authority: string) {
  const so = readFileSync(join(ROOT, 'target/deploy/credence_core.so'));
  const chunk = 512 * 1024;
  for (let off = 0; off < so.length; off += chunk) {
    await rpc(c, 'surfnet_writeProgram', [PROGRAM_ID.toBase58(), so.subarray(off, off + chunk).toString('hex'), off, authority]);
  }
  return so.length;
}
