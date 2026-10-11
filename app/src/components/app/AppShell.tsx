'use client';
// The app frame: brand, top bar (market search, network badge, wallet, alerts, account) and the sidebar in the page
// order of the design, with Demo mode next to Faucet among the fork tools. Below 1024 px the sidebar becomes a menu.
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { RPC_URL } from '@/lib/credence';
import { IS_MAINNET } from '@/lib/network';
import { useAlerts } from '@/lib/hooks/alerts';
import { resolvedTheme, useTheme } from '@/lib/theme';
import { Icon } from './Icon';
import { WalletButton } from './WalletButton';

type Item = { href: string; label: string; icon: string; activeIcon?: string };
type Group = { label?: string; items: Item[] };

// Grouped by what a person came to do: borrow safely, earn, or read the market.
const NAV: Group[] = [
  { items: [{ href: '/app', label: 'Overview', icon: 'home-line', activeIcon: 'home' }] },
  { label: 'Borrow', items: [
    { href: '/app/borrow', label: 'Borrow', icon: 'card' },
    { href: '/app/protect', label: 'Protect', icon: 'shield-check' },
    { href: '/app/weekend-safe', label: 'Weekend-safe', icon: 'clock' },
  ] },
  { label: 'Earn', items: [
    { href: '/app/underwrite', label: 'Underwrite', icon: 'shield' },
    { href: '/app/curator', label: 'Curator', icon: 'pie' },
    { href: '/app/auctions', label: 'Auctions', icon: 'gavel' },
  ] },
  { label: 'Insights', items: [
    { href: '/app/markets', label: 'Markets', icon: 'chart' },
    { href: '/app/risk', label: 'Risk', icon: 'pie' },
    { href: '/app/alerts', label: 'Alerts', icon: 'mail' },
  ] },
];
// The fork's demo tools: hidden on the public read-only build.
const NAV_DEMO: Group = { label: 'Demo · fork', items: [
  { href: '/app/demo', label: 'Demo mode', icon: 'play' },
  { href: '/app/faucet', label: 'Faucet', icon: 'cash' },
  { href: '/app/gap-tokens', label: 'Gap tokens', icon: 'chart' },
] };
const NAV_BOTTOM: Item[] = [
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

function NavGroups({ groups, path, unread }: { groups: Group[]; path: string; unread: number }) {
  return groups.map((g, i) => (
    <div key={g.label ?? i} className="cx-nav-group" role="group" aria-label={g.label}>
      {g.label && <div className="cx-nav-label">{g.label}</div>}
      <NavList items={g.items} path={path} unread={unread} />
    </div>
  ));
}

/** Light ↔ dark in one click; Settings also offers "match the system". */
function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(resolvedTheme(theme) === 'dark'), [theme]);
  return (
    <button type="button" className="cx-bell cx-theme-btn" onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'} data-testid="theme">
      <Icon name={dark ? 'sun' : 'moon'} size={24} strokeWidth={1.6} />
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { unread } = useAlerts();
  const path = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);
  const local = !IS_MAINNET && /127\.0\.0\.1|localhost/.test(RPC_URL);

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
          <span className="cx-preview" title={IS_MAINNET ? 'Solana mainnet, read only: nothing is signed or sent' : `The app reads and writes ${local ? 'a local surfpool fork of Solana mainnet (real Kamino state)' : RPC_URL}`} data-testid="network">
            {IS_MAINNET ? 'Mainnet · read only' : local ? 'Local mainnet fork' : 'Custom RPC'}
          </span>
          <div className="cx-topbar-right">
            <WalletButton />
            <ThemeToggle />
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
          <nav className="cx-nav"><NavGroups groups={IS_MAINNET ? NAV : [...NAV, NAV_DEMO]} path={path} unread={unread} /></nav>
          <nav className="cx-nav cx-nav-bottom"><NavList items={NAV_BOTTOM} path={path} unread={0} /></nav>
        </aside>
        <main className="cx-main">
          {IS_MAINNET && <p className="cx-geo" data-testid="geofence">Public read-only view of Solana mainnet. Not available to US persons (as xStocks); nothing here is an offer or advice.</p>}
          {children}
        </main>
      </div>
    </div>
  );
}
