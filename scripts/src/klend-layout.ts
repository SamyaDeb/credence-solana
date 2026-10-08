// Prints byte offsets (after the 8-byte discriminator) of the klend Obligation and Reserve fields that
// credence-core reads, from klend-sdk's generated borsh layouts. Pinned in programs/credence-core/src/kamino.rs.
// Usage: pnpm tsx src/klend-layout.ts
import { Obligation, Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';

type L = { span: number; property?: string; fields?: L[]; elementLayout?: L; count?: number };
function off(layout: L, path: string[]): { offset: number; span: number } {
  let o = 0;
  let cur = layout;
  for (const p of path) {
    const m = p.match(/^(\w+)\[(\d+)\]$/);
    const name = m ? m[1] : p;
    let acc = 0;
    let f: L | undefined;
    for (const x of cur.fields!) {
      if (x.property === name) { f = x; break; }
      acc += x.span;
    }
    if (!f) throw new Error(`no field ${name}`);
    o += acc;
    cur = f;
    if (m) {
      // borsh.array → WrappedLayout { layout: Structure { fields: [Sequence { elementLayout, count }] } }
      const seq = (cur as L & { layout: L }).layout.fields![0];
      if (Number(m[2]) >= seq.count!) throw new Error(`${name}[${m[2]}] out of range`);
      o += Number(m[2]) * seq.elementLayout!.span;
      cur = seq.elementLayout!;
    }
  }
  return { offset: o, span: cur.span };
}

const ob = (Obligation as unknown as { layout: L }).layout;
const rs = (Reserve as unknown as { layout: L }).layout;
const rows: [string, L, string[]][] = [
  ['OBLIGATION_SIZE', ob, []],
  ['ob.last_update.slot', ob, ['lastUpdate', 'slot']],
  ['ob.last_update.stale', ob, ['lastUpdate', 'stale']],
  ['ob.last_update.price_status', ob, ['lastUpdate', 'priceStatus']],
  ['ob.lending_market', ob, ['lendingMarket']],
  ['ob.owner', ob, ['owner']],
  ['ob.deposits[0]', ob, ['deposits[0]']],
  ['ob.deposits[1]', ob, ['deposits[1]']],
  ['dep.deposit_reserve', ob, ['deposits[0]', 'depositReserve']],
  ['dep.deposited_amount', ob, ['deposits[0]', 'depositedAmount']],
  ['dep.market_value_sf', ob, ['deposits[0]', 'marketValueSf']],
  ['ob.deposited_value_sf', ob, ['depositedValueSf']],
  ['ob.borrows[0]', ob, ['borrows[0]']],
  ['ob.borrows[1]', ob, ['borrows[1]']],
  ['bor.borrow_reserve', ob, ['borrows[0]', 'borrowReserve']],
  ['bor.borrowed_amount_sf', ob, ['borrows[0]', 'borrowedAmountSf']],
  ['bor.market_value_sf', ob, ['borrows[0]', 'marketValueSf']],
  ['bor.bf_adjusted_market_value_sf', ob, ['borrows[0]', 'borrowFactorAdjustedMarketValueSf']],
  ['ob.borrow_factor_adjusted_debt_value_sf', ob, ['borrowFactorAdjustedDebtValueSf']],
  ['ob.borrowed_assets_market_value_sf', ob, ['borrowedAssetsMarketValueSf']],
  ['ob.allowed_borrow_value_sf', ob, ['allowedBorrowValueSf']],
  ['ob.unhealthy_borrow_value_sf', ob, ['unhealthyBorrowValueSf']],
  ['ob.elevation_group', ob, ['elevationGroup']],
  ['ob.has_debt', ob, ['hasDebt']],
  ['RESERVE_SIZE', rs, []],
  ['rs.last_update.slot', rs, ['lastUpdate', 'slot']],
  ['rs.last_update.stale', rs, ['lastUpdate', 'stale']],
  ['rs.lending_market', rs, ['lendingMarket']],
  ['rs.liquidity.mint', rs, ['liquidity', 'mintPubkey']],
  ['rs.liquidity.supply_vault', rs, ['liquidity', 'supplyVault']],
  ['rs.liquidity.market_price_sf', rs, ['liquidity', 'marketPriceSf']],
  ['rs.liquidity.mint_decimals', rs, ['liquidity', 'mintDecimals']],
  ['rs.liquidity.token_program', rs, ['liquidity', 'tokenProgram']],
  ['rs.liquidity.cumulative_borrow_rate_bsf', rs, ['liquidity', 'cumulativeBorrowRateBsf']],
  ['bor.cumulative_borrow_rate_bsf', ob, ['borrows[0]', 'cumulativeBorrowRateBsf']],
  ['rs.config.status', rs, ['config', 'status']],
  ['rs.config.loan_to_value_pct', rs, ['config', 'loanToValuePct']],
  ['rs.config.liquidation_threshold_pct', rs, ['config', 'liquidationThresholdPct']],
  ['rs.config.borrow_factor_pct', rs, ['config', 'borrowFactorPct']],
];
for (const [name, l, path] of rows) {
  const r = path.length ? off(l, path) : { offset: l.span, span: 0 };
  console.log(`${name.padEnd(42)} offset=${String(r.offset).padStart(5)} (+8 = ${String(r.offset + 8).padStart(5)}) span=${r.span}`);
}
