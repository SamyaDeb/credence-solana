'use client';
// Chain reads every page shares: the fork's clock, the covered assets, the weekends (epochs), the XNYS calendar,
// credence_core's Config and Kamino's Scope prices. Each is a react-query hook keyed by what it reads.
import type { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSolana } from '@/components/app/Providers';
import { loadAssets, loadEpochs } from '@/lib/cover';
import { CLOCK_SYSVAR, SCOPE_PRICES, big, decodeScope, pdas, view } from '@/lib/credence';
import { decodeCalendar } from '@/lib/markets';

/** Unix time of the chain's Clock sysvar (follows surfpool time travel, never the browser's clock), read every 5 s and
 * ticked locally each second in between. `slot` is the Clock's slot. */
export function useClock() {
  const { conn } = useSolana();
  const q = useQuery({
    queryKey: ['clock'],
    queryFn: async () => {
      const a = await conn.getAccountInfo(CLOCK_SYSVAR, 'confirmed');
      if (!a) throw new Error('no Clock sysvar on the fork');
      const v = view(a.data);
      return { slot: Number(v.getBigUint64(0, true)), now: Number(v.getBigInt64(32, true)), readAt: Date.now() };
    },
    refetchInterval: 5_000,
    staleTime: 0,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const d = q.data;
  void tick;
  return { now: d ? d.now + Math.floor((Date.now() - d.readAt) / 1000) : null, slot: d?.slot ?? null, error: q.error as Error | null };
}

export function useAssets() {
  const { prog } = useSolana();
  return useQuery({ queryKey: ['assets'], queryFn: () => loadAssets(prog), staleTime: 60_000 });
}

export function useEpochs() {
  const { prog } = useSolana();
  return useQuery({ queryKey: ['epochs'], queryFn: () => loadEpochs(prog), refetchInterval: 15_000 });
}

export function useCalendar() {
  const { conn } = useSolana();
  return useQuery({
    queryKey: ['calendar'],
    queryFn: async () => {
      const a = await conn.getAccountInfo(pdas.calendar(), 'confirmed');
      if (!a) throw new Error('no XNYS calendar on the fork');
      return decodeCalendar(a.data);
    },
    staleTime: Infinity,
  });
}

export type ConfigView = { keeper: PublicKey; uMaxWad: bigint; minPremium: bigint; feeBps: number; paused: boolean; thetaWad: bigint; costOfCapWad: bigint; etaWad: bigint; betaWad: bigint; maxAssetShareWad: bigint };

export function useConfig() {
  const { prog } = useSolana();
  return useQuery({
    queryKey: ['config'],
    queryFn: async (): Promise<ConfigView> => {
      const c = await prog.account.config.fetch(pdas.config(), 'confirmed');
      return { keeper: c.keeper as PublicKey, uMaxWad: big(c.uMaxWad), minPremium: big(c.minPremium), feeBps: c.feeBps, paused: c.paused, thetaWad: big(c.thetaWad),
        costOfCapWad: big(c.costOfCapWad), etaWad: big(c.etaWad), betaWad: big(c.betaWad), maxAssetShareWad: big(c.maxAssetShareWad) };
    },
    staleTime: 60_000,
  });
}

/** Kamino's Scope prices for the given chains, as the fork holds them (cloned from mainnet; demo mode moves them). */
export function useScope(chains: number[]) {
  const { conn } = useSolana();
  return useQuery({
    queryKey: ['scope', chains],
    enabled: chains.length > 0,
    queryFn: async () => {
      const a = await conn.getAccountInfo(SCOPE_PRICES, 'confirmed');
      if (!a) throw new Error("Kamino's Scope account is not on the fork");
      return Object.fromEntries(chains.map((c) => [c, decodeScope(a.data, c)]));
    },
    refetchInterval: 15_000,
  });
}
