'use client';
// Demo mode (fork only): drives the fork through one weekend — Friday close → Monday open with a chosen gap → settle —
// by running the keeper's own jobs and surfpool time travel through /api/demo/step. Every transaction streams in with
// its compute units; each covered obligation's debt and the vault are shown before and after. Everything simulated is
// listed on screen in the same words as the CLI demo.
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { POLICY_NAME, EPOCH_NAME } from '@/lib/credence';
import { et, num, short, usdc } from '@/lib/format';
import { useClock, useEpochs } from '@/lib/hooks/chain';
import { usePolicies, usePositions } from '@/lib/hooks/positions';
import { redact } from '@/lib/redact';
import { useSolana } from '../Providers';
import { H, KV, Note, PageHead, Pill, Sim, StatBlock } from '../ui';
import { rememberCreated, runStep } from './FaucetView';
import { ChainTime } from './shared';

type Pol = { policy: string; ticker: string; obligation: string; state: number; maxPayout: number; premium: number; payout: number; debt: number | null };
type Vault = { equity: number; navPerShare: number; premiumsUnearned: number; totalPayouts: number; liveGroups: number };
type Line = { text: string; kind: 'ok' | 'fail' | 'info' };
type Step = 'create' | 'close' | 'open' | 'settle';

const ALWAYS_SIMULATED = [
  'the clock: surfpool time travel to the Friday close and the Monday open',
  'USDC balances of the demo wallets (surfpool cheatcode)',
  "Kamino's Scope refresh times moved to the fork clock before each klend refresh (prices unchanged; nothing updates Scope on a fork)",
];
const GAPS = [-0.03, -0.05, -0.08, -0.1, -0.12, -0.15, 0.02];

