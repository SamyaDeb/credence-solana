// W1 basis study: how far the weekend fair value the Liquidation Shield acts on is from the price at the open.
//
// For every weekend (and holiday weekend) since the Pyth pro-compatible push accounts for Crypto.<T>X/USD have
// history, per asset:
//   fair  = the last push update published before the shield deadline (open − 2.5 h, Monday 07:00 ET); after the
//           Friday close if there is one, else the last one before it (what the shield would see either way)
//   open  = the first push update published at or after the open (within 1 h; 12–67 s after it in session, plan/09)
//   e     = (fair − open) / close, the basis error as a return (close = the last update at or before the close)
// σ_b = RMS of e over the weekends; also the mean, the worst, and the share of weekends with a weekend push.
//
// The open is the xStock token's own first print (Pyth), a proxy for Kamino's Scope price at the open: Scope reads
// Chainlink and Pyth Lazer (plan/06) and the push follows the same Pyth Pro data. Prices come from the push
// transactions themselves: each carries the Pyth PriceFeedMessage (feed id, then price i64, conf u64, expo i32,
// publish_time i64, big-endian) in its instruction data. Free RPC: signatures paged 1,000 at a time, decoded
// transactions cached in .cache/shield-basis/.
//
// Usage: pnpm tsx src/shield-basis.ts      → data/shield-basis.json
import { config } from 'dotenv';
import { getBase58Encoder } from '@solana/kit';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const CACHE = join(ROOT, '.cache/shield-basis');
const b58 = (s: string) => Buffer.from(getBase58Encoder().encode(s));
mkdirSync(CACHE, { recursive: true });

const ASSETS: Record<string, { push: string; feed: string }> = {
  SPYx: { push: '27Tv3HxU34AKxZ8MgfFAA1gCbWa96msMG5BvSWAHkBfj', feed: '2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14' },
  QQQx: { push: 'BMcyd2UQqakGbWnNRAC67TLAFhV64dzLVeEyRHKyzmUi', feed: '178a6f73a5aede9d0d682e86b0047c9f333ed0efe5c6537ca937565219c4054d' },
  NVDAx: { push: 'VSgf6jkwrcs9jbLuR57iN1Gk2c68vT9stZe8G6GGix2', feed: '4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f' },
};
/** NYSE full-day closures that can fall next to a weekend (2025-06 → 2026-10), from the Pyth schedule (plan/09). */
const HOLIDAYS = new Set(['2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16',
  '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07']);
const SHIELD_DEADLINE_BEFORE_OPEN = 9000;

type Sig = { signature: string; blockTime: number };
type Upd = { price: number; conf: number; publishTime: number };

