'use client';
// Demo mode (task 4.5): one panel that drives the fork through a weekend — Friday close → Monday open with a gap →
// settle — by running the keeper's own jobs and surfpool time travel through /api/demo/step, streaming every
// transaction with its compute units, and showing each covered obligation's debt and the vault before and after.
// Everything simulated is listed on screen in the same words as the CLI demo's "simulated" list.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type EpochView, type PolicyView, loadEpochs, policiesOf } from '@/lib/cover';
import { EPOCH_NAME, POLICY_NAME, chainNow } from '@/lib/credence';
import { et, short, usdc, utc } from '@/lib/format';
import { obligationsOf } from '@/lib/kamino';
import { useApp } from './providers';
import { TwinDemo } from './twin';

type Pol = { policy: string; ticker: string; obligation: string; state: number; maxPayout: number; premium: number; payout: number; debt: number | null };
type Vault = { equity: number; navPerShare: number; premiumsUnearned: number; totalPayouts: number; liveGroups: number };
type Line = { text: string; kind: 'ok' | 'fail' | 'info' | 'wait' };
type Step = 'create' | 'close' | 'open' | 'settle';

const ALWAYS_SIMULATED = [
  'the clock: surfpool time travel to the Friday close and the Monday open',
  'USDC balances of the demo wallets (surfpool cheatcode)',
  "Kamino's Scope refresh times moved to the fork clock before each klend refresh (prices unchanged; nothing updates Scope on a fork)",
];

