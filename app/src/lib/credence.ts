// The app's view of credence_core: program client, PDAs and constants. Mirrors keeper/src/chain.ts (which reads the
// IDL with node:fs and cannot load in a browser); test/keeper-parity.test.ts checks that both derive the same
// addresses and constants. The IDL is copied from target/idl by scripts/sync-idl.mjs.
import { AnchorProvider, BN, Program, type Idl } from '@anchor-lang/core';
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import idlJson from './idl.json' with { type: 'json' };

export const IDL = idlJson as Idl & { address: string; errors: { code: number; name: string; msg: string }[] };
export const PROGRAM_ID = new PublicKey(IDL.address);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'http://127.0.0.1:8899';

export const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
export const FARMS = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
export const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
export const CLOCK_SYSVAR = new PublicKey('SysvarC1ock11111111111111111111111111111111');
export const PYTH_PUSH_ORACLE = new PublicKey('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
/** Kamino's Scope `OraclePrices` account (the SCOPE settlement source). */
export const SCOPE_PRICES = new PublicKey('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH');
/** The two xStocks lending markets `buy_cover` accepts (credence-core kamino.rs `XSTOCKS_MARKETS`). */
export const XSTOCKS_MARKETS: Record<string, string> = {
  '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua': 'xStocks Market',
  '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr': 'Sentora xStocks Market',
};

/** Program constants mirrored from credence-core (state.rs, settle.rs, void.rs, settlement.rs). */
export const EPOCH = { OPEN: 0, CLOSED: 1, SETTLED: 2, HALTED: 3, VOIDED: 4 } as const;
export const EPOCH_NAME = ['open', 'closed', 'settled', 'halted', 'voided'] as const;
export const POLICY = { ACTIVE: 0, SETTLED: 1, REFUNDED: 2 } as const;
export const POLICY_NAME = ['active', 'settled', 'refunded'] as const;
export const SOURCE = { EQUITY: 0, XSTOCK: 1, SCOPE: 2, JUPITER: 3 } as const;
export const SOURCE_NAME = ['EQUITY', 'XSTOCK', 'SCOPE'] as const;
export const TICKET = { DEPOSIT: 0, WITHDRAW: 1 } as const;
export const SCOPE_AFTER_CLOSE = 900;
export const SCOPE_OPEN_DELAY = 60;
export const SETTLE_WINDOW = 300;
export const SETTLE_GRACE = 3600;
export const VOID_AFTER = 6 * 3600;

export const WAD = 10n ** 18n;
/** klend's scaled fractions: U68F60. */
export const SF_SHIFT = 60n;

export const ticker8 = (t: string): number[] => {
  const b = new Uint8Array(8);
  for (let i = 0; i < t.length && i < 8; i++) b[i] = t.charCodeAt(i);
  return [...b];
};
export const tickerStr = (t: number[] | Uint8Array) => String.fromCharCode(...t).replace(/\0+$/, '');
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds: (Buffer | Uint8Array)[], program = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const pdas = {
  config: () => pda([Buffer.from('config')]),
  asset: (t: string) => pda([Buffer.from('asset'), Buffer.from(ticker8(t))]),
  scen: (t: string, closureType = 2) => pda([Buffer.from('scen'), Buffer.from(ticker8(t)), Buffer.from([closureType])]),
  joint: (version: number) => pda([Buffer.from('joint'), u32le(version)]),
  calendar: () => pda([Buffer.from('calendar'), Buffer.from('XNYS\0\0\0\0')]),
  epoch: (t: string, closureId: number) => pda([Buffer.from('epoch'), Buffer.from(ticker8(t)), u32le(closureId)]),
  loss: (group: number) => pda([Buffer.from('loss'), u32le(group)]),
  vault: () => pda([Buffer.from('vault')]),
  vaultUsdc: () => pda([Buffer.from('vault_usdc')]),
  shares: () => pda([Buffer.from('shares')]),
  shareEscrow: () => pda([Buffer.from('share_escrow')]),
  policy: (epoch: PublicKey, obligation: PublicKey) => pda([Buffer.from('policy'), epoch.toBuffer(), obligation.toBuffer()]),
  depositTicket: (owner: PublicKey, waitGroup: number) => pda([Buffer.from('dep'), owner.toBuffer(), u32le(waitGroup)]),
  withdrawTicket: (owner: PublicKey, waitGroup: number) => pda([Buffer.from('wd'), owner.toBuffer(), u32le(waitGroup)]),
  backstop: () => pda([Buffer.from('backstop')]),
  inventory: (t: string) => pda([Buffer.from('inventory'), Buffer.from(ticker8(t))]),
  earnings: (t: string) => pda([Buffer.from('earnings'), Buffer.from(ticker8(t))]),
};

export function pushAccount(feedId: number[] | Uint8Array): PublicKey {
  return pda([Buffer.from([0, 0]), Buffer.from(feedId)], PYTH_PUSH_ORACLE);
}

export function ata(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN): PublicKey {
  return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
}

/** `CreateIdempotent` of the associated token program. */
export function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
  });
}

/** One chain of Scope's `OraclePrices`: 8-byte discriminator, oracle_mappings (32), then 512 × {value u64, exp u64,
 * slot u64, unix_timestamp u64, generic [u8; 24]} (same as keeper `decodeScope`). */
export function decodeScope(d: Uint8Array, chain: number) {
  const v = view(d);
  const o = 8 + 32 + chain * 56;
  const value = v.getBigUint64(o, true);
  const exp = Number(v.getBigUint64(o + 8, true));
  return { value, exp, price: Number(value) / 10 ** exp, slot: Number(v.getBigUint64(o + 16, true)), unixTimestamp: Number(v.getBigUint64(o + 24, true)) };
}

/** Little-endian reads through DataView: the browser's Buffer polyfill has no 64-bit readers. */
export const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

/** A Pyth `PriceUpdateV2` (same as keeper `decodePriceUpdate`). */
export function decodePriceUpdate(d: Uint8Array) {
  const v = view(d);
  const full = d[40] === 1;
  const o = full ? 41 : 42;
  const expo = v.getInt32(o + 48, true);
  return {
    full,
    feedId: [...d.subarray(o, o + 32)].map((x) => x.toString(16).padStart(2, '0')).join(''),
    price: Number(v.getBigInt64(o + 32, true)) * 10 ** expo,
    conf: Number(v.getBigUint64(o + 40, true)) * 10 ** expo,
    publishTime: Number(v.getBigInt64(o + 52, true)),
  };
}

/** Read-only program client: the app builds instructions and decodes accounts with it; signing is the wallet's. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CoreProgram = Program<any> & { account: any; methods: any };
export function program(conn: Connection): CoreProgram {
  const readOnly = {
    publicKey: PublicKey.default,
    signTransaction: () => Promise.reject(new Error('read-only provider')),
    signAllTransactions: () => Promise.reject(new Error('read-only provider')),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(IDL, new AnchorProvider(conn, readOnly as any, { commitment: 'confirmed' })) as CoreProgram;
}

export const bn = (x: bigint | number) => new BN(x.toString());
export const big = (x: { toString(): string } | number | bigint) => BigInt(x.toString());

/** Unix time of the chain's Clock sysvar (follows surfpool time travel; never the browser's clock). */
export async function chainNow(conn: Connection): Promise<number> {
  const a = await conn.getAccountInfo(CLOCK_SYSVAR);
  if (!a) throw new Error('no Clock sysvar');
  return Number(view(a.data).getBigInt64(32, true));
}
