// Weekend helpers shared by the CLI demo (demo.ts) and the app's demo mode (app-step.ts), fork only:
//   recordedScope  the genuine Scope reading the live recorder captured in a time window (data/live/events-*.jsonl)
//   writeScope     write Scope entries (price, refresh time) into the fork's OraclePrices account
//   restampScope   move Scope chains' refresh time to the fork clock, keeping the price (klend's 300 s max age)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Chain, ROOT, SCOPE_PRICES, chainNow, decodeScope } from './chain.js';
import { setAccount } from './fork.js';

/** Genuine Scope readings the live recorder captured: the latest one of `sym` refreshed in [from, to], if any. */
export function recordedScope(sym: string, from: number, to: number): { price: number; ts: number } | null {
  const dir = join(ROOT, 'data/live');
  let best: { price: number; ts: number } | null = null;
  for (const f of readdirSync(dir).filter((x) => /^events-\d+\.jsonl$/.test(x))) {
    for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!l.includes('"kind":"scope"') || !l.includes(`"sym":"${sym}"`)) continue;
      const e = JSON.parse(l) as { price: number; ts: number };
      if (e.ts >= from && e.ts <= to && (!best || e.ts > best.ts)) best = { price: e.price, ts: e.ts };
    }
  }
  return best;
}

/** Writes Scope entries {chain: [price USD, refresh time]} into the fork's Scope account (value with 8 decimals). */
export async function writeScope(c: Chain, entries: { chain: number; price: number; ts: number }[]) {
  const acc = (await c.conn.getAccountInfo(SCOPE_PRICES))!;
  const d = Buffer.from(acc.data);
  const slot = BigInt(await c.conn.getSlot());
  for (const x of entries) {
    const o = decodeScope(d, x.chain).offsets;
    d.writeBigUInt64LE(BigInt(Math.round(x.price * 1e8)), o.value);
    d.writeBigUInt64LE(8n, o.exp);
    d.writeBigUInt64LE(slot, o.slot);
    d.writeBigUInt64LE(BigInt(x.ts), o.ts);
  }
  await setAccount(c, SCOPE_PRICES.toBase58(), { lamports: acc.lamports, data: d, owner: acc.owner.toBase58() });
}

/** Moves each (price, TWAP) Scope pair's refresh time and slot to the fork's clock, keeping the price (fork only).
 * If a simulated gap left the TWAP more than 2% from the price (klend refuses a TWAP more than 5% away; a real TWAP
 * converges within days), the TWAP is set to the price, as the app's /api/fork/scope-fresh does. */
export async function restampScope(c: Chain, pairs: { price: number; twap: number | null }[]) {
  const acc = (await c.conn.getAccountInfo(SCOPE_PRICES))!;
  const d = Buffer.from(acc.data);
  const [slot, now] = [BigInt(await c.conn.getSlot()), BigInt(await chainNow(c))];
  const stamp = (ch: number) => { const o = decodeScope(d, ch).offsets; d.writeBigUInt64LE(slot, o.slot); d.writeBigUInt64LE(now, o.ts); };
  let aligned = false;
  for (const p of pairs) {
    stamp(p.price);
    if (p.twap === null) continue;
    if (Math.abs(decodeScope(d, p.twap).price / decodeScope(d, p.price).price - 1) > 0.02) {
      const [from, to] = [decodeScope(d, p.price).offsets.value, decodeScope(d, p.twap).offsets.value];
      d.copy(d, to, from, from + 16); // value + exp
      aligned = true;
    }
    stamp(p.twap);
  }
  await setAccount(c, SCOPE_PRICES.toBase58(), { lamports: acc.lamports, data: d, owner: acc.owner.toBase58() });
  return { aligned };
}
