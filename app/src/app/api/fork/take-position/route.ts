// POST {obligation, owner}: FORK ONLY. Rewrites a real mainnet obligation's `owner` field (bytes 64..96, credence-core
// `OB_OWNER`) to the connected wallet, so it can sign buy_cover (the program only sells cover to the owner). Collateral,
// debt, reserves and farms stay the real mainnet state. Returns the real owner for the "simulated" label.
import { PublicKey } from '@solana/web3.js';
import { KLEND, XSTOCKS_MARKETS } from '@/lib/credence';
import { assertLocalFork, fail, getAccount, json, setAccount } from '@/lib/server/fork';

export async function POST(req: Request) {
  try {
    assertLocalFork();
    const { obligation, owner } = (await req.json()) as { obligation: string; owner: string };
    const ob = new PublicKey(obligation).toBase58();
    const to = new PublicKey(owner);
    const acc = await getAccount(ob);
    if (!acc || acc.owner !== KLEND.toBase58()) throw new Error('not a klend account');
    const market = new PublicKey(acc.data.subarray(32, 64)).toBase58();
    if (!XSTOCKS_MARKETS[market]) throw new Error('obligation is not in an xStocks market');
    const realOwner = new PublicKey(acc.data.subarray(64, 96)).toBase58();
    const data = Buffer.from(acc.data);
    to.toBuffer().copy(data, 64);
    await setAccount(ob, { lamports: acc.lamports, data, owner: acc.owner });
    return json({ ok: true, obligation: ob, realOwner, newOwner: to.toBase58() });
  } catch (e) {
    return fail(e, 400);
  }
}
