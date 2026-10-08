// The SPYx-reserve accounts a v2 liquidation of the snapshot obligation needs, added next to the klend snapshot
// (programs/credence-core/tests/fixtures/klend) without re-fetching it, so the snapshot's slot and every golden value
// stay as they are (W2, task 1.3). Read from the committed reserve_spyx.bin: the cToken mint and supply vault, the
// liquidity supply and fee vaults, and the collateral farm with the obligation's user state if the reserve has one.
// The token balances are read at a later slot than the snapshot; klend books the reserve's own accounting, so only
// the vault balances (large) must cover the test's redemption. Merged into snapshot.json under "accounts".
// Usage: pnpm tsx src/fetch-klend-liquidation.ts   (reads MAINNET_RPC from .env)
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const DIR = join(ROOT, 'programs/credence-core/tests/fixtures/klend');
const FARMS = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
const DEFAULT = '11111111111111111111111111111111';

async function main() {
  const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
  const meta = JSON.parse(readFileSync(join(DIR, 'snapshot.json'), 'utf8'));
  const r = Reserve.decode(readFileSync(join(DIR, 'reserve_spyx.bin')));
  const usdc = Reserve.decode(readFileSync(join(DIR, 'reserve_usdc.bin')));
  const want: Record<string, string> = {
    spyx_collateral_mint: r.collateral.mintPubkey.toString(),
    spyx_collateral_supply: r.collateral.supplyVault.toString(),
    spyx_liquidity_supply: r.liquidity.supplyVault.toString(),
    spyx_fee_vault: r.liquidity.feeVault.toString(),
    usdc_collateral_mint: usdc.collateral.mintPubkey.toString(),
  };
  if (r.farmCollateral.toString() !== DEFAULT) {
    want.spyx_collateral_farm = r.farmCollateral.toString();
    want.obligation_collateral_farm_user_state = PublicKey.findProgramAddressSync(
      [Buffer.from('user'), new PublicKey(r.farmCollateral.toString()).toBuffer(), new PublicKey(meta.accounts.obligation.address).toBuffer()], FARMS)[0].toBase58();
  }
  const res = await conn.getMultipleAccountsInfoAndContext(Object.values(want).map((k) => new PublicKey(k)), 'confirmed');
  Object.keys(want).forEach((name, i) => {
    const a = res.value[i];
    if (!a) throw new Error(`${name} (${want[name]}) missing`);
    writeFileSync(join(DIR, `${name}.bin`), a.data);
    meta.accounts[name] = { address: want[name], owner: a.owner.toBase58(), lamports: a.lamports, len: a.data.length, slot: res.context.slot };
  });
  writeFileSync(join(DIR, 'snapshot.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(JSON.stringify(Object.fromEntries(Object.keys(want).map((k) => [k, meta.accounts[k]])), null, 2));
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
