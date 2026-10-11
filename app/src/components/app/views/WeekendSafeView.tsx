'use client';
// Weekend-safe market (D1): a klend market where every borrow is covered automatically, so it keeps a higher loan limit through
// the weekend. This page shows the market's limits next to Kamino's xStocks market, the weekend add-on as a yearly rate (the
// program's own `quote_cover`, simulated: nothing is priced here), the user's account, and the actions: open, deposit, borrow,
// repay, withdraw. Repay and withdraw are always on the page and never wait for Credence's state: the buttons read no pause flag
// and no policy, and the program's instructions behind them do not either (a single guard in the weekend freeze: a withdrawal
// may not leave the debt above Kamino's normal limit; repay first and it passes). Fork-proven only.
import { useQuery } from '@tanstack/react-query';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { useState } from 'react';
import {
  TOKEN_2022, USDC_MINT, WSM_MARKET, simulateRefreshed, addonAprBps, createAtaIx, pdas, readWsmAccount, readWsmMarket, simulateQuote, weekendStatus, wsmBorrow, wsmDeposit,
  wsmOpen, wsmPdas, wsmPosition, wsmRefreshes, wsmReopen, wsmRepay, wsmWithdraw,
} from '@credence/sdk';
import { freshenScope, scopeChains } from '@/lib/cover';
import { et, fixed, num, pct, short, usd } from '@/lib/format';
import { useAssets, useClock, useEpochs } from '@/lib/hooks/chain';
import { useSend } from '@/lib/hooks/send';
import { useBalances, useTokenBalance } from '@/lib/hooks/vault';
import { decodeObligation, loadReserves } from '@/lib/kamino';
import { IS_MAINNET, READ_ONLY_NOTE } from '@/lib/network';
import { useSolana } from '../Providers';
import { Details, Empty, H, KV, Note, PageHead, Pill, Sim, StatBlock } from '../ui';
import { ConnectNote, ErrorNote, Loading } from './shared';

const U64_MAX = 18446744073709551615n;

export function WeekendSafeView() {
  if (IS_MAINNET) return <><PageHead title="Weekend-safe market" sub="Fork-proven only." /><Note icon="lock">{READ_ONLY_NOTE}</Note></>;
  return <View />;
}

