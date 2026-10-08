// Monday Backstop (W2) for the keeper: Credence's vault liquidates unhealthy xStock positions itself through the
// program (`backstop_liquidate`: klend's v2 liquidation CPI with the vault PDA as liquidator), holds the redeemed
// collateral as inventory, marks it for NAV and resells it in a Dutch auction. Never Jupiter in a klend transaction:
// sales are their own transactions and never touch klend.
//
//   backstopJob(c, watch)   one pass: mark every inventory; liquidate each watched obligation that klend's own
//                           refreshed values show is liquidatable (within the vault's INV-13 budget); open a sale for
//                           inventory not on sale; close sales whose decay has ended (the next pass re-offers the rest)
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import {
  type Chain, FARMS, INSTRUCTIONS_SYSVAR, KLEND, SCOPE_PRICES, TOKEN, TOKEN_2022, USDC_MINT, ata, chainNow, createAtaIx, log, pdas, pk, send, tickerStr,
} from './chain.js';
import { type ObligationState, deposits, borrows, farmUserState, loadObligation, loadReserve, refreshIxs } from './kamino.js';
import type { Report } from './jobs.js';
type PublicKey = InstanceType<typeof web3.PublicKey>;

const DEFAULT = '11111111111111111111111111111111';
const XSTOCKS_MARKETS = ['5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua', '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr'];
const n = (x: { toString(): string } | number) => Number(x.toString());
const sf = (x: { toString(): string }) => Number(BigInt(x.toString()) >> 40n) / 2 ** 20;

/** klend's view after a refresh: liquidatable when the borrow-factor-adjusted debt reaches the unhealthy value. */
export function healthOf(o: ObligationState) {
  const debt = sf(o.borrowFactorAdjustedDebtValueSf), unhealthy = sf(o.unhealthyBorrowValueSf);
  return { debtUsd: debt, unhealthyUsd: unhealthy, ratio: unhealthy > 0 ? debt / unhealthy : Infinity };
}

/** USDC the backstop may spend now (INV-13): vault cash above the cash kept for live groups and queues, and the
 * pool's share of equity above the inventory already held at cost. */
export async function budget(c: Chain): Promise<bigint> {
  const v = await c.program.account.vault.fetch(pdas.vault());
  const pool = await c.program.account.backstopPool.fetch(pdas.backstop());
  const cash = BigInt((await c.conn.getTokenAccountBalance(pdas.vaultUsdc())).value.amount);
  const keep = BigInt(v.reservedTotal.toString()) + BigInt(v.premiumsUnearned.toString()) + BigInt(v.queuedDeposits.toString());
  const invCost = (v.inv as { cost: { toString(): string } }[]).reduce((a, s) => a + BigInt(s.cost.toString()), 0n);
  const share = (BigInt(v.equity.toString()) * BigInt(pool.maxShareWad.toString())) / 10n ** 18n - invCost;
  const free = cash - keep;
  const m = free < share ? free : share;
  return m > 0n ? m : 0n;
}

/** The asset whose Kamino reserve is `reserve` in the obligation's market. */
async function assetFor(c: Chain, reserve: PublicKey) {
  for (const a of await c.program.account.assetConfig.all()) {
    if ((a.account.kaminoReserves as PublicKey[]).some((r) => r.equals(reserve))) return a;
  }
  return null;
}

/** Refreshes + `backstop_liquidate` for `obligation` (its first deposit and first borrow), repaying at most `maxRepay`
 * USDC. Returns what the vault paid and received (raw units). Throws with klend's logs if klend refuses. */
