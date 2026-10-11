'use client';
// Light / dark / system, kept in this browser only. The root layout's boot script applies the stored choice before first
// paint (no flash); `system` leaves <html> without `data-theme` so the CSS follows prefers-color-scheme.
import { useCallback, useEffect, useState } from 'react';
import { THEME_KEY } from './theme-boot';

export type Theme = 'system' | 'light' | 'dark';
const EVENT = 'credence-theme';

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch { return 'system'; }
}

/** The theme in effect: the stored choice, or the system's when there is none. */
export function resolvedTheme(t: Theme): 'light' | 'dark' {
  if (t !== 'system') return t;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>('system');
  useEffect(() => {
    set(readTheme());
    const on = () => set(readTheme());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const save = useCallback((t: Theme) => {
    set(t);
    const el = document.documentElement;
    if (t === 'system') delete el.dataset.theme; else el.dataset.theme = t;
    try { if (t === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* this visit only */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [theme, save];
}
