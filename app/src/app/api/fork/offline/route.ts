// POST {keys}: FORK ONLY. After the fork's clock has moved past mainnet's (time travel), surfpool fails to process a
// transaction that touches an account it has never seen ("Failed to fetch accounts from remote"), such as the Policy
// PDA buy_cover creates. Accounts that do not exist on the fork (or mainnet) are marked local-only with
// surfnet_offlineAccount before sending. Existing accounts are left alone.
import { PublicKey } from '@solana/web3.js';
import { assertLocalFork, fail, json, rpc } from '@/lib/server/fork';

export async function POST(req: Request) {
  try {
    assertLocalFork();
    const { keys } = (await req.json()) as { keys: string[] };
    if (!Array.isArray(keys) || keys.length > 64) throw new Error('keys: up to 64 addresses');
    const uniq = [...new Set(keys.map((k) => new PublicKey(k).toBase58()))];
    const infos = await rpc<{ value: (unknown | null)[] }>('getMultipleAccounts', [uniq, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    const missing = uniq.filter((_, i) => infos.value[i] === null);
    for (const k of missing) await rpc('surfnet_offlineAccount', [k]);
    return json({ ok: true, offline: missing });
  } catch (e) {
    return fail(e, 400);
  }
}
