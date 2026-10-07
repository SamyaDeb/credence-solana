// Live price recorder (tasks 2.6, 3.5/S7, 4.6, 5.2). Polls mainnet every POLL_MS and records:
//   - every new Pyth pro-compatible push update for Crypto.SPYX/QQQX/NVDAX/USD, as the raw account (solana account
//     JSON, usable with `solana-test-validator --account` and by tests/live.rs): data/live/pyth/<sym>-<publish>.json
//   - Kamino's Scope prices for the xStocks and USDC (value, Scope timestamp) when they change (S7: do they move at
//     weekends, and when?)
//   - Hermes access to the equity feeds (HTTP status changes; the key had no equity entitlement on Oct 8)
// Events append to data/live/events-<yyyymmdd>.jsonl. Secrets are never logged.
//
// Usage: nohup pnpm tsx src/record-prices.ts --until 2026-10-12T17:00:00Z > ../data/live/recorder.log 2>&1 &
import { config } from 'dotenv';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const OUT = join(ROOT, 'data/live');
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const POLL_MS = 10_000;
const untilArg = process.argv.indexOf('--until');
const UNTIL = untilArg > 0 ? Date.parse(process.argv[untilArg + 1]) : Date.now() + 3600_000;

export const PUSH: Record<string, string> = {
  SPYx: '27Tv3HxU34AKxZ8MgfFAA1gCbWa96msMG5BvSWAHkBfj',
  QQQx: 'BMcyd2UQqakGbWnNRAC67TLAFhV64dzLVeEyRHKyzmUi',
  NVDAx: 'VSgf6jkwrcs9jbLuR57iN1Gk2c68vT9stZe8G6GGix2',
};
const SCOPE = '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH';
const SCOPE_CHAINS: Record<string, number> = { SPYx: 344, QQQx: 347, NVDAx: 332, USDC: 13 };
const EQUITY: Record<string, string> = {
  SPY: '19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
  QQQ: '9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d',
  NVDA: 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
};

/** PriceUpdateV2: disc 8, write_authority 32, verification level (Partial = 2 bytes, Full = 1), PriceFeedMessage. */
export function decodePush(d: Buffer) {
  const full = d[40] === 1;
  const o = full ? 41 : 42;
  const expo = d.readInt32LE(o + 48);
  return {
    full,
    price: Number(d.readBigInt64LE(o + 32)) * 10 ** expo,
    conf: Number(d.readBigUInt64LE(o + 40)) * 10 ** expo,
    publishTime: Number(d.readBigInt64LE(o + 52)),
  };
}

function scopeEntry(d: Buffer, chain: number) {
  const o = 8 + 32 + chain * 56;
  const value = d.readBigUInt64LE(o);
  const exp = Number(d.readBigUInt64LE(o + 8));
  return { price: Number(value) / 10 ** exp, ts: Number(d.readBigUInt64LE(o + 24)) };
}

const day = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');
const event = (e: Record<string, unknown>) =>
  appendFileSync(join(OUT, `events-${day()}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');

async function hermesStatus(id: string): Promise<number> {
  try {
    const r = await fetch(`https://pyth.dourolabs.app/hermes/v2/updates/price/latest?ids%5B%5D=${id}&parsed=true`, {
      headers: { Authorization: `Bearer ${process.env.PYTH_API_KEY ?? ''}` },
    });
    return r.status;
  } catch {
    return -1;
  }
}

async function main() {
  mkdirSync(join(OUT, 'pyth'), { recursive: true });
  const lastPush: Record<string, number> = {};
  const lastScope: Record<string, number> = {};
  const lastHermes: Record<string, number> = {};
  const keys = [...Object.values(PUSH), SCOPE].map((k) => new PublicKey(k));
  let n = 0;
  event({ kind: 'start', until: new Date(UNTIL).toISOString() });
  while (Date.now() < UNTIL) {
    try {
      const res = await conn.getMultipleAccountsInfoAndContext(keys, 'confirmed');
      Object.keys(PUSH).forEach((sym, i) => {
        const a = res.value[i];
        if (!a) return;
        const u = decodePush(a.data);
        if (lastPush[sym] === u.publishTime) return;
        lastPush[sym] = u.publishTime;
        const file = join(OUT, 'pyth', `${sym}-${u.publishTime}.json`);
        if (!existsSync(file)) {
          writeFileSync(file, JSON.stringify({
            pubkey: PUSH[sym],
            account: {
              lamports: a.lamports, data: [a.data.toString('base64'), 'base64'], owner: a.owner.toBase58(),
              executable: false, rentEpoch: 0, space: a.data.length,
            },
            observedSlot: res.context.slot,
          }) + '\n');
        }
        event({ kind: 'pyth', sym, ...u, slot: res.context.slot });
      });
      const scope = res.value[3]?.data;
      if (scope) {
        for (const [sym, chain] of Object.entries(SCOPE_CHAINS)) {
          const s = scopeEntry(scope, chain);
          if (lastScope[sym] !== s.ts) {
            const moved = lastScope[sym] !== undefined;
            lastScope[sym] = s.ts;
            if (sym !== 'USDC' || !moved) event({ kind: 'scope', sym, price: s.price, ts: s.ts });
          }
        }
      }
      if (n % 30 === 0) {
        for (const [sym, id] of Object.entries(EQUITY)) {
          const st = await hermesStatus(id);
          if (lastHermes[sym] !== st) {
            lastHermes[sym] = st;
            event({ kind: 'hermes-equity', sym, status: st });
          }
        }
      }
    } catch (e) {
      event({ kind: 'error', message: String(e).slice(0, 200) });
    }
    n++;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  event({ kind: 'stop' });
}
main();
