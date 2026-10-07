// Day 1 task 1.3 helper: reserve, oracle and obligation addresses for the fork clone.
// Usage: pnpm tsx src/discover-kamino.ts > ../data/fork/kamino-accounts.json
import 'dotenv/config';
import { address, createSolanaRpc, getBase64Encoder } from '@solana/kit';
import { Obligation, Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';

const KLEND = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const MARKET = address('5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua');
const RESERVES = {
  SPYx: address('UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d'),
  QQQx: address('2jerdAXR8r2B6z3P7P6VgSiePQX7wqcpbEqdDbm8mgeB'),
  NVDAx: address('7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q'),
  USDC: address('97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E'),
};
const DEFAULT = '11111111111111111111111111111111';
const SF = 2n ** 60n;

const rpc = createSolanaRpc(process.env.MAINNET_RPC ?? process.env.npm_config_rpc ?? '');
const b64 = getBase64Encoder();

async function main() {
  const reserves: Record<string, unknown> = {};
  const byAddr: Record<string, string> = {};
  for (const [sym, addr] of Object.entries(RESERVES)) {
    const r = await Reserve.fetch(rpc, addr, KLEND);
    if (!r) throw new Error(`reserve ${sym} missing`);
    const ti = r.config.tokenInfo;
    const opt = (a: string) => (a === DEFAULT ? null : a);
    reserves[sym] = {
      reserve: addr,
      mint: r.liquidity.mintPubkey,
      tokenProgram: r.liquidity.tokenProgram,
      supplyVault: r.liquidity.supplyVault,
      collateralMint: r.collateral.mintPubkey,
      collateralSupplyVault: r.collateral.supplyVault,
      farmCollateral: opt(r.farmCollateral),
      farmDebt: opt(r.farmDebt),
      oracles: {
        pyth: opt(ti.pythConfiguration.price),
        switchboardPrice: opt(ti.switchboardConfiguration.priceAggregator),
        switchboardTwap: opt(ti.switchboardConfiguration.twapAggregator),
        scopePrices: opt(ti.scopeConfiguration.priceFeed),
        scopeChain: ti.scopeConfiguration.priceChain.map(Number),
      },
      maxAgePriceSeconds: ti.maxAgePriceSeconds.toString(),
      liquidationThresholdPct: r.config.liquidationThresholdPct,
      loanToValuePct: r.config.loanToValuePct,
      lastUpdateSlot: r.lastUpdate.slot.toString(),
    };
    byAddr[addr] = sym;
  }

  const size = BigInt(Obligation.layout.span + 8);
  const accts = await rpc
    .getProgramAccounts(KLEND, {
      encoding: 'base64',
      filters: [{ dataSize: size }, { memcmp: { offset: 32n, bytes: MARKET as any, encoding: 'base58' } }],
    })
    .send();
  const found: unknown[] = [];
  for (const a of accts) {
    const o = Obligation.decode(Buffer.from(b64.encode(a.account.data[0]) as Uint8Array));
    const deps = o.deposits.filter((d) => d.depositReserve !== DEFAULT && d.depositedAmount.gtn(0));
    const bors = o.borrows.filter((b) => b.borrowReserve !== DEFAULT && b.borrowedAmountSf.gtn(0));
    const usdcDebt = bors.find((b) => b.borrowReserve === RESERVES.USDC);
    const xDep = deps.filter((d) => byAddr[d.depositReserve] && byAddr[d.depositReserve] !== 'USDC');
    if (!usdcDebt || xDep.length === 0) continue;
    found.push({
      obligation: a.pubkey,
      owner: o.owner,
      deposits: deps.map((d) => ({ reserve: d.depositReserve, sym: byAddr[d.depositReserve] ?? '?', amount: d.depositedAmount.toString(), marketValueUsd: Number(BigInt(d.marketValueSf.toString()) * 100n / SF) / 100 })),
      borrows: bors.map((b) => ({ reserve: b.borrowReserve, sym: byAddr[b.borrowReserve] ?? '?', marketValueUsd: Number(BigInt(b.marketValueSf.toString()) * 100n / SF) / 100 })),
      depositedValueUsd: Number(BigInt(o.depositedValueSf.toString()) * 100n / SF) / 100,
      debtUsd: Number(BigInt(o.borrowFactorAdjustedDebtValueSf.toString()) * 100n / SF) / 100,
      unhealthyBorrowValueUsd: Number(BigInt(o.unhealthyBorrowValueSf.toString()) * 100n / SF) / 100,
      onlyKnownReserves: deps.every((d) => byAddr[d.depositReserve]) && bors.every((b) => byAddr[b.borrowReserve]),
    });
  }
  found.sort((x: any, y: any) => y.debtUsd - x.debtUsd);
  console.log(JSON.stringify({ market: MARKET, scannedObligations: accts.length, reserves, obligations: found }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
