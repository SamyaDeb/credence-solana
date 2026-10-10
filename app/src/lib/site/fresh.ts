// How old a published number may be before the page says so. Every number on the public site has an as-of time; past its
// bound it is labelled stale, never "live". Pure, so the rule is tested without a server.
export const BOUNDS = {
  /** The Gap Oracle numbers: the frozen-for time moves by the minute. */
  gap: 2 * 3600,
  /** The scan of Kamino and Jupiter Lend positions. */
  scan: 24 * 3600,
  /** The credit-unlock analysis: a dated analysis, read as of its date. */
  unlock: 14 * 86400,
  /** The shadow keeper's summary while it runs (it writes every few minutes). */
  weekend: 6 * 3600,
  /** The fork-demo results (a recorded run). */
  demo: 30 * 86400,
} as const;

export type Freshness = { state: 'fresh' | 'stale'; asOf: string | null; ageSecs: number | null; label: string };

const utc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Plain age: "45 s", "3 min", "5 h 2 min", "3 d". */
export function ageLabel(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)} s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** `asOf` is an ISO time. A missing, unparsable or future time is stale: it is never trusted as fresh. */
export function freshness(asOf: string | null | undefined, nowMs: number, boundSecs: number): Freshness {
  const t = typeof asOf === 'string' && asOf ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(t) || t > nowMs + 60_000) return { state: 'stale', asOf: null, ageSecs: null, label: 'Stale: no valid as-of time for this data' };
  const age = Math.max(0, (nowMs - t) / 1000);
  const when = `as of ${utc(t)}`;
  if (age <= boundSecs) return { state: 'fresh', asOf: asOf!, ageSecs: age, label: `Snapshot ${when} (${ageLabel(age)} old)` };
  return { state: 'stale', asOf: asOf!, ageSecs: age, label: `Stale: ${when} (${ageLabel(age)} old). Not current.` };
}
