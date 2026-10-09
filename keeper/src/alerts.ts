// Friday alerts (C4a.2): before the bell of every weekend or holiday closure (the XNYS calendar decides), each opted-in
// wallet gets one message per position whose −8% need is over its threshold:
//   "A −8% Monday would need $X to keep [position] healthy; gap protection for this weekend costs $Y. [link to /protect]"
// Positions come from the read-only mainnet scan (data/positions/positions-*.json, scripts/src/positions.ts: Kamino
// obligations with their owner and last-refresh values); every number from the program's pricing (alerts_quote,
// keeper/alerts-quote: realized_payout, the closure's own scenario set and σ, premium + shield loading for the −8% need,
// model vault; the closure priced as buy_cover prices it, A-117).
// Idempotent: a ledger per closure (data/alerts/sent-<closure>.json) holds one entry per destination and position;
// a re-run sends nothing twice and retries what failed. Logs hold counts only: no wallet, chat id or endpoint.
//
//   cargo build --release --manifest-path keeper/alerts-quote/Cargo.toml     (once)
//   pnpm -C keeper alerts            # every 15 min from cron; sends only inside [bell − ALERTS_LEAD_SECS, bell)
//   pnpm -C keeper alerts --now <unix> --dry     # a given time, mocked transport (nothing delivered)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { basisSigmaFor } from '../../scripts/src/basis.js';
import { type Channel, type Ledger, type Subscriber, alertsDir, ledgerFile, ledgerKey, readJson, readSubscribers, withLock, writeJsonAtomic } from './alerts-store.js';
import { type Transport, TransportError, memoryTransport, telegramTransport, webPushTransport } from './alerts-transports.js';
import { redact } from './redact.js';

const ROOT = new URL('../../', import.meta.url).pathname;
export const BELL_BEFORE_CLOSE = 15 * 60;
/** A closure this long or longer gets an alert: weekends, holiday weekends, mid-week holidays (an overnight is 17.5 h). */
export const MIN_CLOSURE_SECS = 36 * 3600;
export const MAX_ATTEMPTS = 6;

export type Session = { date: number; open: number; close: number };
export type Window = { closureId: number; bell: number; close: number; open: number; kind: 'weekend' | 'holiday' };

/** The closure whose alert window [bell − lead, bell) contains `now`, or null. */
export function alertWindow(sessions: Session[], now: number, lead: number): Window | null {
  for (let i = 0; i + 1 < sessions.length; i++) {
    const s = sessions[i], next = sessions[i + 1];
    const bell = s.close - BELL_BEFORE_CLOSE;
    if (now < bell - lead || now >= bell) continue;
    if (next.open - s.close < MIN_CLOSURE_SECS) return null;
    const saturday = [...Array(Math.ceil((next.open - s.close) / 86_400) + 1)].some((_, d) => new Date((s.close + d * 86_400) * 1000).getUTCDay() === 6 && s.close + d * 86_400 < next.open);
    return { closureId: s.date, bell, close: s.close, open: next.open, kind: saturday ? 'weekend' : 'holiday' };
  }
  return null;
}

export type ScanPosition = { position: string; owner: string; ticker: string; covered: bigint; debt: bigint; lender: 'kamino' };

type ScanFile = { summary: { generatedAt: string }; positions: { obligation: string; owner: string; eligible: boolean; deposits: { symbol: string }[];
  borrows: { symbol: string; tokens: number }[]; coveredValueUsd: number }[] };

/** Single-asset Kamino positions the program covers (the scan's `eligible`), in USDC base units: C′ rounded down, the
 * debt rounded up, as buy_cover rounds them. Values are each obligation's last mainnet refresh. */
