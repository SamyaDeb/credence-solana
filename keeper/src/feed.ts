// Gap Oracle feed keeper job (C3): creates each asset's `GapFeed` when the keeper wallet is the admin, and cranks
// `update_gap_feed` for every asset (the eight xStocks and the `<T>.J` aliases) every FEED_EVERY_SECS (default 300),
// logging each feed's flags. The crank is permissionless: the program derives or checks every input account, so this
// job only has to pass the same addresses (it cannot supply a price). A missing or stale input is a flag in the feed,
// not a failed transaction.
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { type Chain, SCOPE_PRICES, chainNow, log, pdas, pushAccount, send, tickerStr } from './chain.js';
import { closureTypeAfter } from './jobs.js';

type Pk = InstanceType<typeof web3.PublicKey>;
export type Report = { sent: string[]; failed: string[]; waiting: string[] };

/** `state::feed_flag`. */
export const FEED_FLAGS: Record<string, number> = {
  MISSING_FAIR: 1 << 0, MISSING_LENDER: 1 << 1, NO_CLOSE: 1 << 2, NO_SCENARIOS: 1 << 3, STALE_FAIR: 1 << 4, PAUSED: 1 << 5,
  FAIR_UNVERIFIED: 1 << 6, FAIR_OUTSIDE_CONF: 1 << 7, LENDER_SUSPENDED: 1 << 8,
  LENDER_FROZEN: 1 << 16, LENDER_STALE: 1 << 17, EARNINGS_ASSET: 1 << 18,
};
export const flagNames = (flags: number) => Object.entries(FEED_FLAGS).filter(([, b]) => (flags & b) !== 0).map(([k]) => k);

const SETTLE_WINDOW = 300;
const MIN_UPDATE_SLOTS = Number(process.env.FEED_MIN_SLOTS ?? 150);
const MAX_INPUT_AGE_SECS = Number(process.env.FEED_MAX_INPUT_AGE_SECS ?? 3600);
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());

/** The closure the program describes at `now` (`calendar::feed_closure`): the first whose next open + 5 min is ahead. */
export function feedClosure(sessions: { date: number; open: unknown; close: unknown }[], now: number): { id: number; type: number } | null {
  for (let i = 0; i + 1 < sessions.length; i++) {
    if (n(sessions[i + 1].open as never) + SETTLE_WINDOW > now) return { id: sessions[i].date, type: closureTypeAfter(sessions, i) };
  }
  return null;
}

export async function feedsJob(c: Chain): Promise<Report> {
  const r: Report = { sent: [], failed: [], waiting: [] };
  const every = Number(process.env.FEED_EVERY_SECS ?? 300);
  const now = await chainNow(c);
  const cal = await c.program.account.calendar.fetch(pdas.calendar());
  const sessions = (cal.sessions as { date: number; open: unknown; close: unknown }[]).slice(0, cal.n as number);
  const cl = feedClosure(sessions, now);
  if (!cl) { r.waiting.push('feeds: no closure left in the calendar'); return r; }
  const cfg = await c.program.account.config.fetch(pdas.config());
  const isAdmin = (cfg.admin as Pk).equals(c.payer.publicKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assets = (await c.program.account.assetConfig.all()) as { publicKey: Pk; account: any }[];
  for (const a of assets) {
    const t = tickerStr(a.account.ticker as number[]);
    const feedKey = pdas.feed(t);
    let feed = await c.program.account.gapFeed.fetchNullable(feedKey);
    if (!feed) {
      if (!isAdmin) { r.waiting.push(`${t}: no GapFeed yet (admin must init_gap_feed)`); continue; }
      try {
        const { cu } = await send(c, [await c.program.methods.initGapFeed(a.account.ticker, MIN_UPDATE_SLOTS, MAX_INPUT_AGE_SECS)
          .accountsPartial({ admin: c.payer.publicKey, asset: a.publicKey, feed: feedKey }).instruction()]);
        r.sent.push(`init_gap_feed ${t}`);
        log(`  ok   init_gap_feed ${t} (${cu} CU)`);
        feed = await c.program.account.gapFeed.fetch(feedKey);
      } catch (e) {
        r.failed.push(`init_gap_feed ${t}`);
        log(`  FAIL init_gap_feed ${t}: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
    }
    const age = now - n(feed.lastUpdateTs);
    if (n(feed.updates) > 0 && age >= 0 && age < every) continue;
    const lender = n(a.account.lender) === 1 ? (a.account.lenderOracle as Pk) : SCOPE_PRICES;
    try {
      const { cu } = await send(c, [await c.program.methods.updateGapFeed(a.account.ticker).accountsPartial({
        config: pdas.config(), asset: a.publicKey, calendar: pdas.calendar(), feed: feedKey,
        scenario: pdas.scen(t, cl.type), epoch: pdas.epoch(t, cl.id), fair: pushAccount(a.account.feedXstock as number[]), lender,
      }).instruction()]);
      const f = await c.program.account.gapFeed.fetch(feedKey);
      const fl = flagNames(Number(f.flags));
      r.sent.push(`update_gap_feed ${t}`);
      log(`  ok   update_gap_feed ${t} closure ${cl.id} (${cu} CU) P(gap<-8%)=${(Number(BigInt(f.pLt8Wad.toString()) / 10n ** 10n) / 1e8 * 100).toFixed(3)}%${fl.length ? ' flags: ' + fl.join(',') : ''}`);
    } catch (e) {
      const m = (e as Error).message;
      if (/FeedTooSoon/.test(m)) r.waiting.push(`${t}: rate limited`);
      else { r.failed.push(`update_gap_feed ${t}`); log(`  FAIL update_gap_feed ${t}: ${m.split('\n').slice(0, 3).join(' | ')}`); }
    }
  }
  return r;
}


