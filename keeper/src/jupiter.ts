// Jupiter Lend (W12) for the keeper: the Chainlink Data Streams cache a Jupiter alias asset settles on (source
// JUPITER), and `operate` payback accounts for settle_policy_jl / shield_advance_jl built with `@jup-ag/lend`.
//
// operate's tick accounts depend on the exact amount, so each payback is two steps: simulate the instruction with
// `expected = u64::MAX` (the program only returns the amount it computes now), then build operate's accounts for that
// amount and send. klend restricts Jupiter's Vaults program, so these transactions never carry a klend instruction.
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { getOperateIx } from '@jup-ag/lend/borrow';
import { type Chain, pk } from './chain.js';
import { offlineMissing } from './fork.js';

type PublicKey = InstanceType<typeof web3.PublicKey>;
type TransactionInstruction = InstanceType<typeof web3.TransactionInstruction>;
export const JL_VAULTS = pk('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');
const CACHE_DISC = Buffer.from([65, 102, 75, 47, 79, 156, 109, 193]);

/** A Chainlink Data Streams cache of Jupiter's oracle: price (USD per token) and its last update. */
export async function readJlCache(c: Chain, key: PublicKey): Promise<{ price: number; priceWad: bigint; unixTimestamp: number; suspended: boolean } | null> {
  const a = await c.conn.getAccountInfo(key);
  if (!a || !a.data.subarray(0, 8).equals(CACHE_DISC)) return null;
  const d = a.data;
  const o = 14 + 34 * d.readUInt32LE(10);
  const priceWad = d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
  return { price: Number(priceWad / 10n ** 10n) / 1e8, priceWad, unixTimestamp: Number(d.readBigUInt64LE(o + 16)), suspended: d[o + 16 + 24 + 8] !== 0 };
}

/** A Jupiter Lend position's vault id and NFT id (Position: vault_id u16 @8, nft_id u32 @10). */
export async function positionIds(c: Chain, position: PublicKey) {
  const a = await c.conn.getAccountInfo(position);
  if (!a || !a.owner.equals(JL_VAULTS)) return null;
  return { vaultId: a.data.readUInt16LE(8), nftId: a.data.readUInt32LE(10), mint: new web3.PublicKey(a.data.subarray(14, 46)), tick: a.data.readInt32LE(47), supplyOnly: a.data[46] !== 0 };
}

/** Who holds a Jupiter Lend position's NFT (the owner `operate` checks the position token account of, a payback
 * included): the largest holder of its mint. A book leg (C2) has no owner in the policy, so the keeper reads it here. */
export async function positionHolder(c: Chain, position: PublicKey): Promise<PublicKey> {
  const ids = await positionIds(c, position);
  if (!ids) throw new Error(`${position.toBase58()} is not a Jupiter Lend position`);
  const largest = await c.conn.getTokenLargestAccounts(ids.mint);
  const acc = largest.value.find((x) => x.uiAmount === 1);
  if (!acc) throw new Error(`no holder of position ${position.toBase58()}'s NFT`);
  const info = (await c.conn.getAccountInfo(acc.address))!;
  return new web3.PublicKey(info.data.subarray(32, 64));
}

/** `operate`'s accounts and remaining-account indices for a payback of `amount` USDC base units into `position` by
 * `payer` (the vault PDA), its USDC account replaced by `payFrom`; plus the instructions that must run first (tick or
 * branch accounts to create, signed by the keeper) and Jupiter's lookup tables. */