export async function backstopLiquidate(c: Chain, obligation: PublicKey, maxRepay: bigint, minReceived = 0n) {
  const ob = await loadObligation(c, obligation);
  if (!ob) throw new Error(`obligation ${obligation.toBase58()} not found`);
  const [withdrawKey] = deposits(ob);
  const [repayKey] = borrows(ob);
  const [withdraw, repay] = [await loadReserve(c, withdrawKey), await loadReserve(c, repayKey)];
  const asset = await assetFor(c, withdrawKey);
  if (!asset) throw new Error(`no Credence asset for reserve ${withdrawKey.toBase58()}`);
  const t = tickerStr(asset.account.ticker as number[]);
  const vault = pdas.vault();
  const market = pk(ob.lendingMarket);
  const farm = (f: string) => (f === DEFAULT ? KLEND : pk(f));
  const user = (f: string) => (f === DEFAULT ? KLEND : farmUserState(pk(f), obligation));
  const k = {
    collateralFarmUserState: user(withdraw.farmCollateral), collateralFarmState: farm(withdraw.farmCollateral),
    debtFarmUserState: user(repay.farmDebt), debtFarmState: farm(repay.farmDebt),
  };
  const tokens = ata(vault, pk(withdraw.liquidity.mintPubkey), TOKEN_2022);
  const bal = async (key: PublicKey) => BigInt((await c.conn.getTokenAccountBalance(key)).value.amount);
  const [usdc0, x0] = [await bal(pdas.vaultUsdc()), await bal(tokens)];
  const ix = await c.program.methods.backstopLiquidate(new BN(maxRepay.toString()), new BN(minReceived.toString()))
    .accountsPartial({
      keeper: c.payer.publicKey, pool: pdas.backstop(), asset: asset.publicKey, inventory: pdas.inventory(t), vault, vaultUsdc: pdas.vaultUsdc(),
      invTokens: tokens, invCtokens: ata(vault, pk(withdraw.collateral.mintPubkey), TOKEN), scopePrices: SCOPE_PRICES,
      obligation, lendingMarket: market,
      lendingMarketAuthority: web3.PublicKey.findProgramAddressSync([Buffer.from('lma'), market.toBuffer()], KLEND)[0],
      repayReserve: repayKey, usdcMint: USDC_MINT, repayReserveLiquiditySupply: pk(repay.liquidity.supplyVault),
      withdrawReserve: withdrawKey, xstockMint: pk(withdraw.liquidity.mintPubkey),
      withdrawReserveCollateralMint: pk(withdraw.collateral.mintPubkey), withdrawReserveCollateralSupply: pk(withdraw.collateral.supplyVault),
      withdrawReserveLiquiditySupply: pk(withdraw.liquidity.supplyVault), withdrawReserveLiquidityFeeReceiver: pk(withdraw.liquidity.feeVault),
      tokenProgram: TOKEN, token2022Program: TOKEN_2022, instructionSysvar: INSTRUCTIONS_SYSVAR, ...k, farmsProgram: FARMS, klendProgram: KLEND,
    }).instruction();
  // The program does not demand `mut` on farm slots (A-21); real farms are passed writable.
  for (const m of ix.keys) if (!m.pubkey.equals(KLEND) && Object.values(k).some((x) => x.equals(m.pubkey))) m.isWritable = true;
  const res = await send(c, [...(await refreshIxs(c, obligation, ob)), ix]);
  return { ...res, ticker: t, spent: usdc0 - (await bal(pdas.vaultUsdc())), received: (await bal(tokens)) - x0 };
}

export async function markInventory(c: Chain, t: string) {
  const a = await c.program.account.assetConfig.fetch(pdas.asset(t));
  return send(c, [await c.program.methods.markInventory()
    .accountsPartial({ pool: pdas.backstop(), asset: pdas.asset(t), inventory: pdas.inventory(t), vault: pdas.vault(), xstockMint: a.mint, scopePrices: SCOPE_PRICES })
    .instruction()]);
}

export async function startSale(c: Chain, t: string, lot: bigint) {
  return send(c, [await c.program.methods.startSale(new BN(lot.toString()))
    .accountsPartial({ keeper: c.payer.publicKey, pool: pdas.backstop(), asset: pdas.asset(t), inventory: pdas.inventory(t), scopePrices: SCOPE_PRICES })
    .instruction()]);
}

export async function closeSale(c: Chain, t: string) {
  return send(c, [await c.program.methods.closeSale().accountsPartial({ caller: c.payer.publicKey, inventory: pdas.inventory(t) }).instruction()]);
}

/** `buyer` buys `qty` raw units at the current auction price, paying at most `maxPriceWad` per token. */
export async function buyFromSale(c: Chain, buyer: InstanceType<typeof web3.Keypair>, t: string, qty: bigint, maxPriceWad: bigint) {
  const inv = await c.program.account.inventory.fetch(pdas.inventory(t));
  const mint = inv.mint as PublicKey;
  return send(c, [createAtaIx(buyer.publicKey, buyer.publicKey, mint, TOKEN_2022),
    await c.program.methods.buyFromSale(new BN(qty.toString()), new BN(maxPriceWad.toString()))
      .accountsPartial({
        buyer: buyer.publicKey, pool: pdas.backstop(), inventory: pdas.inventory(t), vault: pdas.vault(), vaultUsdc: pdas.vaultUsdc(),
        invTokens: inv.tokens, xstockMint: mint, buyerUsdc: ata(buyer.publicKey, USDC_MINT), buyerTokens: ata(buyer.publicKey, mint, TOKEN_2022),
        tokenProgram: TOKEN, token2022Program: TOKEN_2022,
      }).instruction()], [buyer]);
}

