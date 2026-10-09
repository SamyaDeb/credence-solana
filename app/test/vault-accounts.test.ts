// Every vault number the Underwriters page shows equals the account value. This test reads the raw
// Vault, Config and share-mint bytes from the fork, decodes them by byte offset (Borsh layout from the IDL, no Anchor),
// and compares with what the page's loader (Anchor decode + vaultFigures) produces. Skipped when no fork is running.
import { Connection } from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { RPC_URL, WAD, pdas, program } from '@/lib/credence';
import { loadVault } from '@/lib/vault';

const conn = new Connection(process.env.RPC_URL ?? RPC_URL, 'confirmed');
let up = false;
beforeAll(async () => {
  try { up = !!(await conn.getAccountInfo(pdas.vault())); } catch { up = false; }
});

const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);
const u32 = (d: Buffer, o: number) => d.readUInt32LE(o);

describe('Underwriters numbers = account values', () => {
  it('vault, config and share supply', async (ctx) => {
    if (!up) ctx.skip();
    const [vRaw, cRaw, mRaw] = await conn.getMultipleAccountsInfo([pdas.vault(), pdas.config(), pdas.shares()], 'confirmed');
    const v = vRaw!.data as Buffer;
    const c = cRaw!.data as Buffer;
    const m = mRaw!.data as Buffer;
    // Vault: disc 8, usdc 32, share_mint 32, fee_account 32, share_escrow 32, then seven u64, live_groups u32,
    // latest_group u32, live [u32; 8].
    const o = 8 + 32 * 4;
    const raw = {
      equity: u64(v, o), reservedTotal: u64(v, o + 8), premiumsUnearned: u64(v, o + 16), queuedDeposits: u64(v, o + 24),
      queuedWithdrawShares: u64(v, o + 32), totalPremiums: u64(v, o + 40), totalPayouts: u64(v, o + 48),
      liveGroups: u32(v, o + 56), latestGroup: u32(v, o + 60),
      live: [...Array(8)].map((_, i) => u32(v, o + 64 + 4 * i)).filter((g) => g !== 0).sort((a, b) => a - b),
    };
    const uMaxWad = u64(c, 8 + 32 * 4); // Config: disc, admin, guardian, keeper, usdc_mint, u_max_wad
    const supply = m.readBigUInt64LE(36); // SPL Mint: mint_authority COption (36), supply u64

    // Whatever the page loads, its own way.
    const page = await loadVault(conn, program(conn));
    const { feeAccount: _f, ...view } = page.view;
    expect(view).toEqual(raw);
    expect(page.supply).toBe(supply);
    expect(page.uMaxWad).toBe(uMaxWad);

    // The derived figures, recomputed here from the raw integers.
    const limit = (raw.equity * uMaxWad) / WAD;
    expect(page.figures.navPerShare6).toBe(supply > 0n ? (raw.equity * 1_000_000n) / supply : 1_000_000n);
    expect(page.figures.premiumsEarned).toBe(raw.totalPremiums - raw.premiumsUnearned);
    expect(page.figures.capacityLimit).toBe(limit);
    expect(page.figures.utilisationPpm).toBe(limit > 0n ? Number((raw.reservedTotal * 1_000_000n) / limit) : 0);
    expect(raw.equity).toBeGreaterThan(0n);
  });
});
