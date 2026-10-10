// The Gap Oracle feed (C3): read `GapFeed` accounts, decode their flags, and build `update_gap_feed`.
// A value is 0 when its flag says the input was missing: always test `blocked` / the flags before using a number.
// The probabilities are the program's (risk-core::gap_prob over the asset's scenario set); nothing is computed here.
import { BorshAccountsCoder } from '@anchor-lang/core';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { IDL, type CoreProgram, SCOPE_PRICES, big, camelKeys, pdas, pushAccount, tickerStr, ticker8 } from './core';

/** `state::feed_flag`. Blocking flags mean a number must not be used; informational ones qualify it. */
export const FEED_FLAGS = {
  MISSING_FAIR: 1 << 0, MISSING_LENDER: 1 << 1, NO_CLOSE: 1 << 2, NO_SCENARIOS: 1 << 3, STALE_FAIR: 1 << 4, PAUSED: 1 << 5,
  FAIR_UNVERIFIED: 1 << 6, FAIR_OUTSIDE_CONF: 1 << 7, LENDER_SUSPENDED: 1 << 8,
  LENDER_FROZEN: 1 << 16, LENDER_STALE: 1 << 17, EARNINGS_ASSET: 1 << 18,
} as const;
export const FEED_BLOCKING_MASK = 0xffff;
export const flagNames = (flags: number): string[] => Object.entries(FEED_FLAGS).filter(([, b]) => (flags & b) !== 0).map(([k]) => k);

export const CLOSURE_NAME = ['', 'OVERNIGHT', 'WEEKEND', 'HOLIDAY_WEEKEND'] as const;
const WAD = 10n ** 18n;
const le = (b: ArrayLike<number>, signed = false) => {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return signed && b[b.length - 1] & 0x80 ? v - (1n << BigInt(8 * b.length)) : v;
};

export type GapFeedView = {
  key: PublicKey;
  ticker: string;
  lender: 'kamino' | 'jupiter';
  closureId: number;
  closureType: number;
  closeTs: number;
  nextOpen: number;
  /** Per raw xStock token unit, WAD USD. */
  closePrice: bigint;
  fairPrice: bigint;
  fairPublishTs: number;
  fairConfBps: number;
  lenderPrice: bigint;
  lenderTs: number;
  /** When the lender's price last changed as the cranks saw it; `LENDER_FROZEN` = unchanged for 30 min after the close. */
  lenderSinceTs: number;
  /** fair ÷ close − 1 and lender ÷ close − 1, signed WAD. */
  impliedGapFair: bigint;
  impliedGapLender: bigint;
  sigma: bigint;
  /** P(gap < −5% / −8% / −12%), WAD, rounded up by the program. */
  pLt5: bigint;
  pLt8: bigint;
  pLt12: bigint;
  flags: number;
  flagNames: string[];
  /** True when any blocking flag is set: do not use the numbers. */
  blocked: boolean;
  /** After the close, the lender's price has not changed for 30 minutes (as the cranks saw it). */
  lenderFrozen: boolean;
  updates: number;
  lastUpdateTs: number;
  lastUpdateSlot: number;
  minUpdateSlots: number;
  maxInputAgeSecs: number;
  epochState: number;
  nScenarios: number;
};

const feedCoder = () => new BorshAccountsCoder(IDL);

/** Decodes a `GapFeed` account's data (discriminator checked). */
export function decodeFeed(key: PublicKey, data: Uint8Array): GapFeedView {
  return feedView(key, feedCoder().decode('GapFeed', Buffer.from(data)) as Record<string, unknown>);
}

export function feedView(key: PublicKey, raw: Record<string, unknown>): GapFeedView {
  const f = camelKeys(raw);
  const flags = Number(f.flags);
  const n = (x: unknown) => Number(big(x as never));
  return {
    key,
    ticker: tickerStr(f.ticker as number[]),
    lender: Number(f.lender) === 1 ? 'jupiter' : 'kamino',
    closureId: Number(f.closureId),
    closureType: Number(f.closureType),
    closeTs: n(f.closeTs),
    nextOpen: n(f.nextOpen),
    closePrice: le(f.closePrice as number[]),
    fairPrice: le(f.fairPrice as number[]),
    fairPublishTs: n(f.fairPublishTs),
    fairConfBps: Number(f.fairConfBps),
    lenderPrice: le(f.lenderPrice as number[]),
    lenderTs: n(f.lenderTs),
    lenderSinceTs: n(f.lenderSinceTs),
    impliedGapFair: le(f.impliedGapFair as number[], true),
    impliedGapLender: le(f.impliedGapLender as number[], true),
    sigma: big(f.sigmaWad as never),
    pLt5: big(f.pLt5Wad as never),
    pLt8: big(f.pLt8Wad as never),
    pLt12: big(f.pLt12Wad as never),
    flags,
    flagNames: flagNames(flags),
    blocked: (flags & FEED_BLOCKING_MASK) !== 0,
    lenderFrozen: (flags & FEED_FLAGS.LENDER_FROZEN) !== 0,
    updates: n(f.updates),
    lastUpdateTs: n(f.lastUpdateTs),
    lastUpdateSlot: n(f.lastUpdateSlot),
    minUpdateSlots: Number(f.minUpdateSlots),
    maxInputAgeSecs: Number(f.maxInputAgeSecs),
    epochState: Number(f.epochState),
    nScenarios: Number(f.nScen),
  };
}

