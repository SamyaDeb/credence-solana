'use client';
// Gap cover for one position: the loss table at −5/−8/−12% (the program's payout rule, golden-tested), the chance a
// policy pays anything (the on-chain scenario set and real closures since 2016), and Buy: quote_cover in a simulation,
// then refresh_reserve ×2 + refresh_obligation + buy_cover in one transaction, the Policy read back. One policy per
// position and weekend: if this weekend's Policy PDA exists, Buy is disabled and the card says whose it is (A-13).
import { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { type EpochView, type PolicyView, type Quote, buyCoverIxs, currentEpoch, freshenScope, policyView, scopeChains, simulateQuote } from '@/lib/cover';
import { POLICY_NAME, pdas } from '@/lib/credence';
import { IS_MAINNET, ON_LOCAL_FORK, READ_ONLY_NOTE } from '@/lib/network';
import { et, fixed, pct, short, usdc, usdc6, wad } from '@/lib/format';
import { useAssets } from '@/lib/hooks/chain';
import type { Position } from '@/lib/hooks/positions';
import { useSend } from '@/lib/hooks/send';
import { borrows, decodeObligation, deposits, loadReserves } from '@/lib/kamino';
import { type History, historyPays, loadHistory, modelPays, oddsPct } from '@/lib/odds';
import { payoutAtGap } from '@/lib/payout';
import { useScenarioZ } from '@/lib/hooks/markets';
import { usePrefs } from '@/lib/prefs';
import { SendStatus } from './actions';
import { useSolana } from './Providers';
import { Note, Sim } from './ui';

/** The epoch's closure type (W11): OVERNIGHT 1, WEEKEND 2, HOLIDAY_WEEKEND 3. */
const CLOSURE_LABEL: Record<number, string> = { 1: 'Overnight', 2: 'Weekend', 3: 'Holiday weekend' };

export const GAPS = [-500, -800, -1200];
const onFork = ON_LOCAL_FORK;

export function useHistory() {
  return useQuery<History>({ queryKey: ['history'], queryFn: loadHistory, staleTime: Infinity });
}

export type Odds = { model: ReturnType<typeof modelPays>; hist: number; closures: number; from: string; sigma: number };

/** The chance a policy on (C′, D) pays anything: the asset's WEEKEND set at its σ, and real closures since 2016. */
export function useOdds() {
  const assets = useAssets();
  const z = useScenarioZ(assets.data);
  const hist = useHistory();
  return useMemo(() => (ticker: string, coveredValue: bigint, debt: bigint): Odds | null => {
    const a = assets.data?.find((x) => x.ticker === ticker);
    const zs = z.data?.[ticker];
    if (!a || !zs || !hist.data?.gaps[ticker] || coveredValue === 0n) return null;
    return { model: modelPays(zs, a.sigmaWad, coveredValue, debt), hist: historyPays(hist.data.gaps[ticker], coveredValue, debt),
      closures: hist.data.closures[ticker], from: hist.data.from, sigma: Number(a.sigmaWad) / 1e18 };
  }, [assets.data, z.data, hist.data]);
}

export function PayOdds({ o, coveredValue, debt, ticker, compact }: { o: Odds | null; coveredValue: bigint; debt: bigint; ticker: string; compact?: boolean }) {
  if (!o) return null;
  if (compact) return <span title={`model: ${o.model.count} of ${o.model.n} scenarios; history: ${o.hist} of ${o.closures} closures since ${o.from}`}>{oddsPct(o.model.p)} · {o.hist}/{o.closures}</span>;
  const be = Number(debt) / Number(coveredValue) - 1;
  return (
    <div className="cx-odds" data-testid="pay-odds">
      <div>Chance this pays anything this weekend: <b>{oddsPct(o.model.p)}</b> · <b>{o.hist} of {o.closures}</b> market closures since {o.from?.slice(0, 7)} would have paid</div>
      <p className="cx-hint">Model: {o.model.count} of {o.model.n} scenarios gap below {pct(be, 1)} at σ {(o.sigma * 100).toFixed(2)}%. History: {ticker.replace(/x$/, '')} opening gaps, daily bars. A small premium buys a rare, large payout.</p>
    </div>
  );
}

export function LossTable({ p, cap }: { p: Position; cap: bigint }) {
  const s = p.snap;
  if (!s) return null;
  return (
    <div className="cx-table-wrap">
      <table className="cx-table is-keep" data-testid="loss-table">
        <thead><tr><th>Gap at the open</th><th className="is-num">Collateral at open</th><th className="is-num">Debt / C′</th><th className="is-num">Repay needed</th><th className="is-num">Paid by cover</th></tr></thead>
        <tbody>
          {GAPS.map((g) => {
            const need = payoutAtGap(s.coveredValue, s.debt, s.debt, g);
            const paid = payoutAtGap(s.coveredValue, s.debt, cap, g);
            const r2 = Number(s.debt) / (Number(s.coveredValue) * (1 + g / 10_000));
            return (
              <tr key={g}>
                <td className="is-strong" data-label="Gap at the open">{pct(g / 10_000, 0)}</td>
                <td className="is-num" data-label="Collateral at open">${usdc((s.collateralValue * BigInt(10_000 + g)) / 10_000n)}</td>
                <td className="is-num" data-label="Debt / C′"><span className={r2 >= 1 ? 'cx-bad' : undefined}>{r2.toFixed(4)}{r2 >= 1 ? ' liquidatable' : ''}</span></td>
                <td className="is-num" data-label="Repay needed">{usdc(need)}</td>
                <td className="is-num is-strong" data-label="Paid with this cover">{usdc(paid)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="cx-hint">Payout = min(cap, max(0, D − C′ × open/close)), the program&apos;s rule (credence_core realized_payout, golden-tested). Values from klend&apos;s refresh, simulated on the fork; USDC rounded to cents, exact amounts are on-chain.</p>
    </div>
  );
}

/** This weekend's policy on the obligation, if one exists (["policy", epoch, obligation]). */
export function useExistingPolicy(epoch: EpochView | undefined, obligation: PublicKey) {
  const { prog } = useSolana();
  const addr = epoch ? pdas.policy(epoch.key, obligation) : null;
  return useQuery<PolicyView | null>({
    queryKey: ['policy-at', addr?.toBase58()],
    enabled: !!addr,
    queryFn: async () => {
      const a = await prog.account.policy.fetchNullable(addr!, 'confirmed');
      return a ? policyView({ publicKey: addr!, account: a }) : null;
    },
    refetchInterval: 10_000,
  });
}

const cents = (x: bigint) => fixed(x - (x % 10_000n), 6, 2).replace(/,/g, '');

export function CoverPanel({ p, epochs, now, cap, setCap }: { p: Position; epochs: EpochView[]; now: number | null; cap: string; setCap: (v: string) => void }) {
  const { conn, prog, signer } = useSolana();
  const odds = useOdds();
  const send = useSend();
  const s = p.snap;
  const epoch = p.asset && now !== null ? currentEpoch(epochs, p.asset.ticker, now) : undefined;
  const existing = useExistingPolicy(epoch, p.key);
  const [prefs] = usePrefs();
  const [slip, setSlip] = useState<number | null>(null);
  const slippage = slip ?? prefs.slippage;
  const [bought, setBought] = useState<PolicyView | null>(null);

  // The cap starts at the full debt (once there is one); the user can lower it.
  useEffect(() => { if (s && s.debt > 0n && (cap === '' || Number(cap) === 0)) setCap(cents(s.debt)); }, [s, cap, setCap]);
  const capBase = useMemo(() => {
    const x = Number(cap);
    const b = Number.isFinite(x) && x > 0 ? BigInt(Math.round(x * 1e6)) : 0n;
    return s && b > s.debt ? s.debt : b;
  }, [cap, s]);

  const quote = useQuery<Quote>({
    queryKey: ['quote', p.key.toBase58(), epoch?.closureId, capBase.toString(), s?.debt.toString(), s?.coveredValue.toString()],
    enabled: !!s && !!p.asset && !!epoch && !!signer && !p.why && capBase > 0n,
    queryFn: () => simulateQuote(conn, prog, signer!.publicKey, p.asset!, epoch!, s!.coveredValue, s!.debt, capBase),
    staleTime: 15_000,
    retry: false,
  });
  const q = quote.data;
  const maxPremium = q ? q.premium + (q.premium * BigInt(slippage * 100) + 9_999n) / 10_000n + 10_000n : 0n;

  async function buy() {
    if (!signer || !p.asset || !epoch || !q) return;
    setBought(null);
    let policy: PublicKey | null = null;
    const ok = await send.run('Refreshing klend and buying', [{
      label: 'refresh_reserve ×2 + refresh_obligation + buy_cover',
      ixs: async () => {
        // Fresh state right before signing: Scope restamped on the fork, obligation and reserves re-read.
        if (onFork) await freshenScope(scopeChains([...p.reserves.values()]));
        const [obAcc, reserves, vault] = await Promise.all([
          conn.getAccountInfo(p.key, 'confirmed'), loadReserves(conn, [...deposits(p.state), ...borrows(p.state)]), prog.account.vault.fetch(pdas.vault()),
        ]);
        const built = await buyCoverIxs(prog, signer.publicKey, p.asset!, epoch, p.key, decodeObligation(obAcc!.data as Buffer), reserves, vault.feeAccount, capBase, maxPremium);
        policy = built.policy;
        return built.ixs;
      },
    }]);
    if (ok && policy) setBought(policyView({ publicKey: policy, account: await prog.account.policy.fetch(policy, 'confirmed') }));
  }

  if (!s) return <Note icon="alert" tone="bad">{p.freshErr ?? 'Refreshing the position…'}</Note>;
  if (p.why) return <Note icon="lock">Phase 1 covers one xStock deposit against one USDC borrow. Not eligible: {p.why}.</Note>;
  if (IS_MAINNET) return <Note icon="lock">{READ_ONLY_NOTE}</Note>;
  if (!epoch) return <div data-testid="sales-closed"><Note icon="clock" tone="warn">Sales are closed for the coming weekend: they close at the bell, 15 minutes before Friday&apos;s close.</Note></div>;
  const have = existing.data;
  const o = p.asset ? odds(p.asset.ticker, s.coveredValue, s.debt) : null;

  return (
    <div className="cx-cover" data-testid="cover">
      <p className="cx-page-sub" style={{ margin: 0 }}>{CLOSURE_LABEL[epoch.closureType ?? 2] ?? 'Closure'} {epoch.closureId}: bell {et(epoch.bell)} · close {et(epoch.close)} → open {et(epoch.open)}</p>
      <div className="cx-field">
        <span className="cx-field-label">Max payout</span>
        <label className="cx-amount">
          <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d.]/g, ''))} data-testid="max-payout" />
          <span>USDC</span>
        </label>
        <div className="cx-quick">
          <button type="button" onClick={() => { const need = payoutAtGap(s.coveredValue, s.debt, s.debt, -1200); setCap(need > 0n ? cents(need + 9_999n) : cents(s.debt)); }}>−12% need</button>
          <button type="button" onClick={() => setCap(cents(s.debt))}>Full debt</button>
        </div>
      </div>
      <div>
        <div className="cx-stat-label">Premium (quote_cover, simulated)</div>
        <div className="cx-stat-value" data-testid="premium">{q ? `${usdc(q.premium)} USDC` : quote.error ? '—' : '…'}</div>
        {q && <p className="cx-hint cx-mono">{usdc6(q.premium)} USDC · {(Number(q.premium) / Number(capBase) * 100).toFixed(3)}% of the cap · worst-scenario loss {usdc(q.worstLoss)} · vault utilisation after {(Number(q.utilAfterWad) / 1e16).toFixed(2)}% · {q.cu.toLocaleString('en-US')} CU</p>}
        {q && p.asset && <PayOdds o={o} coveredValue={s.coveredValue} debt={s.debt} ticker={p.asset.ticker} />}
        {quote.error && <p className="cx-hint is-bad">{(quote.error as Error).message}</p>}
      </div>
      <div className="cx-field">
        <span className="cx-field-label">Slippage · max premium <b className="cx-mono">{q ? usdc6(maxPremium) : '…'}</b> USDC</span>
        <div className="cx-seg" role="group" aria-label="Slippage">
          {[1, 2, 5].map((x) => <button key={x} type="button" aria-pressed={slippage === x} onClick={() => setSlip(x)}>{x}%</button>)}
        </div>
      </div>
      <button type="button" className="cx-btn" aria-disabled={!q || !!send.busy || !!have || undefined} disabled={!q || !!send.busy || !!have} onClick={buy} data-testid="buy">
        {send.busy ? 'Refreshing klend and buying…' : q ? `Buy gap cover for ${usdc(q.premium)} USDC` : 'Buy gap cover'}
      </button>
      <p className="cx-hint">One transaction: refresh_reserve ×2, refresh_obligation, buy_cover. {onFork && <Sim>fork: Kamino&apos;s Scope times moved to the fork clock first (prices unchanged)</Sim>}</p>
      <SendStatus s={send} testId="buy" />
      {bought && <PolicyResult p={bought} />}
      {!bought && have && (
        <p className="cx-hint" data-testid="existing-policy">
          {signer && have.owner.equals(signer.publicKey) ? `You already hold policy ${short(have.key, 6)} on this weekend for this position (cap ${usdc(have.maxPayout)} USDC).`
            : `This position already has policy ${short(have.key, 6)} for this weekend, bought by ${short(have.owner, 4)} before it changed owner.`} One policy per position and weekend.
        </p>
      )}
    </div>
  );
}

function PolicyResult({ p }: { p: PolicyView }) {
  return (
    <div className="cx-result" data-testid="policy-result">
      <b>Policy on-chain</b>
      <dl className="cx-kv">
        {([
          ['Policy', <span key="p" className="cx-mono" data-testid="policy-address">{p.key.toBase58()}</span>],
          ['State', POLICY_NAME[p.state]],
          ['Covered value C′', `${usdc6(p.coveredValue)} USDC`],
          ['Debt at purchase', `${usdc6(p.debt)} USDC`],
          ['Liquidation threshold', wad(p.ltWad, 6)],
          ['Max payout', `${usdc6(p.maxPayout)} USDC`],
          ['Premium (fee incl.)', <span key="pr" data-testid="policy-premium">{usdc6(p.premium)} USDC (fee {usdc6(p.fee)})</span>],
          ['Worst-scenario loss', `${usdc6(p.worstLoss)} USDC`],
        ] as [string, React.ReactNode][]).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <p className="cx-hint">Read back from the Policy account on the fork after confirmation.</p>
    </div>
  );
}
