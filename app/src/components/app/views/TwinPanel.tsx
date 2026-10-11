'use client';
// Twin demo (fork only): runs keeper/src/twin.ts through /api/demo/step and shows two identical $50k SPYx positions on
// Kamino side by side. A buys Gap Cover, B does not. Sunday night the Liquidation Shield repays into A (W1); at Monday
// 08:00 ET Kamino moves −8% and Credence's Monday Backstop (W2) tries both: klend refuses A, the vault liquidates B and
// puts its SPYx on a Dutch auction, and a buyer takes part of the lot. Every number comes from the run; what was
// simulated is listed from it.
import { useState } from 'react';
import { num } from '@/lib/format';
import { useSolana } from '../Providers';
import { Details, Bar, H, KV, Note, Pill } from '../ui';
import { runStep } from './FaucetView';

type Stage = { debtUsdc: number; collateralTokens: number; health: number };
type Side = { liquidated: boolean; repaidUsdc?: number; receivedSpyx?: number; refused?: string };
type Sale = { started: boolean; lotSpyx?: number; startPrice?: number; floorPrice?: number; boughtSpyx?: number; pricePerSpyx?: number; paidUsdc?: number;
  realizedPnlUsdc?: number; inventoryLeftSpyx?: number; bonusAtScopeUsdc?: number };
export type TwinResult = {
  group: number; gap: number;
  positions: { A: string; B: string; debtUsdc: number; debtToCovered: number };
  policyA: { premium: number; shieldLoading: number; cap: number; advanced: number; payout: number; remainder: number };
  stages: Record<'bought' | 'afterShield' | 'atPremarketMove' | 'afterLiquidator' | 'afterSettlement', { A: Stage; B: Stage }>;
  backstop?: { A: Side; B: Side; sale: Sale };
  liquidator: { A: Side; B: Side };
  simulated: string[];
};

const STAGES: [keyof TwinResult['stages'], string][] = [
  ['bought', 'Friday: both at D/C′ 0.96'],
  ['afterShield', 'Sunday 20:30 ET: 24/7 price −8%, the shield repays into A'],
  ['atPremarketMove', 'Monday 08:00 ET: Kamino −8%'],
  ['afterLiquidator', "Credence's backstop tries both"],
  ['afterSettlement', 'Monday open: A settles'],
];

function Health({ s, testId }: { s: Stage; testId: string }) {
  const ok = s.health >= 1;
  // The bar runs from health 0.9 to 1.2; the liquidation line (1.0) is a third of the way.
  return (
    <div data-testid={testId} data-health={s.health.toFixed(4)} style={{ marginBottom: 8 }}>
      <Bar value={Math.max(0, Math.min(1, (s.health - 0.9) / 0.3))} color={ok ? undefined : 'var(--cx-bad, #d14)'} />
      <div className="cx-row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
        <span className={ok ? 'cx-muted' : 'cx-tone-bad'}>health {s.health.toFixed(4)}{ok ? '' : ' · liquidatable'}</span>
        <span className="cx-mono cx-muted">debt {num(s.debtUsdc)} · {s.collateralTokens.toFixed(4)} SPYx</span>
      </div>
    </div>
  );
}

