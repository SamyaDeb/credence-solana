'use client';
// Borrow: the wallet's Kamino xStocks positions read live from the fork, the Bell check before Friday's close (repay to
// safe, add collateral, or buy gap cover), the Kamino actions themselves (deposit collateral, borrow USDC, repay,
// withdraw; klend-sdk's v2 instructions with the refreshes in the same transaction), a new position, real mainnet
// positions to take on the fork, and the wallet's policies.
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { type Asset, type EpochView, freshenScope, scopeChains } from '@/lib/cover';
import { EPOCH_NAME, KLEND, POLICY, POLICY_NAME, SF_SHIFT, TOKEN_2022 } from '@/lib/credence';
import { IS_MAINNET, ON_LOCAL_FORK, READ_ONLY_NOTE } from '@/lib/network';
import { et, fixed, num, pct, short, usdc } from '@/lib/format';
import { useAssets, useClock, useEpochs } from '@/lib/hooks/chain';
import { useMarkets } from '@/lib/hooks/markets';
import { type Position, usePolicies, usePositions } from '@/lib/hooks/positions';
import { useSend } from '@/lib/hooks/send';
import { useBalances, useTokenBalance } from '@/lib/hooks/vault';
import { REFRESH_RESERVE } from '@/lib/kamino';
import { type KaminoActionName, buildKaminoAction, pack } from '@/lib/kamino-actions';
import { XSTOCKS_USDC_RESERVE, type ReserveFigures } from '@/lib/markets';
import { payoutAtGap } from '@/lib/payout';
import { type Spec, Row, plain, units } from '../actions';
import { CoverPanel, LossTable, PayOdds, useOdds } from '../cover';
import { useSolana } from '../Providers';
import { H, KV, Note, PageHead, Pill, Sim, StatBlock } from '../ui';
import { PositionCard } from './OverviewView';
import { ConnectNote, ErrorNote, Loading } from './shared';

const onFork = ON_LOCAL_FORK;
const sf = (x: { toString(): string }) => Number(BigInt(x.toString())) / Number(1n << SF_SHIFT);

/** The reserves a transaction's klend refresh_reserve instructions refresh (their first account). */
function refreshedReserves(ixs: TransactionInstruction[]): PublicKey[] {
  const keys = ixs.filter((ix) => ix.programId.equals(KLEND) && REFRESH_RESERVE.every((b, i) => ix.data[i] === b)).map((ix) => ix.keys[0].pubkey.toBase58());
  return [...new Set(keys)].map((k) => new PublicKey(k));
}

/** One Kamino action as transactions: account creation first, then refreshes + the action (fork: Scope restamped). */
function useKaminoAction(owner: PublicKey | undefined) {
  const send = useSend();
  const { conn } = useSolana();
  const run = async (action: KaminoActionName, reserve: PublicKey, amount: bigint, obligation?: PublicKey) => {
    if (!owner) return false;
    let built: Awaited<ReturnType<typeof buildKaminoAction>> | null = null;
    const get = async () => (built ??= await buildKaminoAction({ action, owner, reserve, amount, obligation }));
    const b = await get().catch((e: Error) => { throw e; });
    const setupBatches = pack(b.setup, owner);
    const steps = [
      ...setupBatches.map((ixs, i) => ({ label: `klend setup ${i + 1}/${setupBatches.length} (${b.labels.setup.map((l) => l.replace(/\[.*/, '')).join(', ')})`, ixs: () => ixs })),
      {
        label: `refresh + ${b.labels.lending.map((l) => l.replace(/\(.*/, '')).join(' + ')}`,
        ixs: async () => {
          if (onFork) {
            const { loadReserves } = await import('@/lib/kamino');
            const keys = refreshedReserves(b.main);
            const res = await loadReserves(conn, keys);
            const chains = scopeChains([...res.values()]);
            if (chains.length) await freshenScope(chains);
          }
          return b.main;
        },
      },
    ];
    return !!(await send.run(`${action[0].toUpperCase()}${action.slice(1)} on Kamino`, steps));
  };
  return { send, run };
}

