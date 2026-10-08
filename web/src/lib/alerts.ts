// Alerts are derived in the browser from chain state; nothing is pushed or stored on a server. Each alert has a stable
// id (what it is about), so "read" is remembered per id in this browser.
import type { EpochView, PolicyView } from './cover';
import { EPOCH, POLICY } from './credence';
import { dur, et, usdc } from './format';
import type { Prefs } from './prefs';
import { type TicketView, ticketLabel, ticketReady } from './vault';

export type Alert = { id: string; kind: keyof Prefs['alerts']; icon: string; tone: 'bad' | 'warn' | 'good' | 'soft'; title: string; body: string; at: number; href: string };

type Pos = { key: { toBase58(): string }; ticker: string; ratio: number | null; eligible: boolean; covered: boolean };

export function deriveAlerts(a: { now: number; positions: Pos[]; policies: PolicyView[]; epochs: EpochView[]; tickets: TicketView[]; live: number[]; prefs: Prefs }): Alert[] {
  const out: Alert[] = [];
  const byEpoch = new Map(a.epochs.map((e) => [e.key.toBase58(), e]));
  // The bell is coming for an uncovered eligible position near its threshold.
  for (const p of a.positions) {
    if (!p.eligible || p.covered || p.ratio === null || p.ratio < a.prefs.nearRatio) continue;
    const e = a.epochs.filter((x) => x.ticker === p.ticker && x.state === EPOCH.OPEN && a.now < x.bell && a.now >= x.saleOpen).sort((x, y) => x.bell - y.bell)[0];
    if (!e || e.bell - a.now > a.prefs.bellLeadHours * 3600) continue;
    out.push({ id: `bell:${e.closureId}:${p.key.toBase58()}`, kind: 'bell', icon: 'bell', tone: p.ratio >= 0.95 ? 'bad' : 'warn', at: e.bell - a.prefs.bellLeadHours * 3600,
      title: `The bell is in ${dur(e.bell - a.now)}: your ${p.ticker} position is uncovered`,
      body: `Debt / C′ ${p.ratio.toFixed(4)} (liquidation at 1). Cover sales for weekend ${e.closureId} close at ${et(e.bell)}. Repay, add collateral, or buy gap cover.`, href: '/app/borrow' });
  }
  for (const p of a.policies) {
    const e = byEpoch.get(p.epoch.toBase58());
    out.push({ id: `cover:${p.key.toBase58()}`, kind: 'cover', icon: 'shield', tone: 'good', at: p.createdAt,
      title: `Gap cover bought on ${p.ticker}${e ? ` for weekend ${e.closureId}` : ''}`, body: `Premium ${usdc(p.premium)} USDC, cap ${usdc(p.maxPayout)} USDC.`, href: '/app/account' });
    if (e && e.closePriceWad > 0n) {
      out.push({ id: `close:${e.key.toBase58()}`, kind: 'close', icon: 'clock', tone: 'soft', at: e.close,
        title: `Friday close stored for ${e.ticker}`, body: `Weekend ${e.closureId}: the close your ${p.ticker} payout is measured from is on-chain.`, href: '/app/risk' });
    }
    if (e && e.settlePriceWad > 0n) {
      out.push({ id: `settlement:${e.key.toBase58()}`, kind: 'settlement', icon: 'chart', tone: 'soft', at: e.open + 60,
        title: `Settlement price posted for ${e.ticker}`, body: `Weekend ${e.closureId}: open / close = ${(Number(e.settlePriceWad) / Number(e.closePriceWad)).toFixed(4)}.`, href: '/app/account' });
    }
    if (p.state === POLICY.SETTLED) {
      out.push({ id: `payout:${p.key.toBase58()}`, kind: 'payout', icon: 'repay', tone: p.payout > 0n ? 'good' : 'soft', at: (e?.settledAt || e?.open || p.createdAt) + 61,
        title: p.payout > 0n ? `${usdc(p.payout)} USDC repaid into your ${p.ticker} position` : `Your ${p.ticker} policy settled with no payout`,
        body: p.payout > 0n ? 'settle_policy repaid it through klend\'s repay CPI (or paid the wallet if the position was closed).' : 'The open did not take the position past its threshold.', href: '/app/account' });
    }
    if (p.state === POLICY.REFUNDED) {
      out.push({ id: `refund:${p.key.toBase58()}`, kind: 'payout', icon: 'withdraw', tone: 'warn', at: (e?.close ?? p.createdAt) + 6 * 3600,
        title: `Premium refunded on ${p.ticker}`, body: 'The Friday close was never stored, so the weekend was voided and the premium (net of fee) returned.', href: '/app/account' });
    }
  }
  for (const t of a.tickets) {
    if (!ticketReady(t, a.live)) continue;
    out.push({ id: `lp:${t.key.toBase58()}`, kind: 'lp', icon: t.kind === 0 ? 'deposit' : 'withdraw', tone: 'good', at: t.requestedAt + 1,
      title: `Your LP ${ticketLabel(t)} is ready to process`, body: `Weekend ${t.waitGroup} has settled; process it on Underwrite (anyone may).`, href: '/app/underwrite' });
  }
  return out.filter((x) => a.prefs.alerts[x.kind]).sort((x, y) => y.at - x.at);
}
