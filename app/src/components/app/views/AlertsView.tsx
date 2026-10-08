'use client';
// Alerts: built in this browser from chain state (lib/alerts.ts): the bell coming for an uncovered position near its
// threshold, cover bought, the Friday close stored, the settlement price posted, a payout repaid into the position, an
// LP ticket ready. Read state and which kinds show (Settings) are kept in this browser.
import Link from 'next/link';
import { utc } from '@/lib/format';
import { useAlerts } from '@/lib/hooks/alerts';
import { Icon } from '../Icon';
import { useSolana } from '../Providers';
import { H, KV, Note, PageHead, StatBlock } from '../ui';
import { ConnectNote, Loading } from './shared';

export function AlertsView() {
  const { signer } = useSolana();
  const { alerts, read, unread, markRead, markUnread, loading } = useAlerts();
  return (
    <>
      <PageHead title="Alerts" sub="The bell, your cover and your payouts, derived in this browser from the chain. Nothing is sent anywhere." />
      <div className="cx-grid">
        <div className="cx-col">
          <section>
            <H right={alerts.length > 0 ? <button type="button" className="cx-btn is-ghost cx-btn-sm" onClick={() => markRead(alerts.map((a) => a.id))} data-testid="mark-all-read">Mark all read</button> : undefined}>Inbox</H>
            {!signer ? <ConnectNote>Connect a wallet to see alerts for its positions, policies and LP requests.</ConnectNote>
              : loading ? <Loading what="Reading the chain" />
              : alerts.length === 0 ? <Note icon="bell">Nothing yet. You will see the bell coming for an uncovered position near its threshold, cover you bought, the Friday close and the settlement price, payouts into your positions and LP tickets ready to process.</Note>
              : (
                <ul className="cx-alerts" data-testid="alerts">
                  {alerts.map((a) => {
                    const isRead = read.has(a.id);
                    return (
                      <li key={a.id} className={`cx-alert-row is-${a.tone}${isRead ? ' is-read' : ''}`} data-testid={`alert-${a.kind}`}>
                        <span className="cx-tile-icon"><Icon name={a.icon} size={20} strokeWidth={1.9} /></span>
                        <div>
                          <h3>{!isRead && <span className="cx-unread-dot" aria-label="unread" />}{a.title}</h3>
                          <p>{a.body}</p>
                          <div className="cx-alert-foot">
                            <time>{utc(a.at).slice(0, 16)} UTC (chain time)</time>
                            <Link href={a.href} onClick={() => markRead([a.id])}>Open</Link>
                            <button type="button" className="cx-link-btn" onClick={() => (isRead ? markUnread(a.id) : markRead([a.id]))}>{isRead ? 'Mark unread' : 'Mark read'}</button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
          </section>
        </div>
        <aside className="cx-aside">
          <StatBlock label="Unread" value={signer ? String(unread) : '—'} chip={`${alerts.length} total`} testId="unread" />
          <KV rows={[['Source', 'chain state, read every 10–30 s'], ['Stored', 'read marks, in this browser'], ['Choose kinds', <Link key="s" href="/app/settings">Settings</Link>]]} />
          <Note icon="clock">Times are the chain&apos;s: on the fork, demo mode moves the clock to the Friday close and the Monday open.</Note>
        </aside>
      </div>
    </>
  );
}