function PositionSection({ p, epochs, now, reserves, usdcBal }: { p: Position; epochs: EpochView[]; now: number | null; reserves: Map<string, ReserveFigures>; usdcBal: bigint | null }) {
  const { signer } = useSolana();
  const owner = signer?.publicKey;
  const [cap, setCap] = useState('');
  const policies = usePolicies(owner);
  const markets = useMarkets();
  const m = markets.markets.find((x) => x.asset.ticker === p.asset?.ticker);
  const s = p.snap;
  const fresh = p.fresh ?? p.state;
  const coll = p.asset ? reserves.get(p.asset.reserves[0]) : undefined;
  const xBal = useTokenBalance(owner, p.asset?.mint, TOKEN_2022);
  const repay = useKaminoAction(owner); const add = useKaminoAction(owner); const borrow = useKaminoAction(owner); const withdraw = useKaminoAction(owner);
  const covered = (policies.data ?? []).some((x) => x.obligation.equals(p.key) && x.state === POLICY.ACTIVE);
  const capBase = BigInt(Math.round((Number(cap) || 0) * 1e6));

  // The Bell check, sized for the modelled 1-in-100 weekend gap of the asset (its on-chain scenario set at σ).
  const tailBps = m?.tail99 != null ? Math.round(m.tail99 * 10_000) : -800;
  const needRepay = s ? payoutAtGap(s.coveredValue, s.debt, s.debt, tailBps) : 0n;
  const lt = s ? Number(s.ltWad) / 1e18 : 0;
  const price = p.scopePrice ?? 0;
  const addTokens = s && lt > 0 && price > 0 ? Number(needRepay) / 1e6 / (lt * price * (1 + tailBps / 10_000)) : 0;
  // klend's own limits from the refreshed obligation: borrow up to the allowed value; withdraw what keeps it there.
  const allowed = sf(fresh.allowedBorrowValueSf);
  const adjDebt = sf(fresh.borrowFactorAdjustedDebtValueSf);
  const borrowRoom = Math.max(0, allowed - adjDebt);
  const ltvPct = coll?.maxLtvPct ?? 0;
  const withdrawRoomUsd = ltvPct > 0 ? Math.max(0, (allowed - adjDebt) / (ltvPct / 100)) : 0;
  const depLiquidity = s && coll ? Number(s.depositAmount) * coll.liquidityPerCollateral : 0; // base units of the xStock
  const ticker = p.asset?.ticker ?? 'xStock';
  const borrowReserve = p.state.borrows.find((b) => b.borrowReserve !== PublicKey.default.toBase58())?.borrowReserve;

  const specs: Spec[] = [
    {
      icon: 'repay', title: 'Repay', testId: 'repay', sub: `To survive a ${pct(tailBps / 10_000, 1)} open (1-in-100 weekend)`, amount: !s ? '—' : needRepay > 0n ? `$${usdc(needRepay)}` : 'Safe',
      dialog: {
        title: `Repay USDC on ${ticker}`, description: 'Repaying lowers the debt; always allowed on Kamino. The suggested amount keeps the position healthy through the modelled 1-in-100 weekend gap.',
        fields: [{ key: 'amount', unit: 'USDC', initial: needRepay > 0n ? plain(needRepay + 9_999n, 6, 2) : '', quick: [
          { label: 'Bell-safe', value: plain(needRepay + 9_999n, 6, 2) }, ...(s ? [{ label: 'All debt', value: plain(s.debt, 6, 6) }] : [])] }],
        preview: (v) => { const a = Number(v.amount) || 0; return s ? [['Debt after', `${num(Math.max(0, Number(s.debt) / 1e6 - a))} USDC`], ['Wallet USDC', usdcBal === null ? 'no account' : usdc(usdcBal)]] : []; },
        confirm: 'Repay', state: repay.send,
        send: (v) => repay.run('repay', new PublicKey(borrowReserve ?? XSTOCKS_USDC_RESERVE), units(v.amount, 6, 'a USDC amount'), p.key),
      },
    },
    {
      icon: 'deposit', title: 'Add collateral', testId: 'add', sub: `To survive a ${pct(tailBps / 10_000, 1)} open (1-in-100 weekend)`, amount: addTokens > 0 ? `${num(addTokens, 4)} ${ticker}` : s ? 'Safe' : '—',
      dialog: {
        title: `Add ${ticker} collateral`, description: 'Deposits more of the same xStock into this obligation (klend deposit_reserve_liquidity_and_obligation_collateral_v2).',
        fields: [{ key: 'amount', unit: ticker, initial: addTokens > 0 ? (Math.ceil(addTokens * 1e4) / 1e4).toString() : '', quick: xBal.data ? [{ label: 'Wallet balance', value: plain(xBal.data, 8, 8) }] : [] }],
        preview: (v) => [['Collateral added', price ? `$${num((Number(v.amount) || 0) * price)}` : '—'], ['Wallet', xBal.data != null ? `${fixed(xBal.data, 8, 4)} ${ticker}` : 'no account']],
        confirm: 'Add collateral', state: add.send, blocked: xBal.data ? null : `This wallet holds no ${ticker}. Get some on Faucet (fork).`,
        send: (v) => add.run('deposit', new PublicKey(p.asset!.reserves[0]), units(v.amount, 8, `an amount of ${ticker}`), p.key),
      },
    },
    {
      icon: 'card', title: 'Borrow', testId: 'borrow', sub: `Up to Kamino's ${ltvPct}% LTV`, amount: `$${num(borrowRoom, 0)}`,
      dialog: {
        title: `Borrow USDC against ${ticker}`, description: 'Borrowing raises the debt and brings the position closer to liquidation; the Bell check above sizes what the weekend needs.',
        fields: [{ key: 'amount', unit: 'USDC', quick: [{ label: 'Half the room', value: (Math.floor(borrowRoom * 50) / 100).toString() }] }],
        preview: (v) => { const a = Number(v.amount) || 0; return s && s.coveredValue > 0n ? [['Debt / C′ after', ((Number(s.debt) / 1e6 + a) / (Number(s.coveredValue) / 1e6)).toFixed(4)], ['Room left', `$${num(Math.max(0, borrowRoom - a))}`]] : []; },
        confirm: 'Borrow', state: borrow.send,
        send: (v) => borrow.run('borrow', new PublicKey(borrowReserve ?? XSTOCKS_USDC_RESERVE), units(v.amount, 6, 'a USDC amount'), p.key),
      },
    },
    {
      icon: 'withdraw', title: 'Withdraw', testId: 'withdraw', sub: 'Collateral above the LTV limit', amount: price ? `${num(withdrawRoomUsd / price, 4)} ${ticker}` : '—',
      dialog: {
        title: `Withdraw ${ticker} collateral`, description: 'Kamino lets you withdraw what keeps the debt within the max LTV; with no debt, everything.',
        fields: [{ key: 'amount', unit: ticker, quick: [
          ...(price ? [{ label: 'Max allowed', value: (Math.floor((withdrawRoomUsd / price) * 0.995 * 1e4) / 1e4).toString() }] : []),
          ...(s && s.debt <= 1n ? [{ label: 'All', value: (Math.floor(depLiquidity) / 1e8).toString() }] : [])] }],
        preview: (v) => [['Deposited', `${num(depLiquidity / 1e8, 4)} ${ticker}`], ['Value withdrawn', price ? `$${num((Number(v.amount) || 0) * price)}` : '—']],
        confirm: 'Withdraw', state: withdraw.send,
        send: (v) => withdraw.run('withdraw', new PublicKey(p.asset!.reserves[0]), units(v.amount, 8, `an amount of ${ticker}`), p.key),
      },
    },
  ];
  // Kamino actions follow what the obligation holds; only gap cover depends on Phase 1 eligibility. No covered xStock
  // deposit: only repay; no borrow yet: nothing to repay.
  const shown = specs.filter((x) => (p.asset || x.title === 'Repay') && (borrowReserve || x.title !== 'Repay'));

  return (
    <section data-testid="position">
      <H right={<small>{p.asset?.ticker ?? 'xStock'} · obligation <span className="cx-mono" title={p.key.toBase58()}>{short(p.key, 6)}</span></small>}>
        {ticker} position {p.why ? <Pill tone="soft" testId="ineligible">not eligible: {p.why}</Pill> : <Pill tone="good">eligible for gap cover</Pill>}
      </H>
      <Labels p={p} />
      <Row specs={IS_MAINNET ? [] : shown}><PositionCard p={p} covered={covered} /></Row>
      {s && (
        <div className="cx-split" style={{ marginTop: 22 }}>
          <div>
            <h3 className="cx-sub-h">If Monday opens…</h3>
            <LossTable p={p} cap={capBase > 0n ? capBase : s.debt} />
          </div>
          <div>
            <h3 className="cx-sub-h">Gap cover</h3>
            <CoverPanel p={p} epochs={epochs} now={now} cap={cap} setCap={setCap} />
          </div>
        </div>
      )}
      {p.freshErr && <Note icon="alert" tone="bad">{p.freshErr}</Note>}
    </section>
  );
}

