// W16 (task B4): the real Token-2022 mint accounts of every xStock in data/onchain/assets.json, read-only from mainnet,
// as LiteSVM fixtures (programs/credence-core/tests/fixtures/mint_<ticker>.bin). Existing fixtures are kept (the tests'
// goldens use their multipliers); delete one to refresh it.
// Usage: pnpm tsx src/fetch-xstock-mints.ts      (MAINNET_RPC in .env)
import { config } from 'dotenv';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: `${ROOT}.env`, quiet: true });
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const assets = JSON.parse(readFileSync(`${ROOT}data/onchain/assets.json`, 'utf8')) as { ticker: string; mint: string }[];
const infos = await conn.getMultipleAccountsInfo(assets.map((a) => new PublicKey(a.mint)));
infos.forEach((info, i) => {
  if (!info) throw new Error(`${assets[i].ticker}: mint not found`);
  const f = `${ROOT}programs/credence-core/tests/fixtures/mint_${assets[i].ticker}.bin`;
  if (existsSync(f)) return;
  writeFileSync(f, info.data);
  console.log(`${assets[i].ticker}: ${info.data.length} bytes, owner ${info.owner.toBase58()}`);
});
