'use client';
// Gap tokens (D2): RESEARCH PROTOTYPE, NOT OFFERED. For one asset and one closure, 1 USDC mints a complete set: 1 GAP-DOWN and
// 1 GAP-UP. Before the closure settles a set merges back into 1 USDC; after it settles on the same price Credence's cover settles
// on, the USDC is split by the gap. Fully collateralized: nobody owes anything. Every figure here is read from the series account
// (the split is the program's); the payout curve is drawn from the band with the SDK's vector-tested port of risk-core. A
// derivative that pays on a stock price is a legal question first: a legal review comes before any offer. Fork-proven only.
import { useQuery } from '@tanstack/react-query';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { useEffect, useState } from 'react';
import { GAP_DISCLAIMER, GAP_SIDE, WAD, pdas, gapAccounts, gapMergeSet, gapMintSet, gapOwed, gapRate, gapRedeem, gapSplit, listGapSeries, type GapSeriesView } from '@credence/sdk';
import { fixed, short, usd, usdc, utc, weekendOf } from '@/lib/format';
import { useClock } from '@/lib/hooks/chain';
import { useSend } from '@/lib/hooks/send';
import { useBalances } from '@/lib/hooks/vault';
import { IS_MAINNET, READ_ONLY_NOTE } from '@/lib/network';
import { useSolana } from '../Providers';
import { Details, H, KV, Note, PageHead, Pill, Sim } from '../ui';
import { ConnectNote, ErrorNote, Loading } from './shared';

const GEO = 'Not offered in the United States or to US persons.';

export function GapTokensView() {
  if (IS_MAINNET) return <><PageHead title="Gap tokens (research prototype)" sub="Fork-proven only." /><Note icon="lock">{READ_ONLY_NOTE}</Note></>;
  return <View />;
}

const STATE_TONE = { open: 'good', settled: 'soft', expired: 'warn' } as const;
const pctOf = (wad: bigint, dp = 1) => `${(Number(wad) / 1e16).toFixed(dp)}%`;

/** The gap to draw: the chart spans ±1.5 bands, so a larger gap sits on its edge. */
const clampR = (r: bigint, k: bigint) => { const m = (k * 3n) / 2n; return r < -m ? -m : r > m ? m : r; };

/** The payout of one DOWN token against the closure's gap, in the band (drawn from `gapSplit`, the port of risk-core::gap_token). */
function Curve({ s }: { s: GapSeriesView }) {
  const W = 560, Hh = 190, P = 28;
  const k = s.kWad;
  const pts: [bigint, number][] = [];
  for (let i = -30; i <= 30; i++) { const r = (k * 3n * BigInt(i)) / 60n; pts.push([r, gapSplit(r, k)[0] / 1e6]); }
  const x = (r: bigint) => P + ((Number(r) / Number(k) + 1.5) / 3) * (W - 2 * P);
  const y = (v: number) => Hh - P - v * (Hh - 2 * P);
  const line = (f: (p: [bigint, number]) => number) => pts.map((p) => `${x(p[0]).toFixed(1)},${y(f(p)).toFixed(1)}`).join(' ');
  const r = s.state === 'settled' && s.closePriceWad > 0n ? ((s.settlePriceWad * WAD) / s.closePriceWad) - WAD : null;
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} role="img" aria-label="Payout of GAP-DOWN and GAP-UP against the closure's gap" data-testid="gap-curve" style={{ width: '100%', maxWidth: 640 }}>
      <line x1={P} y1={y(0)} x2={W - P} y2={y(0)} stroke="currentColor" opacity={0.25} />
      <line x1={x(0n)} y1={P - 6} x2={x(0n)} y2={y(0) + 4} stroke="currentColor" opacity={0.25} />
      <polyline points={line((p) => p[1])} fill="none" stroke="var(--cx-bad, #c0392b)" strokeWidth={2.5} />
      <polyline points={line((p) => 1 - p[1])} fill="none" stroke="var(--cx-good, #1e8e5a)" strokeWidth={2.5} strokeDasharray="6 4" />
      {r != null && <rect x={x(clampR(r, k)) - 1.5} y={P - 6} width={3} height={y(0) + 4 - (P - 6)} fill="currentColor" data-testid="gap-curve-marker"><title>{`gap ${(Number(r) / 1e16).toFixed(2)}%${r !== clampR(r, k) ? ' (beyond the chart)' : ''}`}</title></rect>}
      <text x={P} y={14} fontSize={11} fill="currentColor">USDC per token</text>
      <text x={P} y={Hh - 6} fontSize={11} fill="currentColor">−1.5 × band</text>
      <text x={x(-k)} y={Hh - 6} fontSize={11} fill="currentColor" textAnchor="middle">−{pctOf(k, 1)}</text>
      <text x={x(k)} y={Hh - 6} fontSize={11} fill="currentColor" textAnchor="middle">+{pctOf(k, 1)}</text>
      <text x={W - P} y={Hh - 6} fontSize={11} fill="currentColor" textAnchor="end">+1.5 × band</text>
      <text x={W - P} y={y(1) - 4} fontSize={11} fill="var(--cx-bad, #c0392b)" textAnchor="end">GAP-DOWN</text>
      <text x={W - P} y={y(0) - 5} fontSize={11} fill="var(--cx-good, #1e8e5a)" textAnchor="end">GAP-UP</text>
    </svg>
  );
}

