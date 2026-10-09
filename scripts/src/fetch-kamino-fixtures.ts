// Saves real klend accounts as LiteSVM fixtures plus golden values decoded by klend-sdk, for the layout tests in
// programs/credence-core/tests/kamino.rs. Usage: pnpm tsx src/fetch-kamino-fixtures.ts  (reads MAINNET_RPC from .env)
import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { address, createSolanaRpc } from '@solana/kit';
import { Obligation, Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env') });
const OUT = join(ROOT, 'programs/credence-core/tests/fixtures');
const rpc = createSolanaRpc(process.env.MAINNET_RPC ?? '');

const ACCOUNTS: Record<string, string> = {
  obligation_47wN: '47wNsqpypn5t1nhXW992P3QGRwMDZFbmsvNaMm6vT58N',
  reserve_SPYx: 'UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d',
  reserve_QQQx: '2jerdAXR8r2B6z3P7P6VgSiePQX7wqcpbEqdDbm8mgeB',
  reserve_NVDAx: '7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q',
  reserve_USDC: '97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E',
};

const s = (x: unknown) => (typeof x === 'bigint' ? x.toString() : x && typeof x === 'object' && 'toString' in x ? String(x) : x);

async function main() {
  const golden: Record<string, unknown> = {};
  for (const [name, addr] of Object.entries(ACCOUNTS)) {
    const r = await rpc.getAccountInfo(address(addr), { encoding: 'base64' }).send();
    if (!r.value) throw new Error(`${name} missing`);
    const data = Buffer.from(r.value.data[0], 'base64');
    writeFileSync(join(OUT, `${name}.bin`), data);
    if (name.startsWith('obligation')) {
      const o = Obligation.decode(data);
      golden[name] = {
        address: addr,
        owner_program: r.value.owner,
        len: data.length,
        lastUpdateSlot: s(o.lastUpdate.slot),
        lastUpdateStale: o.lastUpdate.stale,
        priceStatus: o.lastUpdate.priceStatus,
        lendingMarket: o.lendingMarket,
        owner: o.owner,
        elevationGroup: o.elevationGroup,
        depositedValueSf: s(o.depositedValueSf),
        borrowFactorAdjustedDebtValueSf: s(o.borrowFactorAdjustedDebtValueSf),
        borrowedAssetsMarketValueSf: s(o.borrowedAssetsMarketValueSf),
        unhealthyBorrowValueSf: s(o.unhealthyBorrowValueSf),
        deposits: o.deposits.filter((d) => d.depositReserve !== '11111111111111111111111111111111').map((d) => ({
          reserve: d.depositReserve, depositedAmount: s(d.depositedAmount), marketValueSf: s(d.marketValueSf),
        })),
        borrows: o.borrows.filter((b) => b.borrowReserve !== '11111111111111111111111111111111').map((b) => ({
          reserve: b.borrowReserve, borrowedAmountSf: s(b.borrowedAmountSf), marketValueSf: s(b.marketValueSf),
          borrowFactorAdjustedMarketValueSf: s(b.borrowFactorAdjustedMarketValueSf),
        })),
      };
    } else {
      const v = Reserve.decode(data);
      golden[name] = {
        address: addr,
        owner_program: r.value.owner,
        len: data.length,
        lendingMarket: v.lendingMarket,
        mint: v.liquidity.mintPubkey,
        mintDecimals: s(v.liquidity.mintDecimals),
        tokenProgram: v.liquidity.tokenProgram,
        supplyVault: v.liquidity.supplyVault,
        marketPriceSf: s(v.liquidity.marketPriceSf),
        status: v.config.status,
        loanToValuePct: v.config.loanToValuePct,
        liquidationThresholdPct: v.config.liquidationThresholdPct,
        borrowFactorPct: s(v.config.borrowFactorPct),
        // BigFractionBytes value [u64; 4], little-endian limbs (task 1.2: interest on a covered debt).
        feeVault: v.liquidity.feeVault, collateralMint: v.collateral.mintPubkey, collateralSupplyVault: v.collateral.supplyVault,
        farmCollateral: v.farmCollateral, farmDebt: v.farmDebt,
        cumulativeBorrowRateBsf: v.liquidity.cumulativeBorrowRateBsf.value.reduce((a, x, i) => a + (BigInt(x.toString()) << BigInt(64 * i)), 0n).toString(),
      };
    }
  }
  writeFileSync(join(OUT, 'kamino_golden.json'), JSON.stringify(golden, null, 2) + '\n');
  console.log(JSON.stringify(golden, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
