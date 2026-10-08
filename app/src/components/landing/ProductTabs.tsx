'use client';
// "One weekend, step by step": four tabs; the open pane fades out (100 ms) and the next fades in (500 ms).
import { useRef, useState, type KeyboardEvent } from 'react';
import { Heading } from './Heading';
import { tabs, tabsHeading } from './content';

export function ProductTabs() {
  const [current, setCurrent] = useState(0);
  const [shown, setShown] = useState(0);
  const pane = useRef<HTMLDivElement>(null);
  const links = useRef<(HTMLAnchorElement | null)[]>([]);

  const select = (k: number) => {
    if (k === current) return;
    setCurrent(k);
    links.current[k]?.focus({ preventScroll: true });
    const out = pane.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: 'forwards' });
    const swap = () => {
      setShown(k);
      requestAnimationFrame(() => pane.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, easing: 'cubic-bezier(0.19, 1, 0.22, 1)', fill: 'forwards' }));
    };
    if (out) out.onfinish = swap; else swap();
  };

  const onKey = (e: KeyboardEvent) => {
    const last = tabs.length - 1;
    const to = ({ ArrowLeft: current - 1, ArrowUp: current - 1, ArrowRight: current + 1, ArrowDown: current + 1, Home: 0, End: last } as Record<string, number>)[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(to < 0 ? last : to > last ? 0 : to);
  };

  return (
    <div className="section">
      <div className="container">
        <div className="spacing">
          <Heading {...tabsHeading} />
          <div className="fade-in-on-scroll">
            <div className="tabs w-tabs">
              <div className="tabs-menu w-tab-menu" role="tablist" onKeyDown={onKey}>
                {tabs.map((t, k) => (
                  <a key={t.label} ref={(el) => { links.current[k] = el; }} id={`tab-${k}`} href={`#pane-${k}`} role="tab" aria-controls={`pane-${k}`}
                    aria-selected={k === current} tabIndex={k === current ? undefined : -1}
                    className={`tab-link w-inline-block w-tab-link${k === current ? ' w--current' : ''}`}
                    onClick={(e) => { e.preventDefault(); select(k); }}><div>{t.label}</div></a>
                ))}
              </div>
              <div className="tab-content-holder w-tab-content">
                {tabs.map((t, k) => (
                  <div key={t.label} id={`pane-${k}`} role="tabpanel" aria-labelledby={`tab-${k}`} ref={k === shown ? pane : undefined}
                    className={`tab-pane-holder w-tab-pane${k === shown ? ' w--tab-active' : ''}`}>
                    <div className="tab-pane">
                      <img loading="eager" src={t.image} alt="" className="tab-pane-image" />
                      <div className="paragraph-holder"><p>{t.body}</p></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
