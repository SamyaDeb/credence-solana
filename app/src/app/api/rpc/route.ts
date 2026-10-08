// POST JSON-RPC: the browser's read-only window on mainnet in the public mode (NEXT_PUBLIC_NETWORK=mainnet). The
// request goes to MAINNET_RPC from here, so the provider's key never reaches the browser; only read methods pass, and
// a getProgramAccounts must target klend or credence_core with filters (no full-program dumps). Errors are redacted.
import { IS_MAINNET } from '@/lib/network';
import { type Call, allowed } from '@/lib/rpc-allow';
import { fail, json } from '@/lib/server/fork';

export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  try {
    if (!IS_MAINNET) throw new Error('the RPC proxy serves the public read-only mode only');
    const upstream = process.env.MAINNET_RPC;
    if (!upstream) throw new Error('MAINNET_RPC is not set on the server');
    const body = (await req.json()) as Call | Call[];
    const calls = Array.isArray(body) ? body : [body];
    if (calls.length > 20) throw new Error('at most 20 calls per batch');
    for (const c of calls) { const why = allowed(c); if (why) return json({ jsonrpc: '2.0', id: c.id, error: { code: -32601, message: why } }); }
    const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (e) {
    return fail(e, 400);
  }
}
