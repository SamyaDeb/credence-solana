'use client';
// Overview: the wallet's Kamino xStocks positions with their distance to liquidation and cover, the coming weekend's
// bell / close / open, the LP position, and recent activity, all read from the fork.
import Link from 'next/link';
import { type PolicyView, currentEpoch } from '@/lib/cover';
import { POLICY } from '@/lib/credence';
import { dur, et, fixed, num, usdc, utc } from '@/lib/format';
import { useClock, useEpochs } from '@/lib/hooks/chain';
import { type Position, usePolicies, usePositions } from '@/lib/hooks/positions';
import { useLpPosition, useQueue, useVault } from '@/lib/hooks/vault';
import { payoutAtGap } from '@/lib/payout';
import { type TicketView, ticketLabel } from '@/lib/vault';
import { Icon } from '../Icon';
import { useSolana } from '../Providers';
import { type Activity, ActivityList, Bar, GradientCard, H, KV, Note, PageHead, Pill, StatBlock, StatRow } from '../ui';
import { logoOf } from './MarketSpotlight';
import { ChainTime, ConnectNote, ErrorNote, Loading } from './shared';

/** The position that matters most before the bell: eligible and uncovered first, then the closest to liquidation. */
function focusOf(ps: Position[], covered: (p: Position) => boolean) {
  const score = (p: Position) => (p.why ? 0 : covered(p) ? 1 : 2);
  return [...ps].sort((a, b) => score(b) - score(a) || (b.ratio ?? 0) - (a.ratio ?? 0))[0];
}

export function coverPill(p: Position, covered: boolean) {
  if (p.why) return <Pill tone="soft">Not eligible</Pill>;
  if (covered) return <Pill tone="good">Covered</Pill>;
  if ((p.ratio ?? 0) >= 1) return <Pill tone="bad">Liquidatable</Pill>;
  return <Pill>Uncovered</Pill>;
}

export function PositionCard({ p, covered }: { p: Position; covered: boolean }) {
  return (
    <GradientCard
      logo={logoOf(p.asset?.ticker ?? '')}
      tag={p.asset?.ticker ?? 'xStock'}
      big={p.snap ? `${usdc(p.snap.debt)} USDC` : p.freshErr ? 'Refresh failed' : '…'}
      label="Debt / C′ (liquidation at 1.00)"
      value={p.ratio !== null ? `${p.ratio.toFixed(4)} · LT ${p.snap ? fixed(p.snap.ltWad * 100n, 18, 0) : '—'}%` : '—'}
      pill={coverPill(p, covered)}
    />
  );
}

export function activityOf(policies: PolicyView[], tickets: TicketView[]): Activity[] {
  const rows: (Activity & { t: number })[] = [];
  for (const p of policies) {
    rows.push({ t: p.createdAt, icon: 'shield', title: `Gap cover bought · ${p.ticker}`, when: utc(p.createdAt).slice(0, 16), amount: `${usdc(p.premium)} USDC` });
    if (p.state === POLICY.SETTLED) rows.push({ t: p.createdAt + 1, icon: 'repay', title: `Payout into the position · ${p.ticker}`, when: 'settled', amount: `${usdc(p.payout)} USDC` });
    if (p.state === POLICY.REFUNDED) rows.push({ t: p.createdAt + 1, icon: 'withdraw', title: `Premium refunded · ${p.ticker}`, when: 'voided weekend', amount: `${usdc(p.premium - p.fee)} USDC` });
  }
  for (const t of tickets) {
    rows.push({ t: t.requestedAt, icon: t.kind === 0 ? 'deposit' : 'withdraw', title: `LP ${ticketLabel(t)} queued`, when: utc(t.requestedAt).slice(0, 16),
      amount: t.kind === 0 ? `${usdc(t.amount)} USDC` : `${fixed(t.amount, 6, 2)} shares` });
  }
  return rows.sort((a, b) => b.t - a.t);
}

