'use client';
// Gap Oracle (task 4.4). Per asset: the Friday close stored in the epoch account on the fork (real once the Oct 9
// capture lands and matches, else labelled simulated), Kamino's current Scope price on mainnet and when its value
// last changed, the 24/7 xStock price (Pyth `Crypto.<T>X/USD` push account), the implied gap Kamino does not see yet,
// σ for the weekend from the AssetConfig, and the S7 table (when Kamino's price moves around a weekend).
import { useEffect, useMemo, useState } from 'react';
import { type Asset, type EpochView, loadAssets, loadEpochs } from '@/lib/cover';
import { EPOCH, EPOCH_NAME } from '@/lib/credence';
import { dur, et, pct, utc, wad } from '@/lib/format';
import { useApp } from './providers';

type OracleData = {
  recorder: { lastEvent: string | null };
  assets: { sym: string; scope: { price: number; refreshedAt: number; readAt: string; readings: number; since: string; lastChange: { price: number; at: string; ts: number } | null } | null;
    push: { price: number; conf: number; publishTime: number; file: string; recorded: number } | null }[];
  closes: { file: string; group: number; results: { ticker: string; closePriceWad: string; scopeRefreshedAt: number; closeTime: number }[] }[];
  s7: { source: string; rows: { weekend: string; sym: string; firstMove: string | null; firstMoveVsOpenHours: number | null; movedOverWeekend: boolean; preMarketMove: number; weekendMoves: number }[] } | null;
};

const LAST_CLOSE = () => {
  // Most recent Friday 16:00 New York before now (display only; epochs carry the exact times).
  const d = new Date();
  for (let i = 0; i < 8; i++) {
    const x = new Date(d.getTime() - i * 86_400_000);
    const ny = new Date(x.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (ny.getDay() === 5) {
      const offset = x.getTime() - ny.getTime();
      const close = new Date(ny.getFullYear(), ny.getMonth(), ny.getDate(), 16, 0, 0).getTime() + offset;
      if (close <= d.getTime()) return close / 1000;
    }
  }
  return 0;
};

export function Oracle() {
  const { prog, version } = useApp();
  const [d, setD] = useState<OracleData | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [epochs, setEpochs] = useState<EpochView[]>([]);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now() / 1000);

  useEffect(() => {
    let live = true;
    const read = () => fetch('/api/data/oracle').then((r) => r.json()).then((j) => live && (j.error ? setErr(j.error) : setD(j))).catch((e) => setErr(String(e)));
    void read();
    const t = setInterval(read, 10_000);
    const c = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => { live = false; clearInterval(t); clearInterval(c); };
  }, []);
  useEffect(() => { Promise.all([loadAssets(prog), loadEpochs(prog)]).then(([a, e]) => { setAssets(a); setEpochs(e); }).catch((e) => setErr(String(e))); }, [prog, version]);

  const lastClose = useMemo(LAST_CLOSE, []);

  return (
    <div className="stack">
      <div>
        <h1>Gap Oracle</h1>
        <p className="lede">Tokenized stocks trade all weekend; the price Kamino lends against does not. Here: the Friday close each
          epoch settles from, Kamino&apos;s own price and how long it has been frozen, the 24/7 xStock price, and the gap Kamino
          does not see yet. Live values are genuine mainnet readings from the recorder (every 10 s).</p>
      </div>
      {err && <div className="panel err">{err}</div>}
      {d && (
        <div className="note">Recorder: last mainnet reading {d.recorder.lastEvent ? `${utc(Date.parse(d.recorder.lastEvent) / 1000)} (${dur(now - Date.parse(d.recorder.lastEvent) / 1000)} ago)` : 'none'} · source data/live/events-*.jsonl and data/live/pyth/</div>
      )}
      <div className="grid g3">
        {(d?.assets ?? []).map((a) => {
          const asset = assets.find((x) => x.ticker === a.sym);
          return <AssetCard key={a.sym} a={a} asset={asset} epochs={epochs.filter((e) => e.ticker === a.sym)} closes={d!.closes} now={now} lastClose={lastClose} />;
        })}
      </div>
      {d?.s7 && <S7 rows={d.s7.rows} source={d.s7.source} />}
    </div>
  );
}