export function scanPositions(scan: ScanFile, tickers: string[]): ScanPosition[] {
  return scan.positions
    .filter((p) => p.eligible && p.deposits.length === 1 && tickers.includes(p.deposits[0].symbol) && p.borrows.length === 1 && p.borrows[0].symbol === 'USDC')
    .map((p) => ({ position: p.obligation, owner: p.owner, ticker: p.deposits[0].symbol, lender: 'kamino' as const,
      covered: BigInt(Math.floor(p.coveredValueUsd * 1e6)), debt: BigInt(Math.ceil(p.borrows[0].tokens * 1e6)) }))
    .filter((p) => p.covered > 0n && p.debt > 0n);
}

export function latestScan(root = ROOT): { file: string; scan: ScanFile } | null {
  const dir = join(root, 'data/positions');
  const f = readdirSync(dir).filter((x) => /^positions-\d{8}\.json$/.test(x)).sort().pop();
  return f ? { file: f, scan: JSON.parse(readFileSync(join(dir, f), 'utf8')) as ScanFile } : null;
}

export type Assessment = { id: string; ticker: string; need8: bigint; paysCount: number; n: number; premium: bigint | null; cap: bigint | null; refused?: string; error?: string;
  closureType?: number; days?: number };
/** `closureId`: the session the closure follows; the helper prices that closure as buy_cover would (audit A-117). */
export type Pricing = (items: { id: string; ticker: string; covered: bigint; debt: bigint; closureId?: number }[]) => Promise<Assessment[]>;

/** The program's pricing through keeper/alerts-quote (one process per run). σ_b per asset from the loader's own
 * `basisSigmaFor` (scripts/src/basis.ts) over data/shield-basis.json, as load-onchain sets it on-chain. */