export async function paybackAccounts(c: Chain, position: PublicKey, positionOwner: PublicKey, payer: PublicKey, payFrom: PublicKey, amount: bigint) {
  const ids = await positionIds(c, position);
  if (!ids) throw new Error(`${position.toBase58()} is not a Jupiter Lend position`);
  const op = await getOperateIx({
    vaultId: ids.vaultId, positionId: ids.nftId, colAmount: new BN(0), debtAmount: new BN((-amount).toString()),
    connection: c.conn, signer: payer, positionOwner, market: 'main',
  } as never);
  const ix = op.operateIx as TransactionInstruction;
  const metas = ix.keys.map((k) => ({ pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable }));
  const borrowAta = (op.accounts as any).signerBorrowTokenAccount as PublicKey;
  for (const m of metas) if (m.pubkey.equals(borrowAta)) m.pubkey = payFrom;
  // Instructions `getOperateIx` puts before operate (tick / tick-id / branch inits) are paid by `signer`, the vault
  // PDA, which cannot sign a top-level transaction: build them again with the keeper as payer (same PDAs).
  let pre: TransactionInstruction[] = [];
  if ((op.ixs as TransactionInstruction[]).some((x) => x !== ix && x.programId.equals(JL_VAULTS))) {
    const k = await getOperateIx({
      vaultId: ids.vaultId, positionId: ids.nftId, colAmount: new BN(0), debtAmount: new BN((-amount).toString()),
      connection: c.conn, signer: c.payer.publicKey, positionOwner, market: 'main',
    } as never);
    pre = (k.ixs as TransactionInstruction[]).filter((x) => x !== k.operateIx && x.programId.equals(JL_VAULTS));
  }
  return { metas, indices: Buffer.from(op.remainingAccountsIndices as number[]), pre, lookupTables: op.addressLookupTableAccounts };
}

/** Sends `ixs` as one v0 transaction with Jupiter's lookup tables (operate's account list does not fit otherwise). */
export async function sendV0(c: Chain, ixs: TransactionInstruction[], lookupTables: any[], signers: InstanceType<typeof web3.Keypair>[] = []) {
  if (/127\.0\.0\.1|localhost/.test(c.url)) {
    const keys = [...ixs.flatMap((i) => i.keys.map((k) => k.pubkey.toBase58())), ...lookupTables.flatMap((t: any) => t.state.addresses.map((a: PublicKey) => a.toBase58()))];
    await offlineMissing(c.url, keys);
  }
  const { blockhash } = await c.conn.getLatestBlockhash();
  const msg = new web3.TransactionMessage({
    payerKey: c.payer.publicKey, recentBlockhash: blockhash,
    instructions: [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs],
  }).compileToV0Message(lookupTables);
  const tx = new web3.VersionedTransaction(msg);
  tx.sign([c.payer, ...signers]);
  const sig = await c.conn.sendTransaction(tx, { skipPreflight: true });
  await c.conn.confirmTransaction(sig, 'confirmed');
  const t = await c.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (t?.meta?.err) {
    const logs = (t.meta.logMessages ?? []).filter((l) => /Error|failed|AnchorError|Program log/.test(l)).slice(process.env.DEBUG_JL ? -30 : -6);
    throw new Error(`${JSON.stringify(t.meta.err)}\n    ${logs.join('\n    ')}`);
  }
  return { sig, cu: t?.meta?.computeUnitsConsumed ?? 0 };
}

/** Simulates `ix` (expected = u64::MAX) and returns the program's return data: the amount and what `operate` will be
 * offered (the amount `operate`'s accounts must be built for; 0 = no CPI). */
export async function simulateAmounts(c: Chain, ix: TransactionInstruction, lookupTables: any[] = []): Promise<{ amount: bigint; offer: bigint }> {
  const d = await simulateReturn(c, ix, lookupTables);
  return { amount: d.readBigUInt64LE(0), offer: d.length >= 16 ? d.readBigUInt64LE(8) : 0n };
}

/** Simulates `ix` (expected = u64::MAX) and returns the first u64 the program put in its return data. */
export async function simulateAmount(c: Chain, ix: TransactionInstruction, lookupTables: any[] = []): Promise<bigint> {
  return (await simulateReturn(c, ix, lookupTables)).readBigUInt64LE(0);
}

async function simulateReturn(c: Chain, ix: TransactionInstruction, lookupTables: any[]): Promise<Buffer> {
  const { blockhash } = await c.conn.getLatestBlockhash();
  const msg = new web3.TransactionMessage({ payerKey: c.payer.publicKey, recentBlockhash: blockhash,
    instructions: [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix] }).compileToV0Message(lookupTables);
  const tx = new web3.VersionedTransaction(msg);
  tx.sign([c.payer]);
  const r = await c.conn.simulateTransaction(tx, { sigVerify: false });
  if (r.value.err) throw new Error(`simulation: ${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-3).join(' | ')}`);
  const data = r.value.returnData?.data?.[0];
  if (!data) throw new Error('simulation returned no amount');
  return Buffer.from(data, 'base64');
}
