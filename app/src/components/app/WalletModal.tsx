'use client';
// The connect dialog, laid out like the wallet pickers of Solana's production apps. "Detected": every wallet found in
// this browser through the wallet standard, the Mobile Wallet Adapter on Android, and WalletConnect (any mobile wallet,
// by QR code) when it is configured. "More wallets": the well-known wallets that are not here, linking to their download
// page on a desktop, or opening this page inside the wallet app's browser on a phone. The demo burner sits last (fork only).
import { WalletReadyState, type WalletName } from '@solana/wallet-adapter-base';
import { useWallet, type Wallet } from '@solana/wallet-adapter-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IS_MAINNET } from '@/lib/network';
import { isMobileBrowser, missingWallets } from '@/lib/wallets';
import { Icon } from './Icon';
import { useSolana } from './Providers';

const WALLETCONNECT = 'WalletConnect';
/** The adapter's name for the Mobile Wallet Adapter (added on Android by the wallet provider). */
const MWA = 'Mobile Wallet Adapter';

function rowNote(w: Wallet): string {
  if (w.adapter.name === WALLETCONNECT) return 'Scan a QR code with any mobile wallet';
  if (w.adapter.name === MWA) return 'A wallet app on this phone';
  return w.readyState === WalletReadyState.Installed ? 'Detected' : '';
}

function rowLabel(w: Wallet): string {
  return w.adapter.name === MWA ? 'Mobile wallet' : w.adapter.name;
}

/** Wallet errors read as what happened, not as the adapter's class name. */
function friendly(msg: string): string {
  if (/reject|denied|cancel|closed/i.test(msg)) return 'The request was cancelled in the wallet. Try again when you are ready.';
  if (/not ready|not installed|not found/i.test(msg)) return 'That wallet is not available in this browser.';
  return msg;
}

export function WalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { wallets, wallet, select, connect, connected } = useWallet();
  const { connectBurner, dropBurner, walletError } = useSolana();
  const [pending, setPending] = useState<WalletName | null>(null);
  const [clickedAt, setClickedAt] = useState(0);
  const [mobile, setMobile] = useState(false);
  const [here, setHere] = useState({ url: '', origin: '' });

  useEffect(() => {
    setMobile(isMobileBrowser());
    setHere({ url: window.location.href, origin: window.location.origin });
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Connected: the dialog's work is done.
  useEffect(() => { if (connected && open) { setPending(null); onClose(); } }, [connected, open, onClose]);

  const err = walletError && walletError.at >= clickedAt && clickedAt > 0 ? friendly(walletError.message) : '';
  const busy = pending && !err && !connected ? pending : null;

  const detected = useMemo(() => {
    const usable = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
    // Wallets in the browser first, then the phone's own wallet, then WalletConnect.
    const rank = (w: Wallet) => (w.adapter.name === WALLETCONNECT ? 2 : w.adapter.name === MWA ? 1 : 0);
    return usable.sort((a, b) => rank(a) - rank(b));
  }, [wallets]);
  const more = useMemo(() => missingWallets(detected.map((w) => w.adapter.name)), [detected]);

  const choose = (name: WalletName) => {
    setClickedAt(Date.now());
    setPending(name);
    dropBurner();
    // Selecting a wallet makes the provider connect it (autoConnect); a wallet that is already the selected one, from an
    // earlier visit, is connected here. Failures arrive through the provider's onError as `walletError`.
    if (wallet?.adapter.name === name) connect().catch(() => {});
    else select(name);
  };

  return (
    <dialog ref={ref} className="cx-dialog cx-wallet-dialog" aria-label="Connect a wallet" onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <div className="cx-dialog-body">
        <div className="cx-dialog-head">
          <div>
            <h2>Connect a wallet</h2>
            <p>{IS_MAINNET ? 'Read only: connecting shows your own Kamino positions. Nothing is signed.' : 'Use any Solana wallet. Your keys stay in your wallet.'}</p>
          </div>
          <button type="button" className="cx-icon-btn" aria-label="Close" onClick={() => ref.current?.close()}><Icon name="close" size={18} strokeWidth={2} /></button>
        </div>

        {err && <div className="cx-wallet-err" role="alert">{err}</div>}

        {detected.length > 0 && (
          <section className="cx-wallet-sec">
            <div className="cx-wallet-sec-label">{mobile ? 'On this device' : 'Detected'}</div>
            <ul className="cx-wallet-list">
              {detected.map((w) => (
                <li key={w.adapter.name}>
                  <button type="button" className="cx-wallet-row" onClick={() => choose(w.adapter.name)} aria-busy={busy === w.adapter.name}
                    data-testid={`wallet-${w.adapter.name.toLowerCase().replace(/\s+/g, '-')}`}>
                    {w.adapter.icon ? <img src={w.adapter.icon} alt="" width={36} height={36} /> : <span className="cx-wallet-mono" aria-hidden>{w.adapter.name[0]}</span>}
                    <span className="cx-wallet-row-text">
                      <span className="cx-wallet-row-name">{rowLabel(w)}</span>
                      {rowNote(w) && <span className="cx-wallet-row-note">{rowNote(w)}</span>}
                    </span>
                    {busy === w.adapter.name ? <span className="cx-wallet-spin" aria-label="Connecting" /> : <Icon name="chevron" size={18} />}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {detected.length === 0 && (
          <div className="cx-wallet-empty">
            {mobile
              ? 'Phone browsers have no wallet extensions. Open this page in your wallet app below, and it connects there.'
              : 'No Solana wallet was found in this browser. Install one below, then reload this page.'}
          </div>
        )}

        {more.length > 0 && (
          <section className="cx-wallet-sec">
            <div className="cx-wallet-sec-label">{mobile ? 'Open in your wallet app' : 'More wallets'}</div>
            <ul className="cx-wallet-grid">
              {more.map((k) => {
                const href = mobile && k.browse && here.url ? k.browse(here.url, here.origin) : k.install;
                return (
                  <li key={k.name}>
                    <a className="cx-wallet-chip" href={href} target={mobile ? undefined : '_blank'} rel="noopener noreferrer">
                      <span className="cx-wallet-mono" aria-hidden>{k.name[0]}</span>
                      <span className="cx-wallet-chip-name">{k.name}</span>
                      <span className="cx-wallet-chip-act">{mobile && k.browse ? 'Open' : 'Get'}<Icon name="external" size={13} /></span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!IS_MAINNET && (
          <section className="cx-wallet-sec">
            <div className="cx-wallet-sec-label">No wallet?</div>
            <button type="button" className="cx-wallet-row" data-testid="use-burner" onClick={() => { connectBurner(); onClose(); }}>
              <span className="cx-wallet-mono is-burner" aria-hidden><Icon name="flask" size={18} /></span>
              <span className="cx-wallet-row-text">
                <span className="cx-wallet-row-name">Demo burner wallet</span>
                <span className="cx-wallet-row-note">A local keypair kept in this browser. For the local fork only.</span>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          </section>
        )}
      </div>
    </dialog>
  );
}
