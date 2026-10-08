'use client';
// Local preferences (Settings), kept in this browser only. Storage can be unavailable (private windows), so every
// access is guarded and the defaults apply.
import { useCallback, useEffect, useState } from 'react';

export type Prefs = {
  /** Which alerts the Alerts page and the sidebar badge show. */
  alerts: { bell: boolean; cover: boolean; close: boolean; settlement: boolean; payout: boolean; lp: boolean };
  /** Hours before the bell from which an uncovered position raises an alert. */
  bellLeadHours: number;
  /** The slippage Buy gap cover starts with (percent). */
  slippage: 1 | 2 | 5;
  /** Debt / C′ from which a position counts as near its threshold. */
  nearRatio: number;
};

export const DEFAULT_PREFS: Prefs = {
  alerts: { bell: true, cover: true, close: true, settlement: true, payout: true, lp: true },
  bellLeadHours: 48, slippage: 2, nearRatio: 0.9,
};
const KEY = 'credence.prefs.v1';
const EVENT = 'credence-prefs';

export function readPrefs(): Prefs {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null;
    return s ? { ...DEFAULT_PREFS, ...s, alerts: { ...DEFAULT_PREFS.alerts, ...(s.alerts ?? {}) } } : DEFAULT_PREFS;
  } catch { return DEFAULT_PREFS; }
}

export function usePrefs(): [Prefs, (p: Prefs) => void] {
  const [prefs, set] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => {
    set(readPrefs());
    const on = () => set(readPrefs());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const save = useCallback((p: Prefs) => {
    set(p);
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* this visit only */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [prefs, save];
}
