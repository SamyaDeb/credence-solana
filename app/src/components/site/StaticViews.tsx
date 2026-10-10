// The pages that are words: how it works, the roadmap and the disclosure. Wording rules: lib/site/claims.ts.
export function AboutView() {
  return (
    <>
      <h1>How Credence works</h1>
      <p className="sx-lead">Tokenized stocks trade 24/7; the credit built on them runs on a 24/5 clock.</p>
      <p>
        The price Kamino lends against stops moving at Friday’s close and jumps at Monday’s open. A borrower near the liquidation threshold cannot react to a gap
        that has not been priced yet, and a stop-loss cannot fire on a frozen price. Credence is a risk layer for tokenized-stock lending on Solana, in five layers.
      </p>
      <ol className="sx-layers" data-testid="layers">
        <li><h2>Gap Oracle</h2><p>The 24/7 price against the Friday close, whether the lender’s price is still frozen, and the chance of a −5, −8 or −12% Monday, from ten years of weekend gaps. A permissionless crank that no caller can feed a price to.</p></li>
        <li><h2>Liquidation Shield</h2><p>On Sunday night it repays into the borrower’s position, sized from the xStock’s 24/7 price, before Kamino’s pre-market move.</p></li>
        <li><h2>Gap Cover</h2><p>Gap protection bought before the Friday bell. After the Monday open it pays exactly the repayment that brings the position back to its liquidation threshold, capped by the policy. Premiums are priced on-chain.</p></li>
        <li><h2>Monday Backstop</h2><p>What still liquidates at the Monday move, the vault liquidates itself through Kamino’s own liquidation, at Kamino’s own bonus, and resells; it spends only cash that active cover and queued withdrawals do not need.</p></li>
        <li><h2>Yield vault</h2><p>Liquidity providers underwrite the cover in a USDC vault; capacity is bounded by joint stress weekends against the vault’s equity.</p></li>
      </ol>
      <p className="sx-small">All five run on a local fork of Solana mainnet with the real Kamino and Jupiter Lend programs. None is deployed on mainnet.</p>

      <h2>Built on top</h2>
      <ul className="sx-list">
        <li><strong>Curator books.</strong> A curator covers a book of positions it does not own for one premium; an owner can always buy its own cover and leave the book.</li>
        <li><strong>The Protect Action and alerts.</strong> A Solana Action that quotes and builds gap protection for one position (the quote is the program’s own, simulated), and opt-in, wallet-signed alerts before the Friday bell.</li>
        <li><strong>The SDK, the feed and the widget.</strong> <code>@credence/sdk</code> reads the feed and quotes, builds and follows cover (unsigned transactions only); <code>@credence/widget</code> is an embeddable component that shows the gap, the risk and a quote next to a position. Neither holds keys.</li>
      </ul>
    </>
  );
}

export function RoadmapView() {
  return (
    <>
      <h1>Roadmap</h1>
      <p className="sx-lead">What is built, what is next, and what is only designed.</p>
      <ol className="sx-layers">
        <li><h2>Built and fork-proven</h2><p>The program, the keeper, the app, the SDK, the Gap Oracle feed, curator books, the Action and alerts, the widget, and the credit-unlock analysis. Run on a local mainnet fork against the real Kamino and Jupiter Lend programs.</p></li>
        <li><h2>Next: an external audit, then capped mainnet</h2><p>An independent audit of the program comes first. Then a capped pilot on mainnet, on the milestones of the grant: a small vault, a low per-position cap and a few assets, widened only as the results allow.</p></li>
        <li><h2>Designed, not built: Phase D</h2><p>A weekend-safe lending market, gap tokens, hedging of the vault’s weekend exposure, and other market-hours assets. These are designs only; no code for them is claimed here.</p></li>
      </ol>
    </>
  );
}

export function DisclosureView() {
  return (
    <>
      <h1>Disclosure</h1>
      <p className="sx-lead">Not live, not insurance.</p>
      <ul className="sx-list">
        <li><strong>Status.</strong> Credence’s program runs on a local fork of Solana mainnet. It is not deployed on mainnet, holds no user funds, and this site cannot sign or send a transaction.</li>
        <li><strong>Not insurance.</strong> Gap protection is a priced, capped payout into a lending position under the rules of the program, and carries no promise beyond those rules.</li>
        <li><strong>Prior work.</strong> A first version of Credence for EVM chains was started on September 27, 2026. This Solana version reuses its fixed-point risk library (<code>risk-core</code>, unmodified) and its scenario data. Historical stock prices come from Alpaca under a personal licence, so the raw data is not redistributed here.</li>
        <li><strong>Numbers.</strong> Each figure on this site names its source file and its as-of time. Numbers computed off-chain from mainnet data say so; a snapshot older than its bound is marked stale.</li>
        <li id="geofence"><strong>Not for US persons.</strong> xStocks are not offered to US persons, and neither is anything on this site. If you are in the United States, do not use it to trade or borrow.</li>
      </ul>
    </>
  );
}
