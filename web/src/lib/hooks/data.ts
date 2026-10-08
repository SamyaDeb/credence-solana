'use client';
// Reads of the repo's data/ files through the server routes: the Gap Oracle's live recorder readings and captured
// closes (api/data/oracle). The backtest and closure history live with their views.
import { useQuery } from '@tanstack/react-query';

export type OracleData = {
  recorder: { lastEvent: string | null; logUpdated: string | null };
  assets: { sym: string; scope: { price: number; refreshedAt: number; readAt: string; readings: number; since: string; lastChange: { price: number; at: string; ts: number } | null } | null;
    push: { price: number; conf: number; publishTime: number; file: string; recorded: number } | null }[];
  closes: { file: string; group: number; results: { ticker: string; closePriceWad: string; scopeRefreshedAt: number; closeTime: number }[] }[];
  s7: { source: string; generatedAt: string; rows: { weekend: string; sym: string; firstMove: string | null; firstMoveVsOpenHours: number | null; movedOverWeekend: boolean; preMarketMove: number; weekendMoves: number }[] } | null;
};

export function useOracle() {
  return useQuery<OracleData>({
    queryKey: ['oracle'],
    queryFn: async () => { const r = await fetch('/api/data/oracle'); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; },
    refetchInterval: 10_000,
  });
}
