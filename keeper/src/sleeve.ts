// PYUSD sleeve (W4) for the keeper. Cover on the Sentora xStocks Market's PYUSD debt is paid in PYUSD from the vault
// PDA's PYUSD account (the sleeve). INV-14: the sleeve holds every live PYUSD policy's reservation less the advances
// already paid from it, or buy_cover_multi refuses PYUSD cover. Each pass this job keeps the sleeve at
// max(SLEEVE_TARGET_PYUSD, that need):
//   - from PYUSD the keeper already holds (its PYUSD ATA), through fund_sleeve at klend's PYUSD price (the reserve is
//     refreshed in the same transaction; the program bounds the price by its slippage setting and refuses a depeg);
//   - what is still missing is reported. Buying PYUSD (a Jupiter USDC → PYUSD swap in its own transaction, never next
//     to a klend instruction) is not implemented in this keeper: on the fork the demo gives the keeper PYUSD by
//     cheatcode, labelled.
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { type Chain, TOKEN, TOKEN_2022, USDC_MINT, ata, createAtaIx, pdas, pk, send } from './chain.js';
import { loadReserve, refreshReserveIx } from './kamino.js';
import type { Report } from './jobs.js';

const DEFAULT = '11111111111111111111111111111111';
/** The Sentora xStocks Market's PYUSD reserve (fund_sleeve prices PYUSD on it). */
export const SENTORA_PYUSD_RESERVE = pk(process.env.PYUSD_RESERVE ?? '6bR98MJTH68s7eV8ssyBgfuuH5oR2bEt58P9rZPLpBrC');

async function balance(c: Chain, key: InstanceType<typeof web3.PublicKey>): Promise<bigint> {
  try {
    return BigInt((await c.conn.getTokenAccountBalance(key)).value.amount);
  } catch {
    return 0n;
  }
}

/** The sleeve's balance, the INV-14 need (reserved − advanced) and the keeper's target. */
export async function sleeveState(c: Chain) {
  const cfg = await c.program.account.config.fetch(pdas.config());
  const v = await c.program.account.vault.fetch(pdas.vault());
  if (cfg.pyusdMint.toBase58() === DEFAULT || v.pyusdSleeve.toBase58() === DEFAULT) return null;
  const held = await balance(c, v.pyusdSleeve);
  const need = BigInt(v.pyusdReserved.toString()) - BigInt(v.pyusdAdvanced.toString());
  const target = BigInt(Math.round(Number(process.env.SLEEVE_TARGET_PYUSD ?? 0) * 1e6));
  return { mint: cfg.pyusdMint as InstanceType<typeof web3.PublicKey>, sleeve: v.pyusdSleeve as InstanceType<typeof web3.PublicKey>, held, need, target: need > target ? need : target };
}

/** fund_sleeve: `pyusdIn` from the keeper's PYUSD ATA into the sleeve, for `usdcOut` of the vault's USDC (at most
 * klend's price plus the slippage bound). Creates the keeper's USDC ATA if needed. */
export async function fundSleeve(c: Chain, pyusdIn: bigint, usdcOut: bigint) {
  const s = await sleeveState(c);
  if (!s) throw new Error('no PYUSD sleeve configured');
  const r = await loadReserve(c, SENTORA_PYUSD_RESERVE);
  const ix = await c.program.methods.fundSleeve(new BN(pyusdIn.toString()), new BN(usdcOut.toString()))
    .accountsPartial({
      keeper: c.payer.publicKey, vault: pdas.vault(), vaultUsdc: pdas.vaultUsdc(), sleeve: s.sleeve, pyusdMint: s.mint,
      keeperPyusd: ata(c.payer.publicKey, s.mint, TOKEN_2022), keeperUsdc: ata(c.payer.publicKey, USDC_MINT),
      pyusdReserve: SENTORA_PYUSD_RESERVE, tokenProgram: TOKEN, token2022Program: TOKEN_2022,
    }).instruction();
  return send(c, [createAtaIx(c.payer.publicKey, c.payer.publicKey, USDC_MINT), refreshReserveIx(SENTORA_PYUSD_RESERVE, r), ix]);
}

/** klend's PYUSD price (USD per PYUSD) from the reserve as last refreshed. */
export async function pyusdPrice(c: Chain): Promise<number> {
  const r = await loadReserve(c, SENTORA_PYUSD_RESERVE);
  return Number(BigInt(r.liquidity.marketPriceSf.toString()) >> 40n) / 2 ** 20;
}

export async function sleeveJob(c: Chain): Promise<Report> {
  const rep: Report = { sent: [], failed: [], waiting: [] };
  const s = await sleeveState(c);
  if (!s || s.held >= s.target) return rep;
  const short = s.target - s.held;
  const have = await balance(c, ata(c.payer.publicKey, s.mint, TOKEN_2022));
  const amount = have < short ? have : short;
  if (amount > 0n) {
    // At klend's price, rounded down (the vault never pays above it here).
    const px = await pyusdPrice(c);
    const usdc = BigInt(Math.floor(Number(amount) * Math.min(px, 1)));
    try {
      const { cu } = await fundSleeve(c, amount, usdc);
      rep.sent.push(`fund_sleeve ${(Number(amount) / 1e6).toFixed(6)} PYUSD for ${(Number(usdc) / 1e6).toFixed(6)} USDC (${cu} CU)`);
    } catch (e) {
      rep.failed.push(`fund_sleeve: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (amount < short) rep.waiting.push(`PYUSD sleeve short ${(Number(short - amount) / 1e6).toFixed(6)} PYUSD (held ${(Number(s.held) / 1e6).toFixed(2)}, INV-14 need ${(Number(s.need) / 1e6).toFixed(2)}); swap USDC → PYUSD and run fund_sleeve`);
  return rep;
}
