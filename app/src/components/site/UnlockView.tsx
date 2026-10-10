import type { Snapshot } from '@/lib/site/snapshot';
import { BOUNDS } from '@/lib/site/fresh';
import { Fresh, Missing } from './Fresh';
import { pct, usd, usdM } from './fmt';

export function UnlockView({ data, now }: { data: Pick<Snapshot, 'unlock'>; now: number }) {
  const u = data.unlock;
  const t90 = u?.targets.find((t) => t.target === '0.9');
  return (
    <>
      <h1>Credit unlock</h1>
      <p className="sx-lead" data-testid="unlock-caveat"><strong>{u?.caveat ?? 'What cover would allow, not measured demand.'}</strong></p>
      {!u ? <Missing what="credit-unlock analysis" how="scripts/src/unlock.ts then scripts/src/site-snapshot.ts" /> : (
        <>
          <Fresh asOf={u.asOf} now={now} bound={BOUNDS.unlock} source={u.source} />
          <p>
            Borrowers protect themselves by under-borrowing, so the product is headroom: how much more credit full weekend gap protection with the
            Liquidation Shield would allow at a target debt-to-covered ratio (D/C′), at what cost, and with how much capital from liquidity providers.
            Every eligible position on Kamino and Jupiter Lend ({u.totalPositions.toLocaleString('en-US')}, {usdM(u.totalDebtUsd)} of debt) was run through the
            program’s own pricing.
          </p>
          {t90 && (
            <ul className="sx-list" data-testid="unlock-headlines">
              <li>Across {u.totalPositions.toLocaleString('en-US')} covered positions ({usdM(u.totalDebtUsd)} of debt), full weekend cover would allow{' '}
                <strong>{usdM(t90.extraDebtUsd)}</strong> more credit at a debt-to-covered ratio of 0.90.</li>
              <li>At 0.90, a weekend gap alone would make {pct(t90.pUncoveredDebtWeighted, 2)} of that debt liquidatable without cover; with cover and the
                Liquidation Shield, {pct(t90.residualAtOpen, 3)} if the Shield sees the open.</li>
              {t90.lpEquityUsd.find((s) => s.share === 0.5) && <li>Unlocking half of it needs {usdM(t90.lpEquityUsd.find((s) => s.share === 0.5)!.usd)} of capital from liquidity providers.</li>}
            </ul>
          )}
          <h2>By target</h2>
          <div className="sx-scroll" role="region" aria-label="Credit unlock by target" tabIndex={0}>
            <table className="sx-table">
              <caption className="sx-sr">Credit unlock at three target debt-to-covered ratios, debt-weighted costs</caption>
              <thead>
                <tr><th scope="col">Target D/C′</th><th scope="col">Positions</th><th scope="col">Extra credit</th><th scope="col">Cover per weekend</th>
                  <th scope="col">Cost a year, debt-weighted</th><th scope="col">… positions ≥ $1k extra</th><th scope="col">All-in with borrow APR</th>
                  <th scope="col">Liquidatable without cover</th><th scope="col">LP capital: 25% / 50% / 100%</th></tr>
              </thead>
              <tbody>
                {u.targets.map((t) => (
                  <tr key={t.target} data-testid={`unlock-${t.target}`}>
                    <th scope="row">{t.target}</th><td>{t.positions.toLocaleString('en-US')}</td><td>{usdM(t.extraDebtUsd)}</td><td>{usdM(t.premiumPerWeekendUsd)}</td>
                    <td>{pct(t.costDebtWeighted)}</td><td>{pct(t.costDebtWeightedOver1k)}</td><td>{pct(t.allInDebtWeighted)}</td><td>{pct(t.pUncoveredDebtWeighted, 2)}</td>
                    <td>{t.lpEquityUsd.map((s) => usdM(s.usd)).join(' / ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {t90 && (
            <>
              <h2>Cost depends on the size</h2>
              <p>At target 0.90, by the extra credit a position would take. Costs are debt-weighted, because most positions pay the minimum premium.</p>
              <div className="sx-scroll" role="region" aria-label="Cost by size at target 0.90" tabIndex={0}>
                <table className="sx-table">
                  <caption className="sx-sr">Cover cost by size of extra credit at target 0.90</caption>
                  <thead><tr><th scope="col">Extra credit at least</th><th scope="col">Positions</th><th scope="col">Extra credit</th><th scope="col">Cost a year, debt-weighted</th></tr></thead>
                  <tbody>
                    {t90.bySize.map((b) => (
                      <tr key={b.minExtraUsd}><th scope="row">{usd(Number(b.minExtraUsd))}</th><td>{b.positions.toLocaleString('en-US')}</td><td>{usdM(b.extraDebtUsd)}</td><td>{pct(b.costDebtWeighted)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="sx-small">{u.excluded}</p>
          <p className="sx-small">Holiday weekends are priced as plain weekends and overnight gaps are not covered. The Shield’s buffer is below σ for the most volatile single names (TSLAx, HOODx, MSTRx): the residual there is higher; see the audit.</p>
        </>
      )}
    </>
  );
}
