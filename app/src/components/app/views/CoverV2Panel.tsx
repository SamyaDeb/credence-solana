'use client';
// Cover v2 demo (fork only, W11): runs keeper/src/cover-v2-demo.ts through /api/demo/step. One weekend with a long's
// DOWN cover and a short's UP cover in the same group (the vault reserves the larger side, not the sum; UP pays the
// short's wallet), then an OVERNIGHT and a HOLIDAY_WEEKEND cover, each priced on its own closure's scenarios and σ and
// settled. Every number comes from the run; what was simulated is listed from it.
import { useState } from 'react';
import { num } from '@/lib/format';
import { useSolana } from '../Providers';
import { H, KV, Note } from '../ui';
import { runStep } from './FaucetView';

export type V2Result = {
  weekend: { group: number; open: string;
    netting: { downWorst: number; upWorst: number; groupBefore: number; groupAfter: number };
    up: { policy: string; premium: number; cap: number; payout: number; toWallet: number; buyCu: number };
    down: { policy: string; premium: number; payout: number } };
  overnight: { group: number; premium: number; payout: number; open: string; buyCu: number };
  holiday: { group: number; close: string; open: string; premium: number; payout: number; openMove: string };
  keeper: { failed: unknown[] };
  simulated: string[];
};

export function CoverV2Panel() {
  const { refresh } = useSolana();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ text: string; kind: string }[]>([]);
  const [res, setRes] = useState<V2Result | null>(null);
  const [err, setErr] = useState('');

  async function run() {
    setBusy(true); setErr(''); setRes(null); setLines([]);
    try {
      const { exit, result } = await runStep({ step: 'cover-v2' }, (l) => setLines((x) => [...x, l]));
      if (result) setRes(result as unknown as V2Result);
      if (exit !== 0) throw new Error('the Cover v2 demo failed (see the log)');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false); void refresh();
    }
  }

  const w = res?.weekend;
  return (
    <section data-testid="cover-v2">
      <H right={<button type="button" className="cx-btn" disabled={busy} onClick={run} data-testid="cover-v2-run">{busy ? 'Running…' : 'Run Cover v2'}</button>}>
        Cover v2: shorts, overnights and holidays
      </H>
      <p className="cx-hint">A short (SPYx borrowed against USDC) is hurt when SPYx gaps up. Its UP cover pays USDC to the owner&apos;s wallet. In the same
        weekend a long buys DOWN cover: the two sides lose in different scenarios, so the vault reserves the larger, not the sum. Then an overnight and a
        holiday weekend, each priced on its own closure&apos;s history and length.</p>
      {err && <div className="cx-err" data-testid="cover-v2-error">{err}</div>}
      {res && w && (
        <>
          <table className="cx-table" data-testid="cover-v2-netting">
            <thead><tr><th>Weekend {w.group}</th><th>Worst loss (USDC)</th><th>Premium</th><th>Payout at {w.open}</th></tr></thead>
            <tbody>
              <tr><td>DOWN (the long)</td><td className="cx-mono">{num(w.netting.downWorst)}</td><td className="cx-mono">{num(w.down.premium)}</td><td className="cx-mono">{num(w.down.payout)}</td></tr>
              <tr><td>UP (the short)</td><td className="cx-mono">{num(w.netting.upWorst)}</td><td className="cx-mono">{num(w.up.premium)}</td>
                <td className="cx-mono" data-testid="cover-v2-up-payout">{num(w.up.payout)}</td></tr>
              <tr><td>The group reserves</td><td className="cx-mono" data-testid="cover-v2-reserved" data-sum={(w.netting.downWorst + w.netting.upWorst).toFixed(6)}
                data-reserved={w.netting.groupAfter.toFixed(6)}>{num(w.netting.groupAfter)}</td><td /><td /></tr>
            </tbody>
          </table>
          <KV rows={[
            ['UP payout to the short’s wallet', <span key="u" data-testid="cover-v2-wallet">{num(w.up.toWallet)} USDC</span>],
            [`Overnight ${res.overnight.group} (opens ${res.overnight.open})`, <span key="o" data-testid="cover-v2-overnight">premium {num(res.overnight.premium)}, payout {num(res.overnight.payout)}</span>],
            [`Holiday weekend ${res.holiday.group} (${res.holiday.close.slice(0, 10)} → ${res.holiday.open.slice(0, 10)}, opens ${res.holiday.openMove})`,
              <span key="h" data-testid="cover-v2-holiday">premium {num(res.holiday.premium)}, payout {num(res.holiday.payout)}</span>],
            ['Keeper failures', <span key="k" data-testid="cover-v2-failed">{res.keeper.failed.length}</span>],
          ]} />
          <Note icon="shield">UP cover has no shield: there is no xStock debt Credence can repay in USDC. It settles at the open, to the wallet.</Note>
          <ul className="cx-simlist" data-testid="cover-v2-simulated">{res.simulated.map((s) => <li key={s}>{s}</li>)}</ul>
        </>
      )}
      {lines.length > 0 && <div className="cx-log" data-testid="cover-v2-log">{lines.map((l, i) => <div key={i} className={l.kind === 'ok' ? 'is-ok' : l.kind === 'fail' ? 'is-fail' : ''}>{l.text}</div>)}</div>}
    </section>
  );
}
