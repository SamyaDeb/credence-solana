'use client';
// The landing navbar. Below 992 px webflow.css collapses it: the menu button opens the links in an overlay under the
// bar, sliding down from behind it.
import { useEffect, useRef, useState } from 'react';
import { asset, navCta, navLinks } from './content';

const SLIDE_MS = 400;

function Links({ open, onNavigate }: { open: boolean; onNavigate?: () => void }) {
  return (
    <nav role="navigation" className="nav-menu w-nav-menu" {...(open ? { 'data-nav-menu-open': '' } : {})}>
      <div className="nav-menu-link-holder">
        <div className="nav-menu-link-container">
          <div className="nav-links">
            {navLinks.map((l) => (
              <a key={l.label} href={l.href} className={`nav-link w-nav-link${open ? ' w--nav-link-open' : ''}`} onClick={onNavigate}
                {...(l.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{l.label}</a>
            ))}
          </div>
        </div>
        <div className="nav-button-holder"><a href={navCta.href} className="button w-button">{navCta.label}</a></div>
      </div>
    </nav>
  );
}

export function Navbar() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false); // overlay in the DOM (stays during the closing slide)
  const bar = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const menu = overlay.current?.querySelector<HTMLElement>('.w-nav-menu');
    if (!menu || !overlay.current) return;
    const hidden = `translateY(${-((bar.current?.offsetHeight ?? 0) + menu.offsetHeight)}px)`;
    if (open) {
      overlay.current.style.height = `${window.innerHeight - (bar.current?.offsetHeight ?? 0)}px`;
      menu.animate([{ transform: hidden }, { transform: 'translateY(0)' }], { duration: SLIDE_MS, easing: 'ease', fill: 'forwards' });
      return;
    }
    const a = menu.animate([{ transform: 'translateY(0)' }, { transform: hidden }], { duration: SLIDE_MS, easing: 'ease', fill: 'forwards' });
    a.onfinish = () => setMounted(false);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!overlay.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    const mq = window.matchMedia('(max-width: 991px)');
    const wide = () => { if (!mq.matches) { setOpen(false); setMounted(false); } };
    document.addEventListener('click', away);
    document.addEventListener('keydown', esc);
    mq.addEventListener('change', wide);
    return () => { document.removeEventListener('click', away); document.removeEventListener('keydown', esc); mq.removeEventListener('change', wide); };
  }, [open]);

  const toggle = () => { if (!open) setMounted(true); setOpen(!open); };

  return (
    <div className="fixed-nav">
      <div ref={bar} role="banner" className="navbar w-nav" data-collapse="medium" data-animation="default">
        <div className="container navbar-container">
          <div className="navbar-holder">
            <div className="navbar-container">
              <a href="/" aria-current="page" aria-label="Credence home" className="brand w-nav-brand w--current">
                <img src={asset.logo} alt="Credence" className="brand-image" />
              </a>
              {!mounted && <Links open={false} />}
              <div ref={button} className={`menu-button w-nav-button${open ? ' w--open' : ''}`} role="button" tabIndex={0} aria-label="menu"
                aria-controls="nav-overlay" aria-expanded={open} onClick={toggle}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
                <div className="icon w-icon-nav-menu" />
              </div>
            </div>
          </div>
        </div>
        <div ref={overlay} className="w-nav-overlay" id="nav-overlay" style={{ display: mounted ? 'block' : 'none' }}>
          {mounted && <Links open onNavigate={() => setOpen(false)} />}
        </div>
      </div>
    </div>
  );
}
