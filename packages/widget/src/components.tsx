// The widget's parts. They show what the SDK and the program produced; none of them computes a price or a risk.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Connection } from '@solana/web3.js';
import { type RiskView, wadPct } from '@credence/sdk';
import { buildPurchase } from './build';
import { fmtAge, fmtUsdc, shortSig } from './format';
import { loadPosition, type ProtectState } from './load';
import { purchase, type PurchaseResult } from './purchase';
import { quoteFor, type WidgetQuote } from './quote';
import { followPolicy, type PolicyEvent } from './status';
import type { ForkUpkeep, WalletLike } from './types';
import { toPublicKey } from './inputs';

const POLICY_STATE = ['active', 'settled', 'refunded'] as const;
const msg = (e: unknown) => (e instanceof Error ? e.message : 'something went wrong');

/** The 24/7 price vs the Friday close, and whether the lender's price is still frozen and for how long. */
export function GapLine({ state }: { state: ProtectState }) {
  const f = state.feed;
  if (!f) return <p className="cr-muted" data-testid="gap-line">No Gap Oracle feed for {state.ticker} on this cluster.</p>;
  const frozenFor = fmtAge(state.now - f.lenderSinceTs);
  return (
    <section aria-labelledby={useId()} className="cr-block" data-testid="gap-line">
      <h3 className="cr-h">The weekend gap, {state.ticker}</h3>
      <dl className="cr-dl">
        <dt>24/7 price vs the Friday close</dt><dd data-testid="gap-fair">{wadPct(f.impliedGapFair)}</dd>
        <dt>Lender’s price vs the Friday close</dt><dd data-testid="gap-lender">{wadPct(f.impliedGapLender)}</dd>
        <dt>Lender’s price</dt>
        <dd data-testid="gap-frozen">{f.lenderFrozen ? `still frozen: unchanged for ${frozenFor}` : `has moved (last change ${frozenFor} ago)`}</dd>
      </dl>
      {state.feedProblems.length > 0 && <p className="cr-warn" role="note">Do not rely on this feed: {state.feedProblems.join('; ')}.</p>}
    </section>
  );
}

