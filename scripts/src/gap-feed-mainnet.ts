// The Gap Oracle feed from MAINNET inputs (C3, W17), computed off-chain by the program's own Rust, for the Oracle page's
// public read-only mode (credence_core is not on mainnet, so there is no GapFeed account to read).
//   1. the closure the feed describes now (the SDK's `feedClosure`, same rule as calendar::feed_closure) from the calendar;
//   2. mainnet reads (read-only): Kamino's Scope `OraclePrices` and Pyth's push accounts of the eight xStocks;
//   3. the Friday close of that closure: the first captured Scope reading in [close, close + 15 min]
//      (data/live/scope/scope-*.json from the capture jobs), the price `snapshot_close` would store from Scope;
//   4. when each lender price last CHANGED, from the recorders' Scope events (Scope's refresh time keeps advancing while its
//      value is frozen, so the feed's frozen flag needs the value's own history);
//   5. `examples/gap_feed.rs` (compute(): the flag rules and arithmetic of update_gap_feed) on those inputs.
// Writes data/live/gap-feed-mainnet.json (under CREDENCE_DATA_ROOT when set: the checkout the recorders write to), which
// /api/oracle/feed serves. Jupiter aliases are not shown (their lender
// price is Jupiter's cache). Secrets: MAINNET_RPC stays in .env; nothing is logged but addresses and counts.
//
// Usage: cargo build -p credence-core --example gap_feed && (cd packages/sdk && pnpm build) && cd scripts && pnpm tsx src/gap-feed-mainnet.ts
import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const OUT = join(process.env.CREDENCE_DATA_ROOT ?? ROOT, 'data/live');
const SCOPE = new PublicKey('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH');
const PYTH_PUSH_ORACLE = new PublicKey('pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou');
const AFTER_CLOSE = 900;
const TYPE = ['', 'OVERNIGHT', 'WEEKEND', 'HOLIDAY_WEEKEND'];

type A = { ticker: string; scopeChain: number; feeds: { xstock: string } };
type Session = { date: number; open: number; close: number };

/** One Scope chain as {price WAD (BigInt), unix}: value × 10^(18 − exp). Null for an entry `scope::decode` refuses (value 0,
 * exp above 18, time 0): the program records that as MISSING_LENDER, so it must not reach the helper as a price. */
function scopeEntry(d: Buffer, chain: number) {
  const o = 8 + 32 + chain * 56;
  const value = d.readBigUInt64LE(o);
  const exp = d.readBigUInt64LE(o + 8);
  const ts = Number(d.readBigUInt64LE(o + 24));
  if (value === 0n || exp > 18n || ts === 0) return null;
  return { wad: value * 10n ** (18n - exp), ts };
}

/** PriceUpdateV2 → WAD price, publish time, conf in bps (rounded up), verification. */
function push(d: Buffer) {
  const full = d[40] === 1;
  const o = full ? 41 : 42;
  const expo = d.readInt32LE(o + 48);
  const price = d.readBigInt64LE(o + 32);
  const conf = d.readBigUInt64LE(o + 40);
  const wad = price > 0n && expo <= 0 && expo >= -18 ? price * 10n ** BigInt(18 + expo) : 0n;
  const confBps = price > 0n ? Number((conf * 10_000n + price - 1n) / price) : 0xffffffff;
  return { wad, publishTs: Number(d.readBigInt64LE(o + 52)), confBps, full };
}

