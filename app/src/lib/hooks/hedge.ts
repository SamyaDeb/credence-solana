'use client';
// The hedge book and its caps (lib/hedge.ts), re-read every 15 s. `pending` is Vault.hedge_pending.
import { useQuery } from '@tanstack/react-query';
import { useSolana } from '@/components/app/Providers';
import { loadHedge } from '@/lib/hedge';

export function useHedge(pending: number) {
  const { prog } = useSolana();
  return useQuery({ queryKey: ['hedge', pending], queryFn: () => loadHedge(prog, pending), refetchInterval: 15_000 });
}
