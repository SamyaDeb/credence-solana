// A plain third-party Kamino liquidator (W1 twin demo): it plays the market's liquidators. For each obligation it is
// given, it sends refresh_reserve ×N + refresh_obligation + `liquidate_obligation_and_redeem_reserve_collateral_v2`
// from its own keypair, repaying USDC and receiving the xStock collateral at klend's liquidation bonus. klend decides
// whether the obligation is liquidatable and how much may be repaid (close factor, bonus); a healthy obligation makes
// the transaction fail and the bot reports "healthy". It has nothing to do with Credence's program.
//
//   pnpm -C keeper liquidator --obligation <pubkey> [--obligation <pubkey> …] [--once]
//   LIQUIDATOR_WALLET=<keypair.json> (default .fork/liquidator.json, created if missing; fund it on the fork)
import { config } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { FARMS, INSTRUCTIONS_SYSVAR, KLEND, ROOT, TOKEN, type Chain, ata, connect, createAtaIx, log, pk, send } from './chain.js';
import { type ObligationState, type ReserveState, borrows, deposits, farmUserState, loadObligation, loadReserve, refreshIxs } from './kamino.js';
type PublicKey = InstanceType<typeof web3.PublicKey>;
type TransactionInstruction = InstanceType<typeof web3.TransactionInstruction>;

const DEFAULT = '11111111111111111111111111111111';
/** `sha256("global:liquidate_obligation_and_redeem_reserve_collateral_v2")[..8]` (klend-sdk's DISCRIMINATOR). */
export const LIQUIDATE_V2_DISC = createHash('sha256').update('global:liquidate_obligation_and_redeem_reserve_collateral_v2').digest().subarray(0, 8);

const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

/** The liquidator's token accounts for a (repay, withdraw) reserve pair: USDC source, cToken and xStock destinations. */
export function liquidatorAccounts(liquidator: PublicKey, repay: ReserveState, withdraw: ReserveState) {
  const xTokenProgram = pk(withdraw.liquidity.tokenProgram);
  return {
    source: ata(liquidator, pk(repay.liquidity.mintPubkey), pk(repay.liquidity.tokenProgram)),
    destCollateral: ata(liquidator, pk(withdraw.collateral.mintPubkey), TOKEN),
    destLiquidity: ata(liquidator, pk(withdraw.liquidity.mintPubkey), xTokenProgram),
    xTokenProgram,
  };
}

/** `liquidate_obligation_and_redeem_reserve_collateral_v2` (account order as klend-sdk's codegen; a missing farm is
 * the klend program id). `amount` is the most USDC the liquidator will repay; klend repays at most what it allows. */
export function liquidateV2Ix(a: {
  liquidator: PublicKey; obligation: PublicKey; market: PublicKey;
  repayKey: PublicKey; repay: ReserveState; withdrawKey: PublicKey; withdraw: ReserveState;
  amount: bigint; minReceived?: bigint;
}): TransactionInstruction {
  const t = liquidatorAccounts(a.liquidator, a.repay, a.withdraw);
  const lma = web3.PublicKey.findProgramAddressSync([Buffer.from('lma'), a.market.toBuffer()], KLEND)[0];
  const farm = (f: string, writable = true) => (f === DEFAULT ? r(KLEND) : (writable ? w(pk(f)) : r(pk(f))));
  const userState = (f: string) => (f === DEFAULT ? r(KLEND) : w(farmUserState(pk(f), a.obligation)));
  const data = Buffer.alloc(8 + 24);
  LIQUIDATE_V2_DISC.copy(data, 0);
  data.writeBigUInt64LE(a.amount, 8);
  data.writeBigUInt64LE(a.minReceived ?? 0n, 16);
  data.writeBigUInt64LE(0n, 24); // max_allowed_ltv_override_percent: none
  return new web3.TransactionInstruction({
    programId: KLEND,
    data,
    keys: [
      { pubkey: a.liquidator, isSigner: true, isWritable: false },
      w(a.obligation), r(a.market), r(lma),
      w(a.repayKey), r(pk(a.repay.liquidity.mintPubkey)), w(pk(a.repay.liquidity.supplyVault)),
      w(a.withdrawKey), r(pk(a.withdraw.liquidity.mintPubkey)), w(pk(a.withdraw.collateral.mintPubkey)),
      w(pk(a.withdraw.collateral.supplyVault)), w(pk(a.withdraw.liquidity.supplyVault)), w(pk(a.withdraw.liquidity.feeVault)),
      w(t.source), w(t.destCollateral), w(t.destLiquidity),
      r(TOKEN), r(pk(a.repay.liquidity.tokenProgram)), r(t.xTokenProgram), r(INSTRUCTIONS_SYSVAR),
      userState(a.withdraw.farmCollateral), farm(a.withdraw.farmCollateral),
      userState(a.repay.farmDebt), farm(a.repay.farmDebt),
      r(FARMS),
    ],
  });
}

