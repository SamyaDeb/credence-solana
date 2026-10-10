// GET: the Gap Oracle read live from MAINNET in the public read-only mode: Kamino's Scope `OraclePrices` (each covered
// xStock's chain) and the Pyth `Crypto.<T>X/USD` push accounts, read through the server's MAINNET_RPC (the key stays
// here), plus the captured real closes and the S7 history from data/. Same shape as api/data/oracle; with no history of
// readings here, a frozen price is judged against the captured Friday close instead.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { SCOPE_PRICES, decodePriceUpdate, decodeScope, pushAccount } from '@/lib/credence';
import { IS_MAINNET } from '@/lib/network';
import { ROOT, fail, json, readJson } from '@/lib/server/fork';
import { throttle } from '@/lib/server/limit';
// (closes: the captured real closes are shown by the fork's Risk page against its epochs; mainnet has no epoch yet.)

export const dynamic = 'force-dynamic';
type A = { ticker: string; scopeChain: number; feeds: { xstock: string } };

export async function GET(req: Request) {
  const limited = throttle(req, 'read');
  if (limited) return limited;
  try {
    if (!IS_MAINNET) throw new Error('live mainnet reads serve the public mode only');
    const upstream = process.env.MAINNET_RPC;
    if (!upstream) throw new Error('MAINNET_RPC is not set on the server');
    const assets = readJson<A[]>('data/onchain/assets.json');
    const keys = [SCOPE_PRICES.toBase58(), ...assets.map((a) => pushAccount(Buffer.from(a.feeds.xstock, 'hex')).toBase58())];
    const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys, { encoding: 'base64', commitment: 'confirmed' }] }) });
    const j = (await r.json()) as { result?: { value: ({ data: [string, string] } | null)[] }; error?: { message: string } };
    if (!j.result) throw new Error(j.error?.message ?? 'mainnet read failed');
    const [scopeAcc, ...pushes] = j.result.value.map((v) => (v ? Buffer.from(v.data[0], 'base64') : null));
    const readAt = new Date().toISOString();
    const out = assets.map((a, i) => {
      const s = scopeAcc ? decodeScope(scopeAcc, a.scopeChain) : null;
      const p = pushes[i] ? decodePriceUpdate(pushes[i]!) : null;
      return { sym: a.ticker, scope: s && { price: s.price, refreshedAt: s.unixTimestamp, readAt, readings: 1, since: readAt, lastChange: null },
        push: p && { price: p.price, conf: p.conf, publishTime: p.publishTime, file: `mainnet ${new PublicKey(keys[i + 1]).toBase58()}`, recorded: 1 } };
    });
    let s7 = null;
    try { s7 = JSON.parse(readFileSync(join(/* turbopackIgnore: true */ ROOT, 'data/live/s7-history.json'), 'utf8')); } catch { /* not bundled */ }
    return json({ recorder: { lastEvent: readAt, logUpdated: null }, live: 'mainnet', assets: out, closes: [], s7: s7 && { source: s7.source, generatedAt: s7.generatedAt,
      rows: (s7.rows as Record<string, unknown>[]).map((r) => ({ weekend: r.weekend, sym: r.sym, firstMove: r.firstMove, firstMoveVsOpenHours: r.firstMoveVsOpenHours,
        movedOverWeekend: r.movedOverWeekend, preMarketMove: r.preMarketMove, weekendMoves: Array.isArray(r.weekendMoves) ? r.weekendMoves.length : 0 })) } });
  } catch (e) {
    return fail(e, 502);
  }
}
