// Task 4.3 acceptance: every vault number the Underwriters page shows equals the account value. This test reads the raw
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
      // then bump ×4 (u8), inv: [InvSlot; 4] (ticker 8, cost, mark, value u64, marked_at i64 = 40 bytes each, W2),
      // yield_reserve 32, kusdc 32, lent_ctokens, lent_value u64, lent_valued_at, yield_recognized i64,
      // cash_headroom_wad, advanced_live u64 (W3, A-34).
      inventoryCost: [0, 1, 2, 3].reduce((a, i) => a + u64(v, o + 100 + 40 * i + 8), 0n),
      inventoryMark: [0, 1, 2, 3].reduce((a, i) => a + u64(v, o + 100 + 40 * i + 16), 0n),
      lentCtokens: u64(v, o + 260 + 64), lentValue: u64(v, o + 260 + 72), lentValuedAt: Number(v.readBigInt64LE(o + 260 + 80)),
      yieldRecognized: v.readBigInt64LE(o + 260 + 88), advancedLive: u64(v, o + 260 + 104),
      // then pyusd_sleeve 32, pyusd_reserved, pyusd_advanced u64 (W4), hedge_pending u32 (D3).
      hedgePending: u32(v, o + 260 + 112 + 32 + 16),
    };
    const uMaxWad = u64(c, 8 + 32 * 4); // Config: disc, admin, guardian, keeper, usdc_mint, u_max_wad
    const supply = m.readBigUInt64LE(36); // SPL Mint: mint_authority COption (36), supply u64

    // Whatever the page loads, its own way.
    const page = await loadVault(conn, program(conn));
    const { feeAccount: _f, yieldReserve: yr, ...view } = page.view;
    expect(yr.toBuffer().equals(v.subarray(o + 260, o + 292))).toBe(true);
    expect(view).toEqual(raw);
    expect(page.supply).toBe(supply);
    expect(page.uMaxWad).toBe(uMaxWad);

    // The derived figures, recomputed here from the raw integers.
    const limit = ((raw.equity - raw.inventoryCost) * uMaxWad) / WAD;
    const nav = raw.equity - raw.inventoryCost + raw.inventoryMark;
    expect(page.figures.navPerShare6).toBe(supply > 0n ? (nav * 1_000_000n) / supply : 1_000_000n);
    expect(page.figures.premiumsEarned).toBe(raw.totalPremiums - raw.premiumsUnearned);
    expect(page.figures.capacityLimit).toBe(limit);
    expect(page.figures.utilisationPpm).toBe(limit > 0n ? Number((raw.reservedTotal * 1_000_000n) / limit) : 0);
    expect(raw.equity).toBeGreaterThan(0n);
  });
});
