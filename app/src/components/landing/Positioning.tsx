import Link from 'next/link';
import '../site/site.css';

const LAYERS = ['Gap Oracle', 'Liquidation Shield', 'Gap Cover', 'Monday Backstop', 'Yield vault'];

/** The positioning line and the five layers, with the way into the data pages. Dark, to sit under the hero. */
export function Positioning() {
  return (
    <section className="sx-root sx-dark sx-position" id="positioning" aria-labelledby="positioning-h">
      <h2 id="positioning-h" style={{ fontSize: 'clamp(1.6rem,4vw,2.3rem)', margin: '0 0 .5rem' }}>
        Tokenized stocks trade 24/7; the credit built on them runs on a 24/5 clock.
      </h2>
      <p className="sx-lead" style={{ color: 'var(--sx-muted)' }}>
        Credence is a risk layer for tokenized-stock lending on Solana, in five layers: {LAYERS.join(', ')}. Built on top: curator books, the Protect Action
        and alerts, and an SDK, a feed and a widget. Fork-proven against Kamino’s and Jupiter Lend’s real programs; nothing on mainnet; audit first.
      </p>
      <p>
        <Link className="sx-cta" href="/mainnet" style={{ display: 'inline-block', margin: '.25rem .5rem .25rem 0', padding: '.65rem 1.1rem', borderRadius: 8, background: 'var(--sx-accent)', color: 'var(--sx-accent-fg)', fontWeight: 600, textDecoration: 'none' }}>The weekend gap on mainnet data</Link>
        <Link href="/about">How it works</Link> · <Link href="/unlock">Credit unlock</Link> · <Link href="/proof">Proof</Link> · <Link href="/weekend">The real weekend</Link> · <Link href="/roadmap">Roadmap</Link> · <Link href="/disclosure">Disclosure</Link>
      </p>
    </section>
  );
}
