'use client';
// The Markets page's data: per covered xStock, its Kamino reserve and the xStocks Market's USDC reserve (klend, on the
// fork), Kamino's Scope price, σ and the modelled 1st-percentile weekend gap (AssetConfig + ScenarioSet), and the
// premium of the reference position from the program's own quote_cover (simulated, nothing sent).
import { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useSolana } from '@/components/app/Providers';
import { type Asset, type EpochView, type Quote, currentEpoch, simulateQuote } from '@/lib/cover';
import { loadReserves } from '@/lib/kamino';
import { REF_DEBT, XSTOCKS_USDC_RESERVE, refCovered, reserveFigures, tailGap, type ReserveFigures } from '@/lib/markets';
import { IS_MAINNET } from '@/lib/network';
import { loadScenarioZ } from '@/lib/odds';
import { useAssets, useConfig, useEpochs, useScope } from './chain';

export type Market = {
  asset: Asset;
  reserve: PublicKey;
  figures: ReserveFigures | null;
  scopePrice: number | null;
  scopeRefreshedAt: number | null;
  sigma: number;
  tail99: number | null;
  scenarios: number;
};

/** Reserves of the covered assets (xStocks Market) and the market's USDC reserve. */
export function useReserves(assets: Asset[] | undefined) {
  const { conn } = useSolana();
  const keys = (assets ?? []).map((a) => a.reserves[0]).filter((r) => r && r !== PublicKey.default.toBase58());
  return useQuery({
    queryKey: ['reserves', keys],
    enabled: keys.length > 0,
    queryFn: () => loadReserves(conn, [...keys.map((k) => new PublicKey(k)), XSTOCKS_USDC_RESERVE]),
    refetchInterval: 30_000,
  });
}

export function useScenarioZ(assets: Asset[] | undefined) {
  const { conn } = useSolana();
  return useQuery({
    queryKey: ['scenarios', (assets ?? []).map((a) => a.ticker)],
    enabled: !!assets?.length,
    queryFn: async () => Object.fromEntries(await Promise.all(assets!.map(async (a) => {
      if (!IS_MAINNET) return [a.ticker, await loadScenarioZ(conn, a.ticker)] as const;
      const r = await fetch(`/api/data/onchain?what=scenarios&ticker=${a.ticker}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      return [a.ticker, Int16Array.from(j.z as number[])] as const;
    }))),
    staleTime: Infinity,
  });
}

export function useMarkets() {
  const assets = useAssets();
  const reserves = useReserves(assets.data);
  const scope = useScope((assets.data ?? []).map((a) => a.scopeChain));
  const z = useScenarioZ(assets.data);
  const markets: Market[] = (assets.data ?? []).map((a) => {
    const r = reserves.data?.get(a.reserves[0]);
    const s = scope.data?.[a.scopeChain];
    const zs = z.data?.[a.ticker];
    return {
      asset: a, reserve: new PublicKey(a.reserves[0]), figures: r ? reserveFigures(r) : null,
      scopePrice: s?.price ?? null, scopeRefreshedAt: s?.unixTimestamp ?? null,
      sigma: Number(a.sigmaWad) / 1e18, tail99: zs ? tailGap(zs, a.sigmaWad, 0.01) : null, scenarios: zs?.length ?? 0,
    };
  });
  const usdcRaw = reserves.data?.get(XSTOCKS_USDC_RESERVE.toBase58());
  return {
    markets, usdc: usdcRaw ? reserveFigures(usdcRaw) : null,
    isLoading: assets.isLoading || reserves.isLoading, error: (assets.error ?? reserves.error ?? scope.error ?? z.error) as Error | null,
  };
}

/** quote_cover for the reference position ($50,000 debt at D/C′ 0.96, cap = debt) on each asset's current weekend, in
 * a simulation. Null for an asset with no weekend on sale. The keeper wallet (funded on the fork) pays the simulated
 * fee, so the quote shows before any wallet is connected. */
export function useRefQuotes(assets: Asset[] | undefined, epochs: EpochView[] | undefined, now: number | null) {
  const { conn, prog } = useSolana();
  const cfg = useConfig();
  const live = (assets ?? []).map((a) => [a, now === null ? undefined : currentEpoch(epochs ?? [], a.ticker, now)] as const);
  const groups = live.map(([a, e]) => `${a.ticker}:${e?.closureId ?? '-'}`);
  return useQuery({
    queryKey: ['ref-quotes', groups],
    enabled: !IS_MAINNET && !!assets?.length && !!epochs && now !== null && !!cfg.data,
    queryFn: async () => {
      const payer = cfg.data!.keeper;
      const out: Record<string, (Quote & { closureId: number }) | { error: string } | null> = {};
      for (const [a, e] of live) {
        if (!e) { out[a.ticker] = null; continue; }
        try { out[a.ticker] = { ...(await simulateQuote(conn, prog, payer, a, e.closureId, refCovered(), REF_DEBT, REF_DEBT)), closureId: e.closureId }; }
        catch (err) { out[a.ticker] = { error: (err as Error).message }; }
      }
      return out;
    },
    refetchInterval: 60_000,
  });
}

export { useEpochs };
