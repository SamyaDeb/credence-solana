// klend helpers for the keeper: decode obligations and reserves, build `refresh_reserve` ×N + `refresh_obligation`
// for any obligation (deposit reserves, then borrow reserves, as klend expects), and the repay accounts that
// `settle_policy` passes to `repay_obligation_liquidity_v2`.
import { createHash } from 'node:crypto';
import { Obligation, Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { FARMS, INSTRUCTIONS_SYSVAR, KLEND, type Chain, pk } from './chain.js';
type PublicKey = InstanceType<typeof web3.PublicKey>;
type TransactionInstruction = InstanceType<typeof web3.TransactionInstruction>;

const DEFAULT = '11111111111111111111111111111111';
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const meta = (pubkey: PublicKey, isWritable = false) => ({ pubkey, isSigner: false, isWritable });
const orKlend = (a: string) => (a === DEFAULT ? KLEND : pk(a));

export type ObligationState = ReturnType<typeof Obligation.decode>;
export type ReserveState = ReturnType<typeof Reserve.decode>;

export async function loadObligation(c: Chain, key: PublicKey): Promise<ObligationState | null> {
  const a = await c.conn.getAccountInfo(key);
  if (!a || !a.owner.equals(KLEND) || a.data.length === 0) return null;
  return Obligation.decode(a.data);
}

export async function loadReserve(c: Chain, key: PublicKey): Promise<ReserveState> {
  const a = await c.conn.getAccountInfo(key);
  if (!a) throw new Error(`reserve ${key} not found`);
  return Reserve.decode(a.data);
}

export const deposits = (o: ObligationState) => o.deposits.filter((d) => d.depositReserve !== DEFAULT).map((d) => pk(d.depositReserve));
export const borrows = (o: ObligationState) => o.borrows.filter((b) => b.borrowReserve !== DEFAULT).map((b) => pk(b.borrowReserve));

/** USDC debt in base units × 2^60 on `reserve` (0 if the obligation does not borrow from it). */
export function borrowedSf(o: ObligationState, reserve: PublicKey): bigint {
  const b = o.borrows.find((x) => x.borrowReserve === reserve.toBase58());
  return b ? BigInt(b.borrowedAmountSf.toString()) : 0n;
}

export function refreshReserveIx(key: PublicKey, r: ReserveState): TransactionInstruction {
  const t = r.config.tokenInfo;
  return new web3.TransactionInstruction({
    programId: KLEND,
    data: disc('refresh_reserve'),
    keys: [
      meta(key, true),
      meta(pk(r.lendingMarket)),
      meta(orKlend(t.pythConfiguration.price)),
      meta(orKlend(t.switchboardConfiguration.priceAggregator)),
      meta(orKlend(t.switchboardConfiguration.twapAggregator)),
      meta(orKlend(t.scopeConfiguration.priceFeed)),
    ],
  });
}

/** `refresh_reserve` for every reserve of the obligation, then `refresh_obligation`: what buy_cover and settle_policy
 * need first in the same transaction. */
export async function refreshIxs(c: Chain, obligation: PublicKey, o: ObligationState): Promise<TransactionInstruction[]> {
  const deps = deposits(o);
  const bors = borrows(o);
  const uniq = [...new Map([...deps, ...bors].map((k) => [k.toBase58(), k])).values()];
  const ixs: TransactionInstruction[] = [];
  for (const k of uniq) ixs.push(refreshReserveIx(k, await loadReserve(c, k)));
  ixs.push(new web3.TransactionInstruction({
    programId: KLEND,
    data: disc('refresh_obligation'),
    keys: [meta(pk(o.lendingMarket)), meta(obligation, true), ...[...deps, ...bors].map((k) => meta(k))],
  }));
  return ixs;
}

/** Kamino farms user state of `obligation` in `farm`: PDA `["user", farm, obligation]` of the farms program. */
export function farmUserState(farm: PublicKey, obligation: PublicKey): PublicKey {
  return web3.PublicKey.findProgramAddressSync([Buffer.from('user'), farm.toBuffer(), obligation.toBuffer()], FARMS)[0];
}

/** The optional klend accounts of `settle_policy` for a repay into `obligation` on `reserveKey`. */
export async function repayAccounts(c: Chain, obligation: PublicKey, marketKey: PublicKey, reserveKey: PublicKey) {
  const r = await loadReserve(c, reserveKey);
  const farm = r.farmDebt === DEFAULT ? null : pk(r.farmDebt);
  return {
    lendingMarket: marketKey,
    repayReserve: reserveKey,
    reserveDestinationLiquidity: pk(r.liquidity.supplyVault),
    instructionSysvar: INSTRUCTIONS_SYSVAR,
    obligationFarmUserState: farm ? farmUserState(farm, obligation) : KLEND,
    reserveFarmState: farm ?? KLEND,
    lendingMarketAuthority: web3.PublicKey.findProgramAddressSync([Buffer.from('lma'), marketKey.toBuffer()], KLEND)[0],
    farmsProgram: FARMS,
    klendProgram: KLEND,
  };
}
