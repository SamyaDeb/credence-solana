// POST {pairs: [{price, twap}]}: FORK ONLY. Kamino's reserves refuse Scope prices older than their max age (300 s for
// xStocks, 180 s for USDC) and a TWAP that is old or more than `max_twap_divergence_bps` away (5% for xStocks), and
// nothing updates Scope on a fork. This moves each pair's refresh time (and slot) to the fork's clock, keeping the price
// as it is (cloned from mainnet, or set by demo mode). If a simulated gap left the TWAP more than 2% from the price
// (a real TWAP converges within days), the TWAP is set to the price; the response says so and the UI labels it.
import { CLOCK_SYSVAR, SCOPE_PRICES } from '@/lib/credence';
import { assertLocalFork, fail, getAccount, json, rpc, setAccount } from '@/lib/server/fork';

const ok = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 0 && (c as number) < 512;

export async function POST(req: Request) {
  try {
    assertLocalFork();
    const { pairs } = (await req.json()) as { pairs: { price: number; twap: number | null }[] };
    if (!Array.isArray(pairs) || pairs.length === 0 || pairs.length > 8 || pairs.some((p) => !ok(p.price) || (p.twap !== null && !ok(p.twap)))) {
      throw new Error('pairs: 1–8 {price, twap} Scope chain indices in [0, 512)');
    }
    const [acc, clock, slot] = await Promise.all([getAccount(SCOPE_PRICES.toBase58()), getAccount(CLOCK_SYSVAR.toBase58()), rpc<number>('getSlot')]);
    if (!acc || !clock) throw new Error('Scope OraclePrices or Clock not found on the fork');
    const now = clock.data.readBigInt64LE(32);
    const d = Buffer.from(acc.data);
    const at = (c: number) => 8 + 32 + c * 56;
    const price = (c: number) => Number(d.readBigUInt64LE(at(c))) / 10 ** Number(d.readBigUInt64LE(at(c) + 8));
    const stamp = (c: number) => { d.writeBigUInt64LE(BigInt(slot), at(c) + 16); d.writeBigUInt64LE(now, at(c) + 24); };
    const out: { price: number; twap: number | null; value: number; twapAligned: boolean }[] = [];
    for (const p of pairs) {
      stamp(p.price);
      let twapAligned = false;
      if (p.twap !== null) {
        if (Math.abs(price(p.twap) / price(p.price) - 1) > 0.02) {
          d.copy(d, at(p.twap), at(p.price), at(p.price) + 16); // value + exp
          twapAligned = true;
        }
        stamp(p.twap);
      }
      out.push({ price: p.price, twap: p.twap, value: price(p.price), twapAligned });
    }
    await setAccount(SCOPE_PRICES.toBase58(), { lamports: acc.lamports, data: d, owner: acc.owner });
    return json({ ok: true, now: Number(now), pairs: out });
  } catch (e) {
    return fail(e, 400);
  }
}
