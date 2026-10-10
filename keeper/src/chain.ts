// Shared chain access for the keeper and the demo: program client, PDAs, constants, the on-chain clock, Pyth push
// accounts and transaction sending. The program's IDL comes from `anchor build` (target/idl/credence_core.json).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { AnchorProvider, Program, Wallet, web3 } = anchor;
type PublicKey = InstanceType<typeof web3.PublicKey>;
type Keypair = InstanceType<typeof web3.Keypair>;
type TransactionInstruction = InstanceType<typeof web3.TransactionInstruction>;

export const ROOT = new URL('../../', import.meta.url).pathname;
export const IDL = JSON.parse(readFileSync(join(ROOT, 'target/idl/credence_core.json'), 'utf8'));
export const pk = (s: string) => new web3.PublicKey(s);

export const PROGRAM_ID = pk(IDL.address);
export const TOKEN = pk('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022 = pk('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = pk('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const USDC_MINT = pk('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const KLEND = pk('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
export const FARMS = pk('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
export const INSTRUCTIONS_SYSVAR = pk('Sysvar1nstructions1111111111111111111111111');
export const CLOCK_SYSVAR = pk('SysvarC1ock11111111111111111111111111111111');
/** `pyth_solana_receiver_sdk::PYTH_PUSH_ORACLE_ID` (pro-compatible). Push accounts are PDAs `[0u16 LE, feed_id]`. */
export const PYTH_PUSH_ORACLE = pk('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');

/** Program constants mirrored from credence-core (state.rs, settle.rs, void.rs). */
export const EPOCH = { OPEN: 0, CLOSED: 1, SETTLED: 2, HALTED: 3, VOIDED: 4 } as const;
export const POLICY = { ACTIVE: 0, SETTLED: 1, REFUNDED: 2 } as const;
/** Closure types (state.rs `closure`, W11). */
export const CLOSURE = { OVERNIGHT: 1, WEEKEND: 2, HOLIDAY_WEEKEND: 3 } as const;
export const SOURCE = { EQUITY: 0, XSTOCK: 1, SCOPE: 2, JUPITER: 3 } as const;
/** Kamino's Scope `OraclePrices` (the SCOPE settlement source) and the program's SCOPE windows (settlement.rs). */
export const SCOPE_PRICES = pk('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH');
export const SCOPE_AFTER_CLOSE = 900;
export const SCOPE_OPEN_DELAY = 60;
export const TICKET = { DEPOSIT: 0, WITHDRAW: 1 } as const;
/** Book states (state.rs `book_state`, C2). */
export const BOOK = { OPEN: 0, SEALED: 1, VOIDED: 2 } as const;
export const DEFAULT_KEY = '11111111111111111111111111111111';
export const SETTLE_GRACE = 3600;
export const VOID_AFTER = 6 * 3600;
export const SETTLE_WINDOW = 300;

export const ticker8 = (t: string): number[] => {
  const b = Buffer.alloc(8);
  b.write(t, 'ascii');
  return [...b];
};
export const tickerStr = (t: number[] | Uint8Array) => Buffer.from(t).toString('ascii').replace(/\0+$/, '');
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds: (Buffer | Uint8Array)[], program = PROGRAM_ID) => web3.PublicKey.findProgramAddressSync(seeds, program)[0];

/** The weekend-safe klend market (credence-core kamino.rs `WSM_MARKET`; fork-only address, D1). */
export const WSM_MARKET = pk('45PeTGq9mJF9W6zzzSrgNgZjx8stoiYALubvDNTjsHfL');

export const pdas = {
  wsmMarket: () => pda([Buffer.from('wsm_market')]),
  wsmAuth: () => pda([Buffer.from('wsm_auth')]),
  wsm: (user: PublicKey) => pda([Buffer.from('wsm'), user.toBuffer()]),
  wsmUsdc: (user: PublicKey) => pda([Buffer.from('wsm_usdc'), user.toBuffer()]),
  wsmColl: (user: PublicKey) => pda([Buffer.from('wsm_coll'), user.toBuffer()]),
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
  feed: (t: string) => pda([Buffer.from('feed'), Buffer.from(ticker8(t))]),
  earnings: (t: string) => pda([Buffer.from('earnings'), Buffer.from(ticker8(t))]),
  book: (payer: PublicKey, closureId: number, bookId: number) => pda([Buffer.from('book'), payer.toBuffer(), u32le(closureId), u32le(bookId)]),
  bookEscrow: (book: PublicKey) => pda([Buffer.from('book_escrow'), book.toBuffer()]),
};

export function pushAccount(feedId: number[] | Uint8Array): PublicKey {
  return pda([Buffer.from([0, 0]), Buffer.from(feedId)], PYTH_PUSH_ORACLE);
}

export function ata(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN): PublicKey {
  return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
}

/** `CreateIdempotent` of the associated token program. */
export function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN): TransactionInstruction {
  return new web3.TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
  });
}

