// Credence keeper. Runs every job in order (jobs.ts) once, or in a loop.
//
//   pnpm keeper                 # loop, every KEEPER_INTERVAL_SECS (default 30)
//   pnpm keeper --once          # one pass
//   RPC_URL=… KEEPER_WALLET=… pnpm keeper --weekends 4
//
// The wallet must be `Config.keeper` for snapshot_close, post_settlement and halt_epoch; every other job is permissionless.
import { config } from 'dotenv';
import { join } from 'node:path';
import { ROOT, connect, log } from './chain.js';
import { tick } from './jobs.js';
import { redact } from './redact.js';

config({ path: join(ROOT, '.env'), quiet: true });
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const once = process.argv.includes('--once');
const weekends = Number(arg('--weekends') ?? 4);
const interval = Number(process.env.KEEPER_INTERVAL_SECS ?? 30);

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  log(`keeper ${c.payer.publicKey.toBase58()} on ${redact(c.url)}`);
  for (;;) {
    const r = await tick(c, weekends); // never throws; failed jobs are retried on the next pass
    log(`pass done: ${r.sent.length} sent, ${r.failed.length} failed, ${r.waiting.length} waiting`);
    if (once) process.exit(r.failed.length > 0 ? 1 : 0);
    await new Promise((res) => setTimeout(res, interval * 1000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