/** The auction price now (per token, WAD), as the program computes it (rounded up). */
export function salePrice(inv: { startPriceWad: { toString(): string }; floorPriceWad: { toString(): string }; saleStartedAt: unknown; saleSecs: number }, now: number): bigint {
  const [s, f] = [BigInt(inv.startPriceWad.toString()), BigInt(inv.floorPriceWad.toString())];
  const t0 = n(inv.saleStartedAt as never), d = BigInt(inv.saleSecs);
  const el = BigInt(Math.min(Math.max(now - t0, 0), inv.saleSecs));
  return s - ((s - f) * el) / d;
}

/** One backstop pass (see the module header). `watch`: obligations to check for liquidation. */
export async function backstopJob(c: Chain, watch: PublicKey[] = []): Promise<Report> {
  const r: Report = { sent: [], failed: [], waiting: [] };
  if (!(await c.conn.getAccountInfo(pdas.backstop()))) return r;
  const now = await chainNow(c);
  const attempt = async (what: string, f: () => Promise<{ cu: number }>) => {
    try { const { cu } = await f(); r.sent.push(what); log(`  ok   ${what} (${cu} CU)`); return true; }
    catch (e) { r.failed.push(what); log(`  FAIL ${what}: ${(e as Error).message.split('\n').slice(0, 3).join(' | ')}`); return false; }
  };
  for (const o of watch) {
    const ob = await loadObligation(c, o);
    if (!ob || !XSTOCKS_MARKETS.includes(ob.lendingMarket)) continue;
    await send(c, await refreshIxs(c, o, ob)).catch(() => null);
    const fresh = await loadObligation(c, o);
    const h = fresh ? healthOf(fresh) : null;
    const id = o.toBase58().slice(0, 8);
    if (!h || h.ratio < 1) { r.waiting.push(`${id}: healthy (D/C′ ${h?.ratio.toFixed(4) ?? '—'})`); continue; }
    const cap = await budget(c);
    if (cap <= 0n) { r.waiting.push(`${id}: liquidatable but no backstop budget (INV-13)`); continue; }
    const debt = BigInt(fresh!.borrows.find((b) => b.borrowReserve !== DEFAULT)!.borrowedAmountSf.toString()) >> 60n;
    const want = debt + 1n < cap ? debt + 1n : cap; // klend applies its close factor
    await attempt(`backstop_liquidate ${id} (D/C′ ${h.ratio.toFixed(4)}, up to ${(Number(want) / 1e6).toFixed(2)} USDC)`, async () => {
      const l = await backstopLiquidate(c, o, want);
      log(`       vault paid ${(Number(l.spent) / 1e6).toFixed(2)} USDC, received ${(Number(l.received) / 1e8).toFixed(8)} ${l.ticker}`);
      return l;
    });
  }
  for (const i of await c.program.account.inventory.all()) {
    const inv = i.account;
    const t = tickerStr(inv.ticker as number[]);
    if (BigInt(inv.qty.toString()) === 0n) continue;
    await attempt(`mark_inventory ${t}`, () => markInventory(c, t));
    if (inv.saleActive === 1 && now >= n(inv.saleStartedAt) + inv.saleSecs) {
      await attempt(`close_sale ${t} (decay over; unsold ${(n(inv.lotLeft) / 1e8).toFixed(8)} stays)`, () => closeSale(c, t));
    } else if (inv.saleActive === 0) {
      await attempt(`start_sale ${t} lot ${(n(inv.qty) / 1e8).toFixed(8)}`, () => startSale(c, t, BigInt(inv.qty.toString())));
    } else {
      r.waiting.push(`${t}: on sale at ${(Number(salePrice(inv, now) / 10n ** 10n) / 1e8).toFixed(4)} until ${new Date((n(inv.saleStartedAt) + inv.saleSecs) * 1000).toISOString()}`);
    }
  }
  return r;
}
