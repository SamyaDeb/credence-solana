'use client';
// The underwriter vault (every figure a stored field or a stated function of them, lib/vault.ts) and the wallet's LP
// position: shares, USDC and queued requests.
import type { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useSolana } from '@/components/app/Providers';
import { USDC_MINT, ata, pdas } from '@/lib/credence';
import { loadVault, ticketsOf } from '@/lib/vault';

export function useVault() {
  const { conn, prog } = useSolana();
  return useQuery({ queryKey: ['vault'], queryFn: () => loadVault(conn, prog), refetchInterval: 15_000 });
}

const balance = (p: Promise<{ value: { amount: string } }>) => p.then((x) => BigInt(x.value.amount)).catch(() => null);

/** The wallet's LP shares and USDC (null: no token account yet). */
export function useLpPosition(owner: PublicKey | null | undefined) {
  const { conn } = useSolana();
  return useQuery({
    queryKey: ['lp', owner?.toBase58()],
    enabled: !!owner,
    queryFn: async () => {
      const [shares, usdc] = await Promise.all([
        balance(conn.getTokenAccountBalance(ata(owner!, pdas.shares()), 'confirmed')),
        balance(conn.getTokenAccountBalance(ata(owner!, USDC_MINT), 'confirmed')),
      ]);
      return { shares, usdc };
    },
    refetchInterval: 15_000,
  });
}

export function useQueue(owner: PublicKey | null | undefined) {
  const { prog } = useSolana();
  return useQuery({ queryKey: ['queue', owner?.toBase58()], enabled: !!owner, queryFn: () => ticketsOf(prog, owner!), refetchInterval: 15_000 });
}

/** SOL and USDC of a wallet (null: no USDC account). */
export function useBalances(owner: PublicKey | null | undefined) {
  const { conn } = useSolana();
  return useQuery({
    queryKey: ['balances', owner?.toBase58()],
    enabled: !!owner,
    queryFn: async () => ({
      sol: (await conn.getBalance(owner!, 'confirmed')) / 1e9,
      usdc: await balance(conn.getTokenAccountBalance(ata(owner!, USDC_MINT), 'confirmed')),
    }),
    refetchInterval: 10_000,
  });
}

/** A wallet's balance of a mint in its associated token account (base units; null: no account). */
export function useTokenBalance(owner: PublicKey | null | undefined, mint: PublicKey | null | undefined, tokenProgram?: PublicKey) {
  const { conn } = useSolana();
  return useQuery({
    queryKey: ['token', owner?.toBase58(), mint?.toBase58()],
    enabled: !!owner && !!mint,
    queryFn: () => balance(conn.getTokenAccountBalance(ata(owner!, mint!, tokenProgram), 'confirmed')),
    refetchInterval: 10_000,
  });
}
