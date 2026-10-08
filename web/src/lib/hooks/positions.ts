'use client';
// The wallet's Kamino xStocks positions as klend would see them now: every obligation it owns in the two xStocks
// markets, refreshed in a simulation (refresh_reserve ×N + refresh_obligation, nothing sent), with the snapshot
// buy_cover would take (D, C, C′, LT), Phase 1 eligibility and Kamino's Scope price for the collateral. Also the
// wallet's policies.
import { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useSolana } from '@/components/app/Providers';
import { type Asset, type PolicyView, freshenScope, policiesOf, reserveToAsset, scopeChains } from '@/lib/cover';
import { RPC_URL, SCOPE_PRICES, decodeScope } from '@/lib/credence';
import {
  type ObligationState, type ReserveState, borrows, deposits, ineligibility, loadReserves, obligationsOf, simulateRefreshed, snapshot,
} from '@/lib/kamino';
import { useAssets } from './chain';

export type Position = {
  key: PublicKey;
  state: ObligationState;
  /** The obligation after klend's refreshes (simulated); null if the refresh failed (`freshErr`). */
  fresh: ObligationState | null;
  freshErr?: string;
  asset: Asset | undefined;
  reserves: Map<string, ReserveState>;
  /** Why Phase 1 cannot cover it, or null. */
  why: string | null;
  snap: ReturnType<typeof snapshot> | null;
  /** D / C′: liquidation at 1. */
  ratio: number | null;
  scopePrice: number | null;
};

const onFork = /127\.0\.0\.1|localhost/.test(RPC_URL);

export function usePositions(owner: PublicKey | null | undefined) {
  const { conn } = useSolana();
  const assets = useAssets();
  const q = useQuery({
    queryKey: ['positions', owner?.toBase58()],
    enabled: !!owner && !!assets.data,
    queryFn: async () => {
      const byReserve = reserveToAsset(assets.data!);
      const obs = await obligationsOf(conn, owner!);
      const reserves = await loadReserves(conn, obs.flatMap((o) => [...deposits(o.state), ...borrows(o.state)]));
      // FORK ONLY: nothing updates Scope on a fork, so its refresh times are moved to the fork clock first (prices
      // unchanged); after a simulated gap the TWAP may be set to the spot price, and the page says so.
      let twapAligned = false;
      const chains = scopeChains([...reserves.values()]);
      if (onFork && chains.length) twapAligned = (await freshenScope(chains)).pairs.some((p) => p.twapAligned);
      const scope = (await conn.getAccountInfo(SCOPE_PRICES, 'confirmed'))?.data;
      const tickers = new Map([...byReserve].map(([k, v]) => [k, v.ticker]));
      const out: Position[] = [];
      for (const o of obs) {
        const asset = byReserve.get(deposits(o.state)[0]?.toBase58() ?? '');
        let fresh: ObligationState | null = null; let freshErr: string | undefined;
        try { fresh = (await simulateRefreshed(conn, owner!, o.key, o.state, reserves)).state; } catch (e) { freshErr = (e as Error).message; }
        const snap = fresh ? snapshot(fresh) : null;
        out.push({
          key: o.key, state: o.state, fresh, freshErr, asset, reserves, why: ineligibility(o.state, reserves, tickers), snap,
          ratio: snap && snap.coveredValue > 0n ? Number(snap.debt) / Number(snap.coveredValue) : null,
          scopePrice: asset && scope ? decodeScope(scope, asset.scopeChain).price : null,
        });
      }
      out.sort((a, b) => Number((b.snap?.debt ?? 0n) - (a.snap?.debt ?? 0n)));
      return { positions: out, twapAligned };
    },
    refetchInterval: 30_000,
  });
  return { ...q, positions: q.data?.positions, twapAligned: q.data?.twapAligned ?? false };
}

export function usePolicies(owner: PublicKey | null | undefined) {
  const { prog } = useSolana();
  return useQuery<PolicyView[]>({
    queryKey: ['policies', owner?.toBase58()],
    enabled: !!owner,
    queryFn: () => policiesOf(prog, owner!),
    refetchInterval: 15_000,
  });
}
