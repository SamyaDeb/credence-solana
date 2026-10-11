import type { Snapshot } from '@/lib/site/snapshot';
import { BOUNDS } from '@/lib/site/fresh';
import { freshness } from '@/lib/site/fresh';
import { Fresh, Missing } from './Fresh';
import { usd } from './fmt';

export function WeekendView({ data, now }: { data: Pick<Snapshot, 'weekend'>; now: number }) {
  const w = data.weekend;
  return (
    <>
      <h1>The real weekend, Oct 9–12</h1>
      <p className="sx-lead">A read-only model on real data: nothing here sends a transaction.</p>
      <p>
        A shadow keeper watches every eligible Kamino position through the weekend that began with the real Friday close of Oct 9 (20:00 UTC), and records what
        the Liquidation Shield would have done and what the policies would have paid. It prices the real positions with the program’s own functions and reads
        the real Scope price at the real Monday open.
      </p>
      {!w ? <Missing what="shadow summary" how="scripts/src/site-snapshot.ts reads the shadow keeper’s summary.json" /> : (
        <>
          <Fresh asOf={w.asOf} now={now} bound={w.final ? BOUNDS.demo : BOUNDS.weekend} source={w.source} />
          {freshness(w.asOf, now, w.final ? BOUNDS.demo : BOUNDS.weekend).state === 'stale' ? (
            <p className="sx-status" data-testid="weekend-state">This summary is not current: it was written {w.final ? 'a long time ago' : 'hours ago'} and is shown as it was. Refresh the snapshot for today’s numbers.</p>
          ) : w.final ? (
            <p className="sx-status is-final" data-testid="weekend-state">Final: the Monday open has passed and the keeper’s results are complete.</p>
          ) : (
            <p className="sx-status" data-testid="weekend-state">Running: watching {w.watched.toLocaleString('en-US')} positions. Results are final after the Monday open.</p>
          )}
          <dl className="sx-dl sx-card" data-testid="weekend-totals">
            <dt>Positions watched</dt><dd>{w.watched.toLocaleString('en-US')}</dd>
            <dt>Positions the model would have covered</dt><dd>{w.covered.toLocaleString('en-US')} ({usd(w.coveredDebtUsd)} of debt)</dd>
            <dt>Premiums the model would have collected</dt><dd>{usd(w.premiumsUsd, 2)}</dd>
            <dt>Shield advances</dt><dd>{w.shieldAdvances.toLocaleString('en-US')} ({usd(w.shieldAdvancedUsd, 2)})</dd>
            <dt>Positions that became liquidatable</dt><dd>{w.liquidatable.toLocaleString('en-US')} ({w.liquidatableCovered.toLocaleString('en-US')} of them covered)</dd>
            <dt>Saved by the Shield</dt><dd>{w.savedByShield.toLocaleString('en-US')}</dd>
            <dt>Payouts</dt><dd>{w.payouts.toLocaleString('en-US')} ({usd(w.payoutsUsd, 2)})</dd>
          </dl>
          {w.results && (
            <section data-testid="weekend-results">
              <h2>The result</h2>
              <p className="sx-lead" data-testid="weekend-headline">{w.results.headline}</p>
              <p className="sx-small">Computed off-chain from mainnet data by the program’s own pricing code (<code>shadow_quote</code>); no cover was sold and no transaction was sent.</p>
              <table className="sx-table" data-testid="weekend-gaps">
                <thead><tr><th>Asset</th><th>Friday close (Kamino’s Scope)</th><th>Monday open</th><th>Gap</th><th>Scope first moved</th></tr></thead>
                <tbody>
                  {Object.entries(w.results.prices).map(([sym, p]) => (
                    <tr key={sym}>
                      <td>{sym}</td><td>{p.scopeClose === null ? 'n/a' : usd(p.scopeClose, 2)}</td><td>{p.scopeOpen === null ? 'n/a' : usd(p.scopeOpen, 2)}</td>
                      <td>{p.gap === null ? 'n/a' : `${(p.gap * 100).toFixed(2)}%`}</td><td>{p.firstMoveAt ?? 'not before the open'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="sx-dl sx-card" data-testid="weekend-result-totals">
                <dt>Premiums the model would have collected</dt><dd>{w.results.premiumsUsd === null ? 'n/a' : usd(w.results.premiumsUsd, 2)}</dd>
                <dt>Payouts at the open</dt><dd>{w.results.payouts.paying.toLocaleString('en-US')} policies, {usd(w.results.payouts.totalUsd, 2)}{w.results.payouts.lossRatio === null ? '' : ` (loss ratio ${(w.results.payouts.lossRatio * 100).toFixed(1)}%)`}</dd>
                <dt>Shield advances, as the live job logged them (no cap)</dt><dd>{usd(w.results.shield.rawUsd, 2)}</dd>
                <dt>Shield advances, capped by each policy’s reserved worst loss (INV-12)</dt><dd>{usd(w.results.shield.cappedUsd, 2)} on {w.results.shield.policies.toLocaleString('en-US')} policies</dd>
                <dt>Made liquidatable by Kamino’s price</dt><dd>{w.results.liquidations.count.toLocaleString('en-US')} ({w.results.liquidations.covered.toLocaleString('en-US')} covered); Backstop bonus {usd(w.results.liquidations.backstopBonusUsd, 2)}</dd>
              </dl>
            </section>
          )}
          {Object.keys(w.close).length > 0 && (
            <p className="sx-small">Friday closes captured: {Object.entries(w.close).map(([k, v]) => `${k} ${usd(v, 2)}`).join(', ')}.</p>
          )}
        </>
      )}
    </>
  );
}
