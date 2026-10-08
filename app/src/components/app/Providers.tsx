'use client';
// The app owns its Connection (the fork, or mainnet through /api/rpc in the public read-only mode); wallets only sign. Wallets come from the wallet
// standard (Phantom registers itself, so the adapter list is empty). The demo burner is a local keypair kept in this
// browser's localStorage, for judges without Phantom, and is labelled "demo burner" wherever it appears. Chain reads go
// through react-query; `refresh()` re-reads everything after a transaction.
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { program, type CoreProgram } from '@/lib/credence';
import { IS_MAINNET, clientRpcUrl } from '@/lib/network';
import type { AppSigner } from '@/lib/tx';

export const BURNER_KEY = 'credence.burner.v1';

type Ctx = {
  conn: Connection;
  prog: CoreProgram;
  signer: AppSigner | null;
  burner: Keypair | null;
  connectBurner: () => void;
  dropBurner: () => void;
  /** Re-reads every chain query (after a transaction or a fork step). */
  refresh: () => Promise<void>;
};

const SolanaCtx = createContext<Ctx | null>(null);

export function useSolana(): Ctx {
  const c = useContext(SolanaCtx);
  if (!c) throw new Error('useSolana outside <Providers>');
  return c;
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window: this visit only */ } },
};

function loadBurner(): Keypair | null {
  try {
    const s = store.get(BURNER_KEY);
    return s ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s) as number[])) : null;
  } catch {
    return null;
  }
}

function Inner({ children }: { children: ReactNode }) {
  const conn = useMemo(() => new Connection(clientRpcUrl(), 'confirmed'), []);
  const prog = useMemo(() => program(conn), [conn]);
  const wallet = useWallet();
  const qc = useQueryClient();
  const [burner, setBurner] = useState<Keypair | null>(null);
  const [burnerOn, setBurnerOn] = useState(false);

  useEffect(() => {
    const k = loadBurner();
    if (k) { setBurner(k); setBurnerOn(store.get(`${BURNER_KEY}.on`) === '1'); }
  }, []);

  const connectBurnerCb = useCallback(() => {
    let k = loadBurner();
    if (!k) { k = Keypair.generate(); store.set(BURNER_KEY, JSON.stringify([...k.secretKey])); }
    store.set(`${BURNER_KEY}.on`, '1');
    if (wallet.connected) void wallet.disconnect();
    setBurner(k);
    setBurnerOn(true);
  }, [wallet]);

  const dropBurner = useCallback(() => { store.set(`${BURNER_KEY}.on`, '0'); setBurnerOn(false); }, []);

  // Connecting Phantom switches the burner off.
  useEffect(() => { if (wallet.connected && burnerOn) dropBurner(); }, [wallet.connected, burnerOn, dropBurner]);

  const signer: AppSigner | null = useMemo(() => {
    if (burnerOn && burner && !IS_MAINNET) {
      return { publicKey: burner.publicKey, kind: 'burner', signTransaction: async (tx: Transaction) => { tx.partialSign(burner); return tx; } };
    }
    if (wallet.connected && wallet.publicKey && wallet.signTransaction) {
      const sign = wallet.signTransaction;
      return { publicKey: wallet.publicKey, kind: 'phantom', signTransaction: (tx: Transaction) => sign(tx) };
    }
    return null;
  }, [burnerOn, burner, wallet.connected, wallet.publicKey, wallet.signTransaction]);

  const refresh = useCallback(() => qc.invalidateQueries(), [qc]);
  const value = useMemo(() => ({ conn, prog, signer, burner, connectBurner: connectBurnerCb, dropBurner, refresh }),
    [conn, prog, signer, burner, connectBurnerCb, dropBurner, refresh]);
  return <SolanaCtx.Provider value={value}>{children}</SolanaCtx.Provider>;
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } } }));
  return (
    <QueryClientProvider client={qc}>
      {/* ConnectionProvider only satisfies the adapter's context; the app sends through its own Connection. */}
      <ConnectionProvider endpoint={clientRpcUrl()}>
        <WalletProvider wallets={[]} autoConnect>
          <Inner>{children}</Inner>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
