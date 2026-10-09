// LiteSVM fixtures for Jupiter Lend cover (W12, task B2), mainnet read only: one real SPYx/USDC position of vault 78
// (the largest whose D/C′ the tests can set through the cache price), its NFT holder's token account, the vault's config,
// state and tick, its oracle and Chainlink cache, Jupiter's lookup table, and `operate`'s accounts (built by
// `@jup-ag/lend` for the credence vault PDA as signer and its `vault_usdc` as the paying account) for the two paybacks
// the tests send: SHIELD (α × cap of a 2,000 USDC cap = 1,000 USDC) and SETTLE (3,000 USDC). Every account any of them
// names is stored from one slot, except credence_core's own (the tests create them) and executables.
//   programs/credence-core/tests/fixtures/jupiter/<address>.bin, snapshot.json
// Usage: pnpm tsx src/fetch-jupiter-fixtures.ts [--position <pubkey>]     (MAINNET_RPC in .env)
import { config } from 'dotenv';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { getOperateIx } from '@jup-ag/lend/borrow';
import { IDL } from './chain.js';
import { redact } from './redact.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const conn = new web3.Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const DIR = join(ROOT, 'programs/credence-core/tests/fixtures/jupiter');
const VAULTS = new web3.PublicKey('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');
const CORE = new web3.PublicKey(IDL.address);
const VAULT_ID = 78;
// Built for what the program offers operate: the amount less 1 unit (Jupiter takes one more; audit A-55).
const PLANS = { shield: 1_000_000_000n - 1n, settle: 3_000_000_000n - 1n };
const POSITION_DISC = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const vaultPda = web3.PublicKey.findProgramAddressSync([Buffer.from('vault')], CORE)[0];
  const vaultUsdc = web3.PublicKey.findProgramAddressSync([Buffer.from('vault_usdc')], CORE)[0];
  let position: InstanceType<typeof web3.PublicKey>;
  if (arg('--position')) position = new web3.PublicKey(arg('--position')!);
  else {
    const all = await conn.getProgramAccounts(VAULTS, { filters: [
      { memcmp: { offset: 0, bytes: POSITION_DISC.toString('base64'), encoding: 'base64' } } as never,
      { memcmp: { offset: 8, bytes: Buffer.from([VAULT_ID & 255, VAULT_ID >> 8]).toString('base64'), encoding: 'base64' } } as never] });
    // A mid-sized borrower (debt well above the paybacks) so both plans leave it borrowing.
    const withDebt = all.filter(({ account: { data: d } }) => d[46] === 0 && d.readInt32LE(47) > 3000 && d.readBigUInt64LE(55) > 20_000_000_000n);
    position = withDebt.sort((a, b) => Number(b.account.data.readBigUInt64LE(55) - a.account.data.readBigUInt64LE(55)))[Math.floor(withDebt.length / 2)].pubkey;
  }
  const pd = (await conn.getAccountInfo(position))!.data;
  const nftId = pd.readUInt32LE(10);
  const mint = new web3.PublicKey(pd.subarray(14, 46));
  const holder = (await conn.getTokenLargestAccounts(mint)).value[0].address;
  const holderInfo = (await conn.getAccountInfo(holder))!;
  const owner = new web3.PublicKey(holderInfo.data.subarray(32, 64));

  const plans: Record<string, unknown> = {};
  const keys = new Set<string>([position.toBase58(), holder.toBase58()]);
  let lookupTable = '';
  for (const [name, amount] of Object.entries(PLANS)) {
    const op = await getOperateIx({ vaultId: VAULT_ID, positionId: nftId, colAmount: new BN(0), debtAmount: new BN((-amount).toString()),
      connection: conn, signer: vaultPda, positionOwner: owner, market: 'main' } as never);
    const ix = op.operateIx;
    const borrowAta = (op.accounts as any).signerBorrowTokenAccount as InstanceType<typeof web3.PublicKey>;
    const metas = ix.keys.map((k: any) => ({ pubkey: (k.pubkey.equals(borrowAta) ? vaultUsdc : k.pubkey).toBase58(), writable: k.isWritable }));
    const pre = (op.ixs as any[]).filter((x) => x !== ix && x.programId.equals(VAULTS))
      .map((x) => ({ data: Buffer.from(x.data).toString('base64'), keys: x.keys.map((k: any) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })) }));
    plans[name] = { amount: amount.toString(), indices: [...(op.remainingAccountsIndices as number[])], metas, pre };
    for (const m of metas) keys.add(m.pubkey);
    lookupTable = (op.addressLookupTableAddresses as any[])[0]?.toBase58() ?? '';
    for (const p of pre) for (const k of p.keys) keys.add(k.pubkey);
  }
  // Buy: the vault config, state, the position's tick, the vault's oracle and its cache.
  const cfg = (await conn.getAccountInfo(new web3.PublicKey(JSON.parse(JSON.stringify(plans.shield)).metas[6].pubkey)))!.data;
  const oracle = new web3.PublicKey(cfg.subarray(26, 58));
  const od = (await conn.getAccountInfo(oracle))!.data;
  const cache = new web3.PublicKey(od.subarray(14, 46));
  const tickPda = web3.PublicKey.findProgramAddressSync([Buffer.from('tick'), Buffer.from([VAULT_ID & 255, VAULT_ID >> 8]),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(pd.readInt32LE(47) + 16383); return b; })()], VAULTS)[0];
  for (const k of [oracle, cache, tickPda]) keys.add(k.toBase58());
  if (lookupTable) keys.add(lookupTable);
  // Not stored: credence_core's own accounts (the tests create them), program ids, sysvars, the mints the tests have.
  const skip = new Set([vaultPda.toBase58(), vaultUsdc.toBase58(), VAULTS.toBase58(), CORE.toBase58(), web3.SystemProgram.programId.toBase58(),
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC', 'jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc', 'SysvarRent111111111111111111111111111111111',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W']);
  const list = [...keys].filter((k) => !skip.has(k));
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const meta: Record<string, unknown> = {};
  let slot = 0;
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    const res = await conn.getMultipleAccountsInfoAndContext(part.map((k) => new web3.PublicKey(k)));
    slot = res.context.slot;
    res.value.forEach((a, j) => {
      if (!a || a.executable) return; // not created yet (an operate init) or a program
      writeFileSync(join(DIR, `${part[j]}.bin`), a.data);
      meta[part[j]] = { owner: a.owner.toBase58(), lamports: a.lamports };
    });
  }
  const unix = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  writeFileSync(join(DIR, 'snapshot.json'), JSON.stringify({
    fetchedAt: new Date().toISOString(), slot, unix, vaultId: VAULT_ID, position: position.toBase58(), nftId, nftMint: mint.toBase58(),
    nftHolder: holder.toBase58(), owner: owner.toBase58(), vaultConfig: plans.shield && (plans.shield as any).metas[6].pubkey, vaultState: (plans.shield as any).metas[7].pubkey,
    oracle: oracle.toBase58(), cache: cache.toBase58(), tick: tickPda.toBase58(), lookupTable, plans, accounts: meta,
  }, null, 1) + '\n');
  console.log(`position ${position.toBase58()} (#${nftId}), ${Object.keys(meta).length} accounts at slot ${slot}; plans: ${Object.entries(plans).map(([k, v]) => `${k} ${(v as any).metas.length} accounts, ${(v as any).pre.length} pre`).join('; ')}`);
}
main().catch((e) => { console.error(redact(String(e?.stack ?? e))); process.exit(1); });
