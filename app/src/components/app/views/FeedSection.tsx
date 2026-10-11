'use client';
// The Gap Oracle feed (C3): what the on-chain `GapFeed` says per asset: the Friday close, the 24/7 xStock price (Pyth),
// the lender's own price (Kamino's Scope, or Jupiter's cache for an alias) and whether it is still frozen, the implied
// gaps, and P(gap < −5 / −8 / −12%) from the asset's scenario set (risk-core, the code the program prices with). Anyone
// can crank a feed (`update_gap_feed`): "Crank" sends it from the connected wallet; the program derives or checks every
// input, so the wallet cannot supply a price. On mainnet there is no feed account: the same fields are computed off-chain
// from mainnet inputs by the program's own Rust, and labelled so.
import { wadPct } from '@credence/sdk';
import { useSolana } from '../Providers';
import { crankIx, useFeeds, type FeedRow } from '@/lib/hooks/feed';
import { useClock } from '@/lib/hooks/chain';
import { useSend } from '@/lib/hooks/send';
import { dur, et, wad, weekendOf } from '@/lib/format';
import { IS_MAINNET } from '@/lib/network';
import { Details, H, Note, Pill, Sim } from '../ui';
import { ErrorNote, Loading } from './shared';

const TYPE = ['', 'overnight', 'weekend', 'holiday weekend'];
const BLOCKING_TONE = (r: FeedRow) => (r.blocked ? 'bad' : r.flagNames.length ? 'warn' : 'good');
const gap = (g: bigint, ok: boolean) => (ok ? wadPct(g, 2) : '—');
const price = (p: bigint) => (p > 0n ? `$${wad(p, 4)}` : '—');
/** The feed's flag codes as people read them; the code stays in the tooltip. */
const FLAG_LABEL: Record<string, string> = {
  NO_CLOSE: 'no close yet', STALE_FAIR: '24/7 price old', LENDER_STALE: 'lender price old', LENDER_FROZEN: 'lender frozen',
};
const flagText = (names: string[]) => (names.length ? names.map((n) => FLAG_LABEL[n] ?? n.toLowerCase().replace(/_/g, ' ')).join(', ') : 'ok');

function Row({ r, now, onCrank, busy }: { r: FeedRow; now: number; onCrank?: (t: string) => void; busy: boolean }) {
  const hasClose = r.closePrice > 0n;
  const fairOk = hasClose && r.fairPrice > 0n;
  const lenderOk = hasClose && r.lenderPrice > 0n;
  const age = r.updates > 0 || r.lastUpdateTs > 0 ? now - r.lastUpdateTs : null;
  return (
    <tr data-testid={`feed-row-${r.ticker}`}>
      <td className="is-strong" data-label="Asset">{r.ticker}<div className="cx-fig-s">{TYPE[r.closureType]}{r.closureId ? ` of ${weekendOf(r.closureId)}` : ''}</div></td>
      <td data-label="Friday close">{price(r.closePrice)}{hasClose && <div className="cx-fig-s">{et(r.closeTs)}</div>}</td>
      <td data-label="24/7 price (Pyth)">{price(r.fairPrice)}{r.fairPublishTs > 0 && <div className="cx-fig-s">{dur(now - r.fairPublishTs)} old</div>}</td>
      <td data-label="Lender price">
        {price(r.lenderPrice)}
        <div className="cx-fig-s">{r.lender === 'jupiter' ? 'Jupiter cache' : 'Kamino Scope'}</div>
        {r.lenderFrozen && <Pill tone="warn" testId={`feed-frozen-${r.ticker}`}>frozen since the close</Pill>}
      </td>
      <td data-label="Implied gap" data-testid={`feed-gap-${r.ticker}`}>{gap(r.impliedGapFair, fairOk)}<div className="cx-fig-s">lender {gap(r.impliedGapLender, lenderOk)}</div></td>
      <td data-label="P(gap < −5 / −8 / −12%)" data-testid={`feed-p-${r.ticker}`}>{r.nScenarios ? `${wadPct(r.pLt5, 2)} · ${wadPct(r.pLt8, 2)} · ${wadPct(r.pLt12, 2)}` : '—'}<div className="cx-fig-s">σ {r.sigma > 0n ? wadPct(r.sigma, 2) : '—'}</div></td>
      <td data-label="Updated">{age === null ? 'never' : `${dur(age)} ago`}</td>
      <td data-label="Status" title={r.flagNames.join(', ') || undefined}><Pill tone={BLOCKING_TONE(r)} testId={`feed-flags-${r.ticker}`}>{flagText(r.flagNames)}</Pill></td>
      {onCrank && <td data-label=""><button className="cx-btn cx-btn-sm" data-testid={`feed-crank-${r.ticker}`} disabled={busy} onClick={() => onCrank(r.ticker)}>Crank</button></td>}
    </tr>
  );
}

