// Yield vault (W3) for the keeper: `rebalance` keeps vault cash at the buffer and lends the rest to the xStocks Market
// USDC reserve (klend deposit/redeem CPIs inside the program), booking the position's yield. It runs every pass after
// settlements and before the queues, so queued deposits and withdrawals always price on a fresh valuation (INV-5).
// klend's deposit and redeem need no refresh instruction; a refresh_reserve goes first anyway so a pass with nothing
// to move still values the position on this slot's reserve.
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { type Chain, INSTRUCTIONS_SYSVAR, KLEND, TOKEN, USDC_MINT, pdas, pk, send } from './chain.js';
import { loadReserve, refreshReserveIx } from './kamino.js';
import type { Report } from './jobs.js';

const DEFAULT = '11111111111111111111111111111111';

export async function rebalance(c: Chain) {
  const v = await c.program.account.vault.fetch(pdas.vault());
  const reserveKey = v.yieldReserve as InstanceType<typeof web3.PublicKey>;
  if (reserveKey.toBase58() === DEFAULT) return null;
  const r = await loadReserve(c, reserveKey);
  const market = pk(r.lendingMarket);
  const pool = (await c.conn.getAccountInfo(pdas.backstop())) ? pdas.backstop() : null;
  const ix = await c.program.methods.rebalance().accountsPartial({
    keeper: c.payer.publicKey, vault: pdas.vault(), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), pool,
    kusdc: v.kusdc, reserve: reserveKey, lendingMarket: market,
    lendingMarketAuthority: web3.PublicKey.findProgramAddressSync([Buffer.from('lma'), market.toBuffer()], KLEND)[0],
    usdcMint: USDC_MINT, reserveLiquiditySupply: pk(r.liquidity.supplyVault), reserveCollateralMint: pk(r.collateral.mintPubkey),
    tokenProgram: TOKEN, instructionSysvar: INSTRUCTIONS_SYSVAR, klendProgram: KLEND,
  }).instruction();
  return send(c, [refreshReserveIx(reserveKey, r), ix]);
}

/** Supply APY of the yield reserve as klend-sdk computes it is off-chain; the app reads it from the reserve. */
export async function yieldJob(c: Chain): Promise<Report> {
  const r: Report = { sent: [], failed: [], waiting: [] };
  try {
    const res = await rebalance(c);
    if (!res) return r;
    const v = await c.program.account.vault.fetch(pdas.vault());
    r.sent.push(`rebalance (lent ${(Number(v.lentValue.toString()) / 1e6).toFixed(2)} USDC, booked yield to date ${(Number(v.yieldRecognized.toString()) / 1e6).toFixed(6)})`);
  } catch (e) {
    r.failed.push(`rebalance: ${(e as Error).message.split('\n')[0]}`);
  }
  return r;
}
