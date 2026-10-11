'use client';
// Risk: the Gap Oracle and the vault's capacity. Per asset: the Friday close stored in the epoch on the fork (real once
// the captured close matches it, else labelled simulated), Kamino's current Scope price on mainnet and when its value
// last changed, the 24/7 xStock price (Pyth `Crypto.<T>X/USD` push account), the implied gap Kamino does not see yet,
// and σ. Live values are genuine mainnet readings by the recorder (every 10 s). Then S7 (when Kamino's price moves
// around a weekend) and the capacity and concentration limits the program checks at every purchase.
import { useMemo } from 'react';
import { type Asset, type EpochView } from '@/lib/cover';
import { EPOCH, EPOCH_NAME, SOURCE_NAME } from '@/lib/credence';
import { dur, et, fixed, pct, usdc, utc, wad } from '@/lib/format';
import { useAssets, useClock, useConfig, useEpochs } from '@/lib/hooks/chain';
import { type OracleData, useOracle } from '@/lib/hooks/data';
import { useVault } from '@/lib/hooks/vault';
import { concentrationLimit, freeEquity } from '@/lib/vault';
import { Bar, H, KV, Note, PageHead, Pill, Sim, StatBlock } from '../ui';
import { IS_MAINNET } from '@/lib/network';
import { FeedSection } from './FeedSection';
import { RiskScan } from './RiskScan';
import { ErrorNote, Loading } from './shared';

