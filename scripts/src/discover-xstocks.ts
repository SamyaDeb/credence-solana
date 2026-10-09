// W16 (task B4): every xStock reserve in Kamino's two xStocks markets, read-only from mainnet: reserve, mint, Scope
// price chain, LTV / LT / borrow factor, and the liquidity token program. Feeds the asset table in gen-onchain.ts.
// Usage: pnpm tsx src/discover-xstocks.ts > ../data/onchain/xstock-reserves.json      (MAINNET_RPC in .env)
import { config } from 'dotenv';
import { address, createSolanaRpc, getBase64Encoder } from '@solana/kit';
import { Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';

config({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });
const KLEND = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const MARKETS = { xStocks: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua', Sentora: '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr' };
const rpc = createSolanaRpc(process.env.MAINNET_RPC ?? '');
const b64 = getBase64Encoder();

async function main() {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, market] of Object.entries(MARKETS)) {
    const accts = await rpc.getProgramAccounts(KLEND, {
      encoding: 'base64',
      filters: [{ dataSize: BigInt(Reserve.layout.span + 8) }, { memcmp: { offset: 32n, bytes: market as never, encoding: 'base58' } }],
    }).send();
    for (const a of accts) {
      const r = Reserve.decode(Buffer.from(b64.encode(a.account.data[0] as never)));
      const sym = Buffer.from(r.config.tokenInfo.name).toString('utf8').replace(/\0+$/, '').trim();
      if (!/^[A-Z]+x$/.test(sym)) continue;
      out[sym] ??= {};
      out[sym][name] = {
        reserve: a.pubkey, mint: r.liquidity.mintPubkey, tokenProgram: r.liquidity.tokenProgram,
        scopeChain: r.config.tokenInfo.scopeConfiguration.priceChain.map(Number).filter((x) => x !== 65535),
        ltvPct: r.config.loanToValuePct, ltPct: r.config.liquidationThresholdPct, borrowFactorPct: Number(r.config.borrowFactorPct),
        depositLimit: r.config.depositLimit.toString(), status: r.config.status,
      };
    }
  }
  console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), markets: MARKETS, reserves: out }, null, 1));
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<rpc>')); process.exit(1); });
