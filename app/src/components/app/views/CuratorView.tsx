'use client';
// Curator (C2, W5): a curator or vault manager covers a book of positions it does not own. Pick a market, filter the
// scanned positions (C1, GET /api/unlock), quote the book next to the sum of standalone quotes (POST /api/book-quote:
// the program's own leg pricing and risk-core::book_premium; nothing priced here), buy it in batches (open_book, one
// add_book_leg* per transaction, seal_book; resumable: the book is a PDA of the wallet, the weekend and a book id, and
// the legs already added are read back from the chain), and follow the book over the weekend. Costs are debt-weighted
// with C1's size buckets, never the median (2,274 of 2,390 positions pay the minimum premium alone).
import { useQuery } from '@tanstack/react-query';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { useMemo, useState } from 'react';
import { BOOK_NAME, EPOCH_NAME, POLICY_NAME, USDC_MINT, addBookLegIx, ata, claimBookRefund, defaultSealMax, openBook, pdas, sealBook } from '@credence/sdk';
import { currentEpoch, freshenScope, scopeChains } from '@/lib/cover';
import { num, pct, short, usd, usdc6 } from '@/lib/format';
import { useAssets, useClock, useEpochs } from '@/lib/hooks/chain';
import { useSend } from '@/lib/hooks/send';
import { decodeObligation, loadReserves, refreshIxs, deposits, borrows } from '@/lib/kamino';
import { IS_MAINNET, READ_ONLY_NOTE } from '@/lib/network';
import { useSolana } from '../Providers';
import { H, KV, Note, PageHead, Pill, Sim, StatBlock } from '../ui';
import { ConnectNote, ErrorNote, Loading } from './shared';

const JL_VAULTS = new PublicKey('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');
type Market = { id: string; label: string; lender: 'kamino' | 'jupiter'; asset?: string; buy: boolean; note?: string };
const MARKETS: Market[] = [
  { id: 'kamino', label: 'Kamino xStocks Market (USDC)', lender: 'kamino', buy: true },
  { id: 'sentora', label: 'Sentora xStocks Market (multi-collateral, PYUSD)', lender: 'kamino', buy: false,
    note: 'Sentora legs are PYUSD: they need the vault\'s PYUSD sleeve funded first, so the keeper adds them (add_book_leg_multi); quoting works here.' },
  ...['SPYx', 'QQQx', 'NVDAx', 'TSLAx'].map((a) => ({ id: `jl-${a}`, label: `Jupiter Lend ${a} / USDC vault`, lender: 'jupiter' as const, asset: a, buy: true })),
];
const TARGETS = [{ id: '', label: 'as they are' }, { id: '0.85', label: 'unlocked to D/C′ 0.85' }, { id: '0.9', label: 'unlocked to D/C′ 0.90' }];
const MAX_BUY = 40;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
type Quote = { legs: { id: string; standalone: string; extra: string; e: string; loading: string }[]; book: { premium: string; expectedLoss: string; loading: string } | null;
  sumStandalone: string; minPremium: string; missing: number; caveat?: string };

function inMarket(r: Row, m: Market) {
  if (m.id === 'kamino') return r.lender === 'kamino' && r.borrow === 'USDC' && r.path !== 'multi';
  if (m.id === 'sentora') return r.lender === 'kamino' && r.borrow === 'PYUSD';
  return r.lender === 'jupiter' && r.asset === m.asset;
}

const dollars = (base: string | bigint) => Number(BigInt(base)) / 1e6;

