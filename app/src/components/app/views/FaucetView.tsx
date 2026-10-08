'use client';
// Faucet (fork only): everything here is a surfpool cheatcode or a keeper step on the local fork, never a real
// transfer, and says so. Fund the wallet (10 SOL, 50,000 USDC), give it xStocks to deposit, create the $50,000 SPYx
// demo position (real klend deposit + borrow by the demo keeper, then given to the wallet), or take a real one.
import Link from 'next/link';
import { useState } from 'react';
import { TOKEN_2022 } from '@/lib/credence';
import { fixed, num, usdc } from '@/lib/format';
import { useAssets } from '@/lib/hooks/chain';
import { useBalances, useTokenBalance } from '@/lib/hooks/vault';
import { redact } from '@/lib/redact';
import { Icon } from '../Icon';
import { IS_MAINNET, READ_ONLY_NOTE } from '@/lib/network';
import { useSolana } from '../Providers';
import { H, KV, Note, PageHead, Sim, StatBlock } from '../ui';
import { ConnectNote } from './shared';

type Line = { text: string; kind: 'ok' | 'fail' | 'info' };

/** Streams one keeper step from /api/demo/step: its transaction lines and the final result. */
export async function runStep(body: Record<string, unknown>, onLine: (l: Line) => void) {
  const r = await fetch('/api/demo/step', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok || !r.body) throw new Error((await r.json()).error);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = ''; let exit = 1; let result: Record<string, unknown> | null = null; let created: Record<string, unknown> | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n'); buf = parts.pop() ?? '';
    for (const l of parts) {
      if (l.startsWith('@@result ')) { result = JSON.parse(l.slice(9)); continue; }
      if (l.startsWith('@@exit ')) { exit = Number(l.slice(7)); continue; }
      if (l.startsWith('@@error ')) { onLine({ text: redact(l.slice(8)), kind: 'fail' }); continue; }
      if (l.startsWith('{"obligation"')) { created = JSON.parse(l); continue; }
      const text = l.replace(/^\d\d:\d\d:\d\d /, '');
      onLine({ text, kind: /\bok\b/.test(text) ? 'ok' : /FAIL|Error/i.test(text) ? 'fail' : 'info' });
    }
  }
  return { exit, result, created };
}

export function rememberCreated(obligation: string) {
  try {
    const list = JSON.parse(localStorage.getItem('credence.created') ?? '[]') as string[];
    localStorage.setItem('credence.created', JSON.stringify([...new Set([...list, obligation])]));
  } catch { /* storage off */ }
}

export function FaucetView() {
  if (IS_MAINNET) return <><PageHead title="Faucet" sub="Fork tools." /><Note icon="lock">{READ_ONLY_NOTE}</Note></>;
  return <FaucetViewFork />;
}

