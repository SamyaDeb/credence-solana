// Display formatting only: bigint base units → text. No pricing or risk arithmetic lives in the widget.
const grouped = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** USDC base units (6 decimals) → "1,234.56". Truncates by default; `'up'` rounds away from zero, for a bound the person signs
 * for (a maximum premium must never read lower than the transaction allows). */
export function fmtUsdc(v: bigint, round: 'down' | 'up' = 'down'): string {
  const neg = v < 0n;
  let c = (neg ? -v : v) / 10_000n; // cents, truncated
  if (round === 'up' && (neg ? -v : v) % 10_000n !== 0n) c += 1n;
  const whole = c / 100n;
  return `${neg ? '-' : ''}${grouped(whole.toString())}.${(c % 100n).toString().padStart(2, '0')}`;
}

/** Seconds → "3h 12m" / "42m" / "under a minute". */
export function fmtAge(secs: number): string {
  if (secs < 60) return 'under a minute';
  const m = Math.floor(secs / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const shortSig = (s: string) => `${s.slice(0, 6)}…${s.slice(-6)}`;
