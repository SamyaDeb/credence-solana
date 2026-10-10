// POST JSON-RPC: the browser's read-only window on mainnet in the public mode (NEXT_PUBLIC_NETWORK=mainnet). The
// request goes to MAINNET_RPC from here, so the provider's key never reaches the browser; only read methods pass, and
// a getProgramAccounts must target klend or credence_core with filters (no full-program dumps). Errors are redacted.
import { IS_MAINNET } from '@/lib/network';
import { type Call, allowed } from '@/lib/rpc-allow';
import { TtlCache, throttle } from '@/lib/server/limit';
import { fail, json } from '@/lib/server/fork';

export const dynamic = 'force-dynamic';
// One read call answered recently is answered again from memory: the browser polls the same accounts, and each upstream call
// costs the host's provider quota. Only single calls, only small bodies; the response's id is the caller's own.
const cache = new TtlCache<string>(3_000);
const MAX_CACHED = 256 * 1024;
/** True when a JSON-RPC response carries an error (or is not JSON): never cached. */
const hasError = (text: string) => { try { return 'error' in JSON.parse(text); } catch { return true; } };
export async function POST(req: Request) {
  const limited = throttle(req, 'rpc', { burst: 60, perSecond: 10 });
  if (limited) return limited;
  try {
    if (!IS_MAINNET) throw new Error('the RPC proxy serves the public read-only mode only');
    const upstream = process.env.MAINNET_RPC;
    if (!upstream) throw new Error('MAINNET_RPC is not set on the server');
    const body = (await req.json()) as Call | Call[];
    const calls = Array.isArray(body) ? body : [body];
    if (calls.length > 20) throw new Error('at most 20 calls per batch');
    for (const c of calls) { const why = allowed(c); if (why) return json({ jsonrpc: '2.0', id: c.id, error: { code: -32601, message: why } }); }
    const single = !Array.isArray(body) ? body : null;
    const key = single ? JSON.stringify([single.method, single.params ?? null]) : null;
    const hit = key ? cache.get(key) : undefined;
    if (single && hit) return new Response(JSON.stringify({ ...JSON.parse(hit), id: single.id }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const text = await r.text();
    if (key && r.ok && text.length <= MAX_CACHED && !hasError(text)) cache.set(key, text);
    return new Response(text, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (e) {
    return fail(e, 400);
  }
}
