// Saves Kamino's Scope OraclePrices account (raw, as on mainnet) every time it refreshes inside a time range, for the
// SCOPE live checkpoints (tests/live.rs): data/live/scope/scope-<unix ts of the SPYx entry>.json. Secrets never logged.
// Usage: pnpm tsx src/capture-scope.ts --from 2026-10-09T19:58:00Z --to 2026-10-09T20:15:00Z
import { config } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const SCOPE = new PublicKey('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH');
const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1];
const FROM = Date.parse(arg('--from'));
const TO = Date.parse(arg('--to'));
const CHAINS = { SPYx: 344, QQQx: 347, NVDAx: 332 };
const dir = join(ROOT, 'data/live/scope');
mkdirSync(dir, { recursive: true });

while (Date.now() < FROM) await new Promise((r) => setTimeout(r, Math.min(30_000, FROM - Date.now())));
let last = -1;
while (Date.now() < TO) {
  try {
    const r = await conn.getAccountInfoAndContext(SCOPE, 'confirmed');
    const d = r.value!.data;
    const entry = (ch: number) => {
      const o = 8 + 32 + ch * 56;
      return { price: Number(d.readBigUInt64LE(o)) / 10 ** Number(d.readBigUInt64LE(o + 8)), ts: Number(d.readBigUInt64LE(o + 24)) };
    };
    const ts = entry(CHAINS.SPYx).ts;
    const file = join(dir, `scope-${ts}.json`);
    if (ts !== last && !existsSync(file)) {
      writeFileSync(file, JSON.stringify({
        pubkey: SCOPE.toBase58(), observedSlot: r.context.slot, observedAt: new Date().toISOString(),
        entries: Object.fromEntries(Object.entries(CHAINS).map(([s, c]) => [s, { chain: c, ...entry(c) }])),
        account: { lamports: r.value!.lamports, data: [d.toString('base64'), 'base64'], owner: r.value!.owner.toBase58(), executable: false, rentEpoch: 0, space: d.length },
      }) + '\n');
      console.log(new Date().toISOString(), 'saved', file.split('/').pop(), JSON.stringify(Object.fromEntries(Object.keys(CHAINS).map((s) => [s, entry(CHAINS[s as keyof typeof CHAINS]).price]))));
    }
    last = ts;
  } catch (e) {
    console.log(new Date().toISOString(), 'error', String(e).slice(0, 120));
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
