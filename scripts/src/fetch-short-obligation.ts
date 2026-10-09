// LiteSVM fixture for side UP cover (W11, task B3), mainnet read only: a real short on Kamino's xStocks Market, an
// obligation that borrows SPYx (reserve UvXjBu…) against stablecoin deposits only (USDC), the largest one.
//   programs/credence-core/tests/fixtures/klend/obligation_short.bin (+ short.json: address, deposits, debt)
// Usage: pnpm tsx src/fetch-short-obligation.ts      (MAINNET_RPC in .env)
import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { Obligation, Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const SPYX_RESERVE = 'UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d';
const USDC_RESERVE = '97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E';
const DEFAULT = '11111111111111111111111111111111';

async function main() {
  const accts = await conn.getProgramAccounts(KLEND, { filters: [{ dataSize: Obligation.layout.span + 8 }, { memcmp: { offset: 32, bytes: MARKET } }] });
  const shorts = accts.map(({ pubkey, account }) => ({ pubkey, o: Obligation.decode(account.data), data: account.data }))
    .filter(({ o }) => {
      const bors = o.borrows.filter((b) => b.borrowReserve !== DEFAULT);
      const deps = o.deposits.filter((d) => d.depositReserve !== DEFAULT);
      return bors.length === 1 && bors[0].borrowReserve === SPYX_RESERVE && deps.length > 0 && deps.every((d) => d.depositReserve === USDC_RESERVE) && o.elevationGroup === 0;
    })
    .sort((a, b) => Number(BigInt(b.o.borrows.find((x) => x.borrowReserve === SPYX_RESERVE)!.borrowedAmountSf.toString()) - BigInt(a.o.borrows.find((x) => x.borrowReserve === SPYX_RESERVE)!.borrowedAmountSf.toString())));
  console.log(`${shorts.length} SPYx shorts against USDC (of ${accts.length} obligations)`);
  const s = shorts[0];
  const out = join(ROOT, 'programs/credence-core/tests/fixtures/klend');
  writeFileSync(join(out, 'obligation_short.bin'), s.data);
  const sf = (x: { toString(): string }) => Number(BigInt(x.toString()) >> 40n) / 2 ** 20;
  const meta = { address: s.pubkey.toBase58(), owner: s.o.owner, debtValueUsd: sf(s.o.borrowFactorAdjustedDebtValueSf), unhealthyUsd: sf(s.o.unhealthyBorrowValueSf),
    depositedUsd: sf(s.o.depositedValueSf), ratio: sf(s.o.borrowFactorAdjustedDebtValueSf) / sf(s.o.unhealthyBorrowValueSf) };
  writeFileSync(join(out, 'short.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(JSON.stringify(meta));
  void Reserve;
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