function AssetCard({ a, asset, epochs, closes, now, lastClose }: { a: OracleData['assets'][number]; asset?: Asset; epochs: EpochView[]; closes: OracleData['closes']; now: number; lastClose: number }) {
  // The epoch whose Friday close is the latest stored one, else the next one to close.
  const withClose = [...epochs].filter((e) => e.closePriceWad > 0n).sort((x, y) => y.closureId - x.closureId)[0];
  const next = epochs.filter((e) => e.state === EPOCH.OPEN).sort((x, y) => x.closureId - y.closureId)[0];
  const ep = withClose ?? next;
  const real = ep && closes.find((c) => c.group === ep.closureId)?.results.find((r) => r.ticker === a.sym);
  const isReal = !!(ep && real && BigInt(real.closePriceWad) === ep.closePriceWad);
  const sigma = asset ? Number(asset.sigmaWad) / 1e18 : null;
  const scope = a.scope;
  const push = a.push;
  const frozenSince = scope ? (scope.lastChange ? scope.lastChange.ts : Date.parse(scope.since) / 1000) : null;
  const frozen = scope && frozenSince !== null && frozenSince <= lastClose + 900 && now > lastClose;
  const gap = scope && push ? push.price / scope.price - 1 : null;
  const z = gap !== null && sigma ? gap / sigma : null;
  return (
    <div className="panel" data-testid={`oracle-${a.sym}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{a.sym}</h2>
        {asset && <span className="pill">{['EQUITY', 'XSTOCK', 'SCOPE'][asset.settleSource]} settlement</span>}</div>
      <div className="stack" style={{ gap: 14, marginTop: 12 }}>
        <div className="stat">
          <div className="k">Friday close {ep ? `(epoch ${ep.closureId}, ${EPOCH_NAME[ep.state]})` : ''}</div>
          {ep && ep.closePriceWad > 0n ? (
            <>
              <div className="v">${wad(ep.closePriceWad, 4)}</div>
              <div className="s">{et(ep.close)} · per raw token, multiplier applied (WAD)</div>
              {isReal ? <span className="pill ok">real: Kamino Scope at the bell ({real!.scopeRefreshedAt ? utc(real!.scopeRefreshedAt) : ''})</span>
                : <span className="sim">simulated: Kamino&apos;s real Scope price cloned at fork start, refresh time moved to the bell (the real Oct 9 close is captured at 20:00 UTC Fri)</span>}
            </>
          ) : ep ? (
            <><div className="v muted">not yet</div><div className="s">stored at the bell, {et(ep.close)}; {ep.close > now ? `in ${dur(ep.close - now)}` : ''}</div></>
          ) : <div className="v muted">—</div>}
        </div>
        <div className="stat">
          <div className="k">Kamino&apos;s price now (Scope, mainnet)</div>
          <div className="v">{scope ? `$${scope.price.toFixed(4)}` : '—'}</div>
          {scope && <div className="s">refreshed {utc(scope.refreshedAt)} · value {scope.lastChange ? `last changed ${utc(Date.parse(scope.lastChange.at) / 1000)}` : `unchanged in all ${scope.readings} readings since ${utc(Date.parse(scope.since) / 1000)}`}</div>}
          {frozen && <span className="pill warn">frozen since Friday close: {dur(now - lastClose)}</span>}
          {!frozen && a.sym === 'QQQx' && <div className="note">QQQx&apos;s Scope chain follows a 24/7 source and moves after hours (S7).</div>}
        </div>
        <div className="stat">
          <div className="k">24/7 xStock price (Pyth Crypto.{a.sym.toUpperCase()}/USD push)</div>
          <div className="v">{push ? `$${push.price.toFixed(4)}` : '—'}</div>
          {push && <div className="s">published {utc(push.publishTime)} ({dur(now - push.publishTime)} ago) · ±{push.conf.toFixed(4)}</div>}
        </div>
        <div className="grid g2">
          <div className="stat"><div className="k">Implied gap</div><div className={`v ${gap !== null && gap < 0 ? 'bad' : 'accent'}`}>{gap === null ? '—' : pct(gap, 2)}</div><div className="s">24/7 price vs Kamino&apos;s price</div></div>
          <div className="stat"><div className="k">σ for the weekend</div><div className="v">{sigma ? pct(sigma, 2) : '—'}</div><div className="s">{z !== null ? `gap = ${z.toFixed(2)} σ` : 'AssetConfig.sigma_wad'}</div></div>
        </div>
      </div>
    </div>
  );
}

function S7({ rows, source }: { rows: NonNullable<OracleData['s7']>['rows']; source: string }) {
  const weekends = [...new Set(rows.map((r) => r.weekend))];
  const syms = ['SPYx', 'NVDAx', 'QQQx'];
  const cell = (r?: (typeof rows)[number]) => {
    if (!r) return '—';
    if (r.movedOverWeekend) return <span className="warn">moves all weekend ({r.weekendMoves} hourly changes)</span>;
    if (!r.firstMove) return <span className="muted">flat through Monday (holiday)</span>;
    const h = r.firstMoveVsOpenHours ?? 0;
    return <span>{h <= 0 ? <b className="warn">first move {utc(Date.parse(r.firstMove) / 1000).slice(5, 16)} UTC, {Math.abs(h)} h before the open</b> : `flat until ${utc(Date.parse(r.firstMove) / 1000).slice(5, 16)} UTC (after the open)`}{r.preMarketMove ? ` · ${pct(r.preMarketMove, 2)} by the open` : ''}</span>;
  };
  return (
    <div className="panel" data-testid="s7">
      <h2>When does Kamino&apos;s price move? (S7, six weekends)</h2>
      <table>
        <thead><tr><th>Weekend (Friday)</th>{syms.map((s) => <th key={s}>{s}</th>)}</tr></thead>
        <tbody>
          {weekends.map((w) => (
            <tr key={w}><td className="mono">{w}</td>{syms.map((s) => <td key={s} style={{ fontSize: 13.5 }}>{cell(rows.find((r) => r.weekend === w && r.sym === s))}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <div className="note" style={{ marginTop: 8 }}>
        Hourly resolution, from {source}. SPYx and NVDAx are frozen from the Friday close to Monday morning; the gap reaches Kamino in
        pre-market, up to 1.5 h before the 9:30 ET open, so a position can be liquidated before Phase 1 settles. Phase 1 pays the
        gap into your position after the open; the Phase 2 Liquidation Shield acts before Kamino&apos;s first post-closure update (plan/09).
      </div>
    </div>
  );
}
