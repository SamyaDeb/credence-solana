// POST {owner, usdc?}: FORK ONLY. Airdrops 10 SOL and sets the owner's USDC balance with a surfpool cheatcode, so a
// burner (or a fresh Phantom account) can pay fees and premiums on the fork. Labelled "simulated" in the UI.
import { PublicKey } from '@solana/web3.js';
import { USDC_MINT } from '@/lib/credence';
import { assertLocalFork, fail, json, rpc, setTokenBalance } from '@/lib/server/fork';

export async function POST(req: Request) {
  try {
    assertLocalFork();
    const { owner, usdc = 50_000 } = (await req.json()) as { owner: string; usdc?: number };
    const key = new PublicKey(owner).toBase58();
    if (!(usdc >= 0 && usdc <= 10_000_000)) throw new Error('usdc out of range');
    await rpc('requestAirdrop', [key, 10_000_000_000]);
    await setTokenBalance(key, USDC_MINT.toBase58(), BigInt(Math.round(usdc * 1e6)));
    return json({ ok: true, owner: key, sol: 10, usdc });
  } catch (e) {
    return fail(e, 400);
  }
}