export function OverviewView() {
  const { signer } = useSolana();
  const owner = signer?.publicKey;
  const { now } = useClock();
  const epochs = useEpochs();
  const pos = usePositions(owner);
  const policies = usePolicies(owner);
  const vault = useVault();
  const lp = useLpPosition(owner);
  const queue = useQueue(owner);

  const open = (epochs.data ?? []).filter((e) => e.state === 0 && now !== null && now < e.bell);
  const group = open.length ? Math.min(...open.map((e) => e.closureId)) : null;
  const ge = (epochs.data ?? []).find((e) => e.closureId === group);
  const liveEpochs = new Set((epochs.data ?? []).filter((e) => e.closureId === group).map((e) => e.key.toBase58()));
  const covered = (p: Position) => (policies.data ?? []).some((x) => x.obligation.equals(p.key) && x.state === POLICY.ACTIVE && (liveEpochs.size === 0 || liveEpochs.has(x.epoch.toBase58())));
  const ps = pos.positions ?? [];
  const focus = focusOf(ps, covered);
  const epochFor = focus?.asset && now !== null ? currentEpoch(epochs.data ?? [], focus.asset.ticker, now) : undefined;
  const need8 = focus?.snap ? payoutAtGap(focus.snap.coveredValue, focus.snap.debt, focus.snap.debt, -800) : null;
  const nav6 = vault.data?.figures.navPerShare6;
  const lpValue = lp.data && nav6 !== undefined ? ((lp.data.shares ?? 0n) * nav6) / 1_000_000n : null;
  const activity = activityOf(policies.data ?? [], queue.data ?? []);

  return (
    <>
      <PageHead
        title="Dashboard"
        sub={!ge || now === null ? (epochs.isLoading ? 'Reading the weekends on the fork…' : 'No weekend on sale on the fork') :
          `Weekend ${ge.closureId}: bell ${et(ge.bell)} (in ${dur(ge.bell - now)}) · close ${et(ge.close)} · Monday open ${et(ge.open)}`}
        right={<ChainTime now={now} />}
      />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H>Before Friday&apos;s bell</H>
            {!signer ? <ConnectNote>Connect a wallet to see your Kamino xStocks positions and what each needs before the bell.</ConnectNote>
              : pos.error ? <ErrorNote error={pos.error} />
              : pos.isLoading || !pos.positions ? <Loading what="Refreshing your Kamino positions on the fork" />
              : !focus ? (
                <Note icon="card">This wallet has no xStocks positions on the fork. Create one on <Link href="/app/faucet"><b>Faucet</b></Link>, or take a real mainnet position on <Link href="/app/borrow"><b>Borrow</b></Link>.</Note>
              ) : (
                <div className="cx-row" data-testid="focus">
                  <PositionCard p={focus} covered={covered(focus)} />
                  <Link href="/app/borrow" className="cx-tile">
                    <span className="cx-tile-icon"><Icon name="repay" size={24} strokeWidth={1.9} /></span>
                    <span className="cx-tile-title">If Monday opens −8%</span>
                    <span className="cx-tile-sub">Repay needed to stay healthy</span>
                    <span className="cx-tile-amount" data-testid="need8">{need8 !== null ? `$${usdc(need8)}` : '—'}</span>
                  </Link>
                  <Link href="/app/borrow" className="cx-tile">
                    <span className="cx-tile-icon"><Icon name="shield-check" size={24} strokeWidth={1.9} /></span>
                    <span className="cx-tile-title">Gap Cover</span>
                    <span className="cx-tile-sub">{focus.why ? 'Not eligible in Phase 1' : covered(focus) ? 'Covered this weekend' : epochFor ? `On sale until ${et(epochFor.bell).replace(/^\w+, /, '')}` : 'Sales closed'}</span>
                    <span className="cx-tile-amount">{covered(focus) ? 'Covered' : focus.why ? '—' : 'Quote'}</span>
                  </Link>
                </div>
              )}
            {pos.twapAligned && <p className="cx-hint" style={{ marginTop: 12 }}><span className="cx-sim">fork: after a simulated gap, Kamino&apos;s Scope TWAP was set to the spot price so klend accepts it</span></p>}
          </section>
          <section>
            <H right={<span className="cx-chip">Newest first</span>}>Recent activity</H>
            {!signer ? <Note icon="clock">Your cover, payouts and LP requests appear here, read from the chain.</Note>
              : activity.length ? <ActivityList items={activity.slice(0, 6)} />
              : <Note icon="clock">Nothing yet. Policies you buy, payouts into your positions and LP requests appear here, read from the chain.</Note>}
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Debt / C′" value={focus?.ratio != null ? focus.ratio.toFixed(4) : '—'} chip={focus?.asset?.ticker ?? 'No position'} testId="focus-ratio" />
          {focus?.snap && (
            <div>
              <KV rows={[
                ['Collateral', `$${usdc(focus.snap.collateralValue)}`],
                ['Covered value C′', `$${usdc(focus.snap.coveredValue)}`],
                ['USDC debt', `${usdc(focus.snap.debt)}`],
                ['Kamino price', focus.scopePrice ? `$${num(focus.scopePrice, 4)}` : '—'],
              ]} />
              <div style={{ marginTop: 14 }}><Bar value={focus.ratio ?? 0} color={(focus.ratio ?? 0) > 0.95 ? 'var(--cx-bad)' : undefined} /></div>
            </div>
          )}
          <div>
            <H right={<Link href="/app/borrow"><small>View all</small></Link>}>Your positions</H>
            {ps.length ? (
              <div className="cx-stat-rows">
                {ps.map((p) => (
                  <StatRow key={p.key.toBase58()} big={p.snap ? usdc(p.snap.debt, 0) : '—'} unit="USDC" sub={p.ratio !== null ? `${p.asset?.ticker ?? 'xStock'} · D/C′ ${p.ratio.toFixed(3)}` : p.asset?.ticker}
                    tag={p.why ? 'Not eligible' : covered(p) ? 'Covered' : 'Uncovered'} />
                ))}
              </div>
            ) : <p className="cx-page-sub" style={{ margin: 0 }}>{signer ? 'No positions yet.' : 'No wallet connected.'}</p>}
          </div>
          <div>
            <H right={<Link href="/app/underwrite"><small>Underwrite</small></Link>}>Your LP position</H>
            <KV rows={[
              ['Shares', lp.data ? fixed(lp.data.shares ?? 0n, 6, 2) : '—'],
              ['Value at NAV', lpValue !== null ? `${usdc(lpValue)} USDC` : '—'],
              ['Queued requests', queue.data ? String(queue.data.length) : '—'],
            ]} />
          </div>
        </aside>
      </div>
    </>
  );
}
