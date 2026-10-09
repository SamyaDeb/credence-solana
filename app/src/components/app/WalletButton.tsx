'use client';
// The wallet pill in the top bar (ink pill, Outfit, 16 px radius). Not connected: "Connect wallet" opens a menu with the
// wallet-standard wallets found in this browser (Phantom and others) and the demo burner. Connected: the address, with
// "demo burner" beside it when the burner signs; the menu copies the address or disconnects.
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useEffect, useRef, useState } from 'react';
import { short } from '@/lib/format';
import { IS_MAINNET } from '@/lib/network';
import { redact } from '@/lib/redact';
import { Icon } from './Icon';
import { useSolana } from './Providers';

export function WalletButton() {
  const { wallets, select, connect, disconnect, connected, connecting, wallet } = useWallet();
  const { signer, connectBurner, dropBurner } = useSolana();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState('');
  const [mounted, setMounted] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed);

  useEffect(() => setMounted(true), []);
  // `select` takes effect on the next render; connect once the adapter is chosen.
  useEffect(() => {
    if (!pending || !wallet || connected || connecting) return;
    connect().catch((e: Error) => setErr(redact(e.message ?? String(e)))).finally(() => setPending(false));
  }, [pending, wallet, connected, connecting, connect]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  if (!mounted) return <span className="cx-wallet" aria-hidden style={{ visibility: 'hidden' }} />;

  return (
    <div className="cx-wallet-box" ref={box}>
      {signer ? (
        <span className="cx-wallet-group">
          {signer.kind === 'burner' && <span className="cx-sim" title="A local keypair kept in this browser, for visitors without a wallet extension">demo burner</span>}
          <button type="button" className="cx-wallet" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="wallet-button">
            <Icon name="wallet" size={17} strokeWidth={1.9} />
            <span data-testid="wallet">{short(signer.publicKey)}</span>
          </button>
        </span>
      ) : (
        <button type="button" className="cx-wallet" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="connect">
          <Icon name="lock" size={17} strokeWidth={1.9} />
          <span className="cx-wallet-long">{pending ? 'Connecting…' : 'Connect wallet'}</span>
          <span className="cx-wallet-short">Connect</span>
        </button>
      )}
      {open && (
        <div className="cx-menu" role="menu">
          {!signer && (
            <>
              <div className="cx-menu-label">Wallets in this browser</div>
              {installed.map((w) => (
                <button key={w.adapter.name} role="menuitem" type="button" onClick={() => { setErr(''); dropBurner(); select(w.adapter.name); setPending(true); setOpen(false); }}>
                  {w.adapter.icon && <img src={w.adapter.icon} alt="" width={20} height={20} />}{w.adapter.name}
                </button>
              ))}
              {installed.length === 0 && <div className="cx-menu-note">No wallet-standard wallet found. Install Phantom, or use the demo burner.</div>}
              {IS_MAINNET ? <div className="cx-menu-note">Read only: connecting shows your own Kamino positions; nothing is signed.</div> : (
                <>
                  <div className="cx-menu-sep" />
                  <button role="menuitem" type="button" onClick={() => { setErr(''); connectBurner(); setOpen(false); }} data-testid="use-burner">
                    <Icon name="flask" size={18} />Demo burner wallet
                  </button>
                  <div className="cx-menu-note">A local keypair kept in this browser&apos;s storage. For the local fork only.</div>
                </>
              )}
            </>
          )}
          {signer && (
            <>
              <div className="cx-menu-label">{signer.kind === 'burner' ? 'Demo burner (local keypair)' : wallet?.adapter.name ?? 'Wallet'}</div>
              <div className="cx-menu-note cx-mono">{signer.publicKey.toBase58()}</div>
              <button role="menuitem" type="button" onClick={() => { void navigator.clipboard?.writeText(signer.publicKey.toBase58()); setOpen(false); }}>
                <Icon name="copy" size={18} />Copy address
              </button>
              <button role="menuitem" type="button" data-testid="disconnect" onClick={() => { if (signer.kind === 'burner') dropBurner(); else void disconnect(); setOpen(false); }}>
                <Icon name="logout" size={18} />Disconnect
              </button>
            </>
          )}
        </div>
      )}
      {err && <div className="cx-menu cx-error" role="alert" onClick={() => setErr('')}>{err}</div>}
    </div>
  );
}
