import type { ReactNode } from 'react';

/** Line icons in the app's style: 24-unit grid, round caps and joins, drawn in currentColor. */
const PATHS: Record<string, ReactNode> = {
  home: <><path d="M4 10.5 12 4l8 6.5V20H4z" fill="currentColor" fillOpacity={0.22} /><path d="M9.5 20v-5.5h5V20" /></>,
  'home-line': <><path d="M4 10.5 12 4l8 6.5V20H4z" /><path d="M9.5 20v-5.5h5V20" /></>,
  chart: <><path d="M3 3v18h18" /><path d="m7 15 4-5 3 3 6-7" /></>,
  card: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3 9.5h5.5a3.5 3.5 0 0 0 7 0H21" /></>,
  vault: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="12" cy="12" r="3.5" /><path d="M12 8.5v1.2M12 14.3v1.2M8.5 12h1.2M14.3 12h1.2M6 20v1.5M18 20v1.5" /></>,
  shield: <path d="M12 3 20 6v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" />,
  'shield-check': <><path d="M12 3 20 6v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  gavel: <><path d="m13.5 4.5 6 6" /><path d="m11 7 6 6" /><path d="m12.2 5.8-4.4 4.4 6 6 4.4-4.4" /><path d="M10.5 13.5 4 20" /><path d="M13 21h8" /></>,
  pie: <><circle cx="12" cy="12" r="9" /><path d="M12 3v9l6.4 6.4" /><path d="M12 12 3.4 9.4" /></>,
  mail: <><rect x="2.5" y="5" width="19" height="14" rx="1.5" /><path d="m3 6 9 7.5L21 6" /><path d="m3 18.5 6.5-6.5M21 18.5 14.5 12" /></>,
  user: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 18.5c1.4-2 3.3-3 5.5-3s4.1 1 5.5 3" /></>,
  settings: <><path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4z" /><circle cx="12" cy="12" r="3" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  bell: <><path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 1.5h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  repay: <><path d="M12 19V7" /><path d="m7 11 5-5 5 5" /><path d="M4 21h16" /></>,
  deposit: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 21h16" /></>,
  withdraw: <><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M4 21h16" /></>,
  cash: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="3" /></>,
  percent: <><path d="M19 5 5 19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  alert: <><path d="m12 3.5 9.5 16.5h-19z" /><path d="M12 10v4.5M12 17.2v.3" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  play: <><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5.5 3.5-5.5 3.5z" /></>,
  flask: <><path d="M9.5 3h5M10.5 3v6L5 19a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2l-5.5-10V3" /><path d="M7.5 15h9" /></>,
  wallet: <><path d="M4 7.5V18a2 2 0 0 0 2 2h14V9.5H6a2 2 0 0 1-2-2zm0 0A2 2 0 0 1 6 5.5h11V9.5" /><circle cx="16" cy="14.75" r="1.2" fill="currentColor" stroke="none" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
  logout: <><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15" /></>,
  dots: <><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.8v.2" /></>,
  external: <><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
};

export function Icon({ name, size = 22, strokeWidth = 1.7, className }: { name: string; size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? PATHS.dots}
    </svg>
  );
}
