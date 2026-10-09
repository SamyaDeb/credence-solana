// POST {caches: [pubkey]}: FORK ONLY. Jupiter Lend refuses a Chainlink cache older than its max age in every operate,
// and `add_book_leg_jl` / `buy_cover_jl` a cache older than 600 s; nothing refreshes them on a fork. This moves each
// cache's refresh time to the fork's clock, keeping its price (cloned from mainnet, or set by demo mode). Labelled
// "simulated" in the UI.
import { CLOCK_SYSVAR } from '@/lib/credence';
import { assertLocalFork, fail, getAccount, json, setAccount } from '@/lib/server/fork';
import { PublicKey } from '@solana/web3.js';

const JL_ORACLE = 'jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc';

export async function POST(req: Request) {
  try {
    assertLocalFork();
    const { caches } = (await req.json()) as { caches: string[] };
    if (!Array.isArray(caches) || caches.length === 0 || caches.length > 8) throw new Error('caches: 1–8 Chainlink cache accounts');
    const clock = await getAccount(CLOCK_SYSVAR.toBase58());
    if (!clock) throw new Error('Clock not found on the fork');
    const now = clock.data.readBigInt64LE(32);
    const out = [];
    for (const k of caches) {
      const key = new PublicKey(k).toBase58();
      const a = await getAccount(key);
      if (!a || a.owner !== JL_ORACLE) throw new Error(`${key}: not a Jupiter Lend oracle cache`);
      const d = Buffer.from(a.data);
      const o = 14 + 34 * d.readUInt32LE(10);
      d.writeBigUInt64LE(now, o + 16);
      d.writeBigUInt64LE(now, o + 24);
      d.writeBigUInt64LE(now * 1000n, o + 32);
      await setAccount(key, { lamports: a.lamports, data: d, owner: a.owner });
      out.push({ cache: key, now: Number(now) });
    }
    return json({ ok: true, caches: out });
  } catch (e) {
    return fail(e, 400);
  }
}