function View() {
  const { conn, prog, signer } = useSolana();
  const user = signer?.publicKey ?? null;
  const { now } = useClock();
  const send = useSend();
  const [sel, setSel] = useState<string | null>(null);
  const [amt, setAmt] = useState('100');
  const [msg, setMsg] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['gap-series'], queryFn: () => listGapSeries(prog), refetchInterval: 8_000 });
  const cfg = useQuery({ queryKey: ['gap-config'], queryFn: () => prog.account.config.fetch(pdas.config()), refetchInterval: 10_000 });
  const rows = list.data ?? [];
  useEffect(() => { if (!sel && rows.length) setSel(rows[0].key.toBase58()); }, [rows, sel]);
  const s = rows.find((r) => r.key.toBase58() === sel) ?? null;
  const bal = useBalances(user);
  const acc = s && user ? gapAccounts(s, user) : null;
  const holdings = useQuery({
    queryKey: ['gap-holdings', user?.toBase58(), s?.key.toBase58()], enabled: !!acc, refetchInterval: 6_000,
    queryFn: async () => {
      const get = async (k: PublicKey) => { try { return BigInt((await conn.getTokenAccountBalance(k, 'confirmed')).value.amount); } catch { return 0n; } };
      return { down: await get(acc!.down), up: await get(acc!.up) };
    },
  });
  const collateral = useQuery({
    queryKey: ['gap-collateral', s?.collateral.toBase58()], enabled: !!s, refetchInterval: 6_000,
    queryFn: async () => BigInt((await conn.getTokenAccountBalance(s!.collateral, 'confirmed')).value.amount).valueOf(),
  });

  if (list.isLoading) return <><PageHead title="Gap tokens (research prototype)" /><Loading /></>;
  if (list.error) return <><PageHead title="Gap tokens (research prototype)" /><ErrorNote error={list.error} /></>;

  const paused = !!cfg.data?.paused;
  const h = holdings.data ?? { down: 0n, up: 0n };
  const base6 = (v: string) => BigInt(Math.round(Number(v) * 1e6));
  const sets = h.down < h.up ? h.down : h.up;
  const live = !!s && s.state === 'open';
  const selling = live && now != null && now < s!.bell;
  const act = async (title: string, f: () => Promise<TransactionInstruction[]>) => {
    setMsg(null);
    const r = await send.run(title, [{ label: title, ixs: f }]);
    if (r) setMsg(`${title}: done (${r[r.length - 1].cu.toLocaleString()} CU)`);
    void list.refetch(); void holdings.refetch(); void collateral.refetch(); void bal.refetch();
  };
  const mint = () => act('Mint a set', () => gapMintSet(prog, { user: user!, series: s!, amount: base6(amt) }));
  const merge = () => act('Merge a set', async () => [await gapMergeSet(prog, { user: user!, series: s!, amount: base6(amt) })]);
  const redeem = (side: 0 | 1) => act(side === GAP_SIDE.DOWN ? 'Redeem DOWN' : 'Redeem UP', async () => [await gapRedeem(prog, { user: user!, series: s!, side, amount: side === GAP_SIDE.DOWN ? h.down : h.up })]);

  const owed = s ? gapOwed(s) : null;
  const rate = (side: 0 | 1) => (s ? gapRate(s, side) : null);
  const r = s && s.state === 'settled' && s.closePriceWad > 0n ? ((s.settlePriceWad * WAD) / s.closePriceWad) - WAD : null;

  return (
    <>
      <PageHead title="Gap tokens (research prototype)"
        sub={<>Two tokens per stock and weekend: GAP-DOWN pays when it gaps down, GAP-UP when it gaps up. 1 USDC mints one of each. <Sim title="Fork-proven: runs on a local mainnet fork; not live, not insurance, not an investment">fork-proven</Sim></>}
        right={<Pill tone={paused ? 'warn' : 'good'} testId="gap-paused">{paused ? 'Credence paused: minting stopped, merge and redeem stay open' : 'Credence active'}</Pill>} />
      <Note icon="alert" tone="warn"><b data-testid="gap-banner">{GAP_DISCLAIMER[0].toUpperCase() + GAP_DISCLAIMER.slice(1)}.</b> Fork only, fully collateralized; not insurance or an investment. A legal review comes before any offer, and none has happened. <span data-testid="gap-geo">{GEO}</span></Note>

      <H>Series</H>
      {!rows.length ? <Note icon="clock"><span data-testid="gap-none" title="The keeper opens series with the epochs when run with GAP_TOKENS=1.">No series open yet.</span></Note> : (
        <table className="cx-table" data-testid="gap-series">
          <thead><tr><th></th><th>Asset</th><th>Closure</th><th>State</th><th>Band</th><th>Sets outstanding</th></tr></thead>
          <tbody>{rows.map((r2) => (
            <tr key={r2.key.toBase58()} data-testid="gap-row">
              <td><input type="radio" name="gap-series" aria-label={`${r2.ticker} ${r2.closureId}`} checked={sel === r2.key.toBase58()} onChange={() => setSel(r2.key.toBase58())} /></td>
              <td>{r2.ticker}</td><td className="cx-mono">{r2.closureId}</td><td><Pill tone={STATE_TONE[r2.state]}>{r2.state}</Pill></td>
              <td>±{pctOf(r2.kWad)}</td><td>{usdc(r2.setsOutstanding, 0)}</td>
            </tr>))}</tbody>
        </table>
      )}

      {s && (
        <>
          <H>{s.ticker} · weekend of {weekendOf(s.closureId)}</H>
          <KV rows={[
            ['State', <span key="s" data-testid="gap-state"><Pill tone={STATE_TONE[s.state]}>{s.state}</Pill></span>],
            ['Band k', <span key="k" data-testid="gap-band">±{pctOf(s.kWad)} (2.5 σ, from the program)</span>],
            ['Minting until', <span key="b" className="cx-mono">{utc(s.bell)}</span>],
            ['Collateral held', <span key="c" data-testid="gap-collateral">{collateral.data != null ? `${usdc(collateral.data, 6)} USDC` : '…'}</span>],
            ['Sets outstanding', usdc(s.state === 'open' ? s.setsOutstanding : s.setsSettled, 6)],
          ]} />

          <H>Payout curve</H>
          <Curve s={s} />
          <p className="cx-hint">Linear between −{pctOf(s.kWad)} and +{pctOf(s.kWad)}, flat beyond. DOWN and UP always add up to exactly 1 USDC.</p>

          <H>Settlement result</H>
          {s.state === 'open' ? <Note icon="clock"><span data-testid="gap-result" title="It settles on the same stored close and settlement price as cover; anyone may settle it once they are stored.">Not settled yet.</span></Note> : (
            <>
              <KV rows={[
                ['Rate', <span key="r" data-testid="gap-result">{s.state === 'settled' ? 'settled' : 'expired (the epoch never settled)'}</span>],
                ['Close → settlement', s.closePriceWad > 0n ? <span key="p" data-testid="gap-prices">{fixed(s.closePriceWad, 18, 4)} → {fixed(s.settlePriceWad, 18, 4)}{r != null ? ` (${(Number(r) / 1e16).toFixed(2)}%)` : ''}</span> : 'no close was stored: 0.5 each'],
                ['One GAP-DOWN pays', <span key="d" data-testid="gap-down-pays">{(rate(0)! / 1e6).toFixed(6)} USDC</span>],
                ['One GAP-UP pays', <span key="u" data-testid="gap-up-pays">{(rate(1)! / 1e6).toFixed(6)} USDC</span>],
                ['Still owed', owed ? <span key="o" data-testid="gap-owed">{usdc(owed.down + owed.up, 6)} USDC (collateral {collateral.data != null ? usdc(collateral.data, 6) : '…'})</span> : '—'],
              ]} />
            </>
          )}

          <H>Your tokens</H>
          {!user ? <ConnectNote>Connect a wallet to mint, merge or redeem.</ConnectNote> : (
            <>
              <KV rows={[
                ['USDC', bal.data?.usdc != null ? usd(Number(bal.data.usdc) / 1e6) : '…'],
                ['GAP-DOWN', <span key="d" data-testid="gap-hold-down">{usdc(h.down, 6)}</span>],
                ['GAP-UP', <span key="u" data-testid="gap-hold-up">{usdc(h.up, 6)}</span>],
                ['Complete sets', <span key="c" data-testid="gap-hold-sets">{usdc(sets, 6)}</span>],
              ]} />
              <div className="cx-row">
                <label>USDC <input data-testid="gap-amount" type="number" min={0} value={amt} onChange={(e) => setAmt(e.target.value)} /></label>
                <button data-testid="gap-mint" className="cx-btn" disabled={!!send.busy || paused || !selling} onClick={mint}>Mint sets</button>
                <button data-testid="gap-merge" className="cx-btn" disabled={!!send.busy || sets === 0n} onClick={merge}>Merge sets</button>
                {(paused || !selling) && <span className="cx-page-sub" data-testid="gap-mint-note">{paused ? 'Minting is paused.' : !live ? 'The rate is fixed: no more minting.' : 'Minting closed at the bell.'}</span>}
              </div>
              <div className="cx-row">
                <button data-testid="gap-redeem-down" className="cx-btn" disabled={!!send.busy || live || h.down === 0n} onClick={() => redeem(0)}>Redeem all GAP-DOWN</button>
                <button data-testid="gap-redeem-up" className="cx-btn" disabled={!!send.busy || live || h.up === 0n} onClick={() => redeem(1)}>Redeem all GAP-UP</button>
                {live && <span className="cx-page-sub">Redeeming opens when the series settles. Until then a complete set merges back to 1 USDC.</span>}
              </div>
              <Note icon="shield-check"><span data-testid="gap-exit-note">Merge and redeem never depend on Credence’s pause. Tokens move by plain transfer: there is no market, no order book and no price here.</span></Note>
              <Details summary="Token accounts"><p>DOWN {short(acc!.down)} · UP {short(acc!.up)} (Token-2022, no freeze authority, no transfer hook).</p></Details>
            </>
          )}
          {send.busy && <p className="cx-page-sub" data-testid="gap-busy">{send.busy}…</p>}
          {send.error && <Note icon="alert" tone="bad"><span data-testid="gap-error">{send.error}</span></Note>}
          {msg && <p className="cx-page-sub" data-testid="gap-msg">{msg}</p>}
        </>
      )}
    </>
  );
}