/** A decoded Pyth `PriceUpdateV2`: discriminator 8, write authority 32, verification level (Partial = 2 bytes,
 * Full = 1), then the price message (feed id 32, price i64, conf u64, exponent i32, publish time i64, …). */
export function decodePriceUpdate(d: Buffer) {
  const full = d[40] === 1;
  const o = full ? 41 : 42;
  const expo = d.readInt32LE(o + 48);
  return {
    full,
    feedId: d.subarray(o, o + 32).toString('hex'),
    priceRaw: d.readBigInt64LE(o + 32),
    confRaw: d.readBigUInt64LE(o + 40),
    expo,
    price: Number(d.readBigInt64LE(o + 32)) * 10 ** expo,
    publishTime: Number(d.readBigInt64LE(o + 52)),
    /** Offsets for rewriting a recorded update in the demo. */
    offsets: { price: o + 32, conf: o + 40, publishTime: o + 52, prevPublishTime: o + 60, emaPrice: o + 68, emaConf: o + 76 },
  };
}

/** One chain of Scope's `OraclePrices`: 8-byte discriminator, oracle_mappings, then 512 × {value u64, exp u64, slot u64,
 * unix_timestamp u64, generic [u8; 24]}. */
export function decodeScope(d: Buffer, chain: number) {
  const o = 8 + 32 + chain * 56;
  const value = d.readBigUInt64LE(o);
  const exp = Number(d.readBigUInt64LE(o + 8));
  return { price: Number(value) / 10 ** exp, unixTimestamp: Number(d.readBigUInt64LE(o + 24)), offsets: { value: o, exp: o + 8, slot: o + 16, ts: o + 24 } };
}

export function keypair(path: string): Keypair {
  return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

export type Chain = ReturnType<typeof connect>;

export function connect(url = process.env.RPC_URL ?? 'http://127.0.0.1:8899', walletPath = process.env.KEEPER_WALLET ?? `${homedir()}/.config/solana/id.json`) {
  const conn = new web3.Connection(url, 'confirmed');
  const payer = keypair(walletPath);
  const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' });
  // The IDL is loaded as JSON (no generated types), so accounts and methods are untyped, as in scripts/.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(IDL, provider) as any;
  return { conn, payer, provider, program, url };
}

/** Unix time of the chain's Clock sysvar (follows surfpool time travel; never the local clock). */
export async function chainNow(c: Chain): Promise<number> {
  const a = await c.conn.getAccountInfo(CLOCK_SYSVAR);
  if (!a) throw new Error('no Clock sysvar');
  return Number(a.data.readBigInt64LE(32));
}

/** Sends `ixs` in one transaction (1.4M CU limit), payer + `signers`. Returns the signature and compute units, or
 * throws with the program logs. */
export async function send(c: Chain, ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new web3.Transaction().add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  if (/127\.0\.0\.1|localhost/.test(c.url)) {
    const { offlineMissing } = await import('./fork.js');
    await offlineMissing(c.url, ixs.flatMap((i) => i.keys.map((k) => k.pubkey.toBase58())));
  }
  const sig = await c.conn.sendTransaction(tx, [c.payer, ...signers], { skipPreflight: true });
  const res = await c.conn.confirmTransaction(sig, 'confirmed');
  const t = await c.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (res.value.err || t?.meta?.err) {
    const logs = (t?.meta?.logMessages ?? []).filter((l) => /Error|failed|AnchorError|Program log/.test(l)).slice(-6);
    throw new Error(`${JSON.stringify(res.value.err ?? t?.meta?.err)}\n    ${logs.join('\n    ')}`);
  }
  return { sig, cu: t?.meta?.computeUnitsConsumed ?? 0 };
}

export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const fmtTime = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');