const money = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function DemoMode() {
  const { conn, prog, signer, version, bump } = useApp();
  const [now, setNow] = useState(0);
  const [epochs, setEpochs] = useState<EpochView[]>([]);
  const [policies, setPolicies] = useState<PolicyView[]>([]);
  const [positions, setPositions] = useState(0);
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

  const refresh = useCallback(async () => {
    try {
      const [t, es] = await Promise.all([chainNow(conn), loadEpochs(prog)]);
      setNow(t); setEpochs(es);
      if (signer) {
        setPolicies(await policiesOf(prog, signer.publicKey));
        setPositions((await obligationsOf(conn, signer.publicKey)).length);
      }
    } catch (e) { setErr((e as Error).message); }
  }, [conn, prog, signer]);
  useEffect(() => { void refresh(); }, [refresh, version]);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [lines]);

  // The weekend being demonstrated: the one the close step closed (until it settles), else the next open one.
  const group = useMemo(() => {
    if (active) return active;
    const open = epochs.filter((e) => e.state === 0);
    return open.length ? Math.min(...open.map((e) => e.closureId)) : null;
  }, [epochs, active]);
  const live = group ? epochs.filter((e) => e.closureId === group) : [];
  const groupPolicies = policies.filter((p) => live.some((e) => e.key.equals(p.epoch)));

  async function run(step: Step, body: Record<string, unknown>) {
    setBusy(step); setErr('');
    setLines((l) => [...l, { text: `── ${step === 'create' ? 'create a bigger SPYx position' : step === 'close' ? 'Friday close' : step === 'open' ? `Monday open, gap ${(gap * 100).toFixed(1)}%` : 'settle'} ──`, kind: 'info' }]);
    const t0 = Date.now();
    try {
      const r = await fetch('/api/demo/step', { method: 'POST', body: JSON.stringify({ step, ...body }) });
      if (!r.ok || !r.body) throw new Error((await r.json()).error);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = ''; let exit = 1; let res: Record<string, unknown> | null = null; let created: Record<string, unknown> | null = null;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n'); buf = parts.pop() ?? '';
        for (const l of parts) {
          if (l.startsWith('@@result ')) { res = JSON.parse(l.slice(9)); continue; }
          if (l.startsWith('@@exit ')) { exit = Number(l.slice(7)); continue; }
          if (l.startsWith('@@error ')) { setLines((x) => [...x, { text: l.slice(8), kind: 'fail' }]); continue; }
          if (l.startsWith('{"obligation"')) { created = JSON.parse(l); continue; }
          const text = l.replace(/^\d\d:\d\d:\d\d /, '');
          setLines((x) => [...x, { text, kind: /\bok\b/.test(text) ? 'ok' : /FAIL|Error/i.test(text) ? 'fail' : /\bwait\b/.test(text) ? 'wait' : 'info' }]);
        }
      }
      if (exit !== 0) throw new Error(`${step} failed (see the log)`);
      const sim = ((res?.simulated ?? created?.simulated) as string[] | undefined) ?? [];
      if (sim.length) setSimulated((s) => [...new Set([...s, ...sim])]);
      if (created) {
        try {
          const list = JSON.parse(localStorage.getItem('credence.created') ?? '[]');
          localStorage.setItem('credence.created', JSON.stringify([...new Set([...list, created.obligation])]));
        } catch { /* ignore */ }
        setLines((x) => [...x, { text: `position ${created.obligation}: ${money(created.debtUsdc as number)} USDC debt against ${(created.depositTokens as number).toFixed(4)} SPYx`, kind: 'ok' }]);
      }
      if (step === 'close' && res) setActive(res.group as number);
      if (step === 'settle' && res) setActive(null);
      if (step === 'open' && res) { setBefore({ policies: res.policies as Pol[], vault: res.vault as Vault }); setAfter(null); }
      if (step === 'settle' && res) { setBefore(res.before as { policies: Pol[]; vault: Vault }); setAfter({ ...(res.after as { policies: Pol[]; vault: Vault }), epochs: res.epochs as never }); }
      setDone((d) => ({ ...d, [step]: true, ...(step === 'close' ? { open: false, settle: false } : {}) }));
      setLines((x) => [...x, { text: `${step} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`, kind: 'info' }]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null); bump(); void refresh();
    }
  }

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Demo mode</h1>
          <p className="lede" style={{ marginBottom: 0 }}>Fast-forward the fork through one weekend: the Friday close, a Monday gap, and settlement into your position.
            Every step runs the keeper&apos;s own jobs against the real program and real klend on a mainnet fork.</p>
        </div>
        <span className="sim">fork only</span>
      </div>
      {err && <div className="panel err" data-testid="demo-error">{err}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0 }}>Weekend {group ?? '—'}</h3>
            {live[0] && <div className="muted">Friday close {et(live[0].close)} → Monday open {et(live[0].open)} · chain time {now ? utc(now) : '…'}</div>}
          </div>
          <div className="muted">{groupPolicies.length} of your policies on this weekend · {positions} position{positions === 1 ? '' : 's'} in this wallet</div>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel stack" style={{ gap: 10 }}>
          <h3>1 · A position worth covering</h3>
          <div className="muted" style={{ fontSize: 13.5 }}>The real near-threshold positions on Kamino are small (the largest above D/C′ 0.92 has about $430 of debt). Create a bigger SPYx position on the fork: the demo keeper deposits SPYx and borrows USDC through klend to D/C′ 0.96, then the position is given to your wallet.</div>
          <div className="row">
            <input type="number" value={debt} min={1000} max={250000} step={1000} onChange={(e) => setDebt(Number(e.target.value))} style={{ width: 130 }} /> <span className="muted">USDC debt</span>
            <button disabled={!signer || !!busy} onClick={() => run('create', { owner: signer!.publicKey.toBase58(), debt })} data-testid="demo-create">
              {busy === 'create' ? 'Creating…' : 'Create position (fork)'}</button>
          </div>
          <div className="note">Or take a real one: <Link href="/">My weekend risk → Use a real mainnet position</Link>. Then buy gap protection there.</div>
        </div>
        <div className="panel stack" style={{ gap: 10 }}>
          <h3>2 · Buy gap protection</h3>
          <div className="muted" style={{ fontSize: 13.5 }}>On <Link href="/">My weekend risk</Link>: quote, then one click. Your policies on weekend {group}:</div>
          {groupPolicies.length === 0 ? <div className="muted">none yet</div> : (
            <table><tbody>{groupPolicies.map((p) => (
              <tr key={p.key.toBase58()}><td className="mono">{short(p.key, 5)}</td><td>{p.ticker}</td><td className="r">cap {usdc(p.maxPayout)}</td><td className="r">premium {usdc(p.premium)}</td><td>{POLICY_NAME[p.state]}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      </div>

      <div className="panel">
        <h3>3 · The weekend</h3>
        <div className="row" style={{ gap: 10 }}>
          <button className="primary" disabled={!!busy || !group || (done.close && !done.settle)} onClick={() => run('close', {})} data-testid="demo-close">{busy === 'close' ? 'Closing…' : 'Friday close'}</button>
          <span className="muted">→</span>
          <select value={gap} onChange={(e) => setGap(Number(e.target.value))} data-testid="demo-gap">
            {[-0.03, -0.05, -0.08, -0.1, -0.12, -0.15, 0.02].map((g) => <option key={g} value={g}>{g > 0 ? '+' : ''}{(g * 100).toFixed(0)}%</option>)}
          </select>
          <button className="primary" disabled={!!busy || !done.close} onClick={() => run('open', { gap })} data-testid="demo-open">{busy === 'open' ? 'Opening…' : `Monday open with gap ${(gap * 100).toFixed(0)}%`}</button>
          <span className="muted">→</span>
          <button className="primary" disabled={!!busy || !done.open} onClick={() => run('settle', {})} data-testid="demo-settle">{busy === 'settle' ? 'Settling…' : 'Settle'}</button>
        </div>
        <div className="note" style={{ marginTop: 8 }}>Settle within about 4 minutes of the open step: the program accepts Kamino&apos;s price only in the 5-minute window after open + 60 s (INV-4), and the fork&apos;s clock keeps running.</div>
        <div className="log" ref={logRef} style={{ marginTop: 14, minHeight: 120 }} data-testid="demo-log">
          {lines.length === 0 ? <div className="faint">Transactions appear here with their compute units.</div> : lines.map((l, i) => <div key={i} className={l.kind === 'ok' ? 'ok' : l.kind === 'fail' ? 'fail' : l.kind === 'wait' ? 'faint' : ''}>{l.text}</div>)}
        </div>
      </div>

      {(before || after) && <BeforeAfter before={before} after={after} />}

      <TwinDemo />

      <div className="panel">
        <h3>What is simulated</h3>
        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6 }} data-testid="simulated">
          {[...ALWAYS_SIMULATED, ...simulated.filter((s) => !ALWAYS_SIMULATED.includes(s) && !s.startsWith('the clock:'))].map((s) => <li key={s}>{s}</li>)}
        </ul>
        <div className="note" style={{ marginTop: 8 }}>Real: the klend program and every Kamino account (market, reserves, Scope, farms, the obligations&apos; collateral and debt) cloned from mainnet; credence_core built from this repo; the repay is a real CPI into klend signed by the vault PDA; settlement prices come from Kamino&apos;s own Scope oracle, the price klend liquidates on; the XNYS calendar.</div>
      </div>
    </div>
  );
}

function BeforeAfter({ before, after }: { before: { policies: Pol[]; vault: Vault } | null; after: { policies: Pol[]; vault: Vault; epochs: { ticker: string; state: number; closePrice: number; settlePrice: number }[] } | null }) {
  const pols = after?.policies ?? before?.policies ?? [];
  return (
    <div className="panel" data-testid="before-after">
      <h3>Settlement: before → after</h3>
      {after && (
        <div className="row" style={{ gap: 24, marginBottom: 12 }}>
          {after.epochs.map((e) => <span key={e.ticker} className="muted">{e.ticker} {e.closePrice.toFixed(4)} → {e.settlePrice.toFixed(4)} <b className={e.settlePrice < e.closePrice ? 'bad' : 'accent'}>{((e.settlePrice / e.closePrice - 1) * 100).toFixed(2)}%</b> · {EPOCH_NAME[e.state]}</span>)}
        </div>
      )}
      <table>
        <thead><tr><th>Policy</th><th>Obligation</th><th className="r">Debt before</th><th className="r">Payout</th><th className="r">Debt after</th><th>State</th></tr></thead>
        <tbody>
          {pols.map((p) => {
            const b = before?.policies.find((x) => x.policy === p.policy);
            return (
              <tr key={p.policy}>
                <td className="mono">{short(p.policy, 5)}</td><td className="mono">{short(p.obligation, 5)}</td>
                <td className="r">{b?.debt != null ? money(b.debt) : '—'}</td>
                <td className="r accent big" style={{ fontSize: 22 }} data-testid="demo-payout">{after ? money(p.payout) : '—'}</td>
                <td className="r">{after && p.debt != null ? money(p.debt) : '—'}</td>
                <td>{POLICY_NAME[p.state]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {before && (
        <div className="row" style={{ gap: 28, marginTop: 14 }}>
          <span className="muted">Vault equity <b className="mono">{money(before.vault.equity)}</b>{after && <> → <b className="mono">{money(after.vault.equity)}</b></>} USDC</span>
          <span className="muted">NAV/share <b className="mono">{before.vault.navPerShare.toFixed(6)}</b>{after && <> → <b className="mono">{after.vault.navPerShare.toFixed(6)}</b></>}</span>
          <span className="muted">Lifetime payouts <b className="mono">{money(before.vault.totalPayouts)}</b>{after && <> → <b className="mono">{money(after.vault.totalPayouts)}</b></>}</span>
        </div>
      )}
      <div className="note" style={{ marginTop: 8 }}>Debts as klend stores them after each refresh (interest accrues over the weekend); the payout is repaid into the obligation by settle_policy through klend&apos;s repay CPI.</div>
    </div>
  );
}