/** D/C′, the chance the position is liquidatable this weekend, and what a −5/−8/−12% Monday would need repaid. */
export function RiskTable({ risk }: { risk: RiskView }) {
  return (
    <section className="cr-block" data-testid="risk-table">
      <h3 className="cr-h">Risk this weekend</h3>
      <table className="cr-table">
        <caption className="cr-sr">Position risk, from the program’s own rules</caption>
        <tbody>
          <tr><th scope="row">Debt ÷ liquidation value (D/C′)</th><td data-testid="d-over-c">{risk.debtOverCoveredWad === null ? 'n/a' : wadPct(risk.debtOverCoveredWad)}</td></tr>
          <tr><th scope="row">Liquidatable in the model’s weekend scenarios</th><td data-testid="p-liq">{risk.pays.count} of {risk.pays.n}</td></tr>
          {risk.repay.map((r) => (
            <tr key={r.bps}><th scope="row">Repay to stay clear if Monday opens {r.bps / 100}%</th><td data-testid={`repay-${r.bps}`}>{fmtUsdc(r.amount)} USDC</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type Choice = { id: string; label: string; payout: bigint };

/** The quote and the buy. The quote is simulated; pressing the button builds, simulates, then asks the wallet. */
export function QuoteBuy({ connection, wallet, state, slippageBps = 100, onBought }: {
  connection: Connection; wallet: WalletLike | null | undefined; state: ProtectState; slippageBps?: number; onBought?: (r: PurchaseResult) => void;
}) {
  const risk = state.risk;
  const choices = useMemo<Choice[]>(() => risk ? [
    { id: 'full', label: 'Full debt', payout: risk.debt },
    ...risk.repay.slice(1).map((r) => ({ id: String(r.bps), label: `What a ${r.bps / 100}% Monday would need`, payout: r.amount })),
  ].filter((c) => c.payout > 0n) : [], [risk]);
  const [pick, setPick] = useState('full');
  const [quote, setQuote] = useState<WidgetQuote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<PurchaseResult | null>(null);
  const seq = useRef(0);
  const chosen = choices.find((c) => c.id === pick) ?? choices[0];
  const legend = useId();

  useEffect(() => {
    if (!chosen) return;
    const n = ++seq.current;
    setQuote(null); setErr(null);
    quoteFor(connection, state, chosen.payout, slippageBps).then((q) => { if (n === seq.current) setQuote(q); }, (e) => { if (n === seq.current) setErr(msg(e)); });
  }, [connection, state, chosen, slippageBps]);

  const connected = !!wallet?.publicKey;
  const isOwner = connected && wallet!.publicKey!.equals(state.owner);
  const buy = useCallback(async () => {
    if (!wallet || !quote) return;
    setBusy(true); setErr(null);
    try {
      const built = await buildPurchase(connection, state, wallet.publicKey!, quote);
      const r = await purchase(connection, wallet, built);
      setDone(r); onBought?.(r);
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  }, [connection, state, wallet, quote, onBought]);

  if (!risk || !chosen) return null;
  return (
    <section className="cr-block" data-testid="quote-buy">
      <h3 className="cr-h">Gap protection for this weekend</h3>
      <fieldset className="cr-fieldset">
        <legend id={legend}>Pays up to</legend>
        {choices.map((c) => (
          <label key={c.id} className="cr-choice">
            <input type="radio" name={`cr-cap-${legend}`} checked={c.id === chosen.id} onChange={() => setPick(c.id)} />
            <span>{c.label}: {fmtUsdc(c.payout)} USDC</span>
          </label>
        ))}
      </fieldset>
      <p aria-live="polite" data-testid="premium">
        {quote ? <>Premium <strong>{fmtUsdc(quote.premium)} USDC</strong> (the program’s quote; you will sign for at most {fmtUsdc(quote.maxPremium)}).</> : err ? null : 'Quoting…'}
      </p>
      <button type="button" className="cr-btn" disabled={!quote || busy || !isOwner || !!done} onClick={buy}>
        {busy ? 'Waiting for your wallet…' : 'Buy cover'}
      </button>
      {!connected && <p className="cr-muted">Connect the position’s owner wallet to buy.</p>}
      {connected && !isOwner && <p className="cr-muted">This wallet is not the position’s owner: the program sells cover to the owner only.</p>}
      {err && <p className="cr-err" role="alert">{err}</p>}
      {done && (
        <p role="status" data-testid="bought">Bought. Transaction <code>{shortSig(done.signature)}</code>, {done.cu.toLocaleString('en-US')} compute units.</p>
      )}
    </section>
  );
}

/** The policy, Shield advances and settlement: the account, plus the events its transactions emitted. */
export function CoverStatus({ connection, state, refresh = 0 }: { connection: Connection; state: ProtectState; refresh?: number }) {
  const [events, setEvents] = useState<PolicyEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const key = state.policy?.key;
  useEffect(() => {
    if (!key) return;
    let live = true;
    const tick = () => followPolicy(connection, key).then((e) => { if (live) { setEvents(e); setErr(null); } }, (e) => { if (live) setErr(msg(e)); });
    void tick();
    const t = setInterval(tick, 5_000);
    return () => { live = false; clearInterval(t); };
  }, [connection, key, refresh]);
  const p = state.policy;
  if (!p) return null;
  return (
    <section className="cr-block" data-testid="cover-status">
      <h3 className="cr-h">Your cover</h3>
      <dl className="cr-dl">
        <dt>State</dt><dd data-testid="policy-state">{POLICY_STATE[p.state] ?? 'unknown'}</dd>
        <dt>Pays up to</dt><dd>{fmtUsdc(p.maxPayout)} USDC</dd>
        <dt>Premium paid</dt><dd>{fmtUsdc(p.premium)} USDC</dd>
        {p.state === 1 && <><dt>Paid out</dt><dd data-testid="policy-payout">{fmtUsdc(p.payout)} USDC</dd></>}
      </dl>
      {events.length > 0 && (
        <ol className="cr-events" aria-label="Policy events">
          {events.map((e) => <li key={`${e.signature}${e.name}`}><strong>{e.name}</strong> <code>{shortSig(e.signature)}</code></li>)}
        </ol>
      )}
      {err && <p className="cr-err" role="alert">{err}</p>}
    </section>
  );
}

export type CredenceProtectProps = {
  connection: Connection;
  wallet?: WalletLike | null;
  position: unknown;
  lender: unknown;
  slippageBps?: number;
  upkeep?: ForkUpkeep;
  theme?: 'light' | 'dark' | 'auto';
  className?: string;
  onBought?: (r: PurchaseResult) => void;
  children?: ReactNode;
};

/** The whole widget: a position’s gap line, risk, quote/buy and cover status. */
export function CredenceProtect({ connection, wallet, position, lender, slippageBps = 100, upkeep, theme = 'auto', className, onBought }: CredenceProtectProps) {
  const [state, setState] = useState<ProtectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    loadPosition(connection, { position, lender, upkeep }).then((s) => { if (live) setState(s); }, (e) => { if (live) { setState(null); setError(msg(e)); } });
    return () => { live = false; };
  }, [connection, position, lender, upkeep, reload]);

  // The wallet's key must be this widget's PublicKey class too (a second copy of web3.js in the host fails loudly here).
  let walletError: string | null = null;
  if (wallet?.publicKey) { try { toPublicKey(wallet.publicKey, 'wallet public key'); } catch (e) { walletError = msg(e); } }

  return (
    <div className={`cr-root ${className ?? ''}`} data-theme={theme === 'auto' ? undefined : theme}>
      <header className="cr-head">
        <h2 className="cr-title">Credence gap protection</h2>
        <span className="cr-badge" title="Credence is not deployed on mainnet; this runs on a local mainnet fork">fork</span>
      </header>
      {(error ?? walletError) && <p className="cr-err" role="alert">{error ?? walletError}</p>}
      {!error && !state && <p className="cr-muted" role="status">Loading the position…</p>}
      {state && !walletError && (
        <>
          <GapLine state={state} />
          {state.saleNote && <p className="cr-muted">{state.saleNote}</p>}
          {state.bookLeg && <p className="cr-muted">A curator’s book holds this position’s cover; buying your own cover releases it from the book first.</p>}
          {state.risk && <RiskTable risk={state.risk} />}
          <QuoteBuy connection={connection} wallet={wallet} state={state} slippageBps={slippageBps} onBought={(r) => { onBought?.(r); setReload((n) => n + 1); }} />
          <CoverStatus connection={connection} state={state} refresh={reload} />
        </>
      )}
    </div>
  );
}
