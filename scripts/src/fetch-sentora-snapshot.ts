// Snapshot of Kamino's Sentora xStocks Market for the LiteSVM tests of multi-collateral and PYUSD cover (W4): the
// market, its SPYx, NVDAx, QQQx and PYUSD reserves, the PYUSD mint (Token-2022) and supply vault, and two real
// obligations: 3cwtNSst… (SPYx / PYUSD) and xkHzu8RC… (SPYx + NVDAx / PYUSD). One getMultipleAccounts call for the
// market, reserves and obligations (one slot), then the mint and vault the PYUSD reserve names. Mainnet read only.
//   programs/credence-core/tests/fixtures/sentora/<name>.bin, snapshot.json
// Usage: pnpm tsx src/fetch-sentora-snapshot.ts   (MAINNET_RPC in .env)
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const DIR = join(ROOT, 'programs/credence-core/tests/fixtures/sentora');
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const FIRST: Record<string, string> = {
  market: '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr',
  reserve_spyx: '7Yh74hEtP75acqhQ5f2FqoHQny5TYiYBPVxkwN35rCSi',
  reserve_nvdax: '4WqQtjQbewk7ptnXsX3E3Tf3M4pa9YiBsgAqjsJDkspH',
  reserve_qqqx: 'w6diwHyXhRzmhRWwnz3jQPqTt35qFbBDcQP7T2VdgSm',
  reserve_pyusd: '6bR98MJTH68s7eV8ssyBgfuuH5oR2bEt58P9rZPLpBrC',
  obligation_single: '3cwtNSstL1ks6c8LGHYp8j6ueess35ykC96kFbejEFBE',
  obligation_multi: 'xkHzu8RCP7giAaBq6AwRu7MreJc2RTLthqLe3yoyiBu',
};

async function fetchAll(names: Record<string, string>, meta: Record<string, unknown>) {
  const res = await conn.getMultipleAccountsInfoAndContext(Object.values(names).map((k) => new PublicKey(k)), 'confirmed');
  Object.keys(names).forEach((name, i) => {
    const a = res.value[i];
    if (!a) throw new Error(`${name} missing`);
    writeFileSync(join(DIR, `${name}.bin`), a.data);
    meta[name] = { address: names[name], owner: a.owner.toBase58(), lamports: a.lamports, len: a.data.length, slot: res.context.slot };
  });
  return res;
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const meta: Record<string, unknown> = {};
  const res = await fetchAll(FIRST, meta);
  const py = Reserve.decode(res.value[4]!.data);
  await fetchAll({ pyusd_mint: py.liquidity.mintPubkey.toString(), pyusd_supply: py.liquidity.supplyVault.toString() }, meta);
  writeFileSync(join(DIR, 'snapshot.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), accounts: meta }, null, 2) + '\n');
  console.log(JSON.stringify(meta, null, 2));
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
