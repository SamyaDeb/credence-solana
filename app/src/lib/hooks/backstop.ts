'use client';
// The Monday Backstop's pool and inventories (lib/backstop.ts), re-read every 10 s.
import { useQuery } from '@tanstack/react-query';
import { useSolana } from '@/components/app/Providers';
import { loadBackstop } from '@/lib/backstop';

export function useBackstop() {
  const { conn, prog } = useSolana();
  return useQuery({ queryKey: ['backstop'], queryFn: () => loadBackstop(conn, prog), refetchInterval: 10_000 });
}
