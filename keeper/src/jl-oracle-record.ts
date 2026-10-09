// B2.0 spike (S7 method on Jupiter Lend, read only): every 120 s, each xStock vault's oracle price as Jupiter Lend's
// operate and liquidate paths read it (`@jup-ag/lend` readOraclePrice, a simulation) and a hash of its Chainlink Data
// Streams cache account, to see when Jupiter's xStock prices freeze and move around the Oct 9–12 weekend.
//   → data/jupiter/oracle-weekend.jsonl (one line per vault per tick)
// Usage: nohup pnpm tsx src/jl-oracle-record.ts &      (MAINNET_RPC in .env; no key, no signer, no transaction)
import { config } from 'dotenv';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { readOraclePrice } from '@jup-ag/lend/borrow';
import { redact } from './redact.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const OUT = join(ROOT, 'data/jupiter/oracle-weekend.jsonl');
const vaults = JSON.parse(readFileSync(join(ROOT, 'data/jupiter/spike-20261009.json'), 'utf8')).xstockVaults as { vaultId: number; supply: string; borrow: string; oracle: string }[];
// One oracle per asset is enough (the USDC and JupUSD vaults of an asset share the xStock leg).
const seen = new Set<string>();
const oracles = vaults.filter((v) => !seen.has(v.oracle) && seen.add(v.oracle));

async function tick() {
  const ts = Math.floor(Date.now() / 1000);
  for (const v of oracles) {
    try {
      const r = await readOraclePrice({ connection: conn, oracle: new PublicKey(v.oracle) });
      const src = r.oracleSources[0].source;
      const a = await conn.getAccountInfo(src);
      appendFileSync(OUT, JSON.stringify({
        ts, vaultId: v.vaultId, asset: v.supply, debt: v.borrow, operate: r.oraclePriceOperate.toString(), liquidate: r.oraclePriceLiquidate.toString(),
        cache: src.toBase58(), cacheHash: a ? createHash('sha256').update(a.data).digest('hex').slice(0, 16) : null,
      }) + '\n');
    } catch (e) {
      appendFileSync(OUT, JSON.stringify({ ts, vaultId: v.vaultId, asset: v.supply, error: redact(String((e as Error)?.message ?? e)).slice(0, 200) }) + '\n');
    }
  }
}
for (;;) {
  const t0 = Date.now();
  await tick();
  await new Promise((res) => setTimeout(res, Math.max(1_000, 120_000 - (Date.now() - t0))));
}
