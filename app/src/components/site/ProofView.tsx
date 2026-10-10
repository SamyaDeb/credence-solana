import type { Snapshot } from '@/lib/site/snapshot';
import { BOUNDS } from '@/lib/site/fresh';
import { Fresh } from './Fresh';
import { usd } from './fmt';

export function ProofView({ data, now }: { data: Pick<Snapshot, 'proof' | 'books'>; now: number }) {
  const { proof: p, books: b } = data;
  const a = p.audit;
  return (
    <>
      <h1>Proof</h1>
      <p className="sx-lead">Fork-proven against Kamino’s and Jupiter Lend’s real programs; nothing on mainnet; audit first.</p>
      <p>
        Everything below ran on a local fork of Solana mainnet with the real Kamino and Jupiter Lend programs loaded. Credence’s program is not deployed
        on mainnet, and these pages say so wherever a number appears.
      </p>

      <h2 id="tests">Tests</h2>
      <Fresh asOf={p.asOf} now={now} bound={BOUNDS.demo} source={p.source} />
      <div className="sx-scroll" role="region" aria-label="Test results" tabIndex={0}>
        <table className="sx-table" data-testid="tests">
          <caption className="sx-sr">Test suites and their last results</caption>
          <thead><tr><th scope="col">Suite</th><th scope="col">Passed</th><th scope="col">Note</th></tr></thead>
          <tbody>{p.tests.map((t) => <tr key={t.label}><th scope="row">{t.label}</th><td>{t.passed.toLocaleString('en-US')}</td><td>{t.note}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="sx-small">Results at commit <code>{p.commit}</code>. Each audit finding below has a failing test written first, then the fix.</p>

      <h2 id="audit">Internal audit</h2>
      <p data-testid="audit-summary">
        {a.total} findings, A-{a.first} to A-{a.last}: {a.bySeverity.high ?? 0} high, {a.bySeverity.medium ?? 0} medium, {a.bySeverity.low ?? 0} low,
        {' '}{a.bySeverity.info ?? 0} info. {a.fixed} fixed, {a.knownLimit} known limits, {a.open} open{a.other ? `, ${a.other} checked or mixed` : ''}. Every finding, its
        test and its status is in <code>docs/audit/phase1-audit.md</code>; known limits are listed in the README. This is an internal audit: an external one
        comes before any mainnet money.
      </p>

      <h2 id="books">Curator books (fork demo)</h2>
      {b && (
        <>
          <Fresh asOf={b.asOf} now={now} bound={BOUNDS.demo} source={b.source} />
          <ul className="sx-list">
            <li>A curator covers a book of {b.legs.total} real positions ({b.legs.kamino} on Kamino, {b.legs.jupiter} on Jupiter Lend) for one premium.</li>
            <li>One minimum premium per book instead of one per position: on this book, <strong>{usd(b.premiumUsdc, 2)} USDC</strong> against {usd(b.sumStandaloneUsdc, 2)} USDC if each position were covered alone.</li>
            <li>After a −{Math.abs(b.gap * 100)}% Monday on the fork, payouts only went into the positions ({usd(b.advancedUsdc, 2)} USDC advanced by the Shield; {usd(b.refundedUsdc, 2)} USDC refunded to positions repaid in full).</li>
            <li>An owner can always buy its own cover: the book’s leg is released and its share refunded.</li>
          </ul>
          <p className="sx-small">The saving is for this book only. Fork demo on a recorded run; not a claim about any real curator.</p>
        </>
      )}
    </>
  );
}
