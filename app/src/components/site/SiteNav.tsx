'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const SITE_LINKS = [
  { href: '/about', label: 'How it works' },
  { href: '/mainnet', label: 'Mainnet view' },
  { href: '/unlock', label: 'Credit unlock' },
  { href: '/proof', label: 'Proof' },
  { href: '/weekend', label: 'Real weekend' },
  { href: '/roadmap', label: 'Roadmap' },
  { href: '/disclosure', label: 'Disclosure' },
];

export function SiteNav() {
  const path = usePathname();
  return (
    <nav aria-label="Site" className="sx-nav">
      <ul>
        {SITE_LINKS.map((l) => (
          <li key={l.href}><Link href={l.href} aria-current={path === l.href ? 'page' : undefined}>{l.label}</Link></li>
        ))}
      </ul>
    </nav>
  );
}
