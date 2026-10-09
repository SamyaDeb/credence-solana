// Task 2.2: the XNYS session calendar for the on-chain `Calendar` account, built from the Pyth schedule string of
// `Equity.US.SPY/USD` (regular hours, holidays and half days, America/New_York) and cross-checked session by session
// against the EVM calendar in data/calendars/. Writes data/onchain/calendar-XNYS.json.
//
// The Pyth string lists holidays as MMDD without a year, for roughly the next twelve months (on Oct 8, 2026 it starts
// with 0907 = Labor Day 2026 and ends with 0705 = Independence Day observed 2027). MMDD from September on is read as
// 2026, earlier months as 2027, so the calendar ends on Aug 31, 2027; regenerate before then.
//
// Hash (checked by `finalize_calendar`): SHA-256 over each session as date u32 LE ‖ open i64 LE ‖ close i64 LE.
// Usage: pnpm tsx src/gen-calendar.ts   (reads PYTH_API_KEY from .env; pass --offline to use the cached string)
import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './lib/redact.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const OUT = join(ROOT, 'data/onchain/calendar-XNYS.json');
const EVM = join(ROOT, 'data/calendars/XNYS-20261001-20271031.json');
const SPY_EQUITY_FEED = '19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5';
const FROM = '2026-10-01';
const TO = '2027-08-31';

export type Session = { date: number; open: number; close: number };

/** Unix seconds of a wall-clock time in America/New_York. */
export function nyToUnix(y: number, m: number, d: number, hh: number, mm: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  let t = Date.UTC(y, m - 1, d, hh, mm) / 1000 + 5 * 3600; // EST guess
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 1000;
    const want = Date.UTC(y, m - 1, d, hh, mm) / 1000;
    if (shown === want) return t;
    t += want - shown;
  }
  throw new Error(`no NY time ${y}-${m}-${d} ${hh}:${mm}`);
}

/** Parses `America/New_York;Mon,…,Sun;MMDD/spec,…` into sessions for every date in [from, to]. */
export function sessionsFromSchedule(schedule: string, from: string, to: string): Session[] {
  const [tz, weekly, holidays] = schedule.split(';');
  if (tz !== 'America/New_York') throw new Error(`unexpected timezone ${tz}`);
  const days = weekly.split(',');
  if (days.length !== 7) throw new Error('weekly schedule must have 7 entries (Mon..Sun)');
  const special = new Map<string, string>();
  for (const h of (holidays ?? '').split(',').filter(Boolean)) {
    const [mmdd, spec] = h.split('/');
    const year = +mmdd.slice(0, 2) >= 9 ? 2026 : 2027;
    special.set(`${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`, spec);
  }
  const out: Session[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const dow = (new Date(t).getUTCDay() + 6) % 7; // Mon = 0
    const spec = special.get(iso) ?? days[dow];
    if (spec === 'C') continue;
    const m = spec.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (!m) throw new Error(`unsupported session spec ${spec} on ${iso}`);
    const [y, mo, d] = iso.split('-').map(Number);
    out.push({
      date: y * 10000 + mo * 100 + d,
      open: nyToUnix(y, mo, d, +m[1], +m[2]),
      close: nyToUnix(y, mo, d, +m[3], +m[4]),
    });
  }
  return out;
}

export function calendarHash(s: Session[]): string {
  const b = Buffer.alloc(s.length * 20);
  s.forEach((x, i) => {
    b.writeUInt32LE(x.date, i * 20);
    b.writeBigInt64LE(BigInt(x.open), i * 20 + 4);
    b.writeBigInt64LE(BigInt(x.close), i * 20 + 12);
  });
  return createHash('sha256').update(b).digest('hex');
}

async function schedule(offline: boolean): Promise<string> {
  if (offline && existsSync(OUT)) return JSON.parse(readFileSync(OUT, 'utf8')).source.schedule;
  const r = await fetch('https://pyth.dourolabs.app/hermes/v2/price_feeds?query=SPY&asset_type=equity', {
    headers: { Authorization: `Bearer ${process.env.PYTH_API_KEY ?? ''}` },
  });
  if (!r.ok) throw new Error(`Hermes ${r.status}`);
  const feeds = (await r.json()) as { id: string; attributes: { schedule: string } }[];
  const f = feeds.find((x) => x.id === SPY_EQUITY_FEED);
  if (!f) throw new Error('Equity.US.SPY/USD not found');
  return f.attributes.schedule;
}

async function main() {
  const sched = await schedule(process.argv.includes('--offline'));
  const sessions = sessionsFromSchedule(sched, FROM, TO);
  // Cross-check every session against the EVM calendar (same venue, built from exchange holiday lists).
  const evm = JSON.parse(readFileSync(EVM, 'utf8'));
  const evmByDate = new Map<number, { open: number; close: number }>();
  evm.sessionDates.forEach((d: string, i: number) => evmByDate.set(+d.replaceAll('-', ''), evm.sessions[i]));
  const lastDate = +TO.replaceAll('-', '');
  const evmInRange = [...evmByDate.keys()].filter((d) => d >= +FROM.replaceAll('-', '') && d <= lastDate);
  const mismatch: string[] = [];
  if (evmInRange.length !== sessions.length) mismatch.push(`count ${sessions.length} vs EVM ${evmInRange.length}`);
  for (const s of sessions) {
    const e = evmByDate.get(s.date);
    if (!e) mismatch.push(`${s.date}: not an EVM session`);
    else if (e.open !== s.open || e.close !== s.close) mismatch.push(`${s.date}: ${s.open}-${s.close} vs EVM ${e.open}-${e.close}`);
  }
  if (mismatch.length) throw new Error(`calendar mismatch:\n${mismatch.join('\n')}`);
  const hash = calendarHash(sessions);
  mkdirSync(join(ROOT, 'data/onchain'), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    venue: 'XNYS',
    source: { feed: 'Equity.US.SPY/USD', id: SPY_EQUITY_FEED, schedule: sched, fetchedAt: new Date().toISOString() },
    crossCheck: `matches ${EVM.replace(ROOT, '')} for all ${sessions.length} sessions`,
    from: FROM, to: TO, n: sessions.length, sha256: hash, sessions,
  }, null, 1) + '\n');
  console.log(`${sessions.length} sessions ${FROM}..${TO}, matches EVM calendar, sha256 ${hash}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(redact(String(e?.stack ?? e))); process.exit(1); });
