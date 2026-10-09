// Fork only: copies every reserve of Kamino's two xStocks markets, with its liquidity supply vault, collateral mint and
// collateral supply, from mainnet into the fork, each reserve's four accounts read in the same getMultipleAccounts call
// (one slot). surfpool clones accounts lazily, one at a time: a reserve cloned before a mainnet borrow and its vault
// after it disagree (found Oct 9: available 549,516.41 USDC, vault 549,416.41), and klend's post-transfer balance check
// then panics on every deposit and borrow in that reserve (lending_checks.rs:462, "attempt to subtract with overflow").
// The fork's slot is moved up to the read slot when it lags (klend refuses a refresh behind an account's last update).
// Runs after the program is deployed and loaded, before any klend transaction (scripts/demo.sh, scripts/demo-app.sh). Labelled in the README's simulated list.
// Usage: RPC_URL=<fork> pnpm tsx src/pin-klend.ts      (MAINNET_RPC in .env)
import { config } from 'dotenv';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { KLEND, ROOT, connect, log } from './chain.js';
import { rpc, setAccount } from './fork.js';
import { Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';
import { redact } from './redact.js';

config({ path: join(ROOT, '.env'), quiet: true });
const MARKETS = ['5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua', '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr'];
const RESERVE_SIZE = 8624;
const PER_CALL = 25; // reserves per getMultipleAccounts (4 accounts each, ≤ 100 keys)

async function main() {
  const fork = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const main = new web3.Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
  const keys: string[] = [];
  for (const m of MARKETS) {
    const rs = await main.getProgramAccounts(KLEND, { dataSlice: { offset: 0, length: 0 },
      filters: [{ dataSize: RESERVE_SIZE }, { memcmp: { offset: 32, bytes: m } }] });
    keys.push(...rs.map((r) => r.pubkey.toBase58()));
  }
  let n = 0;
  for (let i = 0; i < keys.length; i += PER_CALL) {
    // First the reserves, then each one's three companions, all in one call.
    const part = keys.slice(i, i + PER_CALL).map((k) => new web3.PublicKey(k));
    const rs = await main.getMultipleAccountsInfo(part);
    const group = part.flatMap((k, j) => {
      const r = Reserve.decode(rs[j]!.data);
      return [k, new web3.PublicKey(r.liquidity.supplyVault), new web3.PublicKey(r.collateral.mintPubkey), new web3.PublicKey(r.collateral.supplyVault)];
    });
    const res = await main.getMultipleAccountsInfoAndContext(group);
    for (const [j, a] of res.value.entries()) {
      if (!a) continue;
      await setAccount(fork, group[j].toBase58(), { lamports: a.lamports, data: Buffer.from(a.data), owner: a.owner.toBase58() });
      n++;
    }
    log(`pinned ${part.length} klend reserves with their vaults and collateral (${res.value.length} accounts, mainnet slot ${res.context.slot})`);
    // The copies carry mainnet's last-update slots; klend refuses a refresh whose current slot is behind them
    // (last_update.rs, slots elapsed underflow): the fork's slot moves up to the read slot when it lags.
    const forkSlot = await fork.conn.getSlot();
    if (forkSlot <= res.context.slot) {
      await rpc(fork, 'surfnet_timeTravel', [{ absoluteSlot: res.context.slot + 2 }]);
      log(`fork slot ${forkSlot} → ${res.context.slot + 2} (the copies' mainnet slot)`);
    }
  }
  log(`klend: ${keys.length} reserves, ${n} accounts copied consistently into the fork`);
}
main().catch((e) => { console.error(redact(String(e?.stack ?? e))); process.exit(1); });
