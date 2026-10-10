// Snapshot of Kamino's OnRe Market for LiteSVM tests of the NAV asset (D4): the ONyc reserve and one real ONyc/USDC obligation,
// every account in ONE getMultipleAccounts call (same slot), as `fetch-klend-snapshot.ts` does for the xStocks Market. The klend and farms
// binaries come from `fetch-klend-snapshot.ts --programs-only`.
//
//   programs/credence-core/tests/fixtures/onre/<name>.bin   account data (committed: public on-chain state)
//   programs/credence-core/tests/fixtures/onre/snapshot.json
// Usage: pnpm tsx src/fetch-onre-snapshot.ts [obligation]   (reads MAINNET_RPC from .env). With no argument it picks the real
// obligation with one ONyc deposit and one USDC borrow (borrow factor 100%, no elevation group) whose D/C′ is closest to 0.92.
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { redact } from './lib/redact.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const FIX = join(ROOT, 'programs/credence-core/tests/fixtures/onre');
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const FARMS = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
const MARKET = '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8';
const SCOPE = '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH';
const ONYC_RESERVE = '6ZxkBSJEqsXA3Kdm2PDAzHLUdPTPUK93Lf4bAezec1UQ';
const ONYC_MINT = '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));
const sf = (d: Buffer, o: number) => Number((d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n)) >> 40n) / 2 ** 20;

async function pick(): Promise<{ key: PublicKey; borrowReserve: PublicKey }> {
  const obs = await conn.getProgramAccounts(KLEND, { filters: [{ dataSize: 3344 }, { memcmp: { offset: 32, bytes: MARKET } }] });
  const reserves = new Map<string, Buffer>();
  let best: { key: PublicKey; borrowReserve: PublicKey; score: number } | null = null;
  for (const o of obs) {
    const d = o.account.data;
    const deps = [...Array(8).keys()].map((i) => pk(d, 96 + i * 136)).filter((k) => !k.equals(PublicKey.default));
    const bors = [...Array(5).keys()].map((i) => pk(d, 1208 + i * 200)).filter((k) => !k.equals(PublicKey.default));
    if (deps.length !== 1 || deps[0].toBase58() !== ONYC_RESERVE || bors.length !== 1 || d[2285] !== 0) continue;
    const bk = bors[0].toBase58();
    if (!reserves.has(bk)) reserves.set(bk, (await conn.getAccountInfo(bors[0]))!.data);
    const b = reserves.get(bk)!;
    if (pk(b, 128).toBase58() !== USDC || b[5008] !== 100 || pk(b, 96).equals(PublicKey.default)) continue; // a USDC reserve with a debt farm
    const ratio = sf(d, 2224) / sf(d, 2256);
    const borrowed = sf(d, 2224);
    if (borrowed < 50_000 || borrowed > 5_000_000) continue;
    const score = Math.abs(ratio - 0.92);
    if (!best || score < best.score) best = { key: o.pubkey, borrowReserve: bors[0], score };
  }
  if (!best) throw new Error('no suitable ONyc/USDC obligation');
  return best;
}

async function main() {
  const arg = process.argv[2];
  let key: PublicKey, borrowReserve: PublicKey;
  if (arg) {
    key = new PublicKey(arg);
    borrowReserve = pk((await conn.getAccountInfo(key))!.data, 1208);
  } else ({ key, borrowReserve } = await pick());
  const usdcRes = (await conn.getAccountInfo(borrowReserve))!.data;
  const supplyVault = pk(usdcRes, 160), debtFarm = pk(usdcRes, 96);
  const farmUser = PublicKey.findProgramAddressSync([Buffer.from('user'), debtFarm.toBuffer(), key.toBuffer()], FARMS)[0];
  // FarmState: discriminator 8, farm_admin 32, global_config 32.
  const farmsGlobal = pk((await conn.getAccountInfo(debtFarm))!.data, 40);
  const accounts: Record<string, string> = {
    market: MARKET, scope_prices: SCOPE, reserve_onyc: ONYC_RESERVE, reserve_usdc: borrowReserve.toBase58(), usdc_supply_vault: supplyVault.toBase58(),
    usdc_debt_farm: debtFarm.toBase58(), obligation: key.toBase58(), onyc_mint: ONYC_MINT,
  };
  // The obligation's farm user state exists only if the obligation touched the farm; farms global config is optional.
  const optional: Record<string, string> = { obligation_farm_user_state: farmUser.toBase58(), farms_global_config: farmsGlobal.toBase58() };
  const names = [...Object.keys(accounts), ...Object.keys(optional)];
  const keys = [...Object.values(accounts), ...Object.values(optional)].map((k) => new PublicKey(k));
  const res = await conn.getMultipleAccountsInfoAndContext(keys, 'confirmed');
  mkdirSync(FIX, { recursive: true });
  const meta: Record<string, unknown> = { slot: res.context.slot, fetchedAt: new Date().toISOString(), accounts: {} };
  names.forEach((name, i) => {
    const a = res.value[i];
    if (!a) {
      if (name in optional) { console.log(`${name}: absent (${keys[i].toBase58()})`); return; }
      throw new Error(`${name} missing`);
    }
    writeFileSync(join(FIX, `${name}.bin`), a.data);
    (meta.accounts as Record<string, unknown>)[name] = { address: keys[i].toBase58(), owner: a.owner.toBase58(), lamports: a.lamports, len: a.data.length };
  });
  const scope = res.value[1]!.data;
  const ts = (chain: number) => Number(scope.readBigUInt64LE(8 + 32 + chain * 56 + 24));
  meta.scope = { ONyc: { chain: 350, unixTimestamp: ts(350) }, USDC: { chain: 13, unixTimestamp: ts(13) } };
  const ob = res.value[names.indexOf('obligation')]!.data;
  meta.obligation = { owner: pk(ob, 64).toBase58(), borrowedUsd: sf(ob, 2224), unhealthyUsd: sf(ob, 2256), depositedUsd: sf(ob, 1192) };
  writeFileSync(join(FIX, 'snapshot.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(JSON.stringify(meta, null, 2));
}
main().catch((e) => { console.error(redact(String(e?.stack ?? e))); process.exit(1); });
