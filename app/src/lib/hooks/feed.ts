'use client';
// The Gap Oracle feed (C3) for the Oracle page. On the fork: the `GapFeed` accounts, read with @credence/sdk, one per
// asset (the eight xStocks and the Jupiter aliases that exist). In the public read-only mode there is no feed account
// on mainnet: the same fields are computed off-chain from mainnet inputs by the program's own Rust (examples/gap_feed.rs
// via scripts/src/gap-feed-mainnet.ts) and read from /api/oracle/feed, labelled as such.
import { type GapFeedView, feedClosure, loadSessions, pdas, readFeeds, updateGapFeed } from '@credence/sdk';
import type { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useSolana } from '@/components/app/Providers';
import { IS_MAINNET } from '@/lib/network';

export type FeedRow = Omit<GapFeedView, 'key'> & { key: string };
export type FeedData = { source: 'onchain' | 'offchain'; rows: FeedRow[]; note?: string; computedAt?: number };

type OffchainItem = {
  ticker: string; flags: number; flagNames: string[]; blocked: boolean; sigmaWad: string; nScen: number; pLt5Wad: string; pLt8Wad: string; pLt12Wad: string;
  closePriceWad: string; fairPriceWad: string; fairPublishTs: number; fairConfBps: number; lenderPriceWad: string; lenderTs: number; lenderSinceTs: number;
  impliedGapFairWad: string; impliedGapLenderWad: string;
};
type OffchainDoc = { computedAt: number; closure: { id: number; type: number; closeTs: number; nextOpen: number }; note: string; items: OffchainItem[] };

const toRow = (d: OffchainDoc, i: OffchainItem): FeedRow => ({
  key: `offchain:${i.ticker}`, ticker: i.ticker, lender: i.ticker.endsWith('.J') ? 'jupiter' : 'kamino', closureId: d.closure.id, closureType: d.closure.type,
  closeTs: d.closure.closeTs, nextOpen: d.closure.nextOpen, closePrice: BigInt(i.closePriceWad), fairPrice: BigInt(i.fairPriceWad), fairPublishTs: i.fairPublishTs,
  fairConfBps: i.fairConfBps, lenderPrice: BigInt(i.lenderPriceWad), lenderTs: i.lenderTs, lenderSinceTs: i.lenderSinceTs, impliedGapFair: BigInt(i.impliedGapFairWad), impliedGapLender: BigInt(i.impliedGapLenderWad),
  sigma: BigInt(i.sigmaWad), pLt5: BigInt(i.pLt5Wad), pLt8: BigInt(i.pLt8Wad), pLt12: BigInt(i.pLt12Wad), flags: i.flags, flagNames: i.flagNames, blocked: i.blocked,
  lenderFrozen: i.flagNames.includes('LENDER_FROZEN'), updates: 0, lastUpdateTs: d.computedAt, lastUpdateSlot: 0, minUpdateSlots: 0, maxInputAgeSecs: 3600, epochState: 0, nScenarios: i.nScen,
});

export function useFeeds() {
  const { prog } = useSolana();
  return useQuery<FeedData>({
    queryKey: ['gap-feeds'],
    refetchInterval: 10_000,
    queryFn: async () => {
      if (IS_MAINNET) {
        const r = await fetch('/api/oracle/feed');
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        const d = j as OffchainDoc;
        return { source: 'offchain', rows: d.items.map((i) => toRow(d, i)), note: d.note, computedAt: d.computedAt };
      }
      const feeds = await readFeeds(prog);
      return { source: 'onchain', rows: feeds.map((f) => ({ ...f, key: f.key.toBase58() })) };
    },
  });
}

/** `update_gap_feed` for one feed: permissionless, from the connected (demo) wallet. The program derives or checks every input. */
export async function crankIx(prog: ReturnType<typeof useSolana>['prog'], ticker: string, now: number) {
  const asset = pdas.asset(ticker);
  const [row, sessions] = await Promise.all([prog.account.assetConfig.fetch(asset), loadSessions(prog)]);
  const closure = feedClosure(sessions, now);
  if (!closure) throw new Error('the calendar has no closure left');
  return updateGapFeed(prog, { ticker, asset, feedXstock: row.feedXstock as number[], lender: Number(row.lender) === 1 ? 'jupiter' : 'kamino', lenderOracle: row.lenderOracle as PublicKey }, closure);
}
