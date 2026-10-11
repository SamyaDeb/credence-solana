'use client';
// One market enlarged in the middle of the page (a modal dialog): the card grown into a hero with every figure the
// Markets page has for it. Arrow keys or the chevrons step through the shown markets.
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { type EpochView, currentEpoch } from '@/lib/cover';
import { SOURCE_NAME } from '@/lib/credence';
import { et, num, pct, short, usd, usdc, utc } from '@/lib/format';
import type { Market } from '@/lib/hooks/markets';
import type { MarketState } from '@/lib/markets';
import { Icon } from '../Icon';
import { Bar, CardMark } from '../ui';
import { StatePill } from './shared';

export type QuoteCell =
  | { kind: 'loading' } | { kind: 'closed' } | { kind: 'error'; error: string }
  | { kind: 'quote'; premium: bigint; per1k: bigint; closureId: number; cu: number };

/** Token art: the xStocks are Backed's official artwork (each mint's Token-2022 metadata image,
 * xstocks-metadata.backed.fi), PYUSD is Paxos's (its metadata image). A Jupiter alias (`TSLAx.J`) uses its xStock's mark. */
const LOGOS: Record<string, string> = {
  SPYx: '/tokens/spyx.png', QQQx: '/tokens/qqqx.png', NVDAx: '/tokens/nvdax.png', TSLAx: '/tokens/tslax.png',
  GOOGLx: '/tokens/googlx.png', AAPLx: '/tokens/aaplx.png', MSTRx: '/tokens/mstrx.png', HOODx: '/tokens/hoodx.png',
  USDC: '/tokens/usdc.svg', PYUSD: '/tokens/pyusd.png',
};
export const logoOf = (ticker: string) => LOGOS[ticker.replace(/\.J$/, '')] ?? null;

const NAME: Record<string, string> = {
  SPYx: 'SP500 xStock', QQQx: 'Nasdaq xStock', NVDAx: 'NVIDIA xStock', TSLAx: 'Tesla xStock', GOOGLx: 'Alphabet xStock',
  AAPLx: 'Apple xStock', MSTRx: 'MicroStrategy xStock', HOODx: 'Robinhood xStock',
};

function Group({ title, rows, children }: { title: string; rows: [string, React.ReactNode][]; children?: React.ReactNode }) {
  return (
    <section className="cx-spot-group">
      <h3>{title}</h3>
      <dl className="cx-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {children}
    </section>
  );
}

export function MarketSpotlight({ markets, index, onIndex, onClose, quoteOf, state, epochs, now }: {
  markets: Market[]; index: number | null; onIndex: (i: number) => void; onClose: () => void; quoteOf: (m: Market) => QuoteCell;
  state: MarketState | null; epochs: EpochView[]; now: number | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const m = index === null ? undefined : markets[index];

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (m && !d.open) d.showModal();
    if (!m && d.open) d.close();
  }, [m]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') onIndex((index + 1) % markets.length);
      if (e.key === 'ArrowLeft') onIndex((index - 1 + markets.length) % markets.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, markets.length, onIndex]);

  const q = m ? quoteOf(m) : null;
  const f = m?.figures;
  const e = m && now !== null ? currentEpoch(epochs, m.asset.ticker, now) : undefined;

  return (
    <dialog ref={ref} className="cx-dialog cx-spotlight" aria-label={m ? `${m.asset.ticker} market` : 'Market'} onClose={onClose}
      onClick={(ev) => ev.target === ref.current && ref.current?.close()}>
      {m && (
        <div className="cx-spot" key={m.asset.ticker} data-testid="spotlight">
          <div className="cx-spot-hero">
            <div className="cx-card-top">
              <CardMark logo={logoOf(m.asset.ticker)} />
              <div className="cx-spot-tools">
                <button type="button" className="cx-icon-btn" aria-label="Previous market" onClick={() => onIndex((index! - 1 + markets.length) % markets.length)}><Icon name="chevron" size={18} strokeWidth={2} className="cx-rot-left" /></button>
                <button type="button" className="cx-icon-btn" aria-label="Next market" onClick={() => onIndex((index! + 1) % markets.length)}><Icon name="chevron" size={18} strokeWidth={2} className="cx-rot-right" /></button>
                <button type="button" className="cx-icon-btn" aria-label="Close" onClick={() => ref.current?.close()}><Icon name="close" size={18} strokeWidth={2} /></button>
              </div>
            </div>
            <div className="cx-spot-title"><span className="cx-spot-ticker">{m.asset.ticker}</span><span className="cx-spot-name">{NAME[m.asset.ticker.replace(/\.J$/, '')] ?? ''}</span></div>
            <div className="cx-spot-price">{m.scopePrice !== null ? usd(m.scopePrice, 4) : 'No price on the fork'}</div>
            <div className="cx-card-foot">
              <div>
                <div className="cx-card-label">Gap cover, per $1,000 of debt</div>
                <div className="cx-card-value">{q?.kind === 'quote' ? `${usdc(q.per1k)} USDC` : q?.kind === 'closed' ? 'Sales closed for this weekend' : q?.kind === 'error' ? 'Quote failed' : 'Quoting…'}</div>
              </div>
              {state && <StatePill s={state.state} />}
            </div>
          </div>
          <div className="cx-spot-grid">
            <Group title="Kamino reserve" rows={[
              ['Deposited', f ? `${num(f.supplyTokens, 2)} ${m.asset.ticker}` : '—'],
              ['Deposit cap', f ? `${num(f.depositLimitTokens, 0)} ${m.asset.ticker}` : '—'],
              ['Max LTV', f ? `${f.maxLtvPct}%` : '—'],
              ['Liquidation threshold', f ? `${f.ltPct}%` : '—'],
            ]}>
              {f && f.depositLimitTokens > 0 && <div className="cx-spot-use"><Bar value={f.supplyTokens / f.depositLimitTokens} /></div>}
            </Group>
            <Group title="Weekend risk" rows={[
              ['σ for the weekend', pct(m.sigma, 2)],
              ['1% worst modelled gap', m.tail99 !== null ? pct(m.tail99, 2) : '—'],
              ['Scenarios', m.scenarios ? num(m.scenarios, 0) : '—'],
              ['Reference premium', q?.kind === 'quote' ? `${usdc(q.premium)} USDC on $50,000` : '—'],
            ]} />
            <Group title="Market clock" rows={[
              ['Now', state ? <StatePill key="s" s={state.state} /> : '—'],
              ['Cover on sale', e ? 'yes' : 'no'],
              ['Bell', e ? et(e.bell) : '—'],
              ['Monday open', e ? et(e.open) : '—'],
            ]} />
            <Group title="On-chain" rows={[
              ['Mint (Token-2022)', <span key="m" className="cx-mono" title={m.asset.mint.toBase58()}>{short(m.asset.mint, 6)}</span>],
              ['Kamino reserve', <span key="r" className="cx-mono" title={m.reserve.toBase58()}>{short(m.reserve, 6)}</span>],
              ['Settles on', `${SOURCE_NAME[m.asset.settleSource]} (chain ${m.asset.scopeChain})`],
              ['Scope refreshed', m.scopeRefreshedAt ? utc(m.scopeRefreshedAt) : '—'],
            ]} />
          </div>
          <div className="cx-spot-cta">
            <Link href="/app/borrow" className="cx-btn">Cover your {m.asset.ticker} loan</Link>
            <Link href="/app/risk" className="cx-btn is-ghost">Gap Oracle</Link>
          </div>
        </div>
      )}
    </dialog>
  );
}