export function DemoView() {
  const { signer, refresh } = useSolana();
  const owner = signer?.publicKey;
  const { now } = useClock();
  const epochs = useEpochs();
  const policies = usePolicies(owner);
  const pos = usePositions(owner);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState<Step | null>(null);
  const [gap, setGap] = useState(-0.08);
  const [debt, setDebt] = useState(50_000);
  const [before, setBefore] = useState<{ policies: Pol[]; vault: Vault } | null>(null);
  const [after, setAfter] = useState<{ policies: Pol[]; vault: Vault; epochs: { ticker: string; state: number; closePrice: number; settlePrice: number }[] } | null>(null);
  const [simulated, setSimulated] = useState<string[]>([]);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [lines]);

  // The weekend being demonstrated: the one the close step closed (until it settles), else the next open one.
  const group = useMemo(() => {
    if (active) return active;
    const open = (epochs.data ?? []).filter((e) => e.state === 0);
    return open.length ? Math.min(...open.map((e) => e.closureId)) : null;
  }, [epochs.data, active]);
  const live = (epochs.data ?? []).filter((e) => e.closureId === group);
  const groupPolicies = (policies.data ?? []).filter((p) => live.some((e) => e.key.equals(p.epoch)));

  async function run(step: Step, body: Record<string, unknown>) {
    setBusy(step); setErr('');
    const title = step === 'create' ? `create a $${num(debt, 0)} SPYx position` : step === 'close' ? 'Friday close' : step === 'open' ? `Monday open, gap ${(gap * 100).toFixed(1)}%` : 'settle';
    setLines((l) => [...l, { text: `── ${title} ──`, kind: 'info' }]);
    const t0 = Date.now();
    try {
      const { exit, result: res, created } = await runStep({ step, ...body }, (l) => setLines((x) => [...x, l]));
      if (exit !== 0) throw new Error(`${step} failed (see the log)`);
      const sim = ((res?.simulated ?? created?.simulated) as string[] | undefined) ?? [];
      if (sim.length) setSimulated((s) => [...new Set([...s, ...sim])]);
      if (created) {
        rememberCreated(String(created.obligation));
        setLines((x) => [...x, { text: `position ${created.obligation}: ${num(created.debtUsdc as number)} USDC debt against ${(created.depositTokens as number).toFixed(4)} SPYx`, kind: 'ok' }]);
      }
      if (step === 'close' && res) setActive(res.group as number);
      if (step === 'settle' && res) setActive(null);
      if (step === 'open' && res) { setBefore({ policies: res.policies as Pol[], vault: res.vault as Vault }); setAfter(null); }
      if (step === 'settle' && res) { setBefore(res.before as { policies: Pol[]; vault: Vault }); setAfter({ ...(res.after as { policies: Pol[]; vault: Vault }), epochs: res.epochs as never }); }
      setDone((d) => ({ ...d, [step]: true, ...(step === 'close' ? { open: false, settle: false } : {}) }));
      setLines((x) => [...x, { text: `${step} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`, kind: 'info' }]);
    } catch (e) {
      setErr(redact((e as Error).message));
    } finally {
      setBusy(null); void refresh();
    }
  }

  const settledPayout = after?.policies.reduce((a, p) => a + p.payout, 0) ?? null;

  return (
    <>
      <PageHead title="Demo mode" sub="Fast-forward the fork through one weekend: the Friday close, a Monday gap, and settlement into your position. Every step runs the keeper's own jobs against the real program and real klend on a mainnet fork." right={<Sim>simulated / fork</Sim>} />
      {err && <div style={{ marginBottom: 20 }}><Note icon="alert" tone="bad"><span data-testid="demo-error">{err}</span></Note></div>}
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small>{groupPolicies.length} of your policies · {pos.positions?.length ?? 0} position{pos.positions?.length === 1 ? '' : 's'}</small>}>Weekend {group ?? '—'}</H>
            {live[0] && <p className="cx-page-sub" style={{ margin: 0 }}>Friday close {et(live[0].close)} → Monday open {et(live[0].open)}</p>}
          </section>
          <section>
            <H>1 · A position worth covering</H>
            <p className="cx-hint">The real near-threshold positions on Kamino are small (the largest above D/C′ 0.92 has about $430 of debt). Create a bigger SPYx position on the fork: the demo keeper deposits SPYx and borrows USDC through klend to D/C′ 0.96, then the position is given to your wallet.</p>
            <div className="cx-row" style={{ alignItems: 'center' }}>
              <label className="cx-amount" style={{ maxWidth: 260 }}><input inputMode="decimal" value={debt} onChange={(e) => setDebt(Number(e.target.value.replace(/[^\d]/g, '')) || 0)} /><span>USDC debt</span></label>
              <button type="button" className="cx-btn" disabled={!signer || !!busy || debt < 1000 || debt > 250000} onClick={() => run('create', { owner: owner!.toBase58(), debt })} data-testid="demo-create">{busy === 'create' ? 'Creating…' : 'Create position (fork)'}</button>
            </div>
            {!signer && <p className="cx-hint">Connect a wallet (the demo burner works) and fund it on <Link href="/app/faucet"><b>Faucet</b></Link> first.</p>}
          </section>
          <section>
            <H>2 · Buy gap cover</H>
            <p className="cx-hint">On <Link href="/app/borrow"><b>Borrow</b></Link>: quote, then one click. Your policies on weekend {group ?? '—'}:</p>
            {groupPolicies.length === 0 ? <Note icon="shield">None yet.</Note> : (
              <div className="cx-table-wrap"><table className="cx-table is-keep"><tbody>{groupPolicies.map((p) => (
                <tr key={p.key.toBase58()}><td className="cx-mono">{short(p.key, 5)}</td><td>{p.ticker}</td><td className="is-num">cap {usdc(p.maxPayout)}</td><td className="is-num">premium {usdc(p.premium)}</td><td>{POLICY_NAME[p.state]}</td></tr>
              ))}</tbody></table></div>
            )}
          </section>
          <section>
            <H>3 · The weekend</H>
            <div className="cx-steps">
              <button type="button" className="cx-btn" disabled={!!busy || !group || (done.close && !done.settle)} onClick={() => run('close', {})} data-testid="demo-close">{busy === 'close' ? 'Closing…' : 'Friday close'}</button>
              <span aria-hidden>→</span>
              <div className="cx-seg" role="group" aria-label="Gap at the open" data-testid="demo-gap">
                {GAPS.map((g) => <button key={g} type="button" aria-pressed={gap === g} data-gap={g} onClick={() => setGap(g)}>{g > 0 ? '+' : ''}{(g * 100).toFixed(0)}%</button>)}
              </div>
              <button type="button" className="cx-btn" disabled={!!busy || !done.close} onClick={() => run('open', { gap })} data-testid="demo-open">{busy === 'open' ? 'Opening…' : `Monday open, gap ${(gap * 100).toFixed(0)}%`}</button>
              <span aria-hidden>→</span>
              <button type="button" className="cx-btn" disabled={!!busy || !done.open} onClick={() => run('settle', {})} data-testid="demo-settle">{busy === 'settle' ? 'Settling…' : 'Settle'}</button>
            </div>
            <p className="cx-hint">Settle within about 4 minutes of the open step: the program accepts Kamino&apos;s price only in the 5-minute window after open + 60 s (INV-4), and the fork&apos;s clock keeps running.</p>
            <div className="cx-log" ref={logRef} data-testid="demo-log">
              {lines.length === 0 ? <div className="cx-muted">Transactions appear here with their compute units.</div> : lines.map((l, i) => <div key={i} className={l.kind === 'ok' ? 'is-ok' : l.kind === 'fail' ? 'is-fail' : ''}>{l.text}</div>)}
            </div>
          </section>
          {(before || after) && <BeforeAfter before={before} after={after} />}
          <section>
            <H>What is simulated</H>
            <ul className="cx-simlist" data-testid="simulated">
              {[...ALWAYS_SIMULATED, ...simulated.filter((s) => !ALWAYS_SIMULATED.includes(s) && !s.startsWith('the clock:'))].map((s) => <li key={s}>{s}</li>)}
            </ul>
            <p className="cx-hint">Real: the klend program and every Kamino account (market, reserves, Scope, farms, the obligations&apos; collateral and debt) cloned from mainnet; credence_core built from this repo; the repay is a real CPI into klend signed by the vault PDA; settlement prices come from Kamino&apos;s own Scope oracle, the price klend liquidates on; the XNYS calendar.</p>
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Paid into positions" value={settledPayout !== null ? num(settledPayout) : '—'} chip="USDC, this weekend" testId="demo-total-payout" />
          <KV rows={[['Chain time', <ChainTime key="t" now={now} />], ['Weekend', group ? String(group) : '—'], ['Steps done', ['close', 'open', 'settle'].filter((s) => done[s]).join(', ') || 'none']]} />
          <Note icon="clock">The fork&apos;s clock jumps to the Friday close and the Monday open; Kamino&apos;s Scope price at the open is moved by the chosen gap, which klend also sees.</Note>
        </aside>
      </div>
    </>
  );
}

