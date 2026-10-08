// POST {owner, ticker, tokens}: FORK ONLY. Sets the wallet's balance of an xStock (Token-2022) with a surfpool cheatcode,
// so a demo wallet can deposit collateral on Kamino. Labelled "fork" in the UI: nobody sold these tokens.
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022 } from '@/lib/credence';
import { assertLocalFork, fail, json, readJson, setTokenBalance } from '@/lib/server/fork';

export async function POST(req: Request) {
  try {
    assertLocalFork();
    const { owner, ticker, tokens } = (await req.json()) as { owner: string; ticker: string; tokens: number };
    const key = new PublicKey(owner).toBase58();
    const asset = readJson<{ ticker: string; mint: string }[]>('data/onchain/assets.json').find((a) => a.ticker === ticker);
    if (!asset) throw new Error('ticker must be SPYx, QQQx or NVDAx');
    if (!(tokens > 0 && tokens <= 1_000)) throw new Error('tokens: 0–1,000');
    await setTokenBalance(key, asset.mint, BigInt(Math.round(tokens * 1e8)), TOKEN_2022.toBase58());
    return json({ ok: true, owner: key, ticker, tokens, mint: asset.mint });
  } catch (e) {
    return fail(e, 400);
  }
}
