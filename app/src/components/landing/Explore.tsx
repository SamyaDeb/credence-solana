'use client';
// The product slider: one card per page, arrows (wrapping at both ends), swipe, and keyboard. The current card lifts
// (landing.css, desktop only).
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Heading } from './Heading';
import { asset, explore, slides } from './content';

const EASE_OUT_EXPO = 'cubic-bezier(0.19, 1, 0.22, 1)';

export function Explore() {
  const mask = useRef<HTMLDivElement>(null);
  const [offsets, setOffsets] = useState<number[]>(() => slides.map(() => 0));
  const [i, setI] = useState(0);
  const [animate, setAnimate] = useState(false);
  const down = useRef<{ x: number; y: number } | null>(null);

  // Offsets of each card from the first, re-measured on resize (no animation for the jump).
  useLayoutEffect(() => {
    const m = mask.current;
    if (!m) return;
    const measure = () => {
      const cards = [...m.querySelectorAll<HTMLElement>('.w-slide')];
      const first = cards[0]?.offsetLeft ?? 0;
      setAnimate(false);
      setOffsets(cards.map((c) => c.offsetLeft - first));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(m);
    return () => ro.disconnect();
  }, []);

  const go = (to: number) => { setAnimate(true); setI((to + slides.length) % slides.length); };
  const key = (dir: number) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(i + dir); } };
  const start = (e: PointerEvent) => { down.current = { x: e.clientX, y: e.clientY }; };
  const end = (e: PointerEvent) => {
    const s = down.current; down.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - s.y)) go(i + (dx < 0 ? 1 : -1));
  };

  return (
    <div className="section overflow-hidden" id="explore">
      <div className="container">
        <div className="spacing">
          <Heading {...explore} />
          <div className="fade-in-on-scroll">
            <div className="slider w-slider" role="region" aria-roledescription="carousel" aria-label="Products" onPointerDown={start} onPointerUp={end} onPointerCancel={() => (down.current = null)}>
              <div className="slider-mask w-slider-mask" id="explore-slides" ref={mask}>
                {slides.map((s, k) => (
                  <div key={k} className={`slide w-slide${k === i ? ' is-active' : ''}`} role="group" aria-label={`${k + 1} of ${slides.length}`} aria-hidden={k === i ? undefined : true}
                    style={{ transform: `translateX(${-offsets[i]}px)`, transition: animate ? `transform 1250ms ${EASE_OUT_EXPO}` : undefined }}>
                    <div className={`slider-wrapper${s.light ? ' light' : ''}`}>
                      <div className="slider-content">
                        <div className="slider-title-holder">
                          <img src={s.icon} loading="lazy" alt="" className="slider-icon" />
                          <h5 className={s.light ? undefined : 'white-text'}>{s.title}</h5>
                        </div>
                        <p className={s.light ? undefined : 'white-paragraph'}>{s.body}</p>
                      </div>
                      {s.image && <img src={s.image.src} srcSet={s.image.srcSet} sizes={s.image.sizes} loading="lazy" alt="" className="slider-image" />}
                    </div>
                  </div>
                ))}
              </div>
              {([-1, 1] as const).map((dir) => (
                <div key={dir} className={`arrow-holder${dir > 0 ? ' right w-slider-arrow-right' : ' w-slider-arrow-left'}`} role="button" tabIndex={0}
                  aria-controls="explore-slides" aria-label={dir > 0 ? 'next slide' : 'previous slide'} onClick={() => go(i + dir)} onKeyDown={key(dir)}>
                  <div className="arrow-icon-holder"><img src={dir > 0 ? asset.arrowRight : asset.arrowLeft} loading="lazy" alt="" className="arrow-icon" /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
