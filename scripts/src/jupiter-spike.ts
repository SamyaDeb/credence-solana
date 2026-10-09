// B2.0 spike (W12): what Jupiter Lend's Vaults (Borrow) program holds for xStocks on mainnet. Read only.
//   - every VaultConfig: supply/borrow token, oracle, LT, liquidation penalty; xStock vaults (mints `Xs…`) kept
//   - each xStock vault's VaultState totals (raw × exchange price / 1e12) and its Oracle account's sources
//   - Position accounts per xStock vault: count, with debt (tick above the minimum), not supply-only
// Layouts from the published Anchor IDL (github.com/jup-ag/jupiter-lend, target/idl/vaults.json, oracle.json).
//   → data/jupiter/spike-<yyyymmdd>.json
// Usage: pnpm tsx src/jupiter-spike.ts   (MAINNET_RPC in .env)
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const conn = new Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
export const VAULTS = new PublicKey('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');
const DISC = {
  VaultConfig: Buffer.from([99, 86, 43, 216, 184, 102, 119, 77]),
  VaultState: Buffer.from([228, 196, 82, 165, 98, 210, 235, 152]),
  Position: Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]),
};
const SOURCE = ['Pyth', 'StakePool', 'MsolPool', 'Redstone', 'Chainlink', 'SinglePool', 'JupLend', 'ChainlinkDataStreams', 'PstPool', 'DexSmartColPegOracle', 'DexSmartDebtPegOracle', 'InfPool'];
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();

async function byDisc(disc: Buffer, extra: object[] = []) {
  return conn.getProgramAccounts(VAULTS, { filters: [{ memcmp: { offset: 0, bytes: disc.toString('base64'), encoding: 'base64' } } as never, ...(extra as never[])] });
}

async function symbolOf(mint: string): Promise<string> {
  // Token-2022 metadata extension symbol, if any (xStocks carry it); else the mint's prefix.
  const a = await conn.getParsedAccountInfo(new PublicKey(mint));
  const ext = ((a.value?.data as any)?.parsed?.info?.extensions ?? []) as { extension: string; state: any }[];
  return ext.find((e) => e.extension === 'tokenMetadata')?.state?.symbol ?? mint.slice(0, 6);
}

async function main() {
  const cfgs = await byDisc(DISC.VaultConfig);
  const vaults = cfgs.map(({ pubkey, account: { data: d } }) => ({
    config: pubkey.toBase58(), vaultId: d.readUInt16LE(8), collateralFactor: d.readUInt16LE(14), liquidationThreshold: d.readUInt16LE(16),
    liquidationMaxLimit: d.readUInt16LE(18), liquidationPenalty: d.readUInt16LE(22), oracle: pk(d, 26), oracleProgram: pk(d, 122),
    supplyToken: pk(d, 154), borrowToken: pk(d, 186),
  }));
  const xs = vaults.filter((v) => v.supplyToken.startsWith('Xs'));
  const states = new Map((await byDisc(DISC.VaultState)).map(({ pubkey, account: { data: d } }) => [d.readUInt16LE(8), { key: pubkey.toBase58(), d }]));
  const out = [];
  for (const v of xs) {
    const st = states.get(v.vaultId)!;
    const d = st.d;
    // VaultState: ... total_supply u64 @23, total_borrow u64 @31, total_positions u32 @39, absorbed (u128 ×2, u64) @43..83,
    // liquidity_supply_ex @83, liquidity_borrow_ex @91, vault_supply_ex @99, vault_borrow_ex @107 (1e12 precision).
    const supplyEx = Number(d.readBigUInt64LE(99)) / 1e12, borrowEx = Number(d.readBigUInt64LE(107)) / 1e12;
    const [supplySym, borrowSym] = [await symbolOf(v.supplyToken), await symbolOf(v.borrowToken)];
    const oracle = await conn.getAccountInfo(new PublicKey(v.oracle));
    // Oracle: disc, nonce u16, vec<Sources> (u32 len; each: pubkey, bool, u128, u128, u8 enum = 66 bytes).
    const od = oracle!.data;
    const n = od.readUInt32LE(10);
    const sources = Array.from({ length: n }, (_, i) => {
      const o = 14 + i * 66;
      return { source: pk(od, o), invert: od[o + 32] === 1, type: SOURCE[od[o + 65]] ?? od[o + 65] };
    });
    const pos = await byDisc(DISC.Position, [{ memcmp: { offset: 8, bytes: Buffer.from([v.vaultId & 255, v.vaultId >> 8]).toString('base64'), encoding: 'base64' } }]);
    // Position: vault_id u16 @8, nft_id u32 @10, mint @14, is_supply_only u8 @46, tick i32 @47, tick_id u32 @51, supply u64 @55.
    const MIN_TICK = -2147483648;
    const withDebt = pos.filter(({ account: { data: p } }) => p[46] === 0 && p.readInt32LE(47) !== MIN_TICK && p.readBigUInt64LE(55) > 0n);
    out.push({
      ...v, supply: supplySym, borrow: borrowSym, state: st.key,
      totalSupplyTokens: Number(d.readBigUInt64LE(23)) * supplyEx, totalBorrowRaw: Number(d.readBigUInt64LE(31)) * borrowEx,
      totalPositionsField: d.readUInt32LE(39), positionAccounts: pos.length, positionsWithDebt: withDebt.length, oracleSources: sources,
    });
    console.log(`${supplySym}/${borrowSym} vault ${v.vaultId}: ${withDebt.length} positions with debt of ${pos.length}; LT ${v.liquidationThreshold / 10}%, CF ${v.collateralFactor / 10}%, penalty ${v.liquidationPenalty / 100}%; oracle ${sources.map((s) => s.type).join('+')}`);
  }
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  mkdirSync(join(ROOT, 'data/jupiter'), { recursive: true });
  writeFileSync(join(ROOT, `data/jupiter/spike-${day}.json`), JSON.stringify({ fetchedAt: new Date().toISOString(), vaultCount: vaults.length, xstockVaults: out }, null, 2) + '\n');
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