export function CuratorView() {
  const { conn, prog, signer } = useSolana();
  const { now } = useClock();
  const epochs = useEpochs();
  const assets = useAssets();
  const [market, setMarket] = useState<Market>(MARKETS[0]);
  const [minDebt, setMinDebt] = useState(100);
  const [minDc, setMinDc] = useState(0);
  const [target, setTarget] = useState('0.9');
  const [bookId, setBookId] = useState(1);
  const send = useSend();

  const unlock = useQuery({ queryKey: ['unlock-positions'], staleTime: 300_000, queryFn: async () => {
    const r = await fetch('/api/unlock?positions=1');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    return j;
  } });
  const rows: Row[] = useMemo(() => (unlock.data?.positions ?? [])
    .filter((r: Row) => inMarket(r, market) && dollars(r.debt) >= minDebt && r.dc >= minDc)
    .sort((a: Row, b: Row) => b.dc - a.dc), [unlock.data, market, minDebt, minDc]);

  const quote = useQuery({
    queryKey: ['book-quote', market.id, minDebt, minDc, target, rows.length],
    enabled: rows.length > 0,
    queryFn: async (): Promise<Quote> => {
      const r = await fetch('/api/book-quote', { method: 'POST', body: JSON.stringify({ ids: rows.map((x: Row) => x.id), target: target || null }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      return j;
    },
  });

  // Size buckets and debt-weighted costs (C1): the selected market's aggregate at the selected target.
  const agg = useMemo(() => {
    const a = unlock.data?.aggregates;
    if (!a) return null;
    const t = target || '0.9';
    if (market.id === 'kamino') return a.byLender?.kamino?.targets?.[t];
    if (market.id === 'sentora') return a.pyusd?.targets?.[t] ?? null;
    return a.byLenderAsset?.jupiter?.[market.asset!]?.targets?.[t];
  }, [unlock.data, market, target]);

  // The weekend on sale now and this wallet's book for it (resumable: the address is derived, the legs read back).
  const epochAsset = market.lender === 'jupiter' ? `${market.asset}.J` : 'SPYx';
  const ep = now && epochs.data ? currentEpoch(epochs.data, epochAsset, now) : undefined;
  const group = ep?.closureId;
  const bookKey = signer && group ? pdas.book(signer.publicKey, group, bookId) : null;
  const book = useQuery({
    queryKey: ['book', bookKey?.toBase58()], enabled: !!bookKey, refetchInterval: 10_000,
    queryFn: async () => (await conn.getAccountInfo(bookKey!)) ? await prog.account.book.fetch(bookKey!) : null,
  });
  const b = book.data;
  const buyRows = rows.slice(0, MAX_BUY);
  const legOf = (r: Row) => {
    const t = r.legs[0].ticker as string;
    return { ticker: t, policy: pdas.policy(pdas.epoch(t, group!), new PublicKey(r.id)) };
  };
  const legs = useQuery({
    queryKey: ['book-legs', bookKey?.toBase58(), buyRows.map((r: Row) => r.id).join(',')], enabled: !!bookKey && buyRows.length > 0, refetchInterval: 10_000,
    queryFn: async () => {
      const keys = buyRows.map((r: Row) => legOf(r).policy);
      const out: Record<string, { mine: boolean; state: number; advanced: bigint; payout: bigint } | null> = {};
      for (let i = 0; i < keys.length; i += 100) {
        const infos = await conn.getMultipleAccountsInfo(keys.slice(i, i + 100));
        infos.forEach((a, j) => {
          const id = buyRows[i + j].id;
          if (!a) { out[id] = null; return; }
          const p = prog.coder.accounts.decode('policy', a.data);
          out[id] = { mine: p.book.equals(bookKey!), state: p.state, advanced: BigInt(p.advanced.toString()), payout: BigInt(p.payout.toString()) };
        });
      }
      return out;
    },
  });
  // The quote of exactly what "Buy" adds: these rows at today's debt (A-90: the quote above may be at a target D/C′).
  const buyQuote = useQuery({
    queryKey: ['book-quote-buy', buyRows.map((r: Row) => r.id).join(',')], enabled: buyRows.length > 0,
    queryFn: async (): Promise<Quote> => {
      const r = await fetch('/api/book-quote', { method: 'POST', body: JSON.stringify({ ids: buyRows.map((x: Row) => x.id), target: null }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      return j;
    },
  });
  const pending = buyRows.filter((r: Row) => legs.data && legs.data[r.id] === null);
  const added = buyRows.filter((r: Row) => legs.data?.[r.id]?.mine).length;

  // The SDK builds the instructions (packages/sdk/src/book.ts); the app adds the fork's price refreshes and sends.
  const legIxs = async (r: Row): Promise<TransactionInstruction[]> => {
    const me = signer!.publicKey;
    const { ticker } = legOf(r);
    const position = new PublicKey(r.id);
    if (market.lender === 'kamino') {
      const o = decodeObligation((await conn.getAccountInfo(position))!.data);
      const reserves = await loadReserves(conn, [...deposits(o), ...borrows(o)]);
      await freshenScope(scopeChains([...reserves.values()]));
      return [...refreshIxs(position, o, reserves), await addBookLegIx(prog, { payer: me, book: bookKey!, closureId: group!, leg: { kind: 'kamino', ticker, obligation: position, o, reserves } })];
    }
    const a = await prog.account.assetConfig.fetch(pdas.asset(ticker));
    const r0 = await fetch('/api/fork/jl-fresh', { method: 'POST', body: JSON.stringify({ caches: [a.lenderOracle.toBase58()] }) });
    if (!r0.ok) throw new Error((await r0.json()).error);
    const d = (await conn.getAccountInfo(position))!.data;
    return [await addBookLegIx(prog, { payer: me, book: bookKey!, closureId: group!,
      leg: { kind: 'jupiter', ticker, position, vaultId: d.readUInt16LE(8), tick: d.readInt32LE(47), vaultConfig: a.lenderVault, cache: a.lenderOracle } })];
  };

  const buy = async () => {
    const me = signer!.publicKey;
    const steps: { label: string; ixs: () => Promise<TransactionInstruction[]> }[] = [];
    if (!book.data) {
      steps.push({ label: `open_book ${bookId}`, ixs: async () => [(await openBook(prog, { payer: me, closureId: group!, bookId, epoch: ep!.key })).ix] });
    }
    for (const r of pending) steps.push({ label: `add ${short(r.id)}`, ixs: () => legIxs(r) });
    await send.run('Adding legs', steps);
  };
  // The most the seal may charge (A-89): the escrow (an upper bound of the premium at each add's utilisation) + 10%.
  const sealMax = b ? defaultSealMax(BigInt(b.escrowed.toString())) : 0n;
  const seal = async () => {
    const me = signer!.publicKey;
    const v = await prog.account.vault.fetch(pdas.vault());
    await send.run('Sealing', [{ label: 'seal_book', ixs: async () => [await sealBook(prog, { payer: me, book: bookKey!, closureId: group!, maxPremium: sealMax, feeAccount: v.feeAccount })] }]);
  };
  const claim = async () => {
    const b = book.data!;
    const escrowLive = !!(await conn.getAccountInfo(b.escrow));
    await send.run('Claiming', [{ label: 'claim_book_refund', ixs: async () => [await claimBookRefund(prog, { caller: signer!.publicKey, book: { ...b, key: bookKey!, state: b.state, escrow: b.escrow, payer: b.payer, payerUsdc: b.payerUsdc } as never, escrowLive })] }]);
  };

  const q = quote.data;
  const bookPremium = q?.book ? dollars(q.book.premium) : 0;
  const sumStandalone = q ? dollars(q.sumStandalone) : 0;
  const extra = q ? q.legs.reduce((a, l) => a + dollars(l.extra), 0) : 0;
  const groupEpochs = (epochs.data ?? []).filter((e) => e.closureId === group);

  return (
    <>
      <PageHead title="Curator" sub="Cover a book of positions you do not own: one premium for the book, payouts only ever into the positions." right={<Sim>quotes: program pricing · buying: fork</Sim>} />
      <section>
        <H>Market and filter</H>
        <div className="cx-row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label>Market{' '}
            <select data-testid="curator-market" value={market.id} onChange={(e) => setMarket(MARKETS.find((m) => m.id === e.target.value)!)}>
              {MARKETS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label>Minimum debt ${' '}<input data-testid="curator-min-debt" type="number" min={0} value={minDebt} onChange={(e) => setMinDebt(Number(e.target.value) || 0)} style={{ width: 100 }} /></label>
          <label>Minimum D/C′{' '}<input data-testid="curator-min-dc" type="number" min={0} max={1} step={0.01} value={minDc} onChange={(e) => setMinDc(Number(e.target.value) || 0)} style={{ width: 80 }} /></label>
          <label>Quote{' '}
            <select data-testid="curator-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              {TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
        </div>
        {market.note && <Note icon="info">{market.note}</Note>}
      </section>

      {unlock.isLoading ? <Loading what="Loading the scanned positions" /> : unlock.error ? <ErrorNote error={unlock.error} what="the C1 analysis" /> : (
        <>
          <section data-testid="curator-quote">
            <H right={<Pill>{rows.length} positions</Pill>}>Book quote</H>
            {quote.isLoading ? <Loading what="Pricing the book" /> : quote.error ? <ErrorNote error={quote.error} what="the book quote" /> : q && q.book ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 16 }}>
                  <StatBlock label="Book premium (one weekend)" value={<span data-testid="curator-book-premium">{usd(bookPremium)}</span>} />
                  <StatBlock label="Σ standalone premiums" value={<span data-testid="curator-sum-standalone">{usd(sumStandalone)}</span>} />
                  <StatBlock label="Saving" value={<span data-testid="curator-saving">{pct(sumStandalone > 0 ? 1 - bookPremium / sumStandalone : 0)}</span>} />
                  {extra > 0 && <StatBlock label="Annualised per $ of extra credit, book vs standalone" value={<span data-testid="curator-annualised">{pct(bookPremium * 52 / extra)} vs {pct(sumStandalone * 52 / extra)}</span>} />}
                </div>
                <KV rows={[
                  ['Legs priced', `${q.legs.length}${target ? ` (positions below D/C′ ${target}; extra credit ${usd(extra, 0)})` : ''}`],
                  ['Expected loss / shield loading in the book', `${usdc6(BigInt(q.book.expectedLoss))} / ${usdc6(BigInt(q.book.loading))} USDC`],
                  ['Minimum premium', `${usdc6(BigInt(q.minPremium))} USDC once per book (each standalone policy pays it on its own)`],
                  ['Method', 'pricing::leg_quote_* + risk-core::book_premium at utilisation 0 for both; standalone = what buy_cover* charges'],
                ]} />
                {q.caveat && <Note icon="info">{q.caveat}</Note>}
              </>
            ) : <Note icon="info">No position matches the filter{target ? ` below D/C′ ${target}` : ''}.</Note>}
          </section>

          {agg && (
            <section data-testid="curator-buckets">
              <H>Standalone cost by size (C1, debt-weighted, at D/C′ {target || '0.9'})</H>
              <div className="cx-table-wrap"><table className="cx-table is-wrap">
                <thead><tr><th>Extra credit per position</th><th>Positions</th><th>Extra credit</th><th>Annualised, debt-weighted</th></tr></thead>
                <tbody>{Object.entries(agg.bySize ?? {}).map(([k, v]: [string, Row]) => (
                  <tr key={k}><td>≥ {usd(Number(k), 0)}</td><td>{v.positions}</td><td>{usd(v.extraDebtUsd, 0)}</td><td>{pct(v.annualisedCostDebtWeighted)}</td></tr>
                ))}</tbody>
              </table></div>
            </section>
          )}

          <section>
            <H right={<Pill>top {Math.min(rows.length, 200)} by D/C′</Pill>}>Positions</H>
            <div className="cx-table-wrap is-tall"><table className="cx-table is-wrap" data-testid="curator-positions">
              <thead><tr><th>Position</th><th>Asset</th><th>Debt</th><th>D/C′</th><th>P(liquidatable) today</th><th>Extra credit 0.85 / 0.90</th><th>In this book</th></tr></thead>
              <tbody>{rows.slice(0, 200).map((r: Row) => {
                const l = legs.data?.[r.id];
                return (
                  <tr key={r.id}>
                    <td title={r.id}>{short(r.id)}</td>
                    <td>{r.path === 'multi' ? r.legs.map((x: Row) => x.ticker).join('+') : r.legs[0].ticker}</td>
                    <td>{usd(dollars(r.debt), 0)}</td>
                    <td>{r.dc.toFixed(3)}</td>
                    <td>{pct(r.pLiquidatable.n / r.pLiquidatable.of, 2)}</td>
                    <td>{['0.85', '0.9'].map((t) => r.targets[t] ? usd(dollars(r.targets[t].extra), 0) : '—').join(' / ')}</td>
                    <td>{l === undefined ? '' : l === null ? '—' : l.mine ? `${POLICY_NAME[l.state]}${l.payout > 0n ? `, paid ${usdc6(l.payout)}` : ''}` : 'covered elsewhere'}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </section>

          <section data-testid="curator-buy">
            <H right={b ? <Pill tone={b.state === 1 ? 'good' : 'warn'} testId="curator-book-state">{BOOK_NAME[b.state]}</Pill> : undefined}>Buy the book</H>
            {IS_MAINNET ? <Note icon="info">{READ_ONLY_NOTE}</Note> : !signer ? <ConnectNote>Connect a wallet to cover a book.</ConnectNote> : !market.buy ? <Note icon="info">{market.note}</Note> : !ep ? (
              <Note icon="clock">No weekend on sale for {epochAsset} at this chain time.</Note>
            ) : (
              <>
                <KV rows={[
                  ['Weekend', `${group} (bell ${new Date(ep.bell * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z)`],
                  ['Book', <span key="b" data-testid="curator-book-key">{bookKey ? short(bookKey.toBase58(), 6) : '—'} (id <input type="number" min={1} value={bookId} onChange={(e) => setBookId(Math.max(1, Number(e.target.value) || 1))} style={{ width: 50 }} />)</span>],
                  ['This book (these legs at today\'s debt)', <span key="q" data-testid="curator-buy-quote">{buyQuote.data?.book ? `${usdc6(BigInt(buyQuote.data.book.premium))} USDC vs Σ standalone ${usdc6(BigInt(buyQuote.data.sumStandalone))} (utilisation 0; the seal prices at the vault's)` : '…'}</span>],
                  ['Legs', <span key="l" data-testid="curator-progress">{added} of {buyRows.length} added{pending.length ? `, ${pending.length} to go` : ''}</span>],
                  ...(b ? [
                    ['Escrow / premium', `${usdc6(BigInt(b.escrowed.toString()))} / ${usdc6(BigInt(b.premium.toString()))} USDC`] as [string, string],
                    ['Advanced / paid into positions', `${usdc6(BigInt(b.advanced.toString()))} / ${usdc6(BigInt(b.paidOut.toString()))} USDC`] as [string, string],
                    ['Refunds owed / paid', `${usdc6(BigInt(b.refundOwed.toString()))} / ${usdc6(BigInt(b.refunded.toString()))} USDC`] as [string, string],
                  ] : []),
                ]} />
                <div className="cx-row" style={{ gap: 8 }}>
                  <button type="button" className="cx-btn cx-btn-sm" data-testid="curator-add" disabled={!!send.busy || pending.length === 0 || (b != null && b.state !== 0)} onClick={buy}>
                    {b ? `Continue: add ${pending.length} legs` : `Open the book and add ${pending.length} legs`}
                  </button>
                  <button type="button" className="cx-btn cx-btn-sm" data-testid="curator-seal" disabled={!!send.busy || !b || b.state !== 0 || b.legsLive === 0} onClick={seal}>Seal (pay the book premium, at most {usdc6(sealMax)} USDC)</button>
                  <button type="button" className="cx-btn cx-btn-sm" data-testid="curator-claim" disabled={!!send.busy || !b || (BigInt(b.refundOwed.toString()) === 0n && b.state !== 2)} onClick={claim}>Claim refunds</button>
                </div>
                {send.busy && <Note icon="clock">{send.busy}: {send.sent.length} transactions sent</Note>}
                {send.error && <ErrorNote error={new Error(send.error)} what="the book" />}
                {send.sent.length > 0 && !send.busy && <Note icon="check">{send.sent.length} transactions: {send.sent.map((s) => `${s.label} (${num(s.cu, 0)} CU)`).join(', ')}</Note>}
                <Note icon="info">One leg per transaction from the app (the keeper's batches use a lookup table: up to 6 Kamino legs per transaction). A closed tab resumes: the book is at the same address and the legs already added are read back. Payouts and advances only go into the positions; a position its owner covers itself is released from the book and its share of the premium refunded.</Note>
              </>
            )}
          </section>

          {b && (
            <section data-testid="curator-weekend">
              <H>The book's weekend</H>
              <div className="cx-table-wrap"><table className="cx-table is-wrap">
                <thead><tr><th>Epoch</th><th>State</th><th>Policies (settled)</th></tr></thead>
                <tbody>{groupEpochs.filter((e) => e.policyCount > 0).map((e) => (
                  <tr key={e.key.toBase58()}><td>{e.ticker} {e.closureId}</td><td>{EPOCH_NAME[e.state]}</td><td>{e.policyCount} ({e.policiesSettled})</td></tr>
                ))}</tbody>
              </table></div>
            </section>
          )}
        </>
      )}
    </>
  );
}
