import type { Snapshot } from '@/lib/site/snapshot';
import { BOUNDS } from '@/lib/site/fresh';
import { Fresh, Missing } from './Fresh';
import { pct, usd, usdM, utc, wadPercent, wadUsd } from './fmt';

type Props = { data: Pick<Snapshot, 'gap' | 'scan'>; now: number };

export function MainnetView({ data, now }: Props) {
  const { gap, scan } = data;
  return (
    <>
      <h1>Mainnet view: the weekend gap</h1>
      <p className="sx-lead">
        Tokenized stocks trade 24/7; the lenders built on them price them on a 24/5 clock. This page shows, for the eight covered xStocks,
        what the 24/7 price says against the Friday close, whether the lender’s own price has moved, and how likely a −5, −8 or −12% Monday is.
      </p>
      <p className="sx-note">
        Computed off-chain from mainnet data by the program’s own Rust (<code>examples/gap_feed.rs</code>, the function the on-chain feed runs).
        Credence is not deployed on mainnet, so there is no feed account to read: these are snapshots, each with its as-of time.
      </p>

      <h2 id="gap">The gap on eight assets</h2>
      {!gap ? <Missing what="Gap Oracle numbers" how="scripts/src/gap-feed-mainnet.ts then scripts/src/site-snapshot.ts" /> : (
        <>
          <Fresh asOf={gap.asOf} now={now} bound={BOUNDS.gap} source={gap.source} />
          <p>{gap.note}</p>
          <div className="sx-scroll" role="region" aria-label="Weekend gap by asset" tabIndex={0}>
            <table className="sx-table">
              <caption className="sx-sr">The 24/7 price against the Friday close, the lender’s price, and the probability of a weekend gap, per asset</caption>
              <thead>
                <tr><th scope="col">Asset</th><th scope="col">Friday close</th><th scope="col">24/7 price</th><th scope="col">24/7 vs close</th><th scope="col">Lender’s price vs close</th>
                  <th scope="col">Lender’s price</th><th scope="col">P(gap &lt; −5%)</th><th scope="col">P(gap &lt; −8%)</th><th scope="col">P(gap &lt; −12%)</th></tr>
              </thead>
              <tbody>
                {gap.items.map((i) => (
                  <tr key={i.ticker} data-testid={`gap-${i.ticker}`}>
                    <th scope="row">{i.ticker}</th>
                    <td>{i.flagNames.includes('NO_CLOSE') ? 'not captured' : wadUsd(i.closePriceWad)}</td>
                    {/* A 24/7 price too old to use (STALE_FAIR) is zeroed by the program: show that, never $0.00. */}
                    <td>{i.flagNames.includes('STALE_FAIR') || BigInt(i.fairPriceWad) === 0n ? 'stale' : wadUsd(i.fairPriceWad)}</td>
                    <td>{i.flagNames.includes('NO_CLOSE') || i.flagNames.includes('STALE_FAIR') ? 'n/a' : wadPercent(i.impliedGapFairWad)}</td>
                    <td>{i.flagNames.includes('NO_CLOSE') ? 'n/a' : wadPercent(i.impliedGapLenderWad)}</td>
                    <td>{i.frozen ? `frozen since ${utc(i.lenderSinceTs)}` : `moved (last change ${utc(i.lenderSinceTs)})`}</td>
                    <td>{wadPercent(i.pLt5Wad)}</td><td>{wadPercent(i.pLt8Wad)}</td><td>{wadPercent(i.pLt12Wad)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sx-small">
            Probabilities come from ten years of weekend gaps and each asset’s σ, rounded up by the program. The five assets added later by the second
            recorder show “frozen” only after 30 minutes of history. A row marked not captured had no Scope reading at the bell.
          </p>
        </>
      )}

      <h2 id="scan">Weekend risk of today’s borrowers</h2>
      {!scan ? <Missing what="position scan" how="scripts/src/positions.ts then scripts/src/site-snapshot.ts" /> : (
        <>
          <Fresh asOf={scan.asOf} now={now} bound={BOUNDS.scan} source={scan.source} />
          <p>
            Every Kamino and Jupiter Lend position with USDC debt against a covered xStock, with what a Monday gap would do to it. “Eligible” is what
            Credence’s program accepts today on each lender.
          </p>
          <div className="sx-grid">
            {scan.lenders.map((l) => (
              <section key={l.lender} className="sx-card" aria-labelledby={`scan-${l.lender.replace(/\W/g, '')}`} data-testid={`scan-${l.lender.replace(/\W/g, '')}`}>
                <h3 id={`scan-${l.lender.replace(/\W/g, '')}`}>{l.lender}</h3>
                <dl className="sx-dl">
                  <dt>Positions</dt><dd>{l.positions.toLocaleString('en-US')}</dd>
                  <dt>USDC debt</dt><dd>{usdM(l.debtUsd)}</dd>
                  <dt>Eligible</dt><dd>{l.eligible.toLocaleString('en-US')} ({usdM(l.eligibleDebtUsd)})</dd>
                  <dt>Within 10% of liquidation</dt><dd>{l.nearThreshold.toLocaleString('en-US')}</dd>
                  <dt>Already past it</dt><dd>{l.liquidatableNow.toLocaleString('en-US')}</dd>
                </dl>
                <div className="sx-scroll" role="region" aria-label={`${l.lender} weekend gap effect`} tabIndex={0}>
                  <table className="sx-table">
                    <caption className="sx-sr">{l.lender}: positions made liquidatable by a Monday gap</caption>
                    <thead><tr><th scope="col">Monday opens</th><th scope="col">Positions hit</th><th scope="col">Debt</th><th scope="col">Repay to stay clear</th></tr></thead>
                    <tbody>
                      {l.shocks.map((s) => (
                        <tr key={s.gap}><th scope="row">{pct(s.gap, 0)}</th><td>{s.positions.toLocaleString('en-US')}</td><td>{usd(s.debtUsd)}</td><td>{usd(s.repayNeededUsd)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
          <p className="sx-small">Values are brought to the scan time by the scan’s method (<code>scripts/src/positions.ts</code>); a row with no price is left out, not counted as safe.</p>
        </>
      )}
    </>
  );
}
