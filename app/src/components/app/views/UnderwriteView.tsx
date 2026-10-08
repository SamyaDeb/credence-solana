'use client';
// Underwrite: the LP vault that backs every weekend's gap cover. Every figure is a stored field of the Vault, Config or
// share mint, or a stated function of them (lib/vault.ts, pinned by test/vault-accounts.test.ts and the e2e). LPs
// deposit (immediately while no weekend is live, else queued), request withdrawals (paid at the NAV once the weekends
// they wait for settle, INV-5/INV-6) and process ready tickets. Live weekends are shown as their epochs; the backtest
// replays ten years of weekends through today's pricing.
import { useQuery } from '@tanstack/react-query';
import type { TransactionInstruction } from '@solana/web3.js';
import { EPOCH_NAME, TICKET, USDC_MINT, ata, bn, createAtaIx, pdas } from '@/lib/credence';
import type { EpochView } from '@/lib/cover';
import { et, fixed, num, short, usdc, usdc6, utc } from '@/lib/format';
import { useEpochs } from '@/lib/hooks/chain';
import { useSend } from '@/lib/hooks/send';
import { useLpPosition, useQueue, useVault } from '@/lib/hooks/vault';
import { type TicketView, ticketLabel, ticketReady } from '@/lib/vault';
import { ActionTile, type Spec, Row, plain, units } from '../actions';
import { useSolana } from '../Providers';
import { Bar, GradientCard, H, KV, Note, PageHead, Pill, Sim, StatBlock } from '../ui';
import { IS_MAINNET, READ_ONLY_NOTE } from '@/lib/network';
import { ConnectNote, ErrorNote, Loading } from './shared';

function Fig({ k, v, unit, s, id }: { k: string; v: string; unit?: string; s?: string; id: string }) {
  return (
    <div className="cx-fig">
      <div className="cx-fig-k">{k}</div>
      <div className="cx-fig-v" data-testid={`vault-${id}`}>{v}{unit && <small>{unit}</small>}</div>
      {s && <div className="cx-fig-s">{s}</div>}
    </div>
  );
}

/** One live or past weekend: its epochs (one per asset) added up. */
function groupsOf(epochs: EpochView[]) {
  const m = new Map<number, EpochView[]>();
  for (const e of epochs) m.set(e.closureId, [...(m.get(e.closureId) ?? []), e]);
  return [...m].sort((a, b) => b[0] - a[0]).map(([id, es]) => ({
    id, es, open: es[0].open, close: es[0].close,
    policies: es.reduce((a, e) => a + e.policyCount, 0), settled: es.reduce((a, e) => a + e.policiesSettled, 0),
    premium: es.reduce((a, e) => a + e.totalPremium, 0n), maxPayout: es.reduce((a, e) => a + e.totalMaxPayout, 0n), payout: es.reduce((a, e) => a + e.totalPayout, 0n),
  }));
}