/** The feed of one asset, or null when it was not created. */
export async function readFeed(conn: Connection, ticker: string): Promise<GapFeedView | null> {
  const key = pdas.feed(ticker);
  const a = await conn.getAccountInfo(key, 'confirmed');
  return a ? decodeFeed(key, a.data) : null;
}

/** Every feed (the eight xStocks and the Jupiter aliases), by ticker order. */
export async function readFeeds(prog: CoreProgram): Promise<GapFeedView[]> {
  const rows = (await prog.account.gapFeed.all()) as { publicKey: PublicKey; account: Record<string, unknown> }[];
  return rows.map((r) => feedView(r.publicKey, r.account)).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Why a consumer should not use this feed at chain time `now`, or [] when it may. Mirrors programs/gap-consumer. */
export function feedProblems(f: GapFeedView, now: number, maxAgeSecs: number): string[] {
  const out: string[] = [];
  if (f.updates === 0) out.push('never updated');
  if ((f.flags & FEED_BLOCKING_MASK) !== 0) out.push(`blocking flags: ${flagNames(f.flags & FEED_BLOCKING_MASK).join(', ')}`);
  const age = now - f.lastUpdateTs;
  if (age < 0 || age > maxAgeSecs) out.push(`last update ${age}s ago (max ${maxAgeSecs}s)`);
  if (now >= f.nextOpen) out.push('the closure has opened');
  return out;
}

/** WAD fraction → percent string for display ("1.23%"); the math is the program's. */
export const wadPct = (w: bigint, digits = 2) => `${(Number((w * 10n ** BigInt(digits + 4)) / WAD) / 10 ** (digits + 2) * 100).toFixed(digits)}%`;

// ---------------------------------------------------------------------------------------------------------------
// update_gap_feed
// ---------------------------------------------------------------------------------------------------------------

type Session = { date: number; open: unknown; close: unknown };
const num = (x: unknown) => Number(big(x as never));
const SETTLE_WINDOW = 300;
export const CLOSURE = { OVERNIGHT: 1, WEEKEND: 2, HOLIDAY_WEEKEND: 3 } as const;

const yyyymmddDays = (d: number) => Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100) / 86_400_000;
/** The type of the closure after session `i`, as credence-core `calendar::epoch_times` types it. */
export function closureTypeAfter(sessions: { date: number }[], i: number): number {
  const d0 = yyyymmddDays(sessions[i].date);
  const weekday = new Date(d0 * 86_400_000).getUTCDay();
  const gap = yyyymmddDays(sessions[i + 1].date) - d0;
  return weekday === 5 && gap === 3 ? CLOSURE.WEEKEND : weekday + gap > 7 ? CLOSURE.HOLIDAY_WEEKEND : CLOSURE.OVERNIGHT;
}

/** The closure a feed describes at chain time `now` (`calendar::feed_closure`): the first whose next open + 5 minutes
 * is still ahead. `null` when the calendar has none left. */
export function feedClosure(sessions: Session[], now: number): { id: number; type: number } | null {
  for (let i = 0; i + 1 < sessions.length; i++) {
    if (num(sessions[i + 1].open) + SETTLE_WINDOW > now) return { id: sessions[i].date, type: closureTypeAfter(sessions, i) };
  }
  return null;
}

/** The calendar's sessions (for `feedClosure`). */
export async function loadSessions(prog: CoreProgram): Promise<Session[]> {
  const cal = await prog.account.calendar.fetch(pdas.calendar());
  return (cal.sessions as Session[]).slice(0, cal.n as number);
}

/**
 * `update_gap_feed(ticker)`: permissionless; the program derives or checks every input account, so a wrong account
 * fails the instruction instead of changing a price. `asset` is the AssetConfig row; `closure` from `feedClosure`.
 * The feed may be updated at most once per `minUpdateSlots` slots.
 */
export async function updateGapFeed(prog: CoreProgram, a: { ticker: string; asset: PublicKey; tickerBytes?: number[]; feedXstock: number[]; lender?: 'kamino' | 'jupiter';
  lenderOracle?: PublicKey }, closure: { id: number; type: number }): Promise<TransactionInstruction> {
  const lender = a.lender === 'jupiter' ? a.lenderOracle : SCOPE_PRICES;
  if (!lender) throw new Error(`${a.ticker}: a Jupiter alias needs its lenderOracle (the Chainlink cache from its AssetConfig)`);
  return prog.methods.updateGapFeed(a.tickerBytes ?? ticker8(a.ticker)).accountsPartial({
    config: pdas.config(), asset: a.asset, calendar: pdas.calendar(), feed: pdas.feed(a.ticker),
    scenario: pdas.scen(a.ticker, closure.type), epoch: pdas.epoch(a.ticker, closure.id), fair: pushAccount(a.feedXstock), lender,
  }).instruction();
}
