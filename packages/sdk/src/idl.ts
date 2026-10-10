// Version check: the SDK embeds the IDL it was built from and that IDL's sha256 (idl-hash.ts, written by
// scripts/sync-idl.mjs). `checkProgram` compares it with what is deployed and refuses a program that differs.
import { BorshAccountsCoder } from '@anchor-lang/core';
import { Connection, PublicKey } from '@solana/web3.js';
import { IDL, PROGRAM_ID, pdas } from './core';
import { IDL_HASH } from './idl-hash';

export { IDL_HASH };

export class IdlMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdlMismatchError';
  }
}

export type ProgramCheck = {
  /** `'on-chain-idl'`: the program publishes its IDL and it matches. `'layout'`: no published IDL; the program is
   * executable and its Config account has the embedded IDL's discriminator and size. */
  verified: 'on-chain-idl' | 'layout';
  programId: PublicKey;
  idlHash: string;
};

/** sha256 (hex) of an IDL document re-serialised with sorted keys, as sync-idl.mjs computes `IDL_HASH`. */
export async function hashIdl(idl: unknown): Promise<string> {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  const bytes = new TextEncoder().encode(JSON.stringify(sort(idl)));
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Refuses a program whose interface differs from the one this SDK was built for.
 *  1. The program must exist and be executable at the IDL's address.
 *  2. If it publishes an Anchor IDL account, that IDL's hash must equal `IDL_HASH`.
 *  3. Otherwise (a fork deploy publishes none) its `Config` account must carry the embedded IDL's discriminator and
 *     exactly the embedded layout's size: a program with a changed account layout is refused. With `strict: true` a
 *     program that publishes no IDL is refused too.
 */
export async function checkProgram(conn: Connection, opts: { strict?: boolean } = {}): Promise<ProgramCheck> {
  const info = await conn.getAccountInfo(PROGRAM_ID, 'confirmed');
  if (!info?.executable) throw new IdlMismatchError(`no executable program at ${PROGRAM_ID.toBase58()} on this cluster`);
  const published = await fetchPublishedIdl(conn).catch(() => null);
  if (published) {
    const h = await hashIdl(published);
    if (h !== IDL_HASH) throw new IdlMismatchError(`the deployed program's IDL (${h.slice(0, 12)}…) differs from this SDK's (${IDL_HASH.slice(0, 12)}…): update @credence/sdk`);
    return { verified: 'on-chain-idl', programId: PROGRAM_ID, idlHash: IDL_HASH };
  }
  if (opts.strict) throw new IdlMismatchError('the program publishes no IDL, so strict mode cannot verify it');
  const coder = new BorshAccountsCoder(IDL);
  const cfg = await conn.getAccountInfo(pdas.config(), 'confirmed');
  if (!cfg) throw new IdlMismatchError('the program has no Config account: not initialised, or not Credence');
  const disc = Buffer.from(coder.accountDiscriminator('Config'));
  if (!cfg.data.subarray(0, 8).equals(disc)) throw new IdlMismatchError('the Config account has a different discriminator than this SDK expects');
  const want = coder.size('Config');
  if (cfg.data.length !== want) throw new IdlMismatchError(`the Config account is ${cfg.data.length} bytes; this SDK's layout is ${want}: the program changed`);
  return { verified: 'layout', programId: PROGRAM_ID, idlHash: IDL_HASH };
}

/** The IDL the program published with `anchor idl init` (null when it did not). */
async function fetchPublishedIdl(conn: Connection): Promise<unknown | null> {
  const { Program, AnchorProvider } = await import('@anchor-lang/core');
  const provider = new AnchorProvider(conn, { publicKey: PublicKey.default } as never, { commitment: 'confirmed' });
  return Program.fetchIdl(PROGRAM_ID, provider);
}