function View() {
  const { conn, prog, signer } = useSolana();
  const user = signer?.publicKey ?? null;
  const { now } = useClock();
  const epochs = useEpochs();
  const assets = useAssets();
  const send = useSend();
  const [dep, setDep] = useState('10');
  const [bor, setBor] = useState('1000');
  const [rep, setRep] = useState('500');
  const [hypo, setHypo] = useState({ collateral: 10_000, dcp: 0.93 });
  const [msg, setMsg] = useState<string | null>(null);

  const market = useQuery({ queryKey: ['wsm-market'], queryFn: () => readWsmMarket(prog), refetchInterval: 15_000 });
  const m = market.data ?? null;
  const spy = assets.data?.find((a) => a.ticker === 'SPYx');
  const reserves = useQuery({
    queryKey: ['wsm-reserves', m?.key.toBase58()], enabled: !!m && !!spy,
    queryFn: () => loadReserves(conn, [m!.assets.find((a) => a.ticker === 'SPYx')!.reserve, m!.usdcReserve, new PublicKey(spy!.reserves[0])]),
    refetchInterval: 20_000,
  });
  const cfg = useQuery({ queryKey: ['wsm-config'], queryFn: () => prog.account.config.fetch(pdas.config()), refetchInterval: 10_000 });
  const account = useQuery({ queryKey: ['wsm-account', user?.toBase58()], enabled: !!user && !!m, queryFn: () => readWsmAccount(prog, user!), refetchInterval: 8_000 });
  const accountKey = user ? wsmPdas.account(user) : null;
  const obligation = useQuery({
    queryKey: ['wsm-obligation', accountKey?.toBase58(), account.data?.coveredClosure], enabled: !!accountKey && !!account.data, refetchInterval: 8_000,
    queryFn: async () => {
      const a = await conn.getAccountInfo(wsmPdas.obligation(accountKey!), 'confirmed');
      if (!a || a.data.length === 0) return null;
      const o = decodeObligation(a.data as Buffer);
      // klend fills an obligation's values only when it is refreshed: show it as a refresh leaves it (a simulation, nothing sent).
      const held = [...o.deposits, ...o.borrows].map((x) => ('depositReserve' in x ? x.depositReserve : x.borrowReserve)).filter((k) => k !== PublicKey.default.toBase58());
      if (!held.length || !user) return o;
      try {
        const res = await loadReserves(conn, held.map((k) => new PublicKey(k)));
        const scope = scopeChains([...res.values()]);
        if (scope.length) await freshenScope(scope);
        return (await simulateRefreshed(conn, user, wsmPdas.obligation(accountKey!), o, res)).state;
      } catch { return o; }
    },
  });
  const spyBal = useTokenBalance(user, spy?.mint, TOKEN_2022);
  const bal = useBalances(user);

  const wsmSpy = m?.assets.find((a) => a.ticker === 'SPYx');
  const rs = reserves.data;
  const kam = rs && spy ? rs.get(spy.reserves[0]) : undefined;
  const wsm = rs && wsmSpy ? rs.get(wsmSpy.reserve.toBase58()) : undefined;
  const usdcRes = rs && m ? rs.get(m.usdcReserve.toBase58()) : undefined;
  const paused = !!cfg.data?.paused;
  const week = m && epochs.data && now ? weekendStatus(epochs.data, 'SPYx', now, m.freezeSecs) : null;
  const ep = week?.closureId != null ? epochs.data?.find((e) => e.ticker === 'SPYx' && e.closureId === week.closureId) : undefined;
  const frozen = week?.phase === 'frozen';
  const acct = account.data ?? null;
  const ob = obligation.data ?? null;
  const pos = acct && ob && ob.deposits.some((d) => d.depositReserve !== PublicKey.default.toBase58()) ? wsmPosition(acct, ob) : null;
  const status = acct && week?.closureId != null ? acct.status(week.closureId) : null;

  // The add-on: the program's quote_cover, simulated, for the account's cover (or a stated example); never computed here.
  const lt = wsm ? wsm.config.liquidationThresholdPct / 100 : 0.85;
  const exCollateral = pos ? pos.collateralUsd : hypo.collateral;
  const exCovered = Math.round(exCollateral * lt * 1e6);
  const exDebt = pos ? Math.round(pos.debtUsd * 1e6) : Math.round(exCovered * hypo.dcp);
  const addon = useQuery({
    queryKey: ['wsm-addon', ep?.key.toBase58(), exCovered, exDebt], enabled: !!ep && !!spy && !!user && exDebt > 0 && exDebt < exCovered,
    queryFn: async () => {
      const q = await simulateQuote(conn, prog, user!, spy!, ep!, BigInt(exCovered), BigInt(exDebt), BigInt(exDebt));
      return { premium: q.premium, bps: addonAprBps(q.premium, BigInt(exDebt)) };
    },
  });

  if (market.isLoading || assets.isLoading) return <><PageHead title="Weekend-safe market" /><Loading /></>;
  if (market.error) return <><PageHead title="Weekend-safe market" /><ErrorNote error={market.error} /></>;
  if (!m || !spy || !wsmSpy) {
    return (
      <><PageHead title="Weekend-safe market" sub="A lending market where every borrow is covered automatically." />
        <CreateMarket onDone={() => void market.refetch()} /></>
    );
  }

  async function refreshable(extra: PublicKey[]): Promise<TransactionInstruction[]> {
    if (!rs || !accountKey) return [];
    await freshenScope(scopeChains([...rs.values()]));
    const a = await conn.getAccountInfo(wsmPdas.obligation(accountKey), 'confirmed');
    if (!a || a.data.length === 0) return [];
    return wsmRefreshes(accountKey, decodeObligation(a.data as Buffer), rs, extra);
  }
  const act = async (title: string, f: () => Promise<TransactionInstruction[]>) => {
    setMsg(null);
    const r = await send.run(title, [{ label: title, ixs: f }]);
    if (r) setMsg(`${title}: done (${r[0].cu.toLocaleString()} CU)`);
    void market.refetch(); void account.refetch(); void obligation.refetch();
  };
  const tokens = (s: string) => BigInt(Math.round(Number(s) * 1e8));
  const base6 = (s: string) => BigInt(Math.round(Number(s) * 1e6));

  const open = () => act('Open account', async () => [createAtaIx(user!, user!, USDC_MINT), await wsmOpen(prog, { user: user!, ticker: 'SPYx', coll: spy.mint })]);
  const reopen = () => act('Reopen account', async () => [await wsmReopen(prog, { user: user! })]);
  const deposit = () => act('Deposit', async () => wsmDeposit(prog, { user: user!, ticker: 'SPYx', coll: spy.mint, amount: tokens(dep), reserve: wsmSpy.reserve, reserveState: wsm!, refreshes: await refreshable([wsmSpy.reserve]) }));
  const borrow = () => act('Borrow', async () => wsmBorrow(prog, { user: user!, amount: base6(bor), usdcReserve: m.usdcReserve, usdcState: usdcRes!, refreshes: await refreshable([m.usdcReserve, wsmSpy.reserve]) }));
  const repay = (all: boolean) => act(all ? 'Repay all' : 'Repay', async () => wsmRepay(prog, { user: user!, amount: all ? U64_MAX : base6(rep), usdcReserve: m.usdcReserve, usdcState: usdcRes!, refreshes: await refreshable([]) }));
  const withdraw = () => act('Withdraw', async () => wsmWithdraw(prog, { user: user!, coll: spy.mint, collateral: U64_MAX, reserve: wsmSpy.reserve, reserveState: wsm!, refreshes: await refreshable([]) }));
  const getSpyx = async () => {
    const r = await fetch('/api/fork/xstock', { method: 'POST', body: JSON.stringify({ owner: user!.toBase58(), ticker: 'SPYx', tokens: 100 }) });
    setMsg(r.ok ? 'Fork: 100 SPYx set on your wallet (a cheatcode; nobody sold them).' : `faucet: ${(await r.json()).error}`);
    void spyBal.refetch();
  };

  const kamLtv = kam ? kam.config.loanToValuePct : null;
  const kamLt = kam ? kam.config.liquidationThresholdPct : null;
  const dcpMax = wsm ? wsm.config.loanToValuePct / wsm.config.liquidationThresholdPct : null;
  const kamDcpMax = kamLtv && kamLt ? kamLtv / kamLt : null;
  const maxBorrow = pos ? Math.max(0, Math.min(pos.allowedBorrowUsd, (Number(m.maxDcpWad) / 1e18) * pos.liquidationUsd) - pos.debtUsd) : 0;

  return (
    <>
      <PageHead title="Weekend-safe market"
        sub={<>Borrow against xStocks at a higher limit that holds over the weekend. Every borrow is covered automatically. <Sim title="Fork-proven: a klend market created on the fork, priced by Kamino's real Scope; not live, not insurance">fork-proven</Sim></>}
        right={<Pill tone={paused ? 'warn' : 'good'} testId="wsm-paused">{paused ? 'Credence paused: exits stay open' : 'Credence active'}</Pill>} />

      <H>Loan limits, next to Kamino’s xStocks market</H>
      <table className="cx-table" data-testid="wsm-limits">
        <thead><tr><th>SPYx</th><th>Max LTV</th><th>Liquidation threshold</th><th>Max debt / threshold value</th></tr></thead>
        <tbody>
          <tr><td>Kamino xStocks Market</td><td data-testid="wsm-kamino-ltv">{kamLtv ?? '…'}%</td><td data-testid="wsm-kamino-lt">{kamLt ?? '…'}%</td><td>{kamDcpMax ? kamDcpMax.toFixed(3) : '…'}</td></tr>
          <tr><td>Weekend-safe market</td><td data-testid="wsm-ltv">{wsm ? wsm.config.loanToValuePct : '…'}%</td><td data-testid="wsm-lt">{wsm ? wsm.config.liquidationThresholdPct : '…'}%</td><td>{dcpMax ? dcpMax.toFixed(3) : '…'} (market cap {pct(Number(m.maxDcpWad) / 1e18, 1)})</td></tr>
        </tbody>
      </table>
      <p className="cx-hint">The higher limit is safe because cover removes the weekend gap: a covered loan that Kamino would liquidate on a −8% Monday stays healthy.</p>

      <H>Weekend</H>
      <KV rows={[
        ['Phase', <span key="p" data-testid="wsm-weekend"><Pill tone={frozen ? 'warn' : 'good'}>{frozen ? 'frozen: covered, no new debt' : 'open'}</Pill></span>],
        ['Freeze starts', week?.freezeStart ? et(week.freezeStart) : '—'],
        ['Freeze', `${m.freezeSecs / 3600} h before Friday's cover cut-off until Monday settles`],
      ]} />

      <H right={<Sim title="The program's quote_cover, simulated">simulated quote</Sim>}>Weekend add-on</H>
      {!pos && (
        <label className="cx-page-sub">Example: collateral $
          <input data-testid="wsm-hypo-collateral" type="number" min={100} value={hypo.collateral} onChange={(e) => setHypo({ ...hypo, collateral: Number(e.target.value) })} /> borrowed to D/C′
          <select data-testid="wsm-hypo-dcp" value={hypo.dcp} onChange={(e) => setHypo({ ...hypo, dcp: Number(e.target.value) })}>{[0.8, 0.85, 0.9, 0.93].map((x) => <option key={x} value={x}>{x.toFixed(2)}</option>)}</select>
        </label>
      )}
      <StatBlock label={pos ? 'Your add-on, as a yearly rate on your debt' : 'Add-on for the example, as a yearly rate'} testId="wsm-addon"
        value={!user ? 'connect a wallet' : !ep ? 'no weekend on sale' : addon.data ? `${(Number(addon.data.bps) / 100).toFixed(2)}%` : addon.isLoading ? '…' : addon.error ? 'unavailable' : '—'}
        chip={addon.data ? `${fixed(addon.data.premium, 6, 2)} USDC per weekend` : undefined} />
      <p className="cx-hint" title="Borrowed onto your debt and paid to the vault, never above the quote. Many positions pay the minimum premium alone, which is a larger rate on a small debt.">Charged each Friday, added to your debt.</p>

      <H>Your account</H>
      {!user ? <ConnectNote>Connect a wallet to open an account.</ConnectNote> : (
        <>
          <KV rows={[
            ['Wallet', short(user)],
            ['USDC', bal.data?.usdc != null ? usd(Number(bal.data.usdc) / 1e6) : '…'],
            ['SPYx', spyBal.data != null ? num(Number(spyBal.data) / 1e8, 4) : '…'],
          ]} />
          {!acct && <><button data-testid="wsm-open" className="cx-btn" disabled={!!send.busy || paused} onClick={open}>Open account</button>{paused && <span className="cx-page-sub"> Opening is paused.</span>}</>}
          {acct && !ob && <><Note icon="alert">Your obligation was emptied and closed by klend; reopen it to deposit again.</Note><button data-testid="wsm-reopen" className="cx-btn" disabled={!!send.busy || paused} onClick={reopen}>Reopen</button></>}
          {acct && ob && (
            <>
              <KV rows={[
                ['Collateral', <span key="c" data-testid="wsm-collateral">{pos ? usd(pos.collateralUsd) : '$0.00'}</span>],
                ['Debt', <span key="d" data-testid="wsm-debt">{pos ? usd(pos.debtUsd) : '$0.00'}</span>],
                ['Debt / threshold value', <span key="r" data-testid="wsm-dcp">{pos ? pos.dcp.toFixed(3) : '—'}</span>],
                ['Can borrow now', <span key="m" data-testid="wsm-max">{frozen || paused ? '—' : usd(maxBorrow)}</span>],
                ['This weekend', <span key="s" data-testid="wsm-status">{status === 'covered' ? <Pill tone="good">covered</Pill> : status === 'flagged' ? <Pill tone="bad">flagged: cover refused, no new debt</Pill> : frozen ? <Pill tone="bad">not covered</Pill> : <Pill>covers on Friday</Pill>}</span>],
                ['Add-on paid so far', `${fixed(acct.addonPaidTotal, 6, 4)} USDC`],
              ]} />
              <div className="cx-row">
                <label>SPYx <input data-testid="wsm-dep-amount" type="number" min={0} value={dep} onChange={(e) => setDep(e.target.value)} /></label>
                <button data-testid="wsm-deposit" className="cx-btn" disabled={!!send.busy} onClick={deposit}>Deposit</button>
                <button data-testid="wsm-get-spyx" className="cx-btn" onClick={getSpyx}>Get 100 SPYx (fork)</button>
              </div>
              <div className="cx-row">
                <label>USDC <input data-testid="wsm-bor-amount" type="number" min={0} value={bor} onChange={(e) => setBor(e.target.value)} /></label>
                <button data-testid="wsm-borrow" className="cx-btn" disabled={!!send.busy || paused || frozen} onClick={borrow}>Borrow</button>
                {(paused || frozen) && <span className="cx-page-sub" data-testid="wsm-borrow-note">{paused ? 'Borrowing is paused.' : 'No new debt during the weekend freeze.'}</span>}
              </div>
              <H>Exits</H>
              <Note icon="shield-check"><span data-testid="wsm-exit-note">Repay and withdraw never depend on Credence: they work while it is paused, mid-weekend, with a policy active and with a Shield advance pending.{frozen ? ' In the freeze a withdrawal may leave the debt at most at Kamino’s normal limit; repay first to take everything.' : ''}</span></Note>
              <div className="cx-row">
                <label>USDC <input data-testid="wsm-rep-amount" type="number" min={0} value={rep} onChange={(e) => setRep(e.target.value)} /></label>
                <button data-testid="wsm-repay" className="cx-btn" disabled={!!send.busy} onClick={() => repay(false)}>Repay</button>
                <button data-testid="wsm-repay-all" className="cx-btn" disabled={!!send.busy} onClick={() => repay(true)}>Repay all</button>
                <button data-testid="wsm-withdraw" className="cx-btn" disabled={!!send.busy} onClick={withdraw}>Withdraw all klend allows</button>
              </div>
            </>
          )}
          {send.busy && <p className="cx-page-sub" data-testid="wsm-busy">{send.busy}…</p>}
          {send.error && <Note icon="alert" tone="bad"><span data-testid="wsm-error">{send.error}</span></Note>}
          {msg && <p className="cx-page-sub" data-testid="wsm-msg">{msg}</p>}
        </>
      )}
      <Details summary="Custody">
        <p>Custody: your collateral sits in klend in an obligation owned by a Credence program account, so only your signed instructions (and the documented Shield, settlement and klend’s own liquidation) move it. No admin instruction can. Market {short(WSM_MARKET)} · fork-only address.</p>
      </Details>
    </>
  );
}

/** Fork only: creates the weekend-safe market through the keeper's own setup step. */
function CreateMarket({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function create() {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/demo/step', { method: 'POST', body: JSON.stringify({ step: 'wsm-setup' }) });
      const out = await r.text();
      if (!r.ok || !out.includes('@@exit 0')) throw new Error(out.split('\n').filter(Boolean).slice(-2).join(' ') || 'The setup step failed.');
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div data-testid="wsm-missing">
      <Empty icon="clock" title="Not set up on this fork yet">Create the market on the fork to try it (about a minute).</Empty>
      <div style={{ marginTop: 14 }}>
        <button type="button" className="cx-btn" disabled={busy} onClick={create} data-testid="wsm-create">{busy ? 'Creating the market…' : 'Create the market (fork)'}</button>
      </div>
      {err && <Note icon="alert" tone="bad">{err}</Note>}
    </div>
  );
}
