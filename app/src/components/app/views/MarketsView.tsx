'use client';
// Markets: the xStocks Credence covers, as Kamino's xStocks Market holds them on the fork. Per asset: Kamino's Scope
// price, LT and max LTV, the reserve's supply and the market's USDC borrow rate and utilisation (klend), σ for the
// weekend and the modelled 1st-percentile gap (on-chain AssetConfig and scenario set), the premium of the reference
// position (the program's quote_cover, simulated), and the market's state from the on-chain XNYS calendar.
import Link from 'next/link';
import { useState } from 'react';
import { currentEpoch, salesState } from '@/lib/cover';
import { dur, et, num, pct, usd, usdc } from '@/lib/format';
import { useCalendar, useClock, useEpochs } from '@/lib/hooks/chain';
import { type Market, useMarkets, useRefQuotes } from '@/lib/hooks/markets';
import { REF_DEBT, REF_RATIO, marketState, nextWeekend } from '@/lib/markets';
import { IS_MAINNET, READ_ONLY_NOTE } from '@/lib/network';
import { Details, GradientCard, H, KV, Note, PageHead, StatBlock } from '../ui';
import { MarketSpotlight, logoOf, type QuoteCell } from './MarketSpotlight';
import { ChainTime, ErrorNote, Loading, StatePill } from './shared';