async function main() {
  const assets = JSON.parse(readFileSync(join(ROOT, 'data/onchain/assets.json'), 'utf8')) as A[];
  const cal = JSON.parse(readFileSync(join(ROOT, 'data/onchain/calendar-XNYS.json'), 'utf8')) as { sessions: Session[] };
  const sdkPath = join(ROOT, 'packages/sdk/dist/index.js');
  if (!existsSync(sdkPath)) throw new Error('build the SDK first: (cd packages/sdk && pnpm build)');
  const { feedClosure } = (await import(sdkPath)) as { feedClosure: (s: Session[], now: number) => { id: number; type: number } | null };
  const now = Math.floor(Date.now() / 1000);
  const cl = feedClosure(cal.sessions, now);
  if (!cl) throw new Error('the calendar has no closure left');
  const i = cal.sessions.findIndex((s) => s.date === cl.id);
  const [closeTs, nextOpen] = [cal.sessions[i].close, cal.sessions[i + 1].open];

  const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
  const pushKeys = assets.map((a) => PublicKey.findProgramAddressSync([Buffer.from([0, 0]), Buffer.from(a.feeds.xstock, 'hex')], PYTH_PUSH_ORACLE)[0]);
  const infos = await conn.getMultipleAccountsInfo([SCOPE, ...pushKeys], 'confirmed');
  const scope = infos[0]?.data;

  // The Friday close: the first captured Scope account whose entry for the chain was refreshed in [close, close + 15 min].
  const captures = existsSync(join(OUT, 'scope')) ? readdirSync(join(OUT, 'scope')).filter((f) => /^scope-\d+\.json$/.test(f)).sort() : [];
  const accounts = captures.map((f) => (JSON.parse(readFileSync(join(OUT, 'scope', f), 'utf8')) as { account?: { data: [string, string] } }).account).filter(Boolean)
    .map((a) => Buffer.from(a!.data[0], 'base64')); // each capture parsed once
  const closeOf = (chain: number): bigint => {
    for (const d of accounts) {
      const e = scopeEntry(d, chain);
      if (e && e.ts >= closeTs && e.ts <= closeTs + AFTER_CLOSE) return e.wad;
    }
    return 0n;
  };

  // When each asset's Scope value last changed: walk the recorders' events back from the latest until the price differs.
  const evFiles = existsSync(OUT) ? readdirSync(OUT).filter((f) => /^events-\d+\.jsonl$/.test(f)).sort().slice(-4) : [];
  const evs: Record<string, { price: number; ts: number }[]> = {};
  for (const f of evFiles) {
    for (const l of readFileSync(join(OUT, f), 'utf8').split('\n')) {
      if (!l.includes('"kind":"scope"')) continue;
      try { const e = JSON.parse(l) as { sym: string; price: number; ts: number }; (evs[e.sym] ??= []).push({ price: e.price, ts: e.ts }); } catch { /* partial line */ }
    }
  }
  const sinceOf = (sym: string): number | undefined => {
    const h = (evs[sym] ?? []).sort((x, y) => x.ts - y.ts);
    if (!h.length) return undefined;
    let since = h[h.length - 1].ts;
    for (let j = h.length - 2; j >= 0 && Math.abs(h[j].price - h[h.length - 1].price) <= 1e-9 * h[h.length - 1].price; j--) since = h[j].ts;
    return since;
  };

  const items = assets.map((a, k) => {
    const p = infos[k + 1]?.data ? push(infos[k + 1]!.data) : null;
    const s = scope ? scopeEntry(scope, a.scopeChain) : null;
    const close = closeOf(a.scopeChain);
    return {
      ticker: a.ticker,
      closePriceWad: close > 0n ? close.toString() : null,
      fair: p && { priceWad: p.wad.toString(), publishTs: p.publishTs, confBps: p.confBps, full: p.full },
      lender: s && { priceWad: s.wad.toString(), ts: s.ts, sinceTs: sinceOf(a.ticker) }, // null (missing) when the entry is unset
    };
  });

  const bin = ['target/release/examples/gap_feed', 'target/debug/examples/gap_feed'].map((p) => join(ROOT, p)).find(existsSync);
  if (!bin) throw new Error('build the helper: cargo build -p credence-core --example gap_feed');
  const r = spawnSync(bin, ['--root', ROOT], { input: JSON.stringify({ now, closureType: TYPE[cl.type], closeTs, items }), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  const out = JSON.parse(r.stdout || '{}') as { error?: string; items?: unknown[] };
  if (r.status !== 0 || out.error) throw new Error(`gap_feed helper: ${out.error ?? r.stderr.split('\n')[0]}`);

  const note = `Closure ${cl.id} (${TYPE[cl.type].toLowerCase()}), closed ${new Date(closeTs * 1000).toISOString()}. The close is Kamino's Scope price captured at the bell; where none was captured the row says NO_CLOSE.`;
  const doc = { computedAt: now, closure: { id: cl.id, type: cl.type, closeTs, nextOpen }, note, items: out.items };
  writeFileSync(join(OUT, 'gap-feed-mainnet.json'), JSON.stringify(doc, null, 1) + '\n');
  console.log(`wrote data/live/gap-feed-mainnet.json: closure ${cl.id} ${TYPE[cl.type]}, ${out.items?.length} assets, ${items.filter((i) => i.closePriceWad).length} with a captured close`);
}
main().catch((e) => { console.error(String(e.message ?? e).replace(/https?:\/\/\S+/g, '<rpc>')); process.exit(1); });
