'use client';
// The app owns its Connection (the fork, or mainnet through /api/rpc in the public read-only mode); wallets only sign. Any
// Solana wallet can connect: every wallet-standard wallet registers itself (Phantom, Solflare, Backpack, OKX, Coinbase,
// Trust, Magic Eden, …), the adapter adds the Mobile Wallet Adapter on Android, and WalletConnect (any mobile wallet, by
// QR code) is loaded on demand when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set. The demo burner is a local keypair kept
// in this browser's localStorage, for judges without a wallet, and is labelled "demo burner" wherever it appears. Chain
// reads go through react-query; `refresh()` re-reads everything after a transaction.
import { WalletAdapterNetwork, WalletNotReadyError, type Adapter, type WalletError } from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { program, type CoreProgram } from '@/lib/credence';
import { IS_MAINNET, clientRpcUrl } from '@/lib/network';
import { redact } from '@/lib/redact';
import type { AppSigner } from '@/lib/tx';
import { WALLETCONNECT_PROJECT_ID } from '@/lib/wallets';

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
  /** The last error a wallet reported, with when (the connect dialog shows the ones that follow a click). */
  walletError: { message: string; at: number } | null;
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

function Inner({ children, walletError }: { children: ReactNode; walletError: Ctx['walletError'] }) {
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

  // Connecting a wallet switches the burner off.
  useEffect(() => { if (wallet.connected && burnerOn) dropBurner(); }, [wallet.connected, burnerOn, dropBurner]);

  const signer: AppSigner | null = useMemo(() => {
    if (burnerOn && burner && !IS_MAINNET) {
      return { publicKey: burner.publicKey, kind: 'burner', signTransaction: async (tx: Transaction) => { tx.partialSign(burner); return tx; } };
    }
    if (wallet.connected && wallet.publicKey && wallet.signTransaction) {
      const sign = wallet.signTransaction;
      return { publicKey: wallet.publicKey, kind: 'wallet', signTransaction: (tx: Transaction) => sign(tx) };
    }
    return null;
  }, [burnerOn, burner, wallet.connected, wallet.publicKey, wallet.signTransaction]);

  const refresh = useCallback(() => qc.invalidateQueries(), [qc]);
  const value = useMemo(() => ({ conn, prog, signer, burner, connectBurner: connectBurnerCb, dropBurner, refresh, walletError }),
    [conn, prog, signer, burner, connectBurnerCb, dropBurner, refresh, walletError]);
  return <SolanaCtx.Provider value={value}>{children}</SolanaCtx.Provider>;
}

/** WalletConnect pulls in Reown's AppKit (large), so it is imported in the browser only, and only when configured. */
function useWalletConnect(): Adapter[] {
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  useEffect(() => {
    if (!WALLETCONNECT_PROJECT_ID) return;
    let live = true;
    void import('@walletconnect/solana-adapter').then(({ WalletConnectWalletAdapter }) => {
      if (!live) return;
      const { origin } = window.location;
      setAdapters([new WalletConnectWalletAdapter({
        // The fork is a copy of mainnet, so a wallet signs for mainnet either way (the app sends through its own Connection).
        network: WalletAdapterNetwork.Mainnet,
        options: {
          projectId: WALLETCONNECT_PROJECT_ID,
          metadata: { name: 'Credence', description: 'Weekend gap cover for tokenized stocks on Solana', url: origin, icons: [`${origin}/landing/webclip.png`] },
        },
      })]);
    }).catch(() => { /* WalletConnect stays off; the other wallets still work */ });
    return () => { live = false; };
  }, []);
  return adapters;
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } } }));
  const wallets = useWalletConnect();
  const [walletError, setWalletError] = useState<Ctx['walletError']>(null);
  const onError = useCallback((e: WalletError, adapter?: Adapter) => {
    // A wallet that is not installed: send the person to get it (the adapter's default when no handler is given).
    if (e instanceof WalletNotReadyError && adapter) window.open(adapter.url, '_blank', 'noopener');
    const msg = e.message || (e.error as Error | undefined)?.message || e.name;
    setWalletError({ message: redact(msg), at: Date.now() });
  }, []);
  return (
    <QueryClientProvider client={qc}>
      {/* ConnectionProvider only satisfies the adapter's context; the app sends through its own Connection. */}
      <ConnectionProvider endpoint={clientRpcUrl()}>
        <WalletProvider wallets={wallets} autoConnect onError={onError}>
          <Inner walletError={walletError}>{children}</Inner>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
