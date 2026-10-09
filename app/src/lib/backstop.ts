// Monday Backstop (W2) as the app shows it: the pool's parameters and totals, each xStock's inventory (held, cost, the
// vault's NAV mark and full value) and its Dutch auction. The price a buyer pays is computed exactly as credence-core's
// buy_from_sale does: the Dutch decay from start to floor (rounded up), never below today's floor Scope now × (1 − d_max)
// (rounded up, audit A-38). Prices are per whole token on Kamino's Scope basis (the Scaled UI multiplier inside it).
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { type CoreProgram, SCOPE_PRICES, TOKEN, TOKEN_2022, USDC_MINT, WAD, ata, big, bn, createAtaIx, decodeScope, pdas, tickerStr } from './credence';

export type PoolView = {
  maxShareWad: bigint; haircutWad: bigint; maxDiscountWad: bigint; salePremiumWad: bigint; saleDiscountWad: bigint; saleSecs: number;
  spent: bigint; salesProceeds: bigint; realizedPnl: bigint; liquidations: number; fills: number;
};
export type InventoryView = {
  key: PublicKey; ticker: string; mint: PublicKey; tokens: PublicKey; qty: bigint; cost: bigint; bought: bigint; sold: bigint;
  saleActive: boolean; lotLeft: bigint; startPriceWad: bigint; floorPriceWad: bigint; saleStartedAt: number; saleSecs: number;
  /** From the vault's slot: NAV mark (Scope − haircut) and full value at the last mark. */
  mark: bigint; value: bigint; markedAt: number;
  scopePriceWad: bigint | null;
};

/** The Dutch decay at `now`: start − ⌊(start − floor) × elapsed / duration⌋ (risk-core::dutch_price). */
export function dutchPrice(start: bigint, floor: bigint, t0: number, secs: number, now: number): bigint {
  const el = BigInt(Math.min(Math.max(now - t0, 0), secs));
  return start - ((start - floor) * el) / BigInt(secs);
}

/** What buy_from_sale charges per whole token now (WAD). */
export function salePrice(inv: InventoryView, pool: PoolView, now: number): bigint {
  const d = dutchPrice(inv.startPriceWad, inv.floorPriceWad, inv.saleStartedAt, inv.saleSecs, now);
  if (inv.scopePriceWad === null) return d;
  const today = (inv.scopePriceWad * (WAD - pool.saleDiscountWad) + WAD - 1n) / WAD;
  return d > today ? d : today;
}

/** USDC for `qty` raw units at `priceWad` per whole token of `decimals`: ⌈qty × price / 10^(18 + decimals − 6)⌉. */
export function lotCost(qty: bigint, priceWad: bigint, decimals = 8): bigint {
  const scale = 10n ** BigInt(18 + decimals - 6);
  return (qty * priceWad + scale - 1n) / scale;
}

export async function loadBackstop(conn: Connection, prog: CoreProgram) {
  const pool = await prog.account.backstopPool.fetchNullable(pdas.backstop(), 'confirmed');
  if (!pool) return null;
  const [rows, vault, assets, scope] = await Promise.all([
    prog.account.inventory.all(),
    prog.account.vault.fetch(pdas.vault(), 'confirmed'),
    prog.account.assetConfig.all(),
    conn.getAccountInfo(SCOPE_PRICES, 'confirmed'),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Row = { publicKey: PublicKey; account: any };
  const chain = new Map((assets as Row[]).map((a) => [tickerStr(a.account.ticker as number[]), Number(big(a.account.scopeChain as never))]));
  const slots = vault.inv as { ticker: number[]; cost: unknown; mark: unknown; value: unknown; markedAt: unknown }[];
  const inventories: InventoryView[] = (rows as Row[]).map(({ publicKey, account: i }) => {
    const t = tickerStr(i.ticker as number[]);
    const s = slots.find((x) => tickerStr(x.ticker) === t);
    const c = chain.get(t);
    const px = scope && c !== undefined ? decodeScope(scope.data, c as number) : null;
    return {
      key: publicKey, ticker: t, mint: i.mint, tokens: i.tokens, qty: big(i.qty), cost: big(i.cost), bought: big(i.bought), sold: big(i.sold),
      saleActive: i.saleActive === 1, lotLeft: big(i.lotLeft), startPriceWad: big(i.startPriceWad), floorPriceWad: big(i.floorPriceWad),
      saleStartedAt: Number(big(i.saleStartedAt)), saleSecs: i.saleSecs as number,
      mark: s ? big(s.mark as never) : 0n, value: s ? big(s.value as never) : 0n, markedAt: s ? Number(big(s.markedAt as never)) : 0,
      scopePriceWad: px ? px.value * 10n ** BigInt(18 - px.exp) : null,
    };
  }).sort((a: InventoryView, b: InventoryView) => a.ticker.localeCompare(b.ticker));
  const p: PoolView = {
    maxShareWad: big(pool.maxShareWad), haircutWad: big(pool.haircutWad), maxDiscountWad: big(pool.maxDiscountWad), salePremiumWad: big(pool.salePremiumWad),
    saleDiscountWad: big(pool.saleDiscountWad), saleSecs: pool.saleSecs as number, spent: big(pool.spent), salesProceeds: big(pool.salesProceeds),
    realizedPnl: BigInt(pool.realizedPnl.toString()), liquidations: pool.liquidations as number, fills: pool.fills as number,
  };
  return { pool: p, inventories };
}

/** buy_from_sale for `qty` raw units, paying at most `maxPriceWad` per token; creates the buyer's xStock account. */
export async function buyIxs(prog: CoreProgram, buyer: PublicKey, inv: InventoryView, qty: bigint, maxPriceWad: bigint): Promise<TransactionInstruction[]> {
  return [
    createAtaIx(buyer, buyer, inv.mint, TOKEN_2022),
    await prog.methods.buyFromSale(bn(qty), bn(maxPriceWad)).accountsPartial({
      buyer, pool: pdas.backstop(), inventory: inv.key, asset: pdas.asset(inv.ticker), scopePrices: SCOPE_PRICES, vault: pdas.vault(),
      vaultUsdc: pdas.vaultUsdc(), invTokens: inv.tokens, xstockMint: inv.mint, buyerUsdc: ata(buyer, USDC_MINT),
      buyerTokens: ata(buyer, inv.mint, TOKEN_2022), tokenProgram: TOKEN, token2022Program: TOKEN_2022,
    }).instruction(),
  ];
}
