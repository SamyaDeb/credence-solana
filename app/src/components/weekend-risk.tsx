'use client';
// "My weekend risk" (task 4.2): the wallet's Kamino xStocks positions read live from the fork, what a Monday gap does
// to each, and gap protection bought in one transaction. Numbers come from the chain (klend's refresh, simulated) or
// from a simulated program instruction (quote_cover); the loss table uses the payout rule ported from
// credence_core::pricing::realized_payout and pinned by a golden test.
import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type Asset, type EpochView, type PolicyView, type Quote, buyCoverIxs, currentEpoch, freshenScope, loadAssets, loadEpochs,
  policiesOf, policyView, reserveToAsset, salesState, scopeChains, simulateQuote,
} from '@/lib/cover';
import { EPOCH_NAME, POLICY_NAME, SCOPE_PRICES, XSTOCKS_MARKETS, chainNow, decodeScope, pdas } from '@/lib/credence';
import { dur, et, fixed, pct, short, usdc, usdc6, wad } from '@/lib/format';
import {
  type ObligationState, type ReserveState, borrows, deposits, ineligibility, loadReserves, obligationsOf, simulateRefreshed, snapshot,
} from '@/lib/kamino';
import { payoutAtGap } from '@/lib/payout';
import { TxError, redact, sendTx } from '@/lib/tx';
import { useApp } from './providers';

const GAPS = [-500, -800, -1200];

type Pos = {
  key: PublicKey;
  state: ObligationState;
  fresh: ObligationState | null;
  freshErr?: string;
  asset: Asset | undefined;
  reserves: Map<string, ReserveState>;
  why: string | null;
  snap: ReturnType<typeof snapshot> | null;
  scopePrice: number | null;
};

