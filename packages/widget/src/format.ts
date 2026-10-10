// Display formatting only: bigint base units → text. No pricing or risk arithmetic lives in the widget.
const grouped = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** USDC base units (6 decimals) → "1,234.56". */
export function fmtUsdc(v: bigint): string {
  const neg = v < 0n;
  const x = neg ? -v : v;
  const whole = x / 1_000_000n;
  const frac = (x % 1_000_000n).toString().padStart(6, '0').slice(0, 2);
  return `${neg ? '-' : ''}${grouped(whole.toString())}.${frac}`;
}

/** Seconds → "3h 12m" / "42m" / "under a minute". */
export function fmtAge(secs: number): string {
  if (secs < 60) return 'under a minute';
  const m = Math.floor(secs / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const shortSig = (s: string) => `${s.slice(0, 6)}…${s.slice(-6)}`;