function FaucetViewFork() {
  const { signer, refresh } = useSolana();
  const owner = signer?.publicKey;
  const assets = useAssets();
  const bal = useBalances(owner);
  const [pick, setPick] = useState('SPYx');
  const asset = assets.data?.find((a) => a.ticker === pick);
  const xBal = useTokenBalance(owner, asset?.mint, TOKEN_2022);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [debt, setDebt] = useState(50_000);
  const [tokens, setTokens] = useState(100);
  const [log, setLog] = useState<Line[]>([]);

  async function post(label: string, url: string, body: Record<string, unknown>, ok: (j: Record<string, unknown>) => string) {
    setBusy(label); setMsg(null);
    try {
      const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMsg({ ok: true, text: ok(j) });
    } catch (e) { setMsg({ ok: false, text: redact((e as Error).message) }); } finally { setBusy(''); void refresh(); }
  }

  async function create() {
    if (!owner) return;
    setBusy('create'); setMsg(null); setLog([{ text: `── create a $${num(debt, 0)} SPYx position at D/C′ 0.96 ──`, kind: 'info' }]);
    try {
      const { exit, created } = await runStep({ step: 'create', owner: owner.toBase58(), debt }, (l) => setLog((x) => [...x, l]));
      if (exit !== 0 || !created) throw new Error('create failed (see the log)');
      rememberCreated(String(created.obligation));
      setLog((x) => [...x, { text: `position ${created.obligation}: ${num(created.debtUsdc as number)} USDC debt against ${(created.depositTokens as number).toFixed(4)} SPYx`, kind: 'ok' }, { text: 'create done', kind: 'info' }]);
      setMsg({ ok: true, text: 'Position created and given to this wallet. Open Borrow to see it and cover it.' });
    } catch (e) { setMsg({ ok: false, text: redact((e as Error).message) }); } finally { setBusy(''); void refresh(); }
  }

  return (
    <>
      <PageHead title="Faucet" sub="Fork tools: funds and positions for the demo. Everything here is simulated on the local fork." right={<Sim>simulated / fork</Sim>} />
      <div className="cx-grid">
        <div className="cx-col">
          {!signer ? <section><H>Fund your wallet</H><ConnectNote>Connect a wallet (the demo burner works) to fund it on the fork.</ConnectNote></section> : (
            <>
              <section>
                <H right={<Sim title="requestAirdrop and surfnet_setTokenAccount on the local fork">cheatcode</Sim>}>Fund your wallet</H>
                <div className="cx-row">
                  <button type="button" className="cx-tile" disabled={!!busy} onClick={() => post('fund', '/api/fork/fund', { owner: owner!.toBase58() }, () => '10 SOL airdropped and the USDC balance set to 50,000 (fork cheatcode).')} data-testid="fund">
                    <span className="cx-tile-icon"><Icon name="cash" size={24} strokeWidth={1.9} /></span>
                    <span className="cx-tile-title">Fund (fork)</span>
                    <span className="cx-tile-sub">10 SOL and 50,000 USDC</span>
                    <span className="cx-tile-amount">{busy === 'fund' ? 'Funding…' : 'Fund'}</span>
                  </button>
                  <div className="cx-tile is-static">
                    <span className="cx-tile-icon"><Icon name="deposit" size={24} strokeWidth={1.9} /></span>
                    <span className="cx-tile-title">xStocks (fork)</span>
                    <div className="cx-seg" role="group" aria-label="xStock">
                      {(assets.data ?? []).map((a) => <button key={a.ticker} type="button" aria-pressed={a.ticker === pick} onClick={() => setPick(a.ticker)}>{a.ticker}</button>)}
                    </div>
                    <label className="cx-amount cx-amount-sm"><input inputMode="decimal" value={tokens} onChange={(e) => setTokens(Number(e.target.value.replace(/[^\d.]/g, '')) || 0)} data-testid="xstock-amount" /><span>{pick}</span></label>
                    <button type="button" className="cx-btn cx-btn-sm" disabled={!!busy} data-testid="get-xstock"
                      onClick={() => post('xstock', '/api/fork/xstock', { owner: owner!.toBase58(), ticker: pick, tokens }, (j) => `${pick} balance set to ${j.tokens} (fork cheatcode; nobody sold these tokens).`)}>
                      {busy === 'xstock' ? 'Setting…' : `Set ${pick} balance`}
                    </button>
                  </div>
                </div>
              </section>
              <section>
                <H right={<Sim>keeper step on the fork</Sim>}>A position worth covering</H>
                <p className="cx-hint">The real near-threshold positions on Kamino are small (the largest above D/C′ 0.92 has about $430 of debt). This creates a bigger SPYx position on the fork: the demo keeper gets SPYx by cheatcode, deposits it and borrows USDC through real klend to D/C′ 0.96, then the position&apos;s owner field is set to your wallet.</p>
                <div className="cx-row" style={{ alignItems: 'center' }}>
                  <label className="cx-amount" style={{ maxWidth: 260 }}><input inputMode="decimal" value={debt} onChange={(e) => setDebt(Number(e.target.value.replace(/[^\d]/g, '')) || 0)} data-testid="create-debt" /><span>USDC debt</span></label>
                  <button type="button" className="cx-btn" disabled={!!busy || debt < 1000 || debt > 250000} onClick={create} data-testid="demo-create">{busy === 'create' ? 'Creating…' : 'Create position (fork)'}</button>
                </div>
                {log.length > 0 && <div className="cx-log" data-testid="create-log">{log.map((l, i) => <div key={i} className={l.kind === 'ok' ? 'is-ok' : l.kind === 'fail' ? 'is-fail' : ''}>{l.text}</div>)}</div>}
                <p className="cx-hint">Or take a real mainnet position: <Link href="/app/borrow"><b>Borrow → Use a real mainnet position</b></Link>.</p>
              </section>
              {msg && <p className={`cx-hint ${msg.ok ? 'is-good' : 'is-bad'}`} role={msg.ok ? 'status' : 'alert'} data-testid="faucet-msg">{msg.text}</p>}
            </>
          )}
        </div>
        <aside className="cx-aside">
          <StatBlock label="Wallet USDC" value={bal.data ? (bal.data.usdc === null ? '0.00' : <span data-testid="usdc">{usdc(bal.data.usdc)}</span>) : '—'} chip="fork" />
          <KV rows={[['SOL', bal.data ? num(bal.data.sol, 4) : '—'], [pick, xBal.data != null ? fixed(xBal.data, 8, 4) : '0']]} />
          <Note icon="alert">These balances exist only on your local fork. Nothing here touches mainnet or anyone&apos;s real funds.</Note>
        </aside>
      </div>
    </>
  );
}