function BeforeAfter({ before, after }: { before: { policies: Pol[]; vault: Vault } | null; after: { policies: Pol[]; vault: Vault; epochs: { ticker: string; state: number; closePrice: number; settlePrice: number }[] } | null }) {
  const pols = after?.policies ?? before?.policies ?? [];
  return (
    <section data-testid="before-after">
      <H>Settlement: before → after</H>
      {after && (
        <div className="cx-row" style={{ gap: 18, marginBottom: 14 }}>
          {after.epochs.map((e) => (
            <Pill key={e.ticker} tone={e.settlePrice < e.closePrice ? 'bad' : 'good'}>{e.ticker} {e.closePrice.toFixed(2)} → {e.settlePrice.toFixed(2)} ({((e.settlePrice / e.closePrice - 1) * 100).toFixed(2)}%) · {EPOCH_NAME[e.state]}</Pill>
          ))}
        </div>
      )}
      <div className="cx-table-wrap">
        <table className="cx-table">
          <thead><tr><th>Policy</th><th>Obligation</th><th className="is-num">Debt before</th><th className="is-num">Payout</th><th className="is-num">Debt after</th><th>State</th></tr></thead>
          <tbody>
            {pols.map((p) => {
              const b = before?.policies.find((x) => x.policy === p.policy);
              return (
                <tr key={p.policy}>
                  <td className="cx-mono" data-label="Policy">{short(p.policy, 5)}</td><td className="cx-mono" data-label="Obligation">{short(p.obligation, 5)}</td>
                  <td className="is-num" data-label="Debt before">{b?.debt != null ? num(b.debt) : '—'}</td>
                  <td className="is-num is-strong cx-payout" data-label="Payout" data-testid="demo-payout">{after ? num(p.payout) : '—'}</td>
                  <td className="is-num" data-label="Debt after">{after && p.debt != null ? num(p.debt) : '—'}</td>
                  <td data-label="State">{POLICY_NAME[p.state]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {before && (
        <KV rows={[
          ['Vault equity', `${num(before.vault.equity)}${after ? ` → ${num(after.vault.equity)}` : ''} USDC`],
          ['NAV per share', `${before.vault.navPerShare.toFixed(6)}${after ? ` → ${after.vault.navPerShare.toFixed(6)}` : ''}`],
          ['Lifetime payouts', `${num(before.vault.totalPayouts)}${after ? ` → ${num(after.vault.totalPayouts)}` : ''} USDC`],
        ]} />
      )}
      <p className="cx-hint">Debts as klend stores them after each refresh (interest accrues over the weekend); the payout is repaid into the obligation by settle_policy through klend&apos;s repay CPI.</p>
    </section>
  );
}
