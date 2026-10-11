'use client';
// Multi-collateral + PYUSD demo (fork only, W4): runs keeper/src/multi-demo.ts through /api/demo/step. A real Sentora
// xStocks Market obligation with SPYx and NVDAx deposits and a PYUSD debt buys one Gap Cover policy on both legs; the
// keeper funds the vault's PYUSD sleeve, the Liquidation Shield repays from it on Sunday night on both legs' fair values,
// and settlement pays the rest in PYUSD into the obligation. Every number comes from the run; what was simulated is
// listed from it.
import { useState } from 'react';
import { num } from '@/lib/format';
import { useSolana } from '../Providers';
import { Details, H, KV, Note, Pill } from '../ui';
import { runStep } from './FaucetView';

type Stage = { debtPyusd: number; collateralUsd: number; debtToCovered: number };
export type MultiResult = {
  group: number; legs: string[]; fair: number[]; open: number[]; obligation: string;
  policy: { premiumUsdc: number; shieldLoadingUsdc: number; capPyusd: number; reservedPyusd: number; legCoveredPyusd: number[]; debtPyusd: number;
    advancedPyusd: number; payoutPyusd: number; remainderPyusd: number; state: number; buyCu: number };
  sleeve: { fundedPyusd: number; afterShield: number; afterSettlement: number; reservedAfter: number; advancedAfter: number };
  stages: Record<'before' | 'bought' | 'afterShield' | 'afterSettlement', Stage>;
  simulated: string[];
};

const STAGES: [keyof MultiResult['stages'], string][] = [
  ['before', 'On mainnet'],
  ['bought', 'Friday: borrowed up, cover bought'],
  ['afterShield', 'Sunday night: the shield repaid from the sleeve'],
  ['afterSettlement', 'Monday open: settled'],
];
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

export function MultiPanel() {
  const { refresh } = useSolana();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ text: string; kind: string }[]>([]);
  const [res, setRes] = useState<MultiResult | null>(null);
  const [err, setErr] = useState('');

  async function run() {
    setBusy(true); setErr(''); setRes(null); setLines([]);
    try {
      const { exit, result } = await runStep({ step: 'multi' }, (l) => setLines((x) => [...x, l]));
      if (result) setRes(result as unknown as MultiResult);
      if (exit !== 0) throw new Error('the multi-collateral demo failed (see the log)');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false); void refresh();
    }
  }

  return (
    <section data-testid="multi">
      <H right={<button type="button" className="cx-btn" disabled={busy} onClick={run} data-testid="multi-run">{busy ? 'Running…' : 'Run the PYUSD weekend'}</button>}>
        Multi-collateral cover, paid in PYUSD
      </H>
      <p className="cx-hint">One policy over an SPYx + NVDAx loan that borrowed PYUSD, paid out in PYUSD.</p>
      <Details summary="What this run does"><p>A real position on Kamino&apos;s Sentora xStocks Market: SPYx and NVDAx deposited, PYUSD borrowed. One policy covers both legs:
        the payout is what restores health when the two gap together. It is paid in PYUSD from the vault&apos;s PYUSD sleeve, which must hold every
        live PYUSD reservation (INV-14).</p></Details>
      {err && <div className="cx-err" data-testid="multi-error">{err}</div>}
      {res && (
        <>
          <KV rows={[
            ['Obligation (Sentora)', <span key="o" className="cx-mono">{res.obligation.slice(0, 8)}…</span>],
            ['Legs (C′ = value × LT, PYUSD)', <span key="l" data-testid="multi-legs">{res.legs.map((t, i) => `${t} ${num(res.policy.legCoveredPyusd[i])}`).join(' + ')}</span>],
            ['Debt / cap', `${num(res.policy.debtPyusd)} / ${num(res.policy.capPyusd)} PYUSD`],
            ['Premium (paid in USDC)', <span key="p" data-testid="multi-premium">{num(res.policy.premiumUsdc)}</span>],
            ['Reserved in the sleeve', `${num(res.policy.reservedPyusd)} PYUSD`],
          ]} />
          <table className="cx-table" data-testid="multi-stages">
            <thead><tr><th>Stage</th><th>Debt (PYUSD)</th><th>D/C′</th></tr></thead>
            <tbody>
              {STAGES.map(([k, label]) => (
                <tr key={k} data-testid={`multi-${k}`} data-ratio={res.stages[k].debtToCovered.toFixed(4)}>
                  <td>{label}</td><td className="cx-mono">{num(res.stages[k].debtPyusd)}</td><td className="cx-mono">{res.stages[k].debtToCovered.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <KV rows={[
            ['Fair values Sunday night', res.legs.map((t, i) => `${t} ${pct(res.fair[i])}`).join(', ')],
            ['Shield advance (from the sleeve)', <span key="a" data-testid="multi-advance">{num(res.policy.advancedPyusd)}</span>],
            ['Monday open', res.legs.map((t, i) => `${t} ${pct(res.open[i])}`).join(', ')],
            ['Settlement remainder / total payout', <span key="t" data-testid="multi-payout">{num(res.policy.remainderPyusd)} / {num(res.policy.payoutPyusd)} PYUSD</span>],
            ['Sleeve: funded → after shield → after settlement', `${num(res.sleeve.fundedPyusd)} → ${num(res.sleeve.afterShield)} → ${num(res.sleeve.afterSettlement)} PYUSD`],
            ['Sleeve reservations left', <Pill key="r" tone={res.sleeve.reservedAfter === 0 ? 'good' : 'warn'}>{num(res.sleeve.reservedAfter)} PYUSD</Pill>],
          ]} />
          <Note icon="shield">The keeper buys PYUSD with the vault&apos;s USDC (fund_sleeve, at most Kamino&apos;s PYUSD price plus 0.3%, refused below a
            0.98 peg) before PYUSD cover is sold. The premium is in USDC; the payout is in the debt&apos;s own token.</Note>
          <ul className="cx-simlist" data-testid="multi-simulated">{res.simulated.map((s) => <li key={s}>{s}</li>)}</ul>
        </>
      )}
      {lines.length > 0 && <div className="cx-log" data-testid="multi-log">{lines.map((l, i) => <div key={i} className={l.kind === 'ok' ? 'is-ok' : l.kind === 'fail' ? 'is-fail' : ''}>{l.text}</div>)}</div>}
    </section>
  );
}