/** The most recent Friday 16:00 New York before `nowMs` (wall clock: the recorder's readings are real time). */
function lastFridayClose(nowMs: number) {
  for (let i = 0; i < 8; i++) {
    const x = new Date(nowMs - i * 86_400_000);
    const ny = new Date(x.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (ny.getDay() === 5) {
      const close = new Date(ny.getFullYear(), ny.getMonth(), ny.getDate(), 16, 0, 0).getTime() + (x.getTime() - ny.getTime());
      if (close <= nowMs) return close / 1000;
    }
  }
  return 0;
}

function OracleCard({ a, asset, epochs, closes, now, lastClose }: { a: OracleData['assets'][number]; asset?: Asset; epochs: EpochView[]; closes: OracleData['closes']; now: number; lastClose: number }) {
  // The epoch with the latest stored close, else the next one to close.
  const withClose = [...epochs].filter((e) => e.closePriceWad > 0n).sort((x, y) => y.closureId - x.closureId)[0];
  const next = epochs.filter((e) => e.state === EPOCH.OPEN).sort((x, y) => x.closureId - y.closureId)[0];
  const ep = withClose ?? next;
  const real = ep && closes.find((c) => c.group === ep.closureId)?.results.find((r) => r.ticker === a.sym);
  const isReal = !!(ep && real && BigInt(real.closePriceWad) === ep.closePriceWad);
  const sigma = asset ? Number(asset.sigmaWad) / 1e18 : null;
  const { scope, push } = a;
  const frozenSince = scope ? (scope.lastChange ? scope.lastChange.ts : Date.parse(scope.since) / 1000) : null;
  const frozen = !!scope && frozenSince !== null && frozenSince <= lastClose + 900 && now > lastClose;
  const gap = scope && push ? push.price / scope.price - 1 : null;
  const z = gap !== null && sigma ? gap / sigma : null;
  return (
    <div className="cx-oracle" data-testid={`oracle-${a.sym}`}>
      <div className="cx-oracle-head">
        <b>{a.sym}</b>
        {asset && <Pill tone="soft">{SOURCE_NAME[asset.settleSource]} settlement</Pill>}
      </div>
      <div>
        <div className="cx-fig-k">Friday close {ep ? `(weekend ${ep.closureId}, ${EPOCH_NAME[ep.state]})` : ''}</div>
        {ep && ep.closePriceWad > 0n ? (
          <>
            <div className="cx-fig-v">${wad(ep.closePriceWad, 4)}</div>
            <div className="cx-fig-s">{et(ep.close)} · per raw token, multiplier applied</div>
            {isReal ? <Pill tone="good" testId="close-real">real: Kamino Scope at the bell ({utc(real!.scopeRefreshedAt)})</Pill>
              : <Sim title="Kamino's real Scope price cloned at fork start, with its refresh time moved to the bell">simulated close on the fork</Sim>}
          </>
        ) : ep ? <><div className="cx-fig-v cx-muted">not yet</div><div className="cx-fig-s">stored at the close, {et(ep.close)}</div></> : <><div className="cx-fig-v">—</div>{IS_MAINNET && <div className="cx-fig-s">stored on-chain at 4 PM ET by the keeper once the program runs on mainnet; on the fork demo today</div>}</>}
      </div>
      <div>
        <div className="cx-fig-k">Kamino&apos;s price now (Scope, mainnet)</div>
        <div className="cx-fig-v" data-testid="scope-price">{scope ? `$${scope.price.toFixed(4)}` : '—'}</div>
        {scope && <div className="cx-fig-s">refreshed {utc(scope.refreshedAt)}{IS_MAINNET ? ' · read live from mainnet' : ` · ${scope.lastChange ? `value last changed ${utc(Date.parse(scope.lastChange.at) / 1000)}` : `unchanged in all ${scope.readings} readings since ${utc(Date.parse(scope.since) / 1000)}`}`}</div>}
        {frozen && <Pill tone="warn">frozen since Friday&apos;s close: {dur(now - lastClose)}</Pill>}
        {!frozen && a.sym === 'QQQx' && <p className="cx-hint">QQQx&apos;s Scope chain follows a 24/7 source and moves after hours (S7).</p>}
      </div>
      <div>
        <div className="cx-fig-k">24/7 xStock price (Pyth Crypto.{a.sym.toUpperCase()}/USD push)</div>
        <div className="cx-fig-v">{push ? `$${push.price.toFixed(4)}` : '—'}</div>
        {push && <div className="cx-fig-s">published {utc(push.publishTime)} ({dur(now - push.publishTime)} ago) · ±{push.conf.toFixed(4)}</div>}
      </div>
      <div className="cx-figs">
        <div><div className="cx-fig-k">Implied gap</div><div className={`cx-fig-v ${gap !== null && gap < 0 ? 'cx-bad' : 'cx-good'}`} data-testid="implied-gap">{gap === null ? '—' : pct(gap, 2)}</div><div className="cx-fig-s">24/7 price vs Kamino&apos;s</div></div>
        <div><div className="cx-fig-k">σ for the weekend</div><div className="cx-fig-v">{sigma ? pct(sigma, 2) : '—'}</div><div className="cx-fig-s">{z !== null ? `gap = ${z.toFixed(2)} σ` : 'AssetConfig.sigma_wad'}</div></div>
      </div>
    </div>
  );
}

function S7({ rows, source }: { rows: NonNullable<OracleData['s7']>['rows']; source: string }) {
  const weekends = [...new Set(rows.map((r) => r.weekend))];
  const syms = ['SPYx', 'NVDAx', 'QQQx'];
  const cell = (r?: (typeof rows)[number]) => {
    if (!r) return '—';
    if (r.movedOverWeekend) return <span className="cx-warn">moves all weekend ({r.weekendMoves} hourly changes)</span>;
    if (!r.firstMove) return <span className="cx-muted">flat through Monday (holiday)</span>;
    const h = r.firstMoveVsOpenHours ?? 0;
    const at = utc(Date.parse(r.firstMove) / 1000).slice(5, 16);
    return <span>{h <= 0 ? <b className="cx-warn">first move {at} UTC, {Math.abs(h)} h before the open</b> : `flat until ${at} UTC (after the open)`}{r.preMarketMove ? ` · ${pct(r.preMarketMove, 2)} by the open` : ''}</span>;
  };
  return (
    <section data-testid="s7">
      <H right={<small>hourly, {source}</small>}>When does Kamino&apos;s price move? (S7)</H>
      <div className="cx-table-wrap">
        <table className="cx-table is-wrap">
          <thead><tr><th>Weekend (Friday)</th>{syms.map((s) => <th key={s}>{s}</th>)}</tr></thead>
          <tbody>{weekends.map((w) => <tr key={w}><td className="is-strong" data-label="Weekend">{w}</td>{syms.map((s) => <td key={s} data-label={s}>{cell(rows.find((r) => r.weekend === w && r.sym === s))}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p className="cx-hint">SPYx and NVDAx are frozen from the Friday close to Monday morning; the gap reaches Kamino in pre-market, up to 1.5 h before the 9:30 ET open, so a position can be liquidated before Phase 1 settles. Phase 1 pays the gap into the position after the open; the Liquidation Shield acts before Kamino&apos;s first post-closure update.</p>
    </section>
  );
}

export function RiskView() {
  const oracle = useOracle();
  const assets = useAssets();
  const epochs = useEpochs();
  const vault = useVault();
  const cfg = useConfig();
  const { now: chainNow } = useClock();
  const wallNow = Date.now() / 1000;
  const lastClose = useMemo(() => lastFridayClose(Date.now()), []);
  const d = oracle.data;
  const v = vault.data;
  const free = v ? freeEquity(v.view.equity, v.view.queuedWithdrawShares, v.supply) : null;
  const assetLimit = free !== null && cfg.data ? concentrationLimit(free, cfg.data.uMaxWad, cfg.data.maxAssetShareWad) : null;
  const liveEpochs = (epochs.data ?? []).filter((e) => v?.view.live.includes(e.closureId));
  const nextGroup = (epochs.data ?? []).filter((e) => e.state === EPOCH.OPEN && chainNow !== null && chainNow < e.bell).map((e) => e.closureId).sort((a, b) => a - b)[0];
  const shown = liveEpochs.length ? liveEpochs : (epochs.data ?? []).filter((e) => e.closureId === nextGroup);

  return (
    <>
      <PageHead title="Risk" sub="The Gap Oracle: tokenized stocks trade all weekend; the price Kamino lends against does not. Kamino's own price and how long it has been frozen, the 24/7 xStock price, and the gap Kamino does not see yet." />
      <div style={{ marginBottom: 36 }}><FeedSection /></div>
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={d ? <small>last mainnet reading {d.recorder.lastEvent ? `${utc(Date.parse(d.recorder.lastEvent) / 1000)} (${dur(wallNow - Date.parse(d.recorder.lastEvent) / 1000)} ago)` : 'none'}</small> : undefined}>Gap Oracle</H>
            {oracle.error ? <ErrorNote error={oracle.error} what="the recorder's files" /> : !d ? <Loading what="Reading the recorder" /> : (
              <div className="cx-oracles">
                {d.assets.map((a) => <OracleCard key={a.sym} a={a} asset={assets.data?.find((x) => x.ticker === a.sym)} epochs={(epochs.data ?? []).filter((e) => e.ticker === a.sym)} closes={d.closes} now={wallNow} lastClose={lastClose} />)}
              </div>
            )}
          </section>
          <RiskScan />
          {!IS_MAINNET && <section data-testid="capacity">
            <H right={<small>checked by buy_cover at every purchase</small>}>Vault capacity and concentration</H>
            {v && (
              <>
                <KV rows={[
                  ['Reserved worst loss (INV-2)', `${usdc(v.view.reservedTotal)} of ${usdc(v.figures.capacityLimit)} USDC`],
                  ['Equity net of queued withdrawals', free !== null ? `${usdc(free)} USDC` : '—'],
                  ['Per-asset limit', assetLimit !== null && cfg.data ? `${usdc(assetLimit)} USDC (${fixed(cfg.data.maxAssetShareWad * 100n, 18, 0)}% of u_max × equity)` : '—'],
                ]} />
                <div style={{ margin: '14px 0 22px' }}><Bar value={v.figures.utilisationPpm / 1_000_000} /></div>
                <div className="cx-conc">
                  {shown.map((e) => {
                    const used = assetLimit && assetLimit > 0n ? Number(e.worstLossSum) / Number(assetLimit) : 0;
                    return (
                      <div key={e.key.toBase58()}>
                        <div className="cx-conc-row"><b>{e.ticker}</b><span>weekend {e.closureId} · {e.policyCount} policies · worst covered loss {usdc(e.worstLossSum)} USDC</span><span>{pct(used, 1)}</span></div>
                        <Bar value={used} />
                      </div>
                    );
                  })}
                </div>
                <p className="cx-hint">Each asset&apos;s worst covered loss (the sum of its policies&apos; worst scenario losses this weekend) must stay within max_asset_share × u_max × equity net of queued withdrawals, so one stock cannot use the whole vault.</p>
              </>
            )}
          </section>}
        </div>
        <aside className="cx-aside">
          <StatBlock label={IS_MAINNET ? 'Read from mainnet' : 'Recorder'} value={d?.recorder.lastEvent ? dur(wallNow - Date.parse(d.recorder.lastEvent) / 1000) : '—'} chip="ago" />
          <KV rows={IS_MAINNET ? [['Source', 'Solana mainnet, every 10 s'], ['Accounts', 'Kamino Scope, Pyth push']] : [['Source', 'mainnet, every 10 s'], ['Files', 'data/live/events-*.jsonl, data/live/pyth/'], ['Captured closes', d ? String(d.closes.length) : '—']]} />
          <Note icon="clock">Kamino prices xStocks with Scope (Chainlink Data Streams + Pyth); Chainlink&apos;s 24/5 streams publish nothing at weekends, so SPYx and NVDAx freeze from Friday&apos;s close until Monday pre-market.</Note>
          {!IS_MAINNET && <Note icon="alert">The Friday close shown from the fork&apos;s epoch is labelled simulated unless it equals the real captured close (data/live/close-scope-*.json).</Note>}
        </aside>
      </div>
      {d?.s7 && <div style={{ marginTop: 36 }}><S7 rows={d.s7.rows} source={d.s7.source} /></div>}
    </>
  );
}
