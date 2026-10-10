import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from './SiteNav';
import './site.css';

/** Header, the not-for-US-persons notice, the page, the footer. No scripts of its own beyond the nav's current-page mark. */
export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="sx-root">
      <a className="sx-skip" href="#main">Skip to the content</a>
      <header className="sx-header">
        <Link href="/" className="sx-brand">Credence</Link>
        <SiteNav />
      </header>
      <p className="sx-banner" role="note">
        Not live, not insurance: Credence runs on a local fork of Solana mainnet. Not for US persons. <Link href="/disclosure">Disclosure</Link>
      </p>
      <main id="main" className="sx-main">{children}</main>
      <footer className="sx-footer">
        <p>Credence (Solana): weekend gap protection for tokenized-stock lending. Built for the Colosseum hackathon, October 2026. No cookies, no trackers.</p>
        <p><Link href="/app/risk">Open the read-only app</Link> · <Link href="/disclosure#geofence">US persons</Link></p>
      </footer>
    </div>
  );
}
