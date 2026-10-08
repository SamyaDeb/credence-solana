// The landing page's motion, in the design's timings: elements that animate in on load, reveals when a block scrolls
// into view, and scroll-linked moves (the hero dashboard tilting away, the navbar turning solid, the watch rising).
// `html.ix` (set before first paint by the root layout, skipped for reduced motion) holds elements in their start
// state via landing.css; without it the page is static and fully visible.
const OUT_EXPO = 'cubic-bezier(0.19, 1, 0.22, 1)';
const OUT_QUART = 'cubic-bezier(0.25, 1, 0.5, 1)';

const all = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];

type Frame = [at: number, ...value: number[]];

/** Value at `pos` (0–100): holds the first frame before it and the last after it, linear in between. */
export function sample(frames: Frame[], pos: number): number[] {
  if (pos <= frames[0][0]) return frames[0].slice(1);
  for (let i = 1; i < frames.length; i++) {
    const [a, ...va] = frames[i - 1];
    const [b, ...vb] = frames[i];
    if (pos <= b) {
      const t = b === a ? 1 : (pos - a) / (b - a);
      return va.map((v, k) => v + (vb[k] - v) * t);
    }
  }
  return frames[frames.length - 1].slice(1);
}

/** How far the viewport has scrolled through `el` (0–1). `entering`: count from when its top enters the viewport,
 * else from when it reaches the top of the viewport. */
function progressThrough(el: HTMLElement, entering: boolean) {
  const vh = document.documentElement.clientHeight;
  const r = el.getBoundingClientRect();
  const start = r.top + (entering ? 0 : Math.min(r.height, vh));
  const span = Math.min(vh + (r.top + r.height - start), document.documentElement.scrollHeight);
  return Math.min(Math.max(0, vh - start), span) / span;
}

function pageProgress() {
  const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
  return scrollHeight > clientHeight ? scrollTop / (scrollHeight - clientHeight) : 0;
}

type Transform = { x?: number; y?: number; scale?: number; rotateY?: number };
const css = (t: Transform) =>
  `translate3d(${t.x ?? 0}px, ${t.y ?? 0}px, 0) scale3d(${t.scale ?? 1}, ${t.scale ?? 1}, 1) rotateY(${t.rotateY ?? 0}deg)`;

/** A scroll-linked driver: eases its position toward the scroll target every frame (`smoothing` of the remaining
 * distance is kept per frame, as in the design) and renders its tracks. */
type Driver = { target: () => number; smoothing: number; pos: number | null; render: (p: number) => void };

function reveal(el: HTMLElement, from: Keyframe, delay: number, duration: number, easing: string) {
  el.animate([from, { opacity: 1, transform: 'none' }], { duration, delay, easing, fill: 'both' });
}

function onceInView(els: HTMLElement[], offsetPct: number, run: (el: HTMLElement) => void) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      // A hidden element (an inactive tab pane's copy) has an empty rect; reveal it with the rest.
      const { width, height, top } = e.boundingClientRect;
      if (!e.isIntersecting && !(offsetPct === 0 && width === 0 && height === 0 && top === 0)) continue;
      io.unobserve(e.target);
      run(e.target as HTMLElement);
    }
  }, { rootMargin: `-${offsetPct}% 0px -${offsetPct}% 0px` });
  els.forEach((el) => io.observe(el));
  return () => io.disconnect();
}

function scrollDrivers(desktop: boolean): { drivers: Driver[]; touched: HTMLElement[] } {
  const drivers: Driver[] = [];
  const touched: HTMLElement[] = [];
  const wrapper = document.querySelector<HTMLElement>('.wrapper');
  if (wrapper) {
    const dash = all('.dashobard-wrapper', wrapper);
    const holder = all('.content-holder', wrapper);
    const blur = all('.blue-blur', wrapper);
    const copy = all('.feature-grid-content-holder-2', wrapper);
    touched.push(...dash, ...holder, ...blur, ...copy);
    const xy: Frame[] = desktop ? [[9, 0, 0], [23, 150, 210], [42, 500, 820], [100, 500, 1220]] : [[9, 0, 0], [23, 0, 290], [42, 0, 350], [100, 0, 900]];
    const rot: Frame[] = [[23, 0], [42, -28], [100, -45]];
    const copyOpacity: Frame[] = desktop ? [[23, 0], [45, 1], [100, 1]] : [[9, 0], [23, 1], [100, 1]];
    const copyXY: Frame[] = desktop ? [[23, -260, 0], [45, 0, 0], [100, 0, 380]] : [[9, -260, 0], [23, 0, 0], [100, 0, 380]];
    drivers.push({
      target: () => progressThrough(wrapper, false), smoothing: desktop ? 0.94 : 0.93, pos: null,
      render: (p) => {
        const [x, y] = sample(xy, p); const [r] = sample(rot, p);
        dash.forEach((el) => (el.style.transform = css({ x, y, rotateY: r })));
        const [hy] = sample([[9, 0], [23, 200]], p);
        holder.forEach((el) => (el.style.transform = css({ y: hy })));
        const [bo] = sample([[23, 0], [42, 0.2]], p);
        blur.forEach((el) => (el.style.opacity = String(bo)));
        const [co] = sample(copyOpacity, p); const [cx, cy] = sample(copyXY, p);
        copy.forEach((el) => { el.style.opacity = String(co); el.style.transform = css({ x: cx, y: cy }); });
      },
    });
  }
  // Over the sky the navbar is clear with a white logo; at 4% of the page it turns solid.
  const nav = all('.navbar'); const brand = all('.brand-image'); const text = all(desktop ? '.nav-link' : '.menu-button');
  touched.push(...nav, ...brand, ...text);
  const rgba = (v: number[]) => `rgba(${v.map((x, i) => (i < 3 ? Math.round(x) : x)).join(', ')})`;
  drivers.push({
    target: pageProgress, smoothing: 0.93, pos: null,
    render: (p) => {
      nav.forEach((el) => {
        el.style.backgroundColor = rgba(sample([[0, 255, 255, 255, 0.05], [3, 255, 255, 255, 0.05], [4, 245, 244, 253, 1]], p));
        el.style.borderColor = rgba(sample([[0, 255, 255, 255, 0.08], [3, 255, 255, 255, 0.08], [4, 46, 51, 91, 0.4]], p));
      });
      brand.forEach((el) => (el.style.filter = `invert(${sample([[0, 100], [3, 100], [4, 0]], p)[0]}%)`));
      text.forEach((el) => (el.style.color = rgba(sample([[0, 245, 244, 253, 1], [3, 245, 244, 253, 1], [4, 46, 51, 91, 1]], p))));
    },
  });
  return { drivers, touched };
}

