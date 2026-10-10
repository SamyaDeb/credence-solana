// Display formatting for the public pages: precomputed numbers (from the Rust helpers, the scan, the analysis) → text.
// No pricing or risk arithmetic here.
import { wadPct } from '@credence/sdk';

export const usd = (n: number, digits = 0) => `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const usdM = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : usd(n));
export const pct = (fraction: number, digits = 1) => (Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : 'n/a');
export const wadPercent = (w: string, digits = 2) => wadPct(BigInt(w), digits);
/** A WAD USD price as dollars with two decimals, from the string (no float). */
export function wadUsd(w: string): string {
  const x = BigInt(w);
  const cents = (x + 5n * 10n ** 15n) / 10n ** 16n;
  return `$${(cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(cents % 100n).toString().padStart(2, '0')}`;
}
export const utc = (secs: number) => new Date(secs * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