export async function quoteHelper(root = ROOT, equityUsdc = 2_000_000_000_000n): Promise<{ pricing: Pricing; tickers: string[]; close: () => void }> {
  const proc = spawn(join(root, 'keeper/alerts-quote/target/release/alerts_quote'), ['--root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
  // A missing binary (not built), a crash or a closed pipe rejects the pending request instead of an unhandled 'error'
  // event killing the process (audit A-122).
  let failure: Error | null = null;
  const failed = new Promise<never>((_, reject) => {
    const fail = (e: Error) => { failure ??= new Error(`alerts_quote: ${(e as NodeJS.ErrnoException).code ?? e.message} (cargo build --release --manifest-path keeper/alerts-quote/Cargo.toml)`); reject(failure); };
    proc.on('error', fail);
    proc.stdin.on('error', fail);
    proc.on('exit', (code) => fail(new Error(`exited ${code}`)));
  });
  failed.catch(() => {});
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const r = await Promise.race([lines.next(), failed]);
    if (r.done) throw failure ?? new Error('alerts_quote exited');
    return JSON.parse(r.value);
  };
  const ready = (await next()) as { tickers: string[] };
  const assets = JSON.parse(readFileSync(join(root, 'data/onchain/assets.json'), 'utf8')) as { ticker: string; sigmaWad: string }[];
  const sigma = Object.fromEntries(assets.map((a) => [a.ticker, Number(a.sigmaWad) / 1e18]));
  const study = readJson(join(root, 'data/shield-basis.json'), null);
  const basis = (t: string) => BigInt(Math.round(basisSigmaFor(t, study, sigma) * 1e18)).toString();
  const pricing: Pricing = async (items) => {
    if (failure) throw failure;
    proc.stdin.write(`${JSON.stringify({ op: 'assess', equityUsdc: equityUsdc.toString(),
      items: items.map((x) => ({ id: x.id, ticker: x.ticker, covered: x.covered.toString(), debt: x.debt.toString(), basisSigmaWad: basis(x.ticker), closureId: x.closureId })) })}\n`);
    const r = (await next()) as { items?: Record<string, string | number>[]; error?: string };
    if (!r.items) throw new Error(`alerts_quote: ${r.error}`);
    return r.items.map((a) => ({ id: String(a.id), ticker: String(a.ticker ?? ''), need8: BigInt(a.need8 ?? 0), paysCount: Number(a.paysCount ?? 0), n: Number(a.n ?? 0),
      premium: a.premium !== undefined ? BigInt(a.premium) : null, cap: a.cap !== undefined ? BigInt(a.cap) : null,
      refused: a.refused as string | undefined, error: a.error as string | undefined,
      closureType: a.closureType !== undefined ? Number(a.closureType) : undefined, days: a.days !== undefined ? Number(a.days) : undefined }));
  };
  return { pricing, tickers: ready.tickers, close: () => proc.kill() };
}

const usd = (base: bigint) => `$${(Number(base) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (count: number, n: number) => (n ? `${((count / n) * 100).toFixed(count / n < 0.01 ? 2 : 1)}%` : 'n/a');
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

export function protectUrl(appUrl: string, p: Pick<ScanPosition, 'position' | 'lender'>) {
  return `${appUrl.replace(/\/$/, '')}/app/protect?${new URLSearchParams({ position: p.position, lender: p.lender })}`;
}

/** The alert. Every number is the program's; the wording says what is modelled and that it runs on the fork. */
export function alertText(p: ScanPosition, a: Assessment, w: Window, url: string): string {
  const when = w.kind === 'weekend' ? 'this weekend' : 'this holiday closure';
  const monday = w.kind === 'weekend' ? 'Monday' : 'reopening';
  const cost = a.premium !== null ? `gap protection for ${when} costs ${usd(a.premium)} (cap ${usd(a.cap ?? a.need8)}, model vault)` : `gap protection for ${when} is not available for it (${a.refused ?? 'refused'})`;
  return `A −8% ${monday} would need ${usd(a.need8)} to keep your ${p.ticker} position ${short(p.position)} on Kamino healthy; ${cost}. `
    + `Chance of a gap that liquidates it: ${pct(a.paysCount, a.n)}. ${url}\n`
    + 'Credence runs on a local mainnet fork; not live; not insurance.';
}

export type RunDeps = {
  dir: string;
  now: number;
  sessions: Session[];
  positions: ScanPosition[];
  pricing: Pricing;
  transports: Partial<Record<Channel, Transport>>;
  appUrl: string;
  leadSecs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export type RunResult = { window: Window | null; subscribers: number; matched: number; sent: number; skipped: number; failed: number; noTransport: number };

/** One pass of the job, holding the run lock (an overlapping run waits, then finds the ledger written). Never logs a
 * wallet, a chat id, an endpoint or a position. */
export async function runAlerts(d: RunDeps): Promise<RunResult> {
  return withLock(d.dir, () => runLocked(d), '.run.lock', 15 * 60_000, 2_400);
}

async function runLocked(d: RunDeps): Promise<RunResult> {
  const log = d.log ?? ((l: string) => console.log(`${new Date().toISOString().slice(11, 19)} alerts: ${l}`));
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const out: RunResult = { window: null, subscribers: 0, matched: 0, sent: 0, skipped: 0, failed: 0, noTransport: 0 };
  const w = alertWindow(d.sessions, d.now, d.leadSecs ?? 4 * 3600);
  out.window = w;
  if (!w) { log('outside every alert window (the calendar decides): nothing to do'); return out; }
  const subs = readSubscribers(d.dir);
  out.subscribers = subs.length;
  const owners = new Set(subs.map((s) => s.wallet));
  const mine = d.positions.filter((p) => owners.has(p.owner));
  const assessed = new Map((mine.length ? await d.pricing(mine.map((p) => ({ id: p.position, ticker: p.ticker, covered: p.covered, debt: p.debt, closureId: w.closureId }))) : []).map((a) => [a.id, a]));
  const file = ledgerFile(d.dir, w.closureId);
  for (const s of subs) {
    for (const p of mine.filter((x) => x.owner === s.wallet)) {
      const a = assessed.get(p.position);
      if (!a || a.error || a.need8 <= 0n || Number(a.need8) / 1e6 < s.threshold) continue;
      out.matched++;
      const key = ledgerKey(s, p.position);
      const prior = readJson<Ledger>(file, {})[key];
      if (prior?.ok || (prior && prior.attempts >= MAX_ATTEMPTS)) { out.skipped++; continue; }
      const t = d.transports[s.channel];
      if (!t) { out.noTransport++; continue; }
      const url = protectUrl(d.appUrl, p);
      let ok = false, attempts = prior?.attempts ?? 0;
      for (let i = 0; i < 3 && !ok; i++) {
        attempts++;
        try {
          await t.send(s.channelId, alertText(p, a, w, url), url);
          ok = true;
        } catch (e) {
          const te = e instanceof TransportError ? e : null;
          log(`send failed: ${te ? te.message : 'error'}${i < 2 && !te?.permanent ? ', retrying' : ''}`);
          if (te?.permanent) { attempts = MAX_ATTEMPTS; break; }
          if (i < 2) await sleep(1000 * 2 ** i);
        }
      }
      await withLock(d.dir, () => {
        const ledger = readJson<Ledger>(file, {});
        ledger[key] = { at: new Date(d.now * 1000).toISOString(), attempts, ok };
        writeJsonAtomic(file, ledger);
      });
      if (ok) out.sent++; else out.failed++;
    }
  }
  log(`closure ${w.closureId} (${w.kind}): ${out.subscribers} subscribers, ${out.matched} positions over their threshold, ${out.sent} sent, ${out.skipped} already sent, ${out.failed} failed, ${out.noTransport} without a transport`);
  return out;
}

async function main() {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), quiet: true });
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const dry = process.argv.includes('--dry');
  const now = Number(arg('--now') ?? Math.floor(Date.now() / 1000));
  const sessions = (JSON.parse(readFileSync(join(ROOT, 'data/onchain/calendar-XNYS.json'), 'utf8')) as { sessions: Session[] }).sessions;
  const lead = Number(process.env.ALERTS_LEAD_SECS ?? 4 * 3600);
  if (!alertWindow(sessions, now, lead)) { console.log('alerts: outside every alert window (the calendar decides): nothing to do'); return; }
  const scan = latestScan();
  if (!scan) throw new Error('no scan in data/positions (scripts/src/positions.ts writes it)');
  const age = now - Date.parse(scan.scan.summary.generatedAt) / 1000;
  const maxAge = Number(process.env.ALERTS_MAX_SCAN_AGE_SECS ?? 36 * 3600);
  if (age > maxAge) { console.log(`alerts: the scan ${scan.file} is ${(age / 3600).toFixed(1)} h old (max ${maxAge / 3600} h): refresh it first; nothing sent`); return; }
  const transports: Partial<Record<Channel, Transport>> = {};
  if (dry) { transports.telegram = memoryTransport('telegram (mocked)'); transports.webpush = memoryTransport('webpush (mocked)'); }
  else {
    if (process.env.TELEGRAM_BOT_TOKEN) transports.telegram = telegramTransport(process.env.TELEGRAM_BOT_TOKEN);
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      transports.webpush = webPushTransport({ publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: process.env.VAPID_SUBJECT ?? 'mailto:alerts@credence.invalid' });
    }
  }
  // A dry run works on a copy of the subscribers, so its ledger never stops the real run from sending.
  let dir = alertsDir();
  if (dry) {
    const tmp = mkdtempSync(join(tmpdir(), 'credence-alerts-dry-'));
    writeJsonAtomic(join(tmp, 'subscribers.json'), { subscribers: readSubscribers(dir) });
    dir = tmp;
  }
  const helper = await quoteHelper();
  try {
    const r = await runAlerts({ dir, now, sessions, positions: scanPositions(scan.scan, helper.tickers), pricing: helper.pricing, transports,
      appUrl: process.env.ALERTS_APP_URL ?? 'http://localhost:3000', leadSecs: lead });
    if (dry) console.log(`alerts: dry run, ${r.sent} messages recorded by the mocked transport, nothing delivered`);
  } finally {
    helper.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`alerts: ${redact(String((e as Error)?.message ?? e)).split('\n')[0]}`); process.exit(1); });
}