async function signatures(sym: string, addr: string): Promise<Sig[]> {
  const file = join(CACHE, `${sym}-sigs.json`);
  const cached: Sig[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const known = new Set(cached.map((s) => s.signature));
  const fresh: Sig[] = [];
  let before: string | undefined;
  // Newest first until we reach what is cached; then older than the oldest cached until history ends.
  for (const phase of ['new', 'old'] as const) {
    before = phase === 'old' ? cached.at(-1)?.signature ?? fresh.at(-1)?.signature : undefined;
    if (phase === 'old' && cached.length === 0 && fresh.length === 0) break;
    for (;;) {
      const page = await conn.getSignaturesForAddress(new PublicKey(addr), { before, limit: 1000 });
      if (page.length === 0) break;
      const ok = page.filter((s) => !s.err && s.blockTime).map((s) => ({ signature: s.signature, blockTime: s.blockTime! }));
      const stop = phase === 'new' && ok.some((s) => known.has(s.signature));
      (phase === 'new' ? fresh : cached).push(...ok.filter((s) => !known.has(s.signature)));
      before = page[page.length - 1].signature;
      process.stdout.write(`\r${sym}: ${cached.length + fresh.length} signatures, back to ${new Date(page[page.length - 1].blockTime! * 1000).toISOString().slice(0, 10)}   `);
      if (stop || page.length < 1000) break;
    }
  }
  const all = [...fresh, ...cached].sort((a, b) => b.blockTime - a.blockTime);
  writeFileSync(file, JSON.stringify(all));
  console.log();
  return all.sort((a, b) => a.blockTime - b.blockTime);
}

/** The PriceFeedMessage for `feed` inside the transaction's instruction data (outer or inner), if any. */
function findMessage(datas: Buffer[], feed: Buffer): Upd | null {
  for (const d of datas) {
    for (let i = d.indexOf(feed); i >= 0; i = d.indexOf(feed, i + 1)) {
      const o = i + 32;
      if (o + 28 > d.length) continue;
      const price = d.readBigInt64BE(o);
      const conf = d.readBigUInt64BE(o + 8);
      const expo = d.readInt32BE(o + 16);
      const publishTime = Number(d.readBigInt64BE(o + 20));
      if (expo > 0 || expo < -18 || price <= 0n || publishTime < 1.7e9 || publishTime > 2.0e9) continue;
      return { price: Number(price) * 10 ** expo, conf: Number(conf) * 10 ** expo, publishTime };
    }
  }
  return null;
}

async function update(sym: string, s: Sig): Promise<Upd | null> {
  const file = join(CACHE, `${sym}-tx.json`);
  const cache: Record<string, Upd | null> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (s.signature in cache) return cache[s.signature];
  const t = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const msg = t?.transaction.message as unknown as { compiledInstructions?: { data: Uint8Array }[]; instructions?: { data: string }[] };
  const datas: Buffer[] = [
    ...(msg?.compiledInstructions ?? []).map((i) => Buffer.from(i.data)),
    ...(msg?.instructions ?? []).map((i) => b58(i.data)),
    ...(t?.meta?.innerInstructions ?? []).flatMap((x) => x.instructions.map((i) => b58((i as { data: string }).data))),
  ];
  const u = findMessage(datas, Buffer.from(ASSETS[sym].feed, 'hex'));
  cache[s.signature] = u;
  writeFileSync(file, JSON.stringify(cache));
  return u;
}

/** Unix seconds of `hh:mm` America/New_York on the date `ymd`. */
function et(ymd: string, hh: number, mm: number): number {
  const guess = Date.parse(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) / 1000;
  const off = new Date(guess * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = off.split(':').map(Number);
  return guess + ((hh - h) * 60 + (mm - m)) * 60 + (hh - h < -12 ? 86400 : 0);
}
const ymd = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const addDays = (d: string, k: number) => ymd(Date.parse(d + 'T12:00:00Z') / 1000 + k * 86400);
const isSession = (d: string) => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w >= 1 && w <= 5 && !HOLIDAYS.has(d); };

async function main() {
  const out: Record<string, unknown> = {};
  const weekendsAll: Record<string, unknown>[] = [];
  const skipped: { sym: string; friday: string; why: string }[] = [];
  for (const [sym, a] of Object.entries(ASSETS)) {
    const sigs = await signatures(sym, a.push);
    if (sigs.length === 0) { out[sym] = { weekends: 0 }; continue; }
    const first = sigs[0].blockTime, last = sigs[sigs.length - 1].blockTime;
    const rows: { friday: string; close: number; open: number; fair: Upd; openU: Upd; closeU: Upd; weekendPush: boolean; e: number }[] = [];
    // Closures: a session followed by a gap of a day or more before the next session (weekends, holiday weekends).
    for (let d = ymd(first); Date.parse(d) / 1000 < last; d = addDays(d, 1)) {
      if (!isSession(d)) continue;
      let next = addDays(d, 1);
      while (!isSession(next)) next = addDays(next, 1);
      if (next === addDays(d, 1)) continue; // overnight only
      const close = et(d, 16, 0), open = et(next, 9, 30);
      if (open > last) break;
      const deadline = open - SHIELD_DEADLINE_BEFORE_OPEN;
      // The account's signatures include programs that only read it (Jupiter routes, other oracles): walk from the
      // nearest one by block time (publish time is a few seconds earlier) to the nearest that carries an update.
      const skip = (why: string) => { skipped.push({ sym, friday: d, why }); };
      const nearest = async (t: number, dir: 'before' | 'after', publishOk: (u: Upd) => boolean) => {
        const list = dir === 'before' ? [...sigs].reverse().filter((s) => s.blockTime <= t + 30) : sigs.filter((s) => s.blockTime >= t);
        for (const s of list.slice(0, 40)) {
          const u = await update(sym, s);
          if (u && publishOk(u)) return { s, u };
        }
        return null;
      };
      const cl = await nearest(close, 'before', (u) => u.publishTime <= close);
      const fa = await nearest(deadline, 'before', (u) => u.publishTime <= deadline);
      const op = await nearest(open, 'after', (u) => u.publishTime >= open);
      if (!cl || !fa || !op) { skip('no push update around the closure'); continue; }
      if (op.u.publishTime > open + 3600) { skip(`first push after the open came ${Math.round((op.u.publishTime - open) / 60)} min late`); continue; }
      const [closeU, fair, openU] = [cl.u, fa.u, op.u];
      const e = (fair.price - openU.price) / closeU.price;
      rows.push({ friday: d, close, open, fair, openU, closeU, weekendPush: fair.publishTime > close, e });
      process.stdout.write(`\r${sym} ${d}: e ${(e * 100).toFixed(3)}%            `);
    }
    console.log();
    const es = rows.map((r) => r.e);
    const rms = Math.sqrt(es.reduce((s, x) => s + x * x, 0) / Math.max(1, es.length));
    const mean = es.reduce((s, x) => s + x, 0) / Math.max(1, es.length);
    // Shield risk is fair below open (the shield over-advances): the share and the 95th percentile of −e.
    const down = es.map((x) => -x).sort((x, y) => x - y);
    out[sym] = {
      weekends: rows.length,
      history: { from: new Date(first * 1000).toISOString(), to: new Date(last * 1000).toISOString(), pushes: sigs.length },
      sigmaB: rms, meanE: mean, worstE: es.length ? es.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0) : null,
      fairBelowOpenShare: es.filter((x) => x < 0).length / Math.max(1, es.length),
      overshootP95: down.length ? down[Math.min(down.length - 1, Math.floor(0.95 * down.length))] : null,
      withWeekendPush: rows.filter((r) => r.weekendPush).length,
    };
    weekendsAll.push(...rows.map((r) => ({
      sym, friday: r.friday, close: r.closeU.price, fair: r.fair.price, fairPublish: new Date(r.fair.publishTime * 1000).toISOString(),
      open: r.openU.price, openPublish: new Date(r.openU.publishTime * 1000).toISOString(), weekendPush: r.weekendPush, e: r.e,
    })));
    console.log(sym, JSON.stringify(out[sym]));
  }
  // The σ_b the program uses: the measured RMS where there are at least 8 weekends, else the pooled RMS of all assets
  // (QQQX pushes are sparse); never below 0.25% (a floor for a short history).
  const pooledE = weekendsAll.map((w) => w.e as number);
  const pooled = Math.sqrt(pooledE.reduce((s, x) => s + x * x, 0) / Math.max(1, pooledE.length));
  for (const sym of Object.keys(ASSETS)) {
    const o = out[sym] as { weekends: number; sigmaB?: number };
    const own = o.weekends >= 8 ? o.sigmaB! : pooled;
    (o as Record<string, unknown>).sigmaBUsed = Math.max(0.0025, own);
    (o as Record<string, unknown>).sigmaBSource = o.weekends >= 8 ? 'own weekends' : 'pooled (fewer than 8 own weekends)';
  }
  writeFileSync(join(ROOT, 'data/shield-basis.json'), JSON.stringify({
    kind: 'credence.shield-basis.v1', generatedAt: new Date().toISOString(), generatedBy: 'scripts/src/shield-basis.ts',
    method: 'e = (fair − open) / close; fair = last Crypto.<T>X/USD push before open − 2.5 h; open = first push at or after the open; RMS over weekends',
    pooledSigmaB: pooled, pooledWeekends: pooledE.length, assets: out, weekends: weekendsAll, skipped,
  }, null, 2) + '\n');
  console.log('wrote data/shield-basis.json');
}
main().catch((e) => { console.error(String(e).replace(/https?:\/\/\S+/g, '<rpc>')); process.exit(1); });
