'use client';
import type { ReactNode } from 'react';
// Auctions: the Monday Backstop (W2). What Credence's vault liquidated at the move (klend's liquidation through a
// vault-PDA CPI, at Kamino's bonus) sits in inventory, marked for NAV at Scope − haircut, and is resold through a Dutch
// auction from Scope + p0 down to Scope − d_max. Anyone may buy; the price is the program's own (lib/backstop.ts).
// Every figure is read from the BackstopPool, Inventory and Vault accounts.
import { fixed, num, usdc, utc } from '@/lib/format';
import { type InventoryView, type PoolView, buyIxs, lotCost, salePrice } from '@/lib/backstop';
import { useBackstop } from '@/lib/hooks/backstop';
import { useClock } from '@/lib/hooks/chain';
import { useSend } from '@/lib/hooks/send';
import { IS_MAINNET, READ_ONLY_NOTE } from '@/lib/network';
import { ActionTile, units } from '../actions';
import { useSolana } from '../Providers';
import { Empty, H, KV, Note, PageHead, Pill, StatBlock } from '../ui';
import { ErrorNote, Loading } from './shared';

const pctw = (w: bigint) => `${(Number(w) / 1e16).toFixed(0)}%`;
const px = (w: bigint) => num(Number(w / 10n ** 10n) / 1e8, 4);
const tok = (raw: bigint) => fixed(raw, 8, 4);

export function BackstopView() {
  const b = useBackstop();
  const { now } = useClock();
  if (IS_MAINNET) return <><PageHead title="Auctions" sub="Monday Backstop." /><Note icon="lock">{READ_ONLY_NOTE}</Note></>;
  if (b.isLoading) return <Loading />;
  if (b.error) return <ErrorNote error={b.error} />;
  const head = <PageHead title="Auctions" sub="Monday Backstop: what still liquidates at the move, Credence's vault liquidates itself at Kamino's bonus, holds as inventory and resells in a Dutch auction." right={<Pill tone="soft">fork</Pill>} />;
  if (!b.data) return <>{head}<Empty icon="gavel" title="No backstop on this fork">Load the program data (scripts/demo-app.sh) to initialise the pool.</Empty></>;
  const { pool, inventories } = b.data;
  return (
    <>
      {head}
      <div className="cx-split">
        <div>
          <section>
            <H>The pool</H>
            <div className="cx-grid2" data-testid="backstop-pool">
              <StatBlock label="Spent on liquidations" value={usdc(pool.spent, 2)} chip="USDC" testId="backstop-spent" />
              <StatBlock label="Sale proceeds" value={usdc(pool.salesProceeds, 2)} chip="USDC" testId="backstop-proceeds" />
              <StatBlock label="Realised P&L (to equity)" value={`${pool.realizedPnl < 0n ? '−' : ''}${usdc(pool.realizedPnl < 0n ? -pool.realizedPnl : pool.realizedPnl, 2)}`} chip="USDC" testId="backstop-pnl" />
              <StatBlock label="Liquidations / fills" value={`${pool.liquidations} / ${pool.fills}`} testId="backstop-counts" />
            </div>
            <KV rows={[
              ['Budget', `open inventory at cost ≤ ${pctw(pool.maxShareWad)} of equity, and never the cash kept for live cover groups and queues (INV-13)`],
              ['Paid for (INV-8)', `units received ≤ USDC spent at Scope − ${pctw(pool.maxDiscountWad)}; every cToken redeemed`],
              ['NAV mark', `Scope − ${pctw(pool.haircutWad)} for redemptions; deposits price inventory at Scope (A-36)`],
              ['Auction', `Scope + ${pctw(pool.salePremiumWad)} → Scope − ${pctw(pool.saleDiscountWad)} over ${(pool.saleSecs / 3600).toFixed(1)} h, never below today's floor`],
            ]} />
          </section>
          <section>
            <H>Inventory and sales</H>
            {inventories.every((i) => i.qty === 0n && i.bought === 0n)
              ? <Empty icon="gavel" title="Nothing liquidated yet">Run the twin weekend in Demo: the backstop liquidates position B at Monday 08:00 ET.</Empty>
              : inventories.filter((i) => i.qty > 0n || i.bought > 0n).map((i) => <Lot key={i.ticker} inv={i} pool={pool} now={now ?? Math.floor(Date.now() / 1000)} />)}
          </section>
        </div>
        <aside className="cx-aside">
          <Note icon="shield">A sale is its own transaction and never touches klend or Jupiter. The issuer&apos;s pause or a transfer hook stops it (Token-2022 checks); the issuer&apos;s permanent delegate could claw inventory back (disclosed risk).</Note>
        </aside>
      </div>
    </>
  );
}

function Lot({ inv, pool, now }: { inv: InventoryView; pool: PoolView; now: number }) {
  const { signer, prog } = useSolana();
  const buy = useSend();
  const price = inv.saleActive ? salePrice(inv, pool, now) : null;
  const ends = inv.saleStartedAt + inv.saleSecs;
  return (
    <div data-testid={`lot-${inv.ticker}`} style={{ marginBottom: 18 }}>
      <h3 className="cx-h3">{inv.ticker} {inv.saleActive ? <Pill tone="good" testId={`lot-${inv.ticker}-onsale`}>on sale</Pill> : <Pill tone="soft">held</Pill>}</h3>
      <KV rows={[
        ['Held', <span key="h" data-testid={`lot-${inv.ticker}-held`}>{tok(inv.qty)} {inv.ticker}</span>],
        ['Cost basis', `${usdc(inv.cost)} USDC`],
        ['Value at Scope / NAV mark', `${usdc(inv.value)} / ${usdc(inv.mark)} USDC (marked ${inv.markedAt ? utc(inv.markedAt) : '—'})`],
        ['Bought / sold to date', `${tok(inv.bought)} / ${tok(inv.sold)} ${inv.ticker}`],
        ...(inv.saleActive && price !== null ? [
          ['Price now (per token)', <span key="p" data-testid={`lot-${inv.ticker}-price`}>{px(price)}</span>] as [string, ReactNode],
          ['Start → floor', `${px(inv.startPriceWad)} → ${px(inv.floorPriceWad)}, floor from ${utc(ends)}`] as [string, ReactNode],
          ['Lot left', `${tok(inv.lotLeft)} ${inv.ticker}`] as [string, ReactNode],
        ] : []),
      ]} />
      {inv.saleActive && price !== null && (
        <ActionTile spec={{
          icon: 'cash', title: `Buy ${inv.ticker}`, testId: `buy-${inv.ticker}`, sub: `at ${px(price)} per token now`, amount: `${tok(inv.lotLeft)} left`,
          dialog: {
            title: `Buy ${inv.ticker} from the backstop`,
            description: 'You pay USDC at the auction price when your transaction lands, at most the price shown (it only falls during the decay), and receive the tokens in your Token-2022 account.',
            fields: [{ key: 'qty', unit: inv.ticker, label: 'Amount', initial: fixed(inv.lotLeft / 2n, 8, 8) }],
            preview: (v) => { try { const q = units(v.qty, 8, 'an amount'); return [['You pay about', `${usdc(lotCost(q, price))} USDC`]]; } catch { return []; } },
            confirm: 'Buy', state: buy, blocked: !signer ? 'Connect a wallet first.' : null,
            send: async (v) => {
              const q = units(v.qty, 8, `an ${inv.ticker} amount`);
              return !!(await buy.run('Buying', [{ label: 'buy_from_sale', ixs: () => buyIxs(prog, signer!.publicKey, inv, q, price) }]));
            },
          },
        }} />
      )}
    </div>
  );
}