export function startLandingMotion(): () => void {
  const stops: (() => void)[] = [];

  // On load: the hero copy, buttons and dashboard rise in turn; the navbar fades in.
  [1, 2, 3, 4].forEach((n, i) => all(`.animate-on-load-0${n}`).forEach((el) =>
    reveal(el, { opacity: 0, transform: 'translate3d(0, 45px, 0) scale3d(0.96, 0.96, 1)' }, 300 + i * 100, 1200, OUT_EXPO)));
  all('.navbar').forEach((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, delay: 600, easing: 'ease', fill: 'both' }));
  all('.home-content-wrapper').forEach((el) => el.animate([{ transform: 'translate3d(0, 120px, 0)' }, { transform: 'none' }], { duration: 2000, delay: 300, easing: OUT_EXPO, fill: 'both' }));

  // Reveals: blocks rise 45 px and fade in once in view (offset: percent of the viewport).
  for (const [sel, off] of [['.fade-in-on-scroll', 0], ['.paragraph-holder', 0], ['.title-holder', 0], ['.tag', 10], ['.line', 10], ['.cta-dashboard-holder', 15]] as const) {
    stops.push(onceInView(all(sel), off, (el) => reveal(el, { opacity: 0, transform: 'translate3d(0, 45px, 0)' }, 300, 1200, OUT_EXPO)));
  }
  const presets: Record<string, string> = { slideInBottom: 'translate3d(0, 100px, 0)', slideInLeft: 'translate3d(-100px, 0, 0)', slideInRight: 'translate3d(100px, 0, 0)' };
  stops.push(onceInView(all('[data-ix]'), 10, (el) =>
    reveal(el, { opacity: 0, transform: presets[el.dataset.ix ?? ''] ?? 'none' }, Number(el.dataset.ixDelay ?? 0), 1000, OUT_QUART)));

  // Scroll-linked drivers; the hero and navbar variants swap at the 992 px breakpoint.
  const watch = document.querySelector<HTMLElement>('.section.apple-watch-section');
  const watchDriver: Driver[] = watch ? [{
    target: () => progressThrough(watch, true), smoothing: 0.93, pos: null,
    render: (p) => {
      all('.hand-holder', watch).forEach((el) => (el.style.transform = css({ y: sample([[0, -100], [55, 0]], p)[0] })));
      all('.center-hand-text', watch).forEach((el) => (el.style.transform = css({ y: sample([[0, 140], [55, 0]], p)[0] })));
    },
  }] : [];
  const mq = window.matchMedia('(min-width: 992px)');
  let current = scrollDrivers(mq.matches);
  const onBreakpoint = () => {
    current.touched.forEach((el) => ['transform', 'opacity', 'background-color', 'border-color', 'filter', 'color'].forEach((p) => el.style.removeProperty(p)));
    current = scrollDrivers(mq.matches);
    kick();
  };

  let raf = 0;
  const frame = () => {
    raf = 0;
    let busy = false;
    for (const d of [...current.drivers, ...watchDriver]) {
      const target = d.target();
      d.pos = d.pos === null ? target : d.pos + (target - d.pos) * Math.max(1 - d.smoothing, 0.01);
      if (Math.abs(target - d.pos) < 1e-4) d.pos = target; else busy = true;
      d.render(d.pos * 100);
    }
    if (busy) kick();
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  kick();
  mq.addEventListener('change', onBreakpoint);
  window.addEventListener('scroll', kick, { passive: true });
  window.addEventListener('resize', kick);
  return () => {
    cancelAnimationFrame(raf);
    mq.removeEventListener('change', onBreakpoint);
    window.removeEventListener('scroll', kick);
    window.removeEventListener('resize', kick);
    stops.forEach((s) => s());
  };
}