function store<T>(k: string, d: T): T { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d; } catch { return d; } }

/** How the fork got this position: a real mainnet obligation with its owner rewritten, or one created for the demo. */
function Labels({ p }: { p: Position }) {
  const taken = store<Record<string, string>>('credence.taken', {})[p.key.toBase58()];
  const created = store<string[]>('credence.created', []).includes(p.key.toBase58());
  if (taken) return <p className="cx-hint"><Sim title={`Real mainnet obligation; its owner field (${taken}) was rewritten on the fork to this wallet`}>real mainnet position, owner rewritten on the fork</Sim></p>;
  if (created) return <p className="cx-hint"><Sim>created on the fork: SPYx by cheatcode, real klend deposit + borrow, owner set to this wallet</Sim></p>;
  return null;
}

function NewPosition({ assets, reserves }: { assets: Asset[]; reserves: Map<string, ReserveFigures> }) {
  const { signer } = useSolana();
  const owner = signer?.publicKey;
  const [pick, setPick] = useState('SPYx');
  const a = assets.find((x) => x.ticker === pick) ?? assets[0];
  const xBal = useTokenBalance(owner, a?.mint, TOKEN_2022);
  const dep = useKaminoAction(owner);
  const f = a ? reserves.get(a.reserves[0]) : undefined;
  if (!a) return null;
  const specs: Spec[] = [{
    icon: 'deposit', title: `Deposit ${a.ticker}`, testId: 'new-deposit', sub: 'Opens your Kamino obligation', amount: xBal.data != null ? `${fixed(xBal.data, 8, 2)} held` : 'none held',
    dialog: {
      title: `Deposit ${a.ticker} on Kamino`, description: `Creates your xStocks Market obligation (first time) and deposits ${a.ticker} as collateral; then borrow USDC from the position above.`,
      fields: [{ key: 'amount', unit: a.ticker, quick: xBal.data ? [{ label: 'Wallet balance', value: plain(xBal.data, 8, 8) }] : [] }],
      preview: (v) => [['Max LTV / LT', f ? `${f.maxLtvPct}% / ${f.ltPct}%` : '—'], ['Value', f ? `$${num((Number(v.amount) || 0) * f.marketPrice)}` : '—']],
      confirm: 'Deposit', state: dep.send, blocked: xBal.data ? null : `This wallet holds no ${a.ticker}. Get some on Faucet (fork).`,
      send: (v) => dep.run('deposit', new PublicKey(a.reserves[0]), units(v.amount, 8, `an amount of ${a.ticker}`)),
    },
  }];
  return (
    <section>
      <H right={<small>Deposit an xStock, then borrow USDC</small>}>Open a position</H>
      <div className="cx-seg" role="group" aria-label="Collateral" style={{ marginBottom: 18 }}>
        {assets.map((x) => <button key={x.ticker} type="button" aria-pressed={x.ticker === a.ticker} onClick={() => setPick(x.ticker)}>{x.ticker}</button>)}
      </div>
      <Row specs={specs} />
    </section>
  );
}

