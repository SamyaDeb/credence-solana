// Snapshot of Kamino's xStocks Market for LiteSVM tests that run the real klend program (refresh + repay v2):
// every account in ONE getMultipleAccounts call (same slot), plus the klend and farms program binaries.
//
//   programs/credence-core/tests/fixtures/klend/<name>.bin      account data (committed: public on-chain state)
//   programs/credence-core/tests/fixtures/klend/snapshot.json   addresses, owners, slot, Scope timestamps
//   programs/credence-core/tests/fixtures/programs/*.so         klend + farms (git-ignored: klend is BUSL-1.1, so we
//                                                               fetch it from mainnet like `--clone` does, never commit)
// Usage: pnpm tsx src/fetch-klend-snapshot.ts [--programs-only]   (reads MAINNET_RPC from .env)
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const FIX = join(ROOT, 'programs/credence-core/tests/fixtures');
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');

const PROGRAMS: Record<string, string> = {
  klend: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
  farms: 'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr',
};
const ACCOUNTS: Record<string, string> = {
  market: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua',
  scope_prices: '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH',
  reserve_usdc: '97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E',
  reserve_spyx: 'UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d',
  usdc_supply_vault: '72Gz8BM8vDr5zdeHmFB5A2ptNZYfVgDuw5LDkNwGDdTA',
  usdc_debt_farm: '82eHAjSXZEyA3UpBxTjVYXF4QJmAEtLR6kvWXQca7mqd',
  farms_global_config: '6UodrBjL2ZreDy7QdR4YV1oxqMBjVYSEyrFpctqqwGwL',
  obligation: '47wNsqpypn5t1nhXW992P3QGRwMDZFbmsvNaMm6vT58N',
  obligation_farm_user_state: 'EGKWCcqy46v9mMnardw4MJZ3vdCNmPEuLwH2yRNw3vff',
};

/** Upgradeable program: program account → programdata; the ELF starts after the 45-byte programdata header. */
async function dumpProgram(name: string, id: string) {
  const p = await conn.getAccountInfo(new PublicKey(id));
  if (!p) throw new Error(`${name} missing`);
  const pd = new PublicKey(p.data.subarray(4, 36));
  const d = await conn.getAccountInfo(pd);
  if (!d) throw new Error(`${name} programdata missing`);
  mkdirSync(join(FIX, 'programs'), { recursive: true });
  writeFileSync(join(FIX, 'programs', `${name}.so`), d.data.subarray(45));
  console.log(`${name}.so ${d.data.length - 45} bytes`);
}

async function main() {
  for (const [n, id] of Object.entries(PROGRAMS)) await dumpProgram(n, id);
  if (process.argv.includes('--programs-only')) return;
  const keys = Object.values(ACCOUNTS).map((k) => new PublicKey(k));
  const res = await conn.getMultipleAccountsInfoAndContext(keys, 'confirmed');
  const dir = join(FIX, 'klend');
  mkdirSync(dir, { recursive: true });
  const meta: Record<string, unknown> = { slot: res.context.slot, fetchedAt: new Date().toISOString(), accounts: {} };
  Object.keys(ACCOUNTS).forEach((name, i) => {
    const a = res.value[i];
    if (!a) throw new Error(`${name} missing`);
    writeFileSync(join(dir, `${name}.bin`), a.data);
    (meta.accounts as Record<string, unknown>)[name] = { address: ACCOUNTS[name], owner: a.owner.toBase58(), lamports: a.lamports, len: a.data.length };
  });
  // Scope OraclePrices: 8-byte discriminator, oracle_mappings (32), then 512 × DatedPrice
  // { price: { value u64, exp u64 }, last_updated_slot u64, unix_timestamp u64, _reserved [u64; 2], _reserved2 [u16; 3], index u16 } = 56 bytes.
  const scope = res.value[1]!.data;
  const ts = (chain: number) => Number(scope.readBigUInt64LE(8 + 32 + chain * 56 + 24));
  meta.scope = Object.fromEntries([['SPYx', 344], ['QQQx', 347], ['NVDAx', 332], ['USDC', 13]].map(([s, c]) => [s, { chain: c, unixTimestamp: ts(c as number) }]));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(JSON.stringify(meta, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