export function MarketsView({ q }: { q: string }) {
  const { markets, usdc: usdcRes, isLoading, error } = useMarkets();
  const { now } = useClock();
  const cal = useCalendar();
  const epochs = useEpochs();
  const quotes = useRefQuotes(markets.map((m) => m.asset), epochs.data, now);
  const [open, setOpen] = useState<number | null>(null);
  const query = q.trim().toLowerCase();
  const shown = query ? markets.filter((m) => m.asset.ticker.toLowerCase().includes(query) || m.asset.ticker.replace(/x$/, '').toLowerCase() === query) : markets;
  const st = cal.data && now !== null ? marketState(cal.data.sessions, now) : null;
  const wk = cal.data && now !== null ? nextWeekend(cal.data.sessions, now) : null;
  const quoteOf = (m: Market): QuoteCell => {
    const x = quotes.data?.[m.asset.ticker];
    if (IS_MAINNET) return { kind: 'closed' };
    if (quotes.isLoading || x === undefined) return { kind: 'loading' };
    if (x === null) return { kind: 'closed' };
    if ('error' in x) return { kind: 'error', error: x.error };
    return { kind: 'quote', premium: x.premium, per1k: (x.premium * 1_000_000_000n) / REF_DEBT, closureId: x.closureId, cu: x.cu };
  };

  return (
    <>
      <PageHead
        title="Markets"
        sub="The xStocks you can cover: Kamino's lending terms and this weekend's cover price."
        right={query ? <Link className="cx-chip" href="/app/markets">Clear “{q}” ×</Link> : undefined}
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small>{shown.length} of {markets.length}</small>}>Covered xStocks</H>
            {error && !markets.length ? <ErrorNote error={error} /> : isLoading && !markets.length ? <Loading what="Reading Kamino's reserves on the fork" /> : shown.length === 0 ? (
              <Note icon="search">No covered xStock matches “{q}”. Credence covers SPYx, QQQx, NVDAx, TSLAx, GOOGLx, AAPLx, MSTRx and HOODx.</Note>
            ) : (
              <div className="cx-cards">
                {shown.map((m, i) => {
                  const qc = quoteOf(m);
                  return (
                    <button key={m.asset.ticker} type="button" className="cx-card-btn" aria-label={`${m.asset.ticker} market details`} onClick={() => setOpen(i)} data-testid={`market-${m.asset.ticker}`}>
                      <GradientCard
                        logo={logoOf(m.asset.ticker)}
                        tag={m.asset.ticker}
                        big={<span data-testid="market-price">{m.scopePrice !== null ? usd(m.scopePrice, 2) : 'No price on the fork'}</span>}
                        label={`Max LTV ${m.figures ? `${m.figures.maxLtvPct}%` : '—'} · Liquidation ${m.figures ? `${m.figures.ltPct}%` : '—'}`}
                        value={qc.kind === 'quote' ? `Cover ${usdc(qc.per1k)} USDC per $1,000` : IS_MAINNET ? 'Cover: on the fork demo' : qc.kind === 'closed' ? 'Cover: sales closed' : qc.kind === 'error' ? 'Cover: quote failed' : 'Cover: quoting…'}
                        pill={st ? <StatePill s={st.state} /> : undefined}
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>
        <MarketSpotlight markets={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} quoteOf={quoteOf} state={st} epochs={epochs.data ?? []} now={now} />
        <aside className="cx-aside">
          <StatBlock label="USDC borrow rate" value={usdcRes ? pct(usdcRes.borrowApy, 2) : '—'} chip="APY" testId="usdc-apy" />
          <KV rows={[
            ['USDC supplied', usdcRes ? `${num(usdcRes.supplyTokens, 0)}` : '—'],
            ['USDC borrowed', usdcRes ? `${num(usdcRes.borrowedTokens, 0)}` : '—'],
            ['Utilisation', usdcRes ? pct(usdcRes.utilisation, 1) : '—'],
          ]} />
          <div>
            <H>Market clock</H>
            <KV rows={[
              ['Now', st ? <StatePill key="s" s={st.state} testId="market-state" /> : '—'],
              ['Chain time', <ChainTime key="t" now={now} />],
              ...(wk ? ([
                ['Friday bell', et(wk.friday.close - 15 * 60)],
                ['Friday close', et(wk.friday.close)],
                ['Monday open', et(wk.monday.open)],
                ['Bell in', now !== null && wk.friday.close - 900 > now ? dur(wk.friday.close - 900 - now) : 'passed'],
              ] as [string, string][]) : []),
            ]} />
          </div>
          {IS_MAINNET ? <Note icon="lock">{READ_ONLY_NOTE}</Note> : <SalesNote markets={markets} epochs={epochs.data ?? []} now={now} />}
          <Note icon="clock">Kamino&apos;s xStock price freezes at Friday&apos;s close and jumps in Monday pre-market.</Note>
        </aside>
      </div>
      {markets.length > 0 && (
            <section style={{ marginTop: 36 }}>
              <H>Lending on Kamino</H>
              <div className="cx-table-wrap">
                <table className="cx-table" data-testid="markets-table">
                  <thead><tr><th>Asset</th><th className="is-num">Scope price</th><th className="is-num">Max LTV / LT</th><th className="is-num">Deposited</th><th className="is-num">Deposit cap</th><th className="is-num">σ weekend</th><th className="is-num">1% worst gap</th><th className="is-num">Cover per $1,000</th></tr></thead>
                  <tbody>
                    {markets.map((m) => {
                      const qc = quoteOf(m);
                      return (
                        <tr key={m.asset.ticker} data-testid={`row-${m.asset.ticker}`}>
                          <td className="is-strong" data-label="Asset">{m.asset.ticker}</td>
                          <td className="is-num" data-label="Scope price">{m.scopePrice !== null ? usd(m.scopePrice, 4) : '—'}</td>
                          <td className="is-num" data-label="Max LTV / LT">{m.figures ? `${m.figures.maxLtvPct}% / ${m.figures.ltPct}%` : '—'}</td>
                          <td className="is-num" data-label="Deposited">{m.figures ? num(m.figures.supplyTokens, 2) : '—'}</td>
                          <td className="is-num" data-label="Deposit cap">{m.figures ? num(m.figures.depositLimitTokens, 0) : '—'}</td>
                          <td className="is-num" data-label="σ weekend">{pct(m.sigma, 2)}</td>
                          <td className="is-num" data-label="1% worst gap">{m.tail99 !== null ? pct(m.tail99, 2) : '—'}</td>
                          <td className="is-num" data-label="Cover per $1,000" data-testid="per1k">{qc.kind === 'quote' ? `${usdc(qc.per1k)} USDC` : IS_MAINNET ? 'fork demo' : qc.kind === 'closed' ? 'closed' : qc.kind === 'error' ? 'failed' : '…'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Details summary="How these are worked out">
                <p>Cover per $1,000 is the program&apos;s quote_cover (simulated) for a {usd(Number(REF_DEBT) / 1e6, 0)} USDC position at D/C′ {REF_RATIO}, cap = debt, divided by 50;
                the minimum premium (5 USDC) applies per policy. The 1% worst gap is the 1st percentile of the asset&apos;s on-chain weekend scenario set at its σ.
                Reserve figures are klend&apos;s, as of each reserve&apos;s last refresh; the USDC rate is klend&apos;s curve at the stored utilisation plus the host&apos;s fixed rate.</p>
              </Details>
            </section>
          )}
    </>
  );
}

function SalesNote({ markets, epochs, now }: { markets: Market[]; epochs: import('@/lib/cover').EpochView[]; now: number | null }) {
  if (now === null || !markets.length) return null;
  const e = markets.map((m) => currentEpoch(epochs, m.asset.ticker, now)).find(Boolean);
  if (!e) return <Note icon="lock" tone="warn">No weekend cover on sale right now.</Note>;
  const s = salesState(e, now);
  return <Note icon="shield" tone="good">This weekend&apos;s cover is on sale{s.until ? ` for ${dur(s.until - now)}` : ''}.</Note>;
}