export function FeedSection() {
  const feeds = useFeeds();
  const { now: chainNow } = useClock();
  const { prog, signer } = useSolana();
  const send = useSend();
  const d = feeds.data;
  const now = IS_MAINNET ? Math.floor(Date.now() / 1000) : chainNow ?? Math.floor(Date.now() / 1000);
  const crank = async (t: string) => {
    await send.run(`Crank ${t}`, [{ label: `update_gap_feed ${t}`, ixs: async () => [await crankIx(prog, t, chainNow ?? now)] }]);
    await feeds.refetch();
  };
  return (
    <section data-testid="feed">
      <H right={d?.source === 'offchain' ? <Pill tone="soft" testId="feed-offchain">computed off-chain</Pill> : <Sim title="credence_core is on the local mainnet fork only">fork only</Sim>}>On-chain gap feed</H>
      {feeds.error ? <ErrorNote error={feeds.error} what="the Gap Oracle feeds" /> : !d ? <Loading what="Reading the feeds" /> : (
        <>
          {d.source === 'offchain'
            ? <Note icon="info">Computed off-chain from mainnet data with the same Rust the program runs; the feed account is not on mainnet. {d.note}</Note>
            : <p className="cx-hint">What any lender or app can read on-chain: the weekend gap per stock and the chance it passes −5 / −8 / −12%. Anyone can crank a feed.</p>}
          <div className="cx-table-wrap">
            <table className="cx-table is-wrap">
              <thead><tr><th>Asset</th><th>Friday close</th><th>24/7 price</th><th>Lender price</th><th>Implied gap</th><th>P(gap &lt; −5 / −8 / −12%)</th><th>Updated</th><th>Status</th>{d.source === 'onchain' && <th />}</tr></thead>
              <tbody>{d.rows.map((r) => <Row key={r.key} r={r} now={now} busy={!!send.busy} onCrank={d.source === 'onchain' && signer ? crank : undefined} />)}</tbody>
            </table>
          </div>
          {d.source === 'onchain' && !signer && <p className="cx-hint">Connect a wallet to crank a feed.</p>}
          {send.busy && <p className="cx-hint">{send.busy}…</p>}
          {send.error && <Note icon="alert" tone="bad">{send.error}</Note>}
          {send.sent.length > 0 && !send.error && <p className="cx-hint" data-testid="feed-cranked">Cranked: {send.sent.map((s) => `${s.label} (${s.cu} CU)`).join(', ')}</p>}
          <Details summary="How the feed works">
            {d.source === 'offchain'
              ? <p>Inputs: Kamino&apos;s Scope, Pyth&apos;s push accounts and the captured Friday close.</p>
              : <p>Each row is an on-chain <code>GapFeed</code>: a permissionless crank (<code>update_gap_feed</code>) reads Pyth, the lender&apos;s price and the Friday close from accounts the program derives itself, so no caller can supply a price. A value is shown as — when its input is missing or flagged.</p>}
            <p>Probabilities are the share of the asset&apos;s weekend scenario set below each gap (σ from AssetConfig); the lender is flagged frozen while its price has not moved since the close.</p>
          </Details>
        </>
      )}
    </section>
  );
}