export function WeekendRisk() {
  const { conn, prog, signer, version, bump } = useApp();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [epochs, setEpochs] = useState<EpochView[]>([]);
  const [positions, setPositions] = useState<Pos[] | null>(null);
  const [policies, setPolicies] = useState<PolicyView[]>([]);
  const [now, setNow] = useState(0);
  const [err, setErr] = useState('');
  const [taken, setTaken] = useState<Record<string, string>>({});
  const [aligned, setAligned] = useState(false);

  // Chain clock: read every 5 s, ticked locally in between for the countdown.
  useEffect(() => {
    let live = true;
    const read = () => chainNow(conn).then((t) => live && setNow(t)).catch(() => {});
    void read();
    const a = setInterval(read, 5000);
    const b = setInterval(() => setNow((t) => (t ? t + 1 : t)), 1000);
    return () => { live = false; clearInterval(a); clearInterval(b); };
  }, [conn, version]);

  useEffect(() => {
    try { setTaken(JSON.parse(localStorage.getItem('credence.taken') ?? '{}')); } catch { /* ignore */ }
  }, [version]);

  const load = useCallback(async () => {
    setErr('');
    try {
      const [as, es] = await Promise.all([loadAssets(prog), loadEpochs(prog)]);
      setAssets(as); setEpochs(es);
      if (!signer) { setPositions(null); return; }
      const byReserve = reserveToAsset(as);
      const obs = await obligationsOf(conn, signer.publicKey);
      const reserves = await loadReserves(conn, obs.flatMap((o) => [...deposits(o.state), ...borrows(o.state)]));
      const chains = scopeChains([...reserves.values()]);
      if (chains.length) { const f = await freshenScope(chains); if (f.pairs.some((x) => x.twapAligned)) setAligned(true); }
      const scope = (await conn.getAccountInfo(SCOPE_PRICES))?.data;
      const out: Pos[] = [];
      for (const o of obs) {
        const asset = byReserve.get(deposits(o.state)[0]?.toBase58() ?? '');
        const why = ineligibility(o.state, reserves, new Map([...byReserve].map(([k, v]) => [k, v.ticker])));
        let fresh: ObligationState | null = null; let freshErr: string | undefined;
        try { fresh = (await simulateRefreshed(conn, signer.publicKey, o.key, o.state, reserves)).state; } catch (e) { freshErr = (e as Error).message; }
        out.push({ key: o.key, state: o.state, fresh, freshErr, asset, reserves, why, snap: fresh ? snapshot(fresh) : null,
          scopePrice: asset && scope ? decodeScope(scope, asset.scopeChain).price : null });
      }
      out.sort((a, b) => Number((b.snap?.debt ?? 0n) - (a.snap?.debt ?? 0n)));
      setPositions(out);
      setPolicies(await policiesOf(prog, signer.publicKey));
    } catch (e) {
      setErr(redact((e as Error).message));
    }
  }, [conn, prog, signer]);

  useEffect(() => { void load(); }, [load, version]);

  const group = useMemo(() => {
    const open = epochs.filter((e) => e.state === 0 && now < e.bell);
    return open.length ? Math.min(...open.map((e) => e.closureId)) : null;
  }, [epochs, now]);
  const groupEpoch = epochs.find((e) => e.closureId === group);

  return (
    <div className="stack">
      <div>
        <h1>My weekend risk</h1>
        <p className="lede">
          Your Kamino xStocks positions, what a Monday gap does to them, and gap protection bought before the bell.
          The payout goes into your position after the open. Phase 1 pays after the open, and Kamino's price can move
          earlier in pre-market (plan/09, S7).
        </p>
      </div>

      {groupEpoch && <SalesStrip e={groupEpoch} now={now} />}
      {aligned && <div className="note"><span className="sim">fork: after a simulated gap, Kamino&apos;s Scope TWAP was set to the spot price so klend accepts it (a real TWAP converges within days)</span></div>}

      {!signer && <div className="panel">Connect Phantom or use the demo burner wallet (top right) to see your positions.</div>}
      {err && <div className="panel err">{err}</div>}

      {signer && positions && positions.length === 0 && (
        <div className="panel">This wallet has no xStocks positions on the fork. Take a real one below, or create a bigger one in Demo mode.</div>
      )}
      {signer && positions?.map((p) => (
        <PositionCard key={p.key.toBase58()} p={p} epochs={epochs} now={now} realOwner={taken[p.key.toBase58()]}
          onBought={() => { bump(); }} />
      ))}

      {signer && policies.length > 0 && <Policies rows={policies} epochs={epochs} />}

      {signer && <RealPositions onTaken={() => { bump(); }} owner={signer.publicKey} />}
    </div>
  );
}

function SalesStrip({ e, now }: { e: EpochView; now: number }) {
  const s = salesState(e, now);
  return (
    <div className="panel row" style={{ justifyContent: 'space-between' }} data-testid="sales">
      <div>
        <h3 style={{ margin: 0 }}>Weekend {e.closureId}</h3>
        <div className="muted">Friday close {et(e.close)} → Monday open {et(e.open)}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <span className={`pill ${s.label === 'open' ? 'ok' : 'warn'}`}>sales {s.label}</span>
        {s.until && <div className="big" style={{ fontSize: 28 }}>{dur(s.until - now)}</div>}
        <div className="note">{s.label === 'open' ? `until the bell, ${et(e.bell)} (15 min before the close)` : s.label === 'not yet open' ? `opens ${et(e.saleOpen)}` : ''}</div>
      </div>
    </div>
  );
}