export function TwinPanel() {
  const { refresh } = useSolana();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ text: string; kind: string }[]>([]);
  const [res, setRes] = useState<TwinResult | null>(null);
  const [err, setErr] = useState('');

  async function run() {
    setBusy(true); setErr(''); setRes(null); setLines([]);
    try {
      const { exit, result } = await runStep({ step: 'twin' }, (l) => setLines((x) => [...x, l]));
      if (result) setRes(result as unknown as TwinResult);
      if (exit !== 0) throw new Error('the twin demo failed (see the log)');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false); void refresh();
    }
  }

  const back = res?.backstop ?? (res ? { ...res.liquidator, sale: { started: false } } : null);
  return (
    <section data-testid="twin">
      <H right={<button type="button" className="cx-btn" disabled={busy} onClick={run} data-testid="twin-run">{busy ? 'Running…' : 'Run the twin weekend'}</button>}>
        Twin positions: shield, backstop, auction
      </H>
      <p className="cx-hint">Two identical $50,000 SPYx loans; only one has cover. One weekend shows the shield, the backstop and the auction.</p>
      <Details summary="What this run does"><p>Two identical $50,000 SPYx positions at D/C′ 0.96 on Kamino. A buys Gap Cover, B does not. Sunday night the xStock&apos;s 24/7
        price is −8% while Kamino&apos;s is frozen: the Liquidation Shield repays into A. Monday 08:00 ET Kamino moves −8% and Credence&apos;s Monday Backstop
        tries both; what it liquidates goes on a Dutch auction. A whole weekend on the fork, about a minute (the fork&apos;s clock moves a week on).</p></Details>
      {err && <div className="cx-err" data-testid="twin-error">{err}</div>}
      {res && back && (
        <>
          <div className="cx-grid2">
            {(['A', 'B'] as const).map((k) => (
              <div key={k} data-testid={`twin-${k}`}>
                <h3 className="cx-h3">{k === 'A' ? 'A · covered' : 'B · not covered'} <span className="cx-mono cx-muted">{res.positions[k].slice(0, 8)}…</span></h3>
                {STAGES.map(([s, label]) => (
                  <div key={s}><div className="cx-muted" style={{ fontSize: 12.5 }}>{label}</div><Health s={res.stages[s][k]} testId={`twin-${k}-${s}`} /></div>
                ))}
                <div data-testid={`twin-${k}-outcome`} className={back[k].liquidated ? 'cx-tone-bad' : 'cx-tone-good'} style={{ fontWeight: 600 }}>
                  {back[k].liquidated
                    ? `Liquidated by Credence's backstop: the vault repaid ${num(back[k].repaidUsdc ?? 0)} USDC and took ${(back[k].receivedSpyx ?? 0).toFixed(4)} SPYx`
                    : 'Not liquidated: klend refused (healthy)'}
                </div>
              </div>
            ))}
          </div>
          <KV rows={[
            ["A's premium", `${num(res.policyA.premium)} USDC (shield loading ${num(res.policyA.shieldLoading)})`],
            ['Shield advance into A (Sunday night)', <span key="a" data-testid="twin-advance">{num(res.policyA.advanced)}</span>],
            ['Settlement remainder / total payout', `${num(res.policyA.remainder)} / ${num(res.policyA.payout)} USDC`],
          ]} />
          {back.sale.started && (
            <div data-testid="twin-sale">
              <H right={<Pill tone="good">P&amp;L {num(back.sale.realizedPnlUsdc ?? 0)} USDC</Pill>}>The lot on sale</H>
              <KV rows={[
                ['Bought at the liquidation', `${(back.sale.lotSpyx ?? 0).toFixed(4)} SPYx for ${num(back.B.repaidUsdc ?? 0)} USDC (bonus at Scope ${num(back.sale.bonusAtScopeUsdc ?? 0)})`],
                ['Auction', `${num(back.sale.startPrice ?? 0)} → ${num(back.sale.floorPrice ?? 0)} per SPYx over 2 h`],
                ['Sold after 30 min', <span key="s" data-testid="twin-sold">{(back.sale.boughtSpyx ?? 0).toFixed(4)} SPYx at {num(back.sale.pricePerSpyx ?? 0)} = {num(back.sale.paidUsdc ?? 0)} USDC</span>],
                ['Still on sale', `${(back.sale.inventoryLeftSpyx ?? 0).toFixed(4)} SPYx (see Auctions)`],
              ]} />
            </div>
          )}
          <Note icon="shield">The shield sizes its advance on the fair value marked down by a 2% buffer and counts the weekend&apos;s interest, so it can repay more
            than the payout rule owes at the open; the vault keeps the difference, priced into the premium as the shield loading.</Note>
          <ul className="cx-simlist" data-testid="twin-simulated">{res.simulated.map((s) => <li key={s}>{s}</li>)}</ul>
        </>
      )}
      {lines.length > 0 && <div className="cx-log" data-testid="twin-log">{lines.map((l, i) => <div key={i} className={l.kind === 'ok' ? 'is-ok' : l.kind === 'fail' ? 'is-fail' : ''}>{l.text}</div>)}</div>}
    </section>
  );
}
