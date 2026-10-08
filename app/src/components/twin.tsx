'use client';
// W1 twin demo panel: runs keeper/src/twin.ts on the fork through /api/demo/step and shows the two identical $50k SPYx
// positions side by side — A covered (the Liquidation Shield repays into it on Sunday night), B not — with klend's
// health at each stage, the liquidator's result and the settlement. Everything simulated is listed from the run.
import { useState } from 'react';
import { useApp } from './providers';

type Stage = { debtUsdc: number; collateralTokens: number; collateralUsd: number; health: number; debtToCovered: number };
type Result = {
  group: number; gap: number;
  positions: { A: string; B: string; debtUsdc: number; debtToCovered: number };
  policyA: { premium: number; shieldLoading: number; cap: number; advanced: number; payout: number; remainder: number };
  stages: Record<'bought' | 'afterShield' | 'atPremarketMove' | 'afterLiquidator' | 'afterSettlement', { A: Stage; B: Stage }>;
  liquidator: { A: { liquidated: boolean }; B: { liquidated: boolean; repaidUsdc?: number; receivedSpyx?: number } };
  simulated: string[];
};

const STAGES: [keyof Result['stages'], string][] = [
  ['bought', 'Friday: both at D/C′ 0.96'],
  ['afterShield', 'Sunday 20:30 ET: fair value −8%, shield'],
  ['atPremarketMove', 'Monday 08:00 ET: Kamino −8%'],
  ['afterLiquidator', 'Liquidator runs'],
  ['afterSettlement', 'Monday open: settlement'],
];
const money = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Health({ s, testid }: { s: Stage; testid: string }) {
  // Health = C′ / D; the bar runs from 0.9 (deep in liquidation) to 1.2, with the liquidation line at 1.0.
  const pct = Math.max(0, Math.min(100, ((s.health - 0.9) / 0.3) * 100));
  const ok = s.health >= 1;
  return (
    <div data-testid={testid} data-health={s.health.toFixed(4)}>
      <div style={{ position: 'relative', height: 10, background: 'var(--line)', borderRadius: 5 }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 5, background: ok ? 'var(--accent)' : 'var(--bad, #d14)' }} />
        <div style={{ position: 'absolute', left: `${(0.1 / 0.3) * 100}%`, top: -3, bottom: -3, width: 2, background: 'var(--text)' }} title="liquidation (health 1.0)" />
      </div>
      <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
        <span className={ok ? 'muted' : 'bad'}>health {s.health.toFixed(4)}{ok ? '' : ' · liquidatable'}</span>
        <span className="muted mono">debt {money(s.debtUsdc)} · {s.collateralTokens.toFixed(4)} SPYx</span>
      </div>
    </div>
  );
}

export function TwinDemo() {
  const { bump } = useApp();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState('');

  async function run() {
    setBusy(true); setErr(''); setRes(null); setLines([]);
    try {
      const r = await fetch('/api/demo/step', { method: 'POST', body: JSON.stringify({ step: 'twin' }) });
      if (!r.ok || !r.body) throw new Error((await r.json()).error);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = ''; let exit = 1;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n'); buf = parts.pop() ?? '';
        for (const l of parts) {
          if (l.startsWith('@@result ')) { setRes(JSON.parse(l.slice(9))); continue; }
          if (l.startsWith('@@exit ')) { exit = Number(l.slice(7)); continue; }
          setLines((x) => [...x, l.replace(/^\d\d:\d\d:\d\d /, '')]);
        }
      }
      if (exit !== 0) throw new Error('the twin demo failed (see the log)');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false); bump();
    }
  }

  return (
    <div className="panel stack" style={{ gap: 12 }} data-testid="twin">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h3 style={{ margin: 0 }}>Liquidation Shield: twin positions</h3>
          <div className="muted" style={{ fontSize: 13.5 }}>Two identical $50,000 SPYx positions at D/C′ 0.96 on Kamino. A buys Gap Cover, B does not. On Sunday night the
            xStock&apos;s 24/7 price is −8% while Kamino&apos;s price is still frozen; the shield repays into A. On Monday at 08:00 ET Kamino moves −8% and a plain
            liquidator tries both. Runs a whole weekend on the fork (about a minute; moves the fork&apos;s clock a week on).</div>
        </div>
        <button className="primary" disabled={busy} onClick={run} data-testid="twin-run">{busy ? 'Running…' : 'Run the twin weekend'}</button>
      </div>
      {err && <div className="err" data-testid="twin-error">{err}</div>}
      {res && (
        <>
          <div className="grid g2">
            {(['A', 'B'] as const).map((k) => (
              <div key={k} className="stack" style={{ gap: 8 }} data-testid={`twin-${k}`}>
                <h3 style={{ margin: 0 }}>{k === 'A' ? 'A · covered' : 'B · not covered'} <span className="mono muted" style={{ fontSize: 12 }}>{res.positions[k].slice(0, 8)}…</span></h3>
                {STAGES.map(([s, label]) => (
                  <div key={s}><div className="muted" style={{ fontSize: 12.5 }}>{label}</div><Health s={res.stages[s][k]} testid={`twin-${k}-${s}`} /></div>
                ))}
                <div data-testid={`twin-${k}-outcome`} className={res.liquidator[k].liquidated ? 'bad' : 'accent'} style={{ fontWeight: 600 }}>
                  {res.liquidator[k].liquidated
                    ? `Liquidated: the liquidator repaid ${money(res.liquidator.B.repaidUsdc ?? 0)} USDC and took ${(res.liquidator.B.receivedSpyx ?? 0).toFixed(4)} SPYx`
                    : 'Not liquidated: klend refused the liquidator (healthy)'}
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 24 }}>
            <span className="muted">A&apos;s premium <b className="mono">{money(res.policyA.premium)}</b> USDC (shield loading {money(res.policyA.shieldLoading)})</span>
            <span className="muted">Shield advance <b className="mono accent" data-testid="twin-advance">{money(res.policyA.advanced)}</b> USDC on Sunday night</span>
            <span className="muted">Settlement remainder <b className="mono">{money(res.policyA.remainder)}</b> · total payout <b className="mono">{money(res.policyA.payout)}</b></span>
          </div>
          <div className="note">The shield sized its advance on the fair value marked down by its 2% buffer, so it repaid more than the payout rule owed at this open
            (the vault keeps the difference as its loss; the shield loading in the premium prices it).</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)', fontSize: 13 }} data-testid="twin-simulated">
            {res.simulated.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </>
      )}
      {lines.length > 0 && <div className="log" style={{ maxHeight: 220 }} data-testid="twin-log">{lines.map((l, i) => <div key={i} className={/\bok\b/.test(l) ? 'ok' : /FAIL|Error/.test(l) ? 'fail' : ''}>{l}</div>)}</div>}
    </div>
  );
}
