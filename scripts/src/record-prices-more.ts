// Live price recorder for the other five xStocks (C3, W17): TSLAx, GOOGLx, AAPLx, MSTRx, HOODx. A second process next to
// record-prices.ts (which records SPYx, QQQx, NVDAx and is not touched): same files, same schema, so the Oracle page and
// the Gap Oracle feed can show all eight.
//   - every new Pyth push update of Crypto.<T>X/USD, as the raw account: data/live/pyth/<sym>-<publish>.json
//   - Kamino's Scope price per asset when its value or time changes: events in data/live/events-<yyyymmdd>.jsonl
// The assets, their Scope chains and Pyth feed ids come from data/onchain/assets.json (no ticker list here).
//
// Usage: nohup pnpm tsx src/record-prices-more.ts --until 2026-10-12T17:00:00Z > ../data/live/recorder-more.log 2>&1 &
import { config } from 'dotenv';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
// Output goes to the checkout the first recorder writes to (its data/live), not necessarily the one this file is in.
const OUT = join(process.env.CREDENCE_DATA_ROOT ?? ROOT, 'data/live');
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const POLL_MS = 10_000;
const untilArg = process.argv.indexOf('--until');
const UNTIL = untilArg > 0 ? Date.parse(process.argv[untilArg + 1]) : Date.now() + 3600_000;
if (Number.isNaN(UNTIL)) throw new Error('--until needs a date, e.g. 2026-10-12T17:00:00Z');
/** record-prices.ts records these three; this process records every other asset of assets.json. */
const FIRST_RECORDER = new Set(['SPYx', 'QQQx', 'NVDAx']);
const PYTH_PUSH_ORACLE = new PublicKey('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const SCOPE = new PublicKey('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH');

type A = { ticker: string; scopeChain: number; feeds: { xstock: string } };
const assets = (JSON.parse(readFileSync(join(ROOT, 'data/onchain/assets.json'), 'utf8')) as A[]).filter((a) => !FIRST_RECORDER.has(a.ticker));
const push = (a: A) => PublicKey.findProgramAddressSync([Buffer.from([0, 0]), Buffer.from(a.feeds.xstock, 'hex')], PYTH_PUSH_ORACLE)[0];

/** PriceUpdateV2: disc 8, write_authority 32, verification level (Partial = 2 bytes, Full = 1), PriceFeedMessage. */
function decodePush(d: Buffer) {
  const full = d[40] === 1;
  const o = full ? 41 : 42;
  const expo = d.readInt32LE(o + 48);
  return { full, price: Number(d.readBigInt64LE(o + 32)) * 10 ** expo, conf: Number(d.readBigUInt64LE(o + 40)) * 10 ** expo, publishTime: Number(d.readBigInt64LE(o + 52)) };
}
function scopeEntry(d: Buffer, chain: number) {
  const o = 8 + 32 + chain * 56;
  return { price: Number(d.readBigUInt64LE(o)) / 10 ** Number(d.readBigUInt64LE(o + 8)), ts: Number(d.readBigUInt64LE(o + 24)) };
}
/** Error text goes to a git-tracked file: no URL (an RPC endpoint can carry an api key), no key=value. */
const scrub = (m: string) => m.replace(/(https?|wss?):\/\/\S+/gi, '<rpc>').replace(/(api[-_]?key|apikey|token|key)=[^&\s"')]+/gi, '$1=***').slice(0, 200);
const day = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');
const event = (e: Record<string, unknown>) => appendFileSync(join(OUT, `events-${day()}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');

async function main() {
  mkdirSync(join(OUT, 'pyth'), { recursive: true });
  const lastPush: Record<string, number> = {};
  const lastScope: Record<string, number> = {};
  const keys = [...assets.map(push), SCOPE];
  event({ kind: 'start', recorder: 'more', assets: assets.map((a) => a.ticker), until: new Date(UNTIL).toISOString() });
  while (Date.now() < UNTIL) {
    try {
      const res = await conn.getMultipleAccountsInfoAndContext(keys, 'confirmed');
      assets.forEach((a, i) => {
        try {
        const acc = res.value[i];
        if (!acc) return;
        const u = decodePush(acc.data);
        if (lastPush[a.ticker] === u.publishTime) return;
        lastPush[a.ticker] = u.publishTime;
        const file = join(OUT, 'pyth', `${a.ticker}-${u.publishTime}.json`);
        if (!existsSync(file)) {
          writeFileSync(file, JSON.stringify({
            pubkey: push(a).toBase58(),
            account: { lamports: acc.lamports, data: [acc.data.toString('base64'), 'base64'], owner: acc.owner.toBase58(), executable: false, rentEpoch: 0, space: acc.data.length },
            observedSlot: res.context.slot,
          }) + '\n');
        }
        event({ kind: 'pyth', sym: a.ticker, ...u, slot: res.context.slot });
        } catch (e) { event({ kind: 'error', recorder: 'more', sym: a.ticker, message: scrub(String(e)) }); } // one bad account must not skip the others
      });
      const scope = res.value[assets.length]?.data;
      if (scope) {
        for (const a of assets) {
          const s = scopeEntry(scope, a.scopeChain);
          if (lastScope[a.ticker] !== s.ts) {
            lastScope[a.ticker] = s.ts;
            event({ kind: 'scope', sym: a.ticker, price: s.price, ts: s.ts });
          }
        }
      }
    } catch (e) {
      event({ kind: 'error', recorder: 'more', message: scrub(String(e)) });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  event({ kind: 'stop', recorder: 'more' });
}
main();
