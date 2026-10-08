// Measures the update cadence of the Pyth pro-compatible push accounts for Crypto.<T>X/USD from their transaction
// history (one transaction per push update). Prints gaps and, per weekday session, the first update at or after the
// 13:30 UTC open and the last at or before the 20:00 UTC close (EDT).
// Usage: pnpm tsx src/push-cadence.ts [days=10]  → data/live/push-cadence.json
import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const DAYS = Number(process.argv[2] ?? 10);
// Same accounts as record-prices.ts (not imported: importing it would start a second recorder).
const PUSH: Record<string, string> = {
  SPYx: '27Tv3HxU34AKxZ8MgfFAA1gCbWa96msMG5BvSWAHkBfj',
  QQQx: 'BMcyd2UQqakGbWnNRAC67TLAFhV64dzLVeEyRHKyzmUi',
  NVDAx: 'VSgf6jkwrcs9jbLuR57iN1Gk2c68vT9stZe8G6GGix2',
};

async function times(addr: string): Promise<number[]> {
  const since = Date.now() / 1000 - DAYS * 86400;
  const out: number[] = [];
  let before: string | undefined;
  for (;;) {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { before, limit: 1000 });
    if (sigs.length === 0) break;
    for (const s of sigs) if (!s.err && s.blockTime) out.push(s.blockTime);
    before = sigs[sigs.length - 1].signature;
    if ((sigs[sigs.length - 1].blockTime ?? 0) < since) break;
  }
  return out.filter((t) => t >= since).sort((a, b) => a - b);
}

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16) + 'Z';
const result: Record<string, unknown> = {};
for (const [sym, addr] of Object.entries(PUSH)) {
  const ts = await times(addr);
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  const q = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))];
  const sessions: Record<string, unknown>[] = [];
  for (let d = new Date(ts[0] * 1000); d.getTime() / 1000 < ts[ts.length - 1]; d = new Date(d.getTime() + 86400_000)) {
    const day = d.toISOString().slice(0, 10);
    const wd = new Date(day + 'T12:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const open = Date.parse(day + 'T13:30:00Z') / 1000;
    const close = Date.parse(day + 'T20:00:00Z') / 1000;
    const first = ts.find((t) => t >= open);
    const last = [...ts].reverse().find((t) => t <= close);
    sessions.push({
      day,
      firstAfterOpenSecs: first !== undefined ? first - open : null,
      lastBeforeCloseSecs: last !== undefined ? close - last : null,
    });
  }
  result[sym] = {
    updates: ts.length, from: iso(ts[0]), to: iso(ts[ts.length - 1]),
    gapSecs: { p10: q(0.1), p50: q(0.5), p90: q(0.9), max: gaps[gaps.length - 1] }, sessions, times: ts,
  };
  console.log(sym, JSON.stringify({ ...(result[sym] as object), times: undefined }));
}
writeFileSync(join(ROOT, 'data/live/push-cadence.json'), JSON.stringify({ measuredAt: new Date().toISOString(), days: DAYS, result }, null, 2) + '\n');
