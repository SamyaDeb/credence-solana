'use client';
// Jupiter Lend demo (fork only, W12): runs keeper/src/jl-demo.ts through /api/demo/step. A real Jupiter Lend SPYx/USDC
// position is covered (SPYx.J: SPYx's scenarios, settled on Jupiter's own oracle), shielded on Sunday night and
// settled on Monday, every payment going back into the position through Jupiter's `operate`, signed by the vault PDA.
// Every number comes from the run; what was simulated is listed from it.
import { useState } from 'react';
import { num } from '@/lib/format';
import { useSolana } from '../Providers';
import { Details, H, KV, Note } from '../ui';
import { runStep } from './FaucetView';

type Stage = { tick: number; collateralTokens: number; debtUsdc: number; price: number; debtToCovered: number };
export type JlResult = {
  group: number; ticker: string; vaultId: number; fair: number; open: number; position: string; nftId: number;
  policy: { premiumUsdc: number; shieldLoadingUsdc: number; capUsdc: number; coveredValueUsdc: number; debtUsdc: number; reservedUsdc: number;
    advancedUsdc: number; payoutUsdc: number; remainderUsdc: number; state: number; buyCu: number };
  stages: Record<'before' | 'borrowedUp' | 'bought' | 'afterShield' | 'atOpen' | 'afterSettlement', Stage>;
  simulated: string[];
};

const STAGES: [keyof JlResult['stages'], string][] = [
  ['before', 'On mainnet'],
  ['bought', 'Friday: cover bought'],
  ['afterShield', 'Sunday night: the shield paid back'],
  ['atOpen', 'Monday open, before settlement'],
  ['afterSettlement', 'Monday: settled'],
];
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

export function JupiterPanel() {
  const { refresh } = useSolana();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ text: string; kind: string }[]>([]);
  const [res, setRes] = useState<JlResult | null>(null);
  const [err, setErr] = useState('');

  async function run() {
    setBusy(true); setErr(''); setRes(null); setLines([]);
    try {
      const { exit, result } = await runStep({ step: 'jupiter' }, (l) => setLines((x) => [...x, l]));
      if (result) setRes(result as unknown as JlResult);
      if (exit !== 0) throw new Error('the Jupiter Lend demo failed (see the log)');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false); void refresh();
    }
  }

  return (
    <section data-testid="jupiter">
      <H right={<button type="button" className="cx-btn" disabled={busy} onClick={run} data-testid="jupiter-run">{busy ? 'Running…' : 'Run the Jupiter Lend weekend'}</button>}>
        Jupiter Lend: the second lender
      </H>
      <p className="cx-hint">The same cover on a real Jupiter Lend SPYx loan, settled on Jupiter&apos;s own price.</p>
      <Details summary="What this run does"><p>A real Jupiter Lend SPYx/USDC position. Credence reads it from Jupiter&apos;s own accounts (collateral, its debt tick, Jupiter&apos;s
        price) and settles on Jupiter&apos;s oracle, so the payout uses the price the position is valued at. Payments go back into the position through
        Jupiter&apos;s own instruction, signed by the vault.</p></Details>
      {err && <div className="cx-err" data-testid="jupiter-error">{err}</div>}
      {res && (
        <>
          <KV rows={[
            ['Position', <span key="p" className="cx-mono">{res.position.slice(0, 8)}… (#{res.nftId}, vault {res.vaultId})</span>],
            ['Debt / C′ (Jupiter LT, +1% tick buffer)', `${num(res.policy.debtUsdc)} / ${num(res.policy.coveredValueUsdc)} USDC`],
            ['Premium', <span key="pr" data-testid="jupiter-premium">{num(res.policy.premiumUsdc)}</span>],
          ]} />
          <table className="cx-table" data-testid="jupiter-stages">
            <thead><tr><th>Stage</th><th>Debt (USDC)</th><th>Jupiter price</th><th>D/C′</th></tr></thead>
            <tbody>
              {STAGES.map(([k, label]) => (
                <tr key={k} data-testid={`jupiter-${k}`} data-ratio={res.stages[k].debtToCovered.toFixed(4)}>
                  <td>{label}</td><td className="cx-mono">{num(res.stages[k].debtUsdc)}</td><td className="cx-mono">{num(res.stages[k].price)}</td><td className="cx-mono">{res.stages[k].debtToCovered.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <KV rows={[
            ['Fair value Sunday night / Monday open', `${pct(res.fair)} / ${pct(res.open)}`],
            ['Shield (paid back into the position)', <span key="a" data-testid="jupiter-advance">{num(res.policy.advancedUsdc)}</span>],
            ['Settlement remainder / total payout', <span key="t" data-testid="jupiter-payout">{num(res.policy.remainderUsdc)} / {num(res.policy.payoutUsdc)} USDC</span>],
          ]} />
          <Note icon="shield">Jupiter refuses any instruction that leaves a position above its threshold, and its debt moves in 0.15% ticks; Credence
            prices a Jupiter policy on its debt plus 1%, so a payment always lands the position healthy.</Note>
          <ul className="cx-simlist" data-testid="jupiter-simulated">{res.simulated.map((s) => <li key={s}>{s}</li>)}</ul>
        </>
      )}
      {lines.length > 0 && <div className="cx-log" data-testid="jupiter-log">{lines.map((l, i) => <div key={i} className={l.kind === 'ok' ? 'is-ok' : l.kind === 'fail' ? 'is-fail' : ''}>{l.text}</div>)}</div>}
    </section>
  );
}
