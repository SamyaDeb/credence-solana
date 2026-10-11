'use client';
// The wallet pill in the top bar (ink pill, Outfit, 16 px radius). Not connected: "Connect wallet" opens the connect
// dialog (WalletModal: any Solana wallet, WalletConnect, phone wallets, the demo burner). Connected: the address, with
// "demo burner" beside it when the burner signs; the menu copies the address, changes wallet or disconnects.
import { useWallet } from '@solana/wallet-adapter-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { short } from '@/lib/format';
import { Icon } from './Icon';
import { useSolana } from './Providers';
import { WalletModal } from './WalletModal';

export function WalletButton() {
  const { disconnect, connecting, wallet } = useWallet();
  const { signer, dropBurner } = useSolana();
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [mounted, setMounted] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const closeDialog = useCallback(() => setDialog(false), []);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [menu]);

  if (!mounted) return <span className="cx-wallet" aria-hidden style={{ visibility: 'hidden' }} />;

  const leave = async () => { if (signer?.kind === 'burner') dropBurner(); else await disconnect().catch(() => {}); };

  return (
    <div className="cx-wallet-box" ref={box}>
      {signer ? (
        <span className="cx-wallet-group">
          {signer.kind === 'burner' && <span className="cx-sim" title="A local keypair kept in this browser, for judges without a wallet">demo burner</span>}
          <button type="button" className="cx-wallet" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-haspopup="menu" data-testid="wallet-button">
            {signer.kind === 'wallet' && wallet?.adapter.icon ? <img src={wallet.adapter.icon} alt="" width={20} height={20} /> : <Icon name="wallet" size={17} strokeWidth={1.9} />}
            <span data-testid="wallet">{short(signer.publicKey)}</span>
          </button>
        </span>
      ) : (
        <button type="button" className="cx-wallet" onClick={() => setDialog(true)} aria-haspopup="dialog" data-testid="connect">
          <Icon name="lock" size={17} strokeWidth={1.9} />
          <span className="cx-wallet-long">{connecting ? 'Connecting…' : 'Connect wallet'}</span>
          <span className="cx-wallet-short">{connecting ? '…' : 'Connect'}</span>
        </button>
      )}
      {menu && signer && (
        <div className="cx-menu" role="menu">
          <div className="cx-menu-label">{signer.kind === 'burner' ? 'Demo burner (local keypair)' : wallet?.adapter.name ?? 'Wallet'}</div>
          <div className="cx-menu-note cx-mono">{signer.publicKey.toBase58()}</div>
          <button role="menuitem" type="button" onClick={() => { void navigator.clipboard?.writeText(signer.publicKey.toBase58()); setMenu(false); }}>
            <Icon name="copy" size={18} />Copy address
          </button>
          <button role="menuitem" type="button" onClick={() => { setMenu(false); void leave().then(() => setDialog(true)); }}>
            <Icon name="wallet" size={18} />Change wallet
          </button>
          <button role="menuitem" type="button" data-testid="disconnect" onClick={() => { void leave(); setMenu(false); }}>
            <Icon name="logout" size={18} />Disconnect
          </button>
        </div>
      )}
      <WalletModal open={dialog} onClose={closeDialog} />
    </div>
  );
}
