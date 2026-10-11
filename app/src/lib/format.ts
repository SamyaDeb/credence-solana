// Display of on-chain integers. Every amount is formatted from the stored integer with bigint arithmetic (no float
// round trip): USDC has 6 decimals, xStocks 8, LP shares 6, prices in WAD (1e18). `dp` below the stored precision
// rounds half-up for display only; screens that show a rounded figure say so.
export function fixed(base: bigint, decimals: number, dp = decimals): string {
  const neg = base < 0n;
  let x = neg ? -base : base;
  if (dp < decimals) {
    const f = 10n ** BigInt(decimals - dp);
    x = (x + f / 2n) / f;
  } else if (dp > decimals) {
    x *= 10n ** BigInt(dp - decimals);
  }
  const s = x.toString().padStart(dp + 1, '0');
  const int = s.slice(0, s.length - dp).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = dp > 0 ? `.${s.slice(s.length - dp)}` : '';
  return `${neg ? '−' : ''}${int}${frac}`;
}
export const usdc = (base: bigint, dp = 2) => fixed(base, 6, dp);
export const usdc6 = (base: bigint) => fixed(base, 6, 6);
export const wad = (x: bigint, dp = 4) => fixed(x, 18, dp);
export const pct = (x: number, dp = 1) => `${x >= 0 ? '' : '−'}${Math.abs(x * 100).toFixed(dp)}%`;
export const short = (k: { toBase58(): string } | string, n = 4) => {
  const s = typeof k === 'string' ? k : k.toBase58();
  return `${s.slice(0, n)}…${s.slice(-n)}`;
};
export const utc = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z').replace('T', ' ');
export function et(unix: number) {
  return new Date(unix * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
}
export function dur(secs: number) {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${ss}s` : `${m}m ${ss}s`;
}
/** Display of floats that are already approximations (prices, token totals read as numbers, rates). */
export const num = (x: number, dp = 2) => x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const usd = (x: number, dp = 2) => `$${num(x, dp)}`;

/** A closure id (the Friday's date, 20261023) as people read it: "Oct 23, 2026". */
export function weekendOf(id: number | string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(id));
  if (!m) return String(id);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