export type Liquidated = { sig: string; cu: number; repaidUsdc: bigint; receivedXstockRaw: bigint; debtBefore: bigint; debtAfter: bigint };

/** One liquidation attempt on `obligation` (first USDC-like borrow, first deposit) from `c.payer`. Creates the
 * liquidator's token accounts if missing. Throws with klend's logs when klend refuses (e.g. the obligation is healthy). */
export async function liquidate(c: Chain, obligation: PublicKey, maxRepay?: bigint): Promise<Liquidated> {
  const ob = (await loadObligation(c, obligation)) as ObligationState;
  if (!ob) throw new Error(`obligation ${obligation.toBase58()} not found`);
  const [withdrawKey] = deposits(ob);
  const [repayKey] = borrows(ob);
  const [repay, withdraw] = [await loadReserve(c, repayKey), await loadReserve(c, withdrawKey)];
  const me = c.payer.publicKey;
  const t = liquidatorAccounts(me, repay, withdraw);
  const debt = BigInt(ob.borrows.find((b) => b.borrowReserve === repayKey.toBase58())!.borrowedAmountSf.toString()) >> 60n;
  const bal = async (k: PublicKey) => {
    const a = await c.conn.getTokenAccountBalance(k).catch(() => null);
    return BigInt(a?.value.amount ?? '0');
  };
  const [usdc0, x0] = [await bal(t.source), await bal(t.destLiquidity)];
  const ixs = [
    createAtaIx(me, me, pk(withdraw.collateral.mintPubkey), TOKEN),
    createAtaIx(me, me, pk(withdraw.liquidity.mintPubkey), t.xTokenProgram),
    ...(await refreshIxs(c, obligation, ob)),
    liquidateV2Ix({ liquidator: me, obligation, market: pk(ob.lendingMarket), repayKey, repay, withdrawKey, withdraw, amount: maxRepay ?? debt + 1n }),
  ];
  const { sig, cu } = await send(c, ixs);
  const after = await loadObligation(c, obligation);
  const debtAfter = after ? BigInt(after.borrows.find((b) => b.borrowReserve === repayKey.toBase58())?.borrowedAmountSf.toString() ?? '0') >> 60n : 0n;
  return { sig, cu, repaidUsdc: usdc0 - (await bal(t.source)), receivedXstockRaw: (await bal(t.destLiquidity)) - x0, debtBefore: debt, debtAfter };
}

/** The liquidator keypair: LIQUIDATOR_WALLET, else `.fork/liquidator.json` (created on first use). */
export function liquidatorWalletPath(): string {
  const p = process.env.LIQUIDATOR_WALLET ?? join(ROOT, '.fork/liquidator.json');
  if (!existsSync(p)) {
    mkdirSync(join(ROOT, '.fork'), { recursive: true });
    writeFileSync(p, JSON.stringify([...web3.Keypair.generate().secretKey]));
  }
  return p;
}

async function main() {
  config({ path: join(ROOT, '.env'), quiet: true });
  const obligations: PublicKey[] = [];
  process.argv.forEach((a, i) => { if (a === '--obligation') obligations.push(pk(process.argv[i + 1])); });
  if (obligations.length === 0) throw new Error('pass --obligation <pubkey> (repeatable)');
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899', liquidatorWalletPath());
  log(`liquidator ${c.payer.publicKey.toBase58()} watching ${obligations.length} obligation(s)`);
  for (;;) {
    for (const o of obligations) {
      try {
        const l = await liquidate(c, o);
        log(`  LIQUIDATED ${o.toBase58().slice(0, 8)}: repaid ${(Number(l.repaidUsdc) / 1e6).toFixed(2)} USDC, received ${(Number(l.receivedXstockRaw) / 1e8).toFixed(8)} xStock, debt ${(Number(l.debtBefore) / 1e6).toFixed(2)} → ${(Number(l.debtAfter) / 1e6).toFixed(2)} (${l.cu} CU)`);
      } catch (e) {
        const m = (e as Error).message;
        log(`  ${o.toBase58().slice(0, 8)}: ${/healthy|LiquidationNotAllowed|6016|0x1780|ObligationHealthy/i.test(m) ? 'healthy' : m.split('\n').slice(0, 3).join(' | ')}`);
      }
    }
    if (process.argv.includes('--once')) break;
    await new Promise((res) => setTimeout(res, 5_000));
  }
}

if (process.argv[1]?.endsWith('liquidator.ts')) main().catch((e) => { console.error(e); process.exit(1); });

