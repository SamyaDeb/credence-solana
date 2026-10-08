'use client';
// The app frame: brand, top bar (market search, network badge, wallet, alerts, account) and the sidebar in the page
// order of the design, with Demo mode next to Faucet among the fork tools. Below 1024 px the sidebar becomes a menu.
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { RPC_URL } from '@/lib/credence';
import { useAlerts } from '@/lib/hooks/alerts';
import { Icon } from './Icon';
import { WalletButton } from './WalletButton';

type Item = { href: string; label: string; icon: string; activeIcon?: string };

const NAV: Item[] = [
  { href: '/app', label: 'Overview', icon: 'home-line', activeIcon: 'home' },
  { href: '/app/markets', label: 'Markets', icon: 'chart' },
  { href: '/app/borrow', label: 'Borrow', icon: 'card' },
  { href: '/app/lend', label: 'Lend', icon: 'vault' },
  { href: '/app/underwrite', label: 'Underwrite', icon: 'shield' },
  { href: '/app/auctions', label: 'Auctions', icon: 'gavel' },
  { href: '/app/risk', label: 'Risk', icon: 'pie' },
  { href: '/app/alerts', label: 'Alerts', icon: 'mail' },
];
const NAV_BOTTOM: Item[] = [
  { href: '/app/faucet', label: 'Faucet', icon: 'cash' },
  { href: '/app/demo', label: 'Demo mode', icon: 'play' },
  { href: '/app/account', label: 'Account', icon: 'user' },
  { href: '/app/settings', label: 'Settings', icon: 'settings' },
];

function NavList({ items, path, unread }: { items: Item[]; path: string; unread: number }) {
  return items.map((it) => {
    const active = it.href === '/app' ? path === '/app' : path.startsWith(it.href);
    const badge = it.href === '/app/alerts' ? unread : 0;
    return (
      <Link key={it.href} href={it.href} aria-current={active ? 'page' : undefined}>
        <Icon name={active && it.activeIcon ? it.activeIcon : it.icon} size={26} strokeWidth={1.6} />
        <span>{it.label}</span>
        {badge > 0 && <span className="cx-badge" aria-label={`${badge} unread`} data-testid="alerts-badge">{badge}</span>}
      </Link>
    );
  });
}

export function AppShell({ children }: { children: ReactNode }) {
  const { unread } = useAlerts();
  const path = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);
  const local = /127\.0\.0\.1|localhost/.test(RPC_URL);

  const onSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    router.push(q ? `/app/markets?q=${encodeURIComponent(q)}` : '/app/markets');
  };

  return (
    <div className="cx-body">
      <div className={`cx-frame${menu ? ' is-menu-open' : ''}`}>
        <a href="/" className="cx-brand" aria-label="Credence home">
          <img src="/landing/mark-ink.svg" alt="" />
          <span>Credence</span>
        </a>
        <div className="cx-topbar">
          <form className="cx-search" role="search" onSubmit={onSearch}>
            <Icon name="search" size={19} strokeWidth={2} />
            <input name="q" type="search" placeholder="Search markets" aria-label="Search markets" />
          </form>
          <span className="cx-preview" title={`The app reads and writes ${local ? 'a local surfpool fork of Solana mainnet (real Kamino state)' : RPC_URL}`} data-testid="network">
            {local ? 'Local mainnet fork' : 'Custom RPC'}
          </span>
          <div className="cx-topbar-right">
            <WalletButton />
            <Link href="/app/alerts" className="cx-bell" aria-label={`Alerts, ${unread} unread`} data-unread={unread ? '' : undefined}>
              <Icon name="bell" size={26} strokeWidth={1.6} />
            </Link>
            <Link href="/app/account" className="cx-avatar" aria-label="Account" />
            <button type="button" className="cx-menu-btn" aria-expanded={menu} aria-label="Menu" onClick={() => setMenu((o) => !o)}>
              <Icon name={menu ? 'close' : 'menu'} size={22} strokeWidth={2} />
            </button>
          </div>
        </div>
        <aside className="cx-side" aria-label="App">
          <nav className="cx-nav"><NavList items={NAV} path={path} unread={unread} /></nav>
          <nav className="cx-nav cx-nav-bottom"><NavList items={NAV_BOTTOM} path={path} unread={0} /></nav>
        </aside>
        <main className="cx-main">{children}</main>
      </div>
    </div>
  );
}
