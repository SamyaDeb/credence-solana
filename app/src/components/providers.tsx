'use client';
// The app owns its Connection to the fork (NEXT_PUBLIC_RPC_URL). Wallets come from the wallet standard (Phantom
// registers itself; no adapter list needed) and are only asked to sign. The demo burner is a local keypair kept in
// this browser's localStorage, for judges without Phantom; it is labelled as such everywhere it appears.
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { RPC_URL, program, type CoreProgram } from '@/lib/credence';
import type { AppSigner } from '@/lib/tx';

const BURNER_KEY = 'credence.burner.v1';

type Ctx = {
  conn: Connection;
  prog: CoreProgram;
  signer: AppSigner | null;
  burner: Keypair | null;
  enableBurner: () => void;
  dropBurner: () => void;
  /** Bumped after every transaction so views re-read the chain. */
  version: number;
  bump: () => void;
};

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside <Providers>');
  return c;
}

function loadBurner(): Keypair | null {
  try {
    const s = localStorage.getItem(BURNER_KEY);
    return s ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s))) : null;
  } catch {
    return null;
  }
}

function Inner({ children }: { children: ReactNode }) {
  const conn = useMemo(() => new Connection(RPC_URL, 'confirmed'), []);
  const prog = useMemo(() => program(conn), [conn]);
  const wallet = useWallet();
  const [burner, setBurner] = useState<Keypair | null>(null);
  const [burnerOn, setBurnerOn] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const k = loadBurner();
    if (k) { setBurner(k); setBurnerOn(localStorage.getItem(`${BURNER_KEY}.on`) === '1'); }
  }, []);

  const enableBurnerCb = useCallback(() => {
    let k = loadBurner();
    if (!k) {
      k = Keypair.generate();
      try { localStorage.setItem(BURNER_KEY, JSON.stringify([...k.secretKey])); } catch { /* private window: session only */ }
    }
    try { localStorage.setItem(`${BURNER_KEY}.on`, '1'); } catch { /* ignore */ }
    if (wallet.connected) void wallet.disconnect();
    setBurner(k);
    setBurnerOn(true);
  }, [wallet]);

  const dropBurner = useCallback(() => {
    try { localStorage.setItem(`${BURNER_KEY}.on`, '0'); } catch { /* ignore */ }
    setBurnerOn(false);
  }, []);

  // Connecting Phantom switches the burner off.
  useEffect(() => { if (wallet.connected && burnerOn) dropBurner(); }, [wallet.connected, burnerOn, dropBurner]);

  const signer: AppSigner | null = useMemo(() => {
    if (burnerOn && burner) {
      return {
        publicKey: burner.publicKey,
        kind: 'burner',
        signTransaction: async (tx: Transaction) => { tx.partialSign(burner); return tx; },
      };
    }
    if (wallet.connected && wallet.publicKey && wallet.signTransaction) {
      const sign = wallet.signTransaction;
      return { publicKey: wallet.publicKey as PublicKey, kind: 'phantom', signTransaction: (tx: Transaction) => sign(tx) };
    }
    return null;
  }, [burnerOn, burner, wallet.connected, wallet.publicKey, wallet.signTransaction]);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ conn, prog, signer, burner, enableBurner: enableBurnerCb, dropBurner, version, bump }),
    [conn, prog, signer, burner, enableBurnerCb, dropBurner, version, bump]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    // ConnectionProvider only satisfies the adapter's context; the app sends through its own Connection.
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={[]} autoConnect>
        <Inner>{children}</Inner>
      </WalletProvider>
    </ConnectionProvider>
  );
}