type Candidate = { obligation: string; owner: string; symbol: string; collateralUsd: number; debtUsd: number; debtToCovered: number; repayAtMinus8: number };

function RealPositions({ owner }: { owner: PublicKey }) {
  const { refresh } = useSolana();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const q = useQuery({
    queryKey: ['candidates'], enabled: open, staleTime: Infinity,
    queryFn: async () => { const r = await fetch('/api/positions/candidates'); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j as { generatedAt: string; eligible: number; total: number; rows: Candidate[] }; },
  });
  async function take(ob: string) {
    setBusy(ob); setErr('');
    try {
      const r = await fetch('/api/fork/take-position', { method: 'POST', body: JSON.stringify({ obligation: ob, owner: owner.toBase58() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      try { const m = store<Record<string, string>>('credence.taken', {}); m[ob] = j.realOwner; localStorage.setItem('credence.taken', JSON.stringify(m)); } catch { /* storage off */ }
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }
  return (
    <section>
      <H right={<button type="button" className="cx-btn is-ghost cx-btn-sm" onClick={() => setOpen(!open)} data-testid="real-positions">{open ? 'Hide' : 'Show positions'}</button>}>
        Use a real mainnet position <Sim>fork only</Sim>
      </H>
      <p className="cx-hint">Eligible near-threshold positions from the mainnet scan. One click rewrites the obligation&apos;s owner field on the fork to this wallet so it can sign buy_cover; collateral, debt, reserves and farms stay real.</p>
      {err && <p className="cx-hint is-bad">{err}</p>}
      {q.error && <ErrorNote error={q.error} what="the positions scan" />}
      {open && q.data && (
        <>
          <p className="cx-hint">Scan of {new Date(q.data.generatedAt).toUTCString()}: {q.data.eligible} of {q.data.total} positions with USDC debt against a covered xStock (SPYx, QQQx, NVDAx, TSLAx, GOOGLx, AAPLx, MSTRx, HOODx) fit single-asset cover. Values are from each obligation&apos;s last mainnet refresh.</p>
          <div className="cx-table-wrap">
            <table className="cx-table">
              <thead><tr><th>Obligation</th><th>Collateral</th><th className="is-num">Collateral $</th><th className="is-num">Debt $</th><th className="is-num">Debt / C′</th><th className="is-num">Repay at −8%</th><th /></tr></thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={r.obligation}>
                    <td className="cx-mono" data-label="Obligation">{short(r.obligation, 6)}</td><td data-label="Collateral">{r.symbol}</td>
                    <td className="is-num" data-label="Collateral $">{num(r.collateralUsd)}</td><td className="is-num" data-label="Debt $">{num(r.debtUsd)}</td>
                    <td className="is-num" data-label="Debt / C′">{r.debtToCovered.toFixed(4)}</td><td className="is-num" data-label="Repay at −8%">{num(r.repayAtMinus8)}</td>
                    <td className="is-num"><button type="button" className="cx-btn cx-btn-sm" disabled={!!busy} onClick={() => take(r.obligation)} data-testid={`take-${r.obligation}`}>{busy === r.obligation ? '…' : 'Use this position'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export function Policies({ owner, epochs }: { owner: PublicKey; epochs: EpochView[] }) {
  const policies = usePolicies(owner);
  const odds = useOdds();
  const byKey = new Map(epochs.map((e) => [e.key.toBase58(), e]));
  if (!policies.data?.length) return null;
  return (
    <section>
      <H right={<small>Read from the Policy accounts</small>}>Your policies</H>
      <div className="cx-table-wrap">
        <table className="cx-table" data-testid="policies">
          <thead><tr><th>Policy</th><th>Asset</th><th>Weekend</th><th>Epoch</th><th>State</th><th className="is-num">Max payout</th><th className="is-num">Premium</th><th className="is-num">Chance · history</th><th className="is-num">Payout</th></tr></thead>
          <tbody>
            {policies.data.map((p) => {
              const e = byKey.get(p.epoch.toBase58());
              return (
                <tr key={p.key.toBase58()}>
                  <td className="cx-mono" data-label="Policy">{short(p.key, 6)}</td><td data-label="Asset">{p.ticker}</td><td data-label="Weekend">{e?.closureId}</td>
                  <td data-label="Epoch">{e ? EPOCH_NAME[e.state] : ''}</td>
                  <td data-label="State"><Pill tone={p.state === POLICY.SETTLED ? 'good' : p.state === POLICY.REFUNDED ? 'warn' : 'soft'}>{POLICY_NAME[p.state]}</Pill></td>
                  <td className="is-num" data-label="Max payout">{usdc(p.maxPayout)}</td><td className="is-num" data-label="Premium">{usdc(p.premium)}</td>
                  <td className="is-num" data-label="Chance · history"><PayOdds o={odds(p.ticker, p.coveredValue, p.debt)} coveredValue={p.coveredValue} debt={p.debt} ticker={p.ticker} compact /></td>
                  <td className="is-num is-strong" data-label="Payout" data-testid="policy-payout">{p.state === POLICY.SETTLED ? usdc(p.payout) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="cx-hint">Settled payouts were repaid into the obligation by settle_policy (klend repay CPI), or sent to the wallet if the position was closed.</p>
    </section>
  );
}

export function BorrowView() {
  const { signer } = useSolana();
  const owner = signer?.publicKey;
  const { now } = useClock();
  const epochs = useEpochs();
  const assets = useAssets();
  const pos = usePositions(owner);
  const bal = useBalances(owner);
  const markets = useMarkets();
  const reserves = useMemo(() => new Map(markets.markets.filter((m) => m.figures).map((m) => [m.reserve.toBase58(), m.figures!])), [markets.markets]);
  const ps = pos.positions ?? [];
  const debt = ps.reduce((a, p) => a + (p.snap?.debt ?? 0n), 0n);
  const ge = (epochs.data ?? []).filter((e) => e.state === 0 && now !== null && now < e.bell).sort((a, b) => a.closureId - b.closureId)[0];

  return (
    <>
      <PageHead title="Borrow" sub="Your Kamino xStocks loans. Before Friday's bell each one should be safe for a weekend gap, or carry gap cover that pays into it after the open." />
      <div className="cx-grid">
        <div className="cx-col">
          {!signer ? <section><H>Your positions</H><ConnectNote>Connect a wallet to see your Kamino positions, act on them and cover them for the weekend.</ConnectNote></section>
            : pos.error ? <ErrorNote error={pos.error} />
            : pos.isLoading || !pos.positions ? <Loading what="Refreshing your Kamino positions on the fork" />
            : ps.length === 0 ? <section><H>Your positions</H><Note icon="card">This wallet has no xStocks positions on the fork. Open one below, create the $50,000 demo position on Faucet, or take a real mainnet position.</Note></section>
            : ps.map((p) => <PositionSection key={p.key.toBase58()} p={p} epochs={epochs.data ?? []} now={now} reserves={reserves} usdcBal={bal.data?.usdc ?? null} />)}
          {pos.twapAligned && <p className="cx-hint"><Sim>fork: after a simulated gap, Kamino&apos;s Scope TWAP was set to the spot price so klend accepts it (a real TWAP converges within days)</Sim></p>}
          {IS_MAINNET && <Note icon="lock">{READ_ONLY_NOTE}</Note>}
          {signer && assets.data && !IS_MAINNET && <NewPosition assets={assets.data} reserves={reserves} />}
          {signer && !IS_MAINNET && <Policies owner={signer.publicKey} epochs={epochs.data ?? []} />}
          {signer && !IS_MAINNET && <RealPositions owner={signer.publicKey} />}
        </div>
        <aside className="cx-aside">
          <StatBlock label="Total USDC debt" value={pos.positions ? usdc(debt, 0) : '—'} chip={pos.positions ? `${ps.length} position${ps.length === 1 ? '' : 's'}` : '…'} testId="total-debt" />
          {ps.length > 0 && <div><H>Debt / C′</H><KV rows={ps.map((p) => [p.asset?.ticker ?? 'xStock', p.ratio !== null ? `${p.ratio.toFixed(4)}${p.ratio >= 1 ? ' · liquidatable' : ''}` : '—'])} /></div>}
          <div>
            <H>Wallet</H>
            <KV rows={[['SOL', bal.data ? num(bal.data.sol, 4) : '—'], ['USDC', bal.data ? (bal.data.usdc === null ? '0.00 (no account)' : <span key="u" data-testid="usdc">{usdc(bal.data.usdc)}</span>) : '—']]} />
          </div>
          <div>
            <H>The weekend</H>
            <KV rows={[
              ['Bell', ge ? et(ge.bell) : '—'], ['Friday close', ge ? et(ge.close) : '—'], ['Monday open', ge ? et(ge.open) : '—'],
              ['Payout', 'After the open, into the position'], ['Rule', 'min(cap, D − C′ × open/close)'],
            ]} />
          </div>
          <Note icon="clock">Phase 1 pays after the open. Kamino&apos;s price can move in Monday pre-market, before the payout lands.</Note>
        </aside>
      </div>
    </>
  );
}