function PositionCard({ p, epochs, now, realOwner, onBought }: { p: Pos; epochs: EpochView[]; now: number; realOwner?: string; onBought: () => void }) {
  const { conn, prog, signer } = useApp();
  const s = p.snap;
  const market = XSTOCKS_MARKETS[p.state.lendingMarket] ?? 'other market';
  const epoch = p.asset ? currentEpoch(epochs, p.asset.ticker, now) : undefined;
  const ratio = s && s.coveredValue > 0n ? Number(s.debt) / Number(s.coveredValue) : null;
  const [cap, setCap] = useState('');
  const [slip, setSlip] = useState(2);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [qErr, setQErr] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<{ signature: string; cu: number; cuLimit: number; policy: PolicyView } | null>(null);
  const [bErr, setBErr] = useState('');

  // Caps are shown rounded DOWN to cents (max_payout must be ≤ the debt) and clamped to the current debt.
  const cents = (x: bigint) => fixed(x - (x % 10_000n), 6, 2).replace(/,/g, '');
  useEffect(() => { if (s && cap === '') setCap(cents(s.debt)); }, [s, cap]);
  const capBase = useMemo(() => {
    const x = Number(cap);
    const b = Number.isFinite(x) && x > 0 ? BigInt(Math.round(x * 1e6)) : 0n;
    return s && b > s.debt ? s.debt : b;
  }, [cap, s]);

  // Quote: the program's quote_cover in a simulation, re-run when the cap changes.
  useEffect(() => {
    if (!s || !p.asset || !epoch || !signer || p.why || capBase === 0n) { setQuote(null); return; }
    let live = true;
    setQErr('');
    const t = setTimeout(() => {
      simulateQuote(conn, prog, signer.publicKey, p.asset!, epoch.closureId, s.coveredValue, s.debt, capBase)
        .then((q) => live && setQuote(q))
        .catch((e) => live && (setQuote(null), setQErr((e as Error).message)));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [conn, prog, signer, s, p.asset, p.why, epoch, capBase]);

  const maxPremium = quote ? quote.premium + (quote.premium * BigInt(slip * 100) + 9_999n) / 10_000n + 10_000n : 0n;

  async function buy() {
    if (!signer || !p.asset || !epoch || !quote) return;
    setBusy('buy'); setBErr(''); setResult(null);
    try {
      // Fresh state right before signing: Scope restamped on the fork, obligation and reserves re-read.
      await freshenScope(scopeChains([...p.reserves.values()]));
      const [obAcc, reserves, vault] = await Promise.all([
        conn.getAccountInfo(p.key, 'confirmed'),
        loadReserves(conn, [...deposits(p.state), ...borrows(p.state)]),
        prog.account.vault.fetch(pdas.vault()),
      ]);
      const { decodeObligation } = await import('@/lib/kamino');
      const o = decodeObligation(obAcc!.data as Buffer);
      const { ixs, policy } = await buyCoverIxs(prog, signer.publicKey, p.asset, epoch, p.key, o, reserves, vault.feeAccount, capBase, maxPremium);
      const r = await sendTx(conn, signer, ixs);
      const pol = policyView({ publicKey: policy, account: await prog.account.policy.fetch(policy, 'confirmed') });
      setResult({ signature: r.signature, cu: r.cu, cuLimit: r.cuLimit, policy: pol });
      onBought();
    } catch (e) {
      setBErr(e instanceof TxError ? `${e.stage === 'simulate' ? 'Simulation' : 'Transaction'} failed: ${e.message}` : redact((e as Error).message));
    } finally {
      setBusy('');
    }
  }

  const existing = epoch && signer ? pdas.policy(epoch.key, signer.publicKey, p.key).toBase58() : '';

  return (
    <div className="panel" data-testid="position">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>{p.asset?.ticker ?? 'xStock'} position</h2>
          <span className="muted">{market}</span>
          <a className="mono faint" title={p.key.toBase58()}>obligation {short(p.key, 6)}</a>
          {p.why ? <span className="pill bad" data-testid="ineligible">not eligible: {p.why}</span> : <span className="pill ok">eligible for gap protection</span>}
        </div>
        {realOwner && <span className="sim" title={`Real mainnet obligation; its owner field (${realOwner}) was rewritten on the fork to this wallet`}>real mainnet position, owner rewritten on the fork</span>}
        {!realOwner && p.state.lendingMarket && <CreatedLabel obligation={p.key.toBase58()} />}
      </div>

      {p.freshErr && <div className="err">{p.freshErr}</div>}
      {s && (
        <div className="grid g4" style={{ marginBottom: 18 }}>
          <div className="stat"><div className="k">Collateral value</div><div className="v">${usdc(s.collateralValue)}</div>
            <div className="s">{p.scopePrice ? `${p.asset?.ticker} @ $${p.scopePrice.toFixed(4)} (Kamino Scope)` : ''}</div></div>
          <div className="stat"><div className="k">USDC debt</div><div className="v" data-testid="debt">{usdc(s.debt)}</div><div className="s">{usdc6(s.debt)} (rounded up, as buy_cover)</div></div>
          <div className="stat"><div className="k">Debt / C′ (C′ = LT × collateral)</div><div className="v" data-testid="ratio">{ratio?.toFixed(4)}</div>
            <div className="s">liquidation at 1.0000; C′ ${usdc(s.coveredValue)}</div></div>
          <div className="stat"><div className="k">Liquidation threshold</div><div className="v">{wad(s.ltWad * 100n, 2)}%</div><div className="s">klend, from the refresh</div></div>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1.15fr 1fr', gap: 22 }}>
        <div>
          <h3>If Monday opens…</h3>
          {s && (
            <table data-testid="loss-table">
              <thead><tr><th>Gap at the open</th><th className="r">Collateral at open</th><th className="r">Debt / C′</th><th className="r">Repay needed to stay healthy</th><th className="r">Paid with this cover</th></tr></thead>
              <tbody>
                {GAPS.map((g) => {
                  const need = payoutAtGap(s.coveredValue, s.debt, s.debt, g);
                  const paid = payoutAtGap(s.coveredValue, s.debt, capBase, g);
                  const r2 = Number(s.debt) / (Number(s.coveredValue) * (1 + g / 10_000));
                  return (
                    <tr key={g}>
                      <td><b>{pct(g / 10_000, 0)}</b></td>
                      <td className="r">${usdc((s.collateralValue * BigInt(10_000 + g)) / 10_000n)}</td>
                      <td className={`r ${r2 >= 1 ? 'bad' : ''}`}>{r2.toFixed(4)}{r2 >= 1 ? ' liquidatable' : ''}</td>
                      <td className="r">{usdc(need)}</td>
                      <td className="r accent">{usdc(paid)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="note" style={{ marginTop: 8 }}>
            Payout = min(cap, max(0, D − C′ × open/close)), the program's rule (credence_core realized_payout, golden-tested).
            Values from klend&apos;s refresh, simulated on the fork. USDC rounded to cents; exact amounts are on-chain.
          </div>
        </div>

        <div>
          <h3>Gap protection</h3>
          {p.why ? <div className="muted">Phase 1 covers one xStock deposit against one USDC borrow. {p.why}.</div> : !epoch ? (
            <div className="muted">Sales are closed for the coming weekend (they close at the bell, 15 minutes before Friday&apos;s close).</div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              <div className="muted">Weekend {epoch.closureId}: Friday close {et(epoch.close)} → Monday open {et(epoch.open)}</div>
              <label className="row">
                <span style={{ width: 150 }}>Max payout (USDC)</span>
                <input value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 160 }} data-testid="max-payout" />
                {s && <>
                  <button className="small" onClick={() => { const need = payoutAtGap(s.coveredValue, s.debt, s.debt, -1200); setCap(need > 0n ? cents(need + 9_999n) : cents(s.debt)); }}>−12% need</button>
                  <button className="small" onClick={() => setCap(cents(s.debt))}>full debt</button>
                </>}
              </label>
              <div>
                <div className="muted" style={{ fontSize: 12.5 }}>Premium (quote_cover, simulated)</div>
                <div className="big" data-testid="premium">{quote ? `${usdc(quote.premium)} USDC` : qErr ? '—' : '…'}</div>
                {quote && <div className="note mono">{usdc6(quote.premium)} USDC · {(Number(quote.premium) / Number(capBase) * 100).toFixed(3)}% of the cap · worst-scenario loss {usdc(quote.worstLoss)} · vault utilisation after {(Number(quote.utilAfterWad) / 1e16).toFixed(2)}% · {quote.cu.toLocaleString()} CU</div>}
                {qErr && <div className="err">{qErr}</div>}
              </div>
              <label className="row">
                <span style={{ width: 150 }}>Slippage</span>
                <select value={slip} onChange={(e) => setSlip(Number(e.target.value))}>
                  {[1, 2, 5].map((x) => <option key={x} value={x}>{x}%</option>)}
                </select>
                <span className="muted">max premium <b className="mono">{quote ? usdc6(maxPremium) : '…'}</b> USDC</span>
              </label>
              <button className="primary" disabled={!quote || !!busy} onClick={buy} data-testid="buy">
                {busy ? 'Refreshing klend and buying…' : quote ? `Buy gap protection for ${usdc(quote.premium)} USDC` : 'Buy gap protection'}
              </button>
              <div className="note">One transaction: refresh_reserve ×2, refresh_obligation, buy_cover. <span className="sim">fork: Kamino&apos;s Scope timestamps moved to the fork clock before the refresh (prices unchanged)</span></div>
              {bErr && <div className="err" data-testid="buy-error">{bErr}</div>}
              {result && <PolicyResult r={result} />}
              {!result && existing && <ExistingPolicy address={existing} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CreatedLabel({ obligation }: { obligation: string }) {
  const [created, setCreated] = useState(false);
  useEffect(() => {
    try { setCreated(JSON.parse(localStorage.getItem('credence.created') ?? '[]').includes(obligation)); } catch { /* ignore */ }
  }, [obligation]);
  return created ? <span className="sim">created on the fork (demo wallet deposited SPYx and borrowed USDC through klend)</span> : null;
}

function ExistingPolicy({ address }: { address: string }) {
  const { prog, version } = useApp();
  const [p, setP] = useState<PolicyView | null>(null);
  useEffect(() => {
    prog.account.policy.fetchNullable(address).then((a: unknown) => setP(a ? policyView({ publicKey: new PublicKey(address), account: a }) : null)).catch(() => {});
  }, [prog, address, version]);
  return p ? <div className="note">You already hold policy {short(p.key, 6)} on this weekend for this position (cap {usdc(p.maxPayout)} USDC); one policy per position and weekend.</div> : null;
}

function PolicyResult({ r }: { r: { signature: string; cu: number; cuLimit: number; policy: PolicyView } }) {
  const p = r.policy;
  return (
    <div className="result" data-testid="policy-result">
      <div className="row" style={{ justifyContent: 'space-between' }}><b className="accent">Policy on-chain</b><span className="mono">{r.cu.toLocaleString()} CU (limit {r.cuLimit.toLocaleString()})</span></div>
      <div className="kv" style={{ marginTop: 8 }}>
        <span>signature</span><span data-testid="signature">{r.signature}</span>
        <span>policy</span><span data-testid="policy-address">{p.key.toBase58()}</span>
        <span>state</span><span>{POLICY_NAME[p.state]}</span>
        <span>covered value C′</span><span>{usdc6(p.coveredValue)} USDC</span>
        <span>collateral value</span><span>{usdc6(p.collateralValue)} USDC</span>
        <span>debt at purchase</span><span>{usdc6(p.debt)} USDC</span>
        <span>liquidation threshold</span><span>{wad(p.ltWad, 6)}</span>
        <span>max payout</span><span>{usdc6(p.maxPayout)} USDC</span>
        <span>premium (fee incl.)</span><span data-testid="policy-premium">{usdc6(p.premium)} USDC (fee {usdc6(p.fee)})</span>
        <span>worst-scenario loss</span><span>{usdc6(p.worstLoss)} USDC</span>
      </div>
      <div className="note" style={{ marginTop: 6 }}>Read back from the Policy account on the fork after confirmation.</div>
    </div>
  );
}

function Policies({ rows, epochs }: { rows: PolicyView[]; epochs: EpochView[] }) {
  const byKey = new Map(epochs.map((e) => [e.key.toBase58(), e]));
  return (
    <div className="panel">
      <h2>Your policies</h2>
      <table data-testid="policies">
        <thead><tr><th>Policy</th><th>Asset</th><th>Weekend</th><th>Epoch</th><th>Policy state</th><th className="r">Max payout</th><th className="r">Premium</th><th className="r">Payout</th><th>Obligation</th></tr></thead>
        <tbody>
          {rows.map((p) => {
            const e = byKey.get(p.epoch.toBase58());
            return (
              <tr key={p.key.toBase58()}>
                <td className="mono">{short(p.key, 6)}</td><td>{p.ticker}</td><td>{e?.closureId}</td><td>{e ? EPOCH_NAME[e.state] : ''}</td>
                <td><span className={`pill ${p.state === 1 ? 'ok' : ''}`}>{POLICY_NAME[p.state]}</span></td>
                <td className="r">{usdc(p.maxPayout)}</td><td className="r">{usdc(p.premium)}</td>
                <td className="r accent" data-testid="policy-payout">{p.state === 1 ? usdc(p.payout) : '—'}</td>
                <td className="mono">{short(p.obligation, 6)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="note" style={{ marginTop: 6 }}>Settled payouts were repaid into the obligation by settle_policy (klend repay CPI), or sent to the wallet if the position was closed.</div>
    </div>
  );
}

function RealPositions({ owner, onTaken }: { owner: PublicKey; onTaken: () => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ generatedAt: string; eligible: number; total: number; rows: { obligation: string; owner: string; symbol: string; collateralUsd: number; debtUsd: number; debtToCovered: number; repayAtMinus8: number }[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open && !data) fetch('/api/positions/candidates').then((r) => r.json()).then((j) => (j.error ? setErr(j.error) : setData(j))).catch((e) => setErr(String(e)));
  }, [open, data]);

  async function take(obligation: string) {
    setBusy(obligation); setErr('');
    try {
      const r = await fetch('/api/fork/take-position', { method: 'POST', body: JSON.stringify({ obligation, owner: owner.toBase58() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      try {
        const m = JSON.parse(localStorage.getItem('credence.taken') ?? '{}');
        m[obligation] = j.realOwner;
        localStorage.setItem('credence.taken', JSON.stringify(m));
      } catch { /* ignore */ }
      onTaken();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>Use a real mainnet position <span className="sim">fork only</span></h2>
          <div className="note">Eligible near-threshold positions from the mainnet scan. One click rewrites the obligation&apos;s owner field on the fork to this wallet so it can sign buy_cover; collateral, debt, reserves and farms stay real.</div>
        </div>
        <button onClick={() => setOpen(!open)} data-testid="real-positions">{open ? 'Hide' : 'Show positions'}</button>
      </div>
      {err && <div className="err">{err}</div>}
      {open && data && (
        <>
          <div className="note" style={{ margin: '10px 0' }}>Scan of {new Date(data.generatedAt).toUTCString()}: {data.eligible} of {data.total} positions with USDC debt against SPYx/QQQx/NVDAx are eligible in Phase 1. Values below are from each obligation&apos;s last mainnet refresh; the card above shows them after a fresh klend refresh.</div>
          <table>
            <thead><tr><th>Obligation</th><th>Collateral</th><th className="r">Collateral $</th><th className="r">Debt $</th><th className="r">Debt / C′</th><th className="r">Repay need at −8%</th><th /></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.obligation}>
                  <td className="mono">{short(r.obligation, 6)}</td><td>{r.symbol}</td>
                  <td className="r">{r.collateralUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                  <td className="r">{r.debtUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                  <td className="r">{r.debtToCovered.toFixed(4)}</td><td className="r">{r.repayAtMinus8.toFixed(2)}</td>
                  <td className="r"><button className="small" disabled={!!busy} onClick={() => take(r.obligation)} data-testid={`take-${r.obligation}`}>{busy === r.obligation ? '…' : 'Use this position'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