export function UnderwriteView() {
  const { signer, prog } = useSolana();
  const owner = signer?.publicKey;
  const vault = useVault();
  const lp = useLpPosition(owner);
  const queue = useQueue(owner);
  const epochs = useEpochs();
  const dep = useSend(); const wd = useSend(); const proc = useSend();
  const v = vault.data;
  const f = v?.figures;
  const s = v?.view;
  const newest = s?.live.length ? Math.max(...s.live) : 0;
  const locked = (s?.liveGroups ?? 0) > 0;
  const shares = lp.data?.shares ?? 0n;
  const value = f ? (shares * f.navPerShare6) / 1_000_000n : 0n;
  const wallet = lp.data?.usdc ?? 0n;

  const depositIxs = async (amount: bigint): Promise<TransactionInstruction[]> => {
    const me = owner!;
    if (!locked) {
      return [createAtaIx(me, me, pdas.shares()), await prog.methods.deposit(bn(amount)).accountsPartial({
        depositor: me, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), depositorUsdc: ata(me, USDC_MINT), depositorShares: ata(me, pdas.shares()), shareEscrow: pdas.shareEscrow(),
      }).instruction()];
    }
    return [await prog.methods.requestDeposit(bn(amount)).accountsPartial({
      depositor: me, vaultUsdc: pdas.vaultUsdc(), depositorUsdc: ata(me, USDC_MINT), ticket: pdas.depositTicket(me, newest),
    }).instruction()];
  };
  const withdrawIxs = async (n: bigint) => [await prog.methods.requestWithdraw(bn(n)).accountsPartial({
    owner: owner!, shareMint: pdas.shares(), shareEscrow: pdas.shareEscrow(), ownerShares: ata(owner!, pdas.shares()), ticket: pdas.withdrawTicket(owner!, newest),
  }).instruction()];
  const processIxs = async (t: TicketView): Promise<TransactionInstruction[]> => {
    const me = owner!;
    if (t.kind === TICKET.DEPOSIT) {
      return [createAtaIx(me, t.owner, pdas.shares()), createAtaIx(me, t.owner, USDC_MINT), await prog.methods.processDeposit().accountsPartial({
        caller: me, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), ticket: t.key, owner: t.owner, ownerShares: ata(t.owner, pdas.shares()), shareEscrow: pdas.shareEscrow(), ownerUsdc: ata(t.owner, USDC_MINT),
      }).instruction()];
    }
    return [createAtaIx(me, t.owner, USDC_MINT), await prog.methods.processWithdrawal().accountsPartial({
      caller: me, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), shareEscrow: pdas.shareEscrow(), ticket: t.key, owner: t.owner, ownerUsdc: ata(t.owner, USDC_MINT),
    }).instruction()];
  };

  const specs: Spec[] = [
    {
      icon: 'deposit', title: locked ? 'Queue deposit' : 'Deposit', testId: 'lp-deposit', sub: locked ? `Joins after weekend ${newest} settles` : 'Shares minted now at the NAV', amount: owner && lp.data ? `${usdc(wallet, 0)} USDC` : '—',
      dialog: {
        title: locked ? 'Queue a deposit' : 'Deposit into the vault',
        description: locked ? `Weekend ${s?.live.join(', ')} is live: the deposit waits in the queue (request_deposit) and joins equity at the NAV after it settles. Queued USDC earns none of that weekend's premium and bears none of its loss.`
          : 'No weekend is live: shares are minted now at the current NAV (deposit), rounded against you by less than one share.',
        fields: [{ key: 'amount', unit: 'USDC', initial: '10000', quick: [{ label: '1,000', value: '1000' }, { label: '10,000', value: '10000' }, { label: 'Wallet', value: plain(wallet, 6, 2) }] }],
        preview: (x) => { const a = Number(x.amount) || 0; return f ? [['Shares at today\'s NAV', num(a / (Number(f.navPerShare6) / 1e6), 6)], ['Counts from', locked ? `After weekend ${newest}` : 'Now']] : []; },
        confirm: locked ? 'Queue deposit' : 'Deposit', state: dep, blocked: v?.paused ? 'The vault is paused: deposits are refused (A-08).' : null,
        send: async (x) => { const a = units(x.amount, 6, 'a USDC amount'); return !!(await dep.run(locked ? 'Queuing' : 'Depositing', [{ label: locked ? 'request_deposit' : 'deposit', ixs: () => depositIxs(a) }])); },
      },
    },
    {
      icon: 'withdraw', title: 'Request withdrawal', testId: 'lp-withdraw', sub: newest ? `Paid after weekend ${newest} settles` : 'Paid when processed', amount: owner && lp.data ? `${fixed(shares, 6, 2)} sh` : '—',
      dialog: {
        title: 'Request a withdrawal', description: 'request_withdraw moves the shares into escrow: they keep bearing the live weekends\' losses and earning their premiums, and are paid at the NAV once those weekends settle.',
        fields: [{ key: 'shares', unit: 'shares', quick: [{ label: 'Half', value: plain(shares / 2n, 6, 6) }, { label: 'All', value: plain(shares, 6, 6) }] }],
        preview: (x) => [['Value at today\'s NAV', f ? `${num((Number(x.shares) || 0) * Number(f.navPerShare6) / 1e6)} USDC` : '—'], ['Paid', newest ? `After weekend ${newest} settles` : 'When processed']],
        confirm: 'Request withdrawal', state: wd, blocked: shares === 0n ? 'You hold no LP shares.' : null,
        send: async (x) => { const n = units(x.shares, 6, 'a number of shares'); if (n > shares) throw new Error('More than you hold.'); return !!(await wd.run('Requesting', [{ label: 'request_withdraw', ixs: () => withdrawIxs(n) }])); },
      },
    },
  ];

  const groups = groupsOf(epochs.data ?? []);
  const live = groups.filter((g) => s?.live.includes(g.id));

  return (
    <>
      {IS_MAINNET ? <MainnetUnderwrite /> : <>
      <PageHead title="Underwrite" sub="LPs deposit USDC into one vault that backs every weekend's gap cover. Premiums are earned when the weekend settles; payouts come out of equity. Deposits and withdrawals made while a weekend is live wait for it." />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={<small className="cx-mono" title={pdas.vault().toBase58()}>vault {short(pdas.vault(), 6)}{v?.paused ? ' · PAUSED' : ''}</small>}>LP vault</H>
            {vault.error ? <ErrorNote error={vault.error} /> : !v ? <Loading what="Reading the vault" /> : (
              <Row specs={specs}>
                <GradientCard tag="LP vault" big={owner ? (lp.data ? `${usdc(value)} USDC` : '…') : `${usdc(s!.equity, 0)} USDC`} label={owner ? 'Your shares × NAV' : 'LP equity'}
                  value={`NAV ${fixed(f!.navPerShare6, 6, 6)} USDC/share`} pill={<Pill tone={locked ? 'warn' : 'good'}>{locked ? `${s!.liveGroups} live weekend${s!.liveGroups > 1 ? 's' : ''}` : 'No weekend live'}</Pill>} />
              </Row>
            )}
            {!signer && <div style={{ marginTop: 18 }}><ConnectNote>Connect a wallet to deposit and see your shares.</ConnectNote></div>}
          </section>
          {v && (
            <section data-testid="vault">
              <H right={<small>Read from the Vault account</small>}>The vault, as stored</H>
              <div className="cx-figs">
                <Fig k="LP equity" v={usdc(s!.equity)} unit="USDC" s={`${usdc6(s!.equity)} · vault.equity`} id="equity" />
                <Fig k="NAV per share" v={fixed(f!.navPerShare6, 6, 6)} unit="USDC" s={`equity / ${usdc6(v.supply)} shares, rounded down`} id="nav" />
                <Fig k="Premiums unearned" v={usdc(s!.premiumsUnearned)} unit="USDC" s="live weekends" id="unearned" />
                <Fig k="Premiums earned" v={usdc(f!.premiumsEarned)} unit="USDC" s={`lifetime: ${usdc(s!.totalPremiums)} − unearned`} id="earned" />
                <Fig k="Reserved worst loss" v={usdc(s!.reservedTotal)} unit="USDC" s={`limit ⌊u_max × equity⌋ = ${usdc(f!.capacityLimit)}`} id="reserved" />
                <Fig k="Utilisation" v={`${(f!.utilisationPpm / 10_000).toFixed(4)}%`} s={`reserved / limit (u_max ${fixed(v.uMaxWad * 100n, 18, 0)}%)`} id="util" />
                <Fig k="Payouts (lifetime)" v={usdc(s!.totalPayouts)} unit="USDC" s={usdc6(s!.totalPayouts)} id="payouts" />
                <Fig k="Live weekends" v={String(s!.liveGroups)} s={s!.live.length ? s!.live.join(', ') : 'none: deposits are immediate'} id="live" />
              </div>
              <div style={{ marginTop: 18 }}><Bar value={f!.utilisationPpm / 1_000_000} /></div>
              <p className="cx-hint">Capacity: the worst of 256 joint stress weekends must stay within u_max × equity (INV-2). Cover sales stop when it is full.</p>
            </section>
          )}
          {owner && (queue.data?.length ?? 0) > 0 && (
            <section>
              <H right={<small>Processing is permissionless once a ticket is ready</small>}>Your queued requests</H>
              <div className="cx-row" data-testid="tickets">
                {queue.data!.map((t) => {
                  const ready = ticketReady(t, s?.live ?? []);
                  return (
                    <ActionTile key={t.key.toBase58()} spec={{
                      icon: t.kind === TICKET.DEPOSIT ? 'deposit' : 'withdraw', title: `${ticketLabel(t)[0].toUpperCase()}${ticketLabel(t).slice(1)}`, testId: `process-${t.kind === TICKET.DEPOSIT ? 'dep' : 'wd'}`,
                      sub: ready ? 'Ready to process' : `Waits for weekend ${t.waitGroup}`, amount: t.kind === TICKET.DEPOSIT ? `${usdc(t.amount)} USDC` : `${fixed(t.amount, 6, 2)} sh`,
                      dialog: {
                        title: `Process the ${ticketLabel(t)}`, description: t.kind === TICKET.DEPOSIT ? 'Mints shares at the NAV of this moment, rounded against you (INV-5).' : 'Pays USDC at the NAV of this moment, once every weekend up to the ticket\'s has settled (INV-6).',
                        preview: () => [['Ticket', short(t.key, 6)], ['Requested', utc(t.requestedAt)], ['Waits for weekend', t.waitGroup ? String(t.waitGroup) : 'none'], ['Status', ready ? 'ready' : 'waiting']],
                        confirm: 'Process', state: proc, blocked: ready ? null : `Weekend ${t.waitGroup} has not settled yet.`,
                        send: async () => !!(await proc.run('Processing', [{ label: t.kind === TICKET.DEPOSIT ? 'process_deposit' : 'process_withdrawal', ixs: () => processIxs(t) }])),
                      },
                    }} />
                  );
                })}
              </div>
            </section>
          )}
          <section>
            <H right={<small>One epoch per asset, one loss vector per weekend; policies settled / sold</small>}>Weekends</H>
            {groups.length === 0 ? <Note icon="clock">No weekend has been opened on the fork yet.</Note> : (
              <div className="cx-table-wrap">
                <table className="cx-table is-keep" data-testid="weekends">
                  <thead><tr><th>Weekend</th><th className="is-num">Policies</th><th className="is-num">Premiums</th><th className="is-num">Max payout</th><th className="is-num">Paid</th></tr></thead>
                  <tbody>
                    {groups.slice(0, 6).map((g) => (
                      <tr key={g.id} title={`${et(g.close)} → ${et(g.open)} · ${g.es.map((e) => `${e.ticker} ${EPOCH_NAME[e.state]}`).join(', ')}`}>
                        <td className="is-strong">{g.id}{s?.live.includes(g.id) ? <span className="cx-live"> live</span> : ` · ${EPOCH_NAME[g.es[0].state]}`}</td>
                        <td className="is-num">{g.settled}/{g.policies}</td>
                        <td className="is-num">{usdc(g.premium)}</td>
                        <td className="is-num">{usdc(g.maxPayout, 0)}</td>
                        <td className="is-num">{usdc(g.payout)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <Backtest />
        </div>
        <aside className="cx-aside">
          <StatBlock label="Your LP value" value={owner && lp.data && f ? usdc(value) : '—'} chip="USDC" testId="lp-value" />
          <KV rows={[['Shares', owner && lp.data ? <span key="s" data-testid="lp-shares">{fixed(shares, 6, 6)}</span> : '—'], ['Wallet USDC', owner && lp.data ? usdc(wallet) : '—'], ['Queued requests', owner && queue.data ? String(queue.data.length) : '—']]} />
          {v && (
            <div>
              <H>Queues</H>
              <KV rows={[['Queued deposits', `${usdc6(s!.queuedDeposits)} USDC`], ['Queued withdrawals', `${fixed(s!.queuedWithdrawShares, 6, 6)} sh`], ['Share supply', fixed(v.supply, 6, 6)], ['Free capacity', `${usdc(f!.freeCapacity, 0)} USDC`]]} />
            </div>
          )}
          {live.length > 0 && <Note icon="shield">Weekend {live.map((g) => g.id).join(', ')}: {live.reduce((a, g) => a + g.policies, 0)} policies, {usdc(live.reduce((a, g) => a + g.premium, 0n))} USDC of premiums unearned until it settles.</Note>}
          <Note icon="lock">Withdrawals for a weekend are paid only after it settles (INV-6), at the NAV of that moment; a deposit or withdrawal never lowers the NAV per share (INV-5).</Note>
        </aside>
      </div>
    </>}
    </>
  );
}

type W = { date: string; type: string; lpReturn: number; pnlUsd: number; premiumUsd: number; payoutUsd: number; r: Record<string, number> };
type BT = {
  generatedBy: string; caveats: string[]; sigmaWad: Record<string, string>;
  summary: { book: { policies: number; perAsset: number; debtUsdEach: number; debtToCoveredRange: [number, number] }; closures: { dated: number; nonOvernight: number; premiumOnly: number };
    totals: { annualReturnOnEquity: number; lossRatio: number; pnlUsd: number }; vaultEquityUsd: number; worstWeekend: W & { payoutUsd: Record<string, number> }; worstSynthetic: W };
  dated: W[];
};
const usdF = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const pc = (x: number, dp = 2) => `${x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(dp)}%`;

export function Backtest() {
  const q = useQuery<BT>({ queryKey: ['backtest'], staleTime: Infinity, queryFn: async () => { const r = await fetch('/api/data/backtest'); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; } });
  if (q.error) return <ErrorNote error={q.error} what="the backtest" />;
  if (!q.data) return <Loading what="Loading the backtest" />;
  const d = q.data; const s = d.summary; const worst = s.worstWeekend;
  const worstMove = Object.entries(worst.r).sort((a, b) => a[1] - b[1])[0];
  return (
    <section data-testid="backtest">
      <H right={<Sim>historical replay, not live results</Sim>}>Backtest: LP return per weekend, 2016–2026</H>
      <p className="cx-hint">{s.book.policies} policies ({s.book.perAsset} each on SPYx, QQQx, NVDAx), {usdF(s.book.debtUsdEach)} of debt each at D/C′ {s.book.debtToCoveredRange[0]}–{s.book.debtToCoveredRange[1]}, cap = debt, against a {usdF(s.vaultEquityUsd)} vault, bought every weekend at today&apos;s premiums and σ and paid with the program&apos;s own payout rule.</p>
      <div className="cx-figs" style={{ margin: '14px 0' }}>
        <Fig k="Return on LP equity" v={pc(s.totals.annualReturnOnEquity)} unit="/ yr" s={`${s.closures.nonOvernight} weekends`} id="bt-return" />
        <Fig k="Total, 10 years" v={`+${pc(s.totals.pnlUsd / s.vaultEquityUsd)}`} s={`loss ratio ${pc(s.totals.lossRatio, 1)}`} id="bt-total" />
        <Fig k="Worst weekend" v={pc(worst.lpReturn)} s={`${worst.date}: ${worstMove[0]} ${pc(worstMove[1], 1)}`} id="bt-worst" />
        <Fig k="Worst synthetic stress" v={pc(s.worstSynthetic.lpReturn)} s="all three at z = −9.2" id="bt-synth" />
      </div>
      <Bars rows={d.dated} worst={worst.date} />
      <p className="cx-hint" style={{ lineHeight: 1.6 }}>
        <b>Parameters:</b> θ 100%, c 10%, η 1, β 97.5%, u_max 50%, min premium 5 USDC, fee 0; σ per weekend = max(recent, 2016–2026 long-run): SPYx {pc(Number(d.sigmaWad.SPYx) / 1e18)}, QQQx {pc(Number(d.sigmaWad.QQQx) / 1e18)}, NVDAx {pc(Number(d.sigmaWad.NVDAx) / 1e18)}.
        Shown: the {s.closures.dated} dated weekends of the joint stress set; {s.closures.premiumOnly} calmer weekends earn premium only. Source: {d.generatedBy}. <b>Data licence:</b> Alpaca SIP data, free personal licence, not cleared for commercial use. <b>Caveats:</b> {d.caveats.join('; ')}.
      </p>
    </section>
  );
}

function Bars({ rows, worst }: { rows: W[]; worst: string }) {
  const W = 1000, H = 230, padL = 50, padR = 8, padT = 12, padB = 26;
  const min = Math.min(...rows.map((r) => r.lpReturn));
  const lo = Math.floor(Math.min(min, -0.005) * 1.08 * 200) / 200, hi = 0.0025;
  const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB);
  const bw = (W - padL - padR) / rows.length;
  const ticks = Array.from({ length: Math.round(-lo / 0.005) + 1 }, (_, k) => -k * 0.005);
  const years = rows.map((r, i) => ({ i, y: r.date.slice(0, 4) })).filter((r, k, a) => k === 0 || a[k - 1].y !== r.y);
  const wi = rows.findIndex((r) => r.date === worst);
  return (
    <svg className="cx-chart-wide" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="LP return per weekend, 2016 to 2026">
      {ticks.map((t) => <g key={t}><line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#9597aa' : '#e4e4e8'} /><text x={padL - 8} y={y(t) + 4} fill="#9597aa" fontSize="11" textAnchor="end">{pc(t, 1)}</text></g>)}
      {years.map((yr) => <text key={yr.y} x={padL + yr.i * bw} y={H - 8} fill="#9597aa" fontSize="11">{yr.y}</text>)}
      {rows.map((r, i) => {
        const top = y(Math.max(r.lpReturn, 0)), bot = y(Math.min(r.lpReturn, 0));
        return <rect key={r.date} x={padL + i * bw} y={top} width={Math.max(bw - 0.6, 0.8)} height={Math.max(bot - top, 0.8)}
          fill={i === wi ? '#c0392b' : r.lpReturn < 0 ? '#d98880' : '#2e335b'} opacity={r.lpReturn < 0 ? 0.95 : 0.55}><title>{`${r.date}: ${pc(r.lpReturn, 3)} (premium ${usdF(r.premiumUsd)}, payout ${usdF(r.payoutUsd)})`}</title></rect>;
      })}
      {wi >= 0 && <text x={padL + wi * bw + 6} y={y(rows[wi].lpReturn) + 4} fill="#c0392b" fontSize="11">worst: {rows[wi].date}</text>}
    </svg>
  );
}

/** The public read-only view: the vault runs on the local fork until the mainnet pilot is deployed; the backtest is data. */
function MainnetUnderwrite() {
  return (
    <>
      <PageHead title="Underwrite" sub="LPs deposit USDC into one vault that backs every weekend's gap cover; premiums are earned when the weekend settles." />
      <div className="cx-col">
        <Note icon="lock">{READ_ONLY_NOTE}</Note>
        <Backtest />
      </div>
    </>
  );
}
