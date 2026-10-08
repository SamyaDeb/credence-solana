'use client';
// Top bar: navigation, the wallet menu (wallet-standard wallets such as Phantom, or the demo burner) and a status line
// read from the fork every two seconds: wallet, SOL and USDC balances, program id, slot and the chain's own clock.
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PROGRAM_ID, RPC_URL, USDC_MINT, ata, chainNow } from '@/lib/credence';
import { short, usdc, utc } from '@/lib/format';
import { useApp } from './providers';

const TABS = [
  ['/', 'My weekend risk'],
  ['/underwriters', 'Underwriters'],
  ['/oracle', 'Gap Oracle'],
  ['/demo', 'Demo mode'],
] as const;

export function Header() {
  const path = usePathname();
  return (
    <>
      <header className="top">
        <div className="wrap">
          <Link href="/" className="brand"><i />Credence</Link>
          <nav className="tabs">
            {TABS.map(([href, label]) => (
              <Link key={href} href={href} className={path === href ? 'on' : ''}>{label}</Link>
            ))}
          </nav>
          <div className="grow" />
          <WalletMenu />
        </div>
      </header>
      <StatusBar />
    </>
  );
}

function WalletMenu() {
  const { wallets, select, connect, disconnect, connected, wallet } = useWallet();
  const { signer, enableBurner, dropBurner, bump } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed);

  // `select` then `connect` once the adapter is chosen.
  useEffect(() => {
    if (wallet && !connected && busy === 'connecting') connect().catch((e) => setErr(String(e?.message ?? e))).finally(() => setBusy(''));
  }, [wallet, connected, busy, connect]);

  async function fund() {
    if (!signer) return;
    setBusy('funding'); setErr('');
    try {
      const r = await fetch('/api/fork/fund', { method: 'POST', body: JSON.stringify({ owner: signer.publicKey.toBase58() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      bump();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }

  return (
    <div className="menu">
      {signer ? (
        <div className="row">
          {signer.kind === 'burner' && <span className="sim" title="A local keypair in this browser, for judges without Phantom">demo burner wallet</span>}
          <button className="small" onClick={fund} disabled={!!busy} data-testid="fund" title="Fork only: 10 SOL airdrop and 50,000 USDC set by a surfpool cheatcode">
            {busy === 'funding' ? 'Funding…' : 'Fund (fork)'}
          </button>
          <button onClick={() => setOpen(!open)} data-testid="wallet-button">{short(signer.publicKey)}</button>
        </div>
      ) : (
        <button className="primary" onClick={() => setOpen(!open)} data-testid="connect">Connect</button>
      )}
      {open && (
        <div className="drop" onMouseLeave={() => setOpen(false)}>
          {installed.map((w) => (
            <button key={w.adapter.name} onClick={() => { dropBurner(); select(w.adapter.name); setBusy('connecting'); setOpen(false); }}>
              {w.adapter.name}
            </button>
          ))}
          {installed.length === 0 && <div className="note">No wallet-standard wallet found (install Phantom), or use the burner.</div>}
          <button onClick={() => { enableBurner(); setOpen(false); }} data-testid="use-burner">Demo burner wallet (local keypair)</button>
          {signer && (
            <button onClick={() => { if (signer.kind === 'burner') dropBurner(); else void disconnect(); setOpen(false); }}>Disconnect</button>
          )}
          {signer && <div className="note mono">{signer.publicKey.toBase58()}</div>}
        </div>
      )}
      {err && <div className="err" style={{ position: 'absolute', right: 0, top: 46, width: 360 }}>{err}</div>}
    </div>
  );
}

function StatusBar() {
  const { conn, signer, version } = useApp();
  const [s, setS] = useState<{ slot?: number; now?: number; sol?: number; usdc?: bigint | null; err?: string }>({});
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const [slot, now] = await Promise.all([conn.getSlot('confirmed'), chainNow(conn)]);
        let sol: number | undefined; let u: bigint | null | undefined;
        if (signer) {
          sol = (await conn.getBalance(signer.publicKey, 'confirmed')) / 1e9;
          const a = await conn.getTokenAccountBalance(ata(signer.publicKey, USDC_MINT), 'confirmed').catch(() => null);
          u = a ? BigInt(a.value.amount) : null;
        }
        if (live) setS({ slot, now, sol, usdc: u });
      } catch (e) {
        if (live) setS({ err: `fork unreachable at ${RPC_URL}: ${(e as Error).message}` });
      }
    };
    void read();
    const t = setInterval(read, 2000);
    return () => { live = false; clearInterval(t); };
  }, [conn, signer, version]);
  return (
    <div className="statusbar" data-testid="statusbar">
      <div className="wrap">
        {s.err ? <span className="bad">{s.err}</span> : (
          <>
            <span>RPC <b>{RPC_URL.replace(/^https?:\/\//, '')}</b> <span className="sim">local mainnet fork</span></span>
            <span>program <b title={PROGRAM_ID.toBase58()} data-testid="program-id">{short(PROGRAM_ID, 6)}</b></span>
            <span>slot <b data-testid="slot">{s.slot?.toLocaleString('en-US') ?? '…'}</b></span>
            <span>chain time <b data-testid="chain-time">{s.now ? utc(s.now) : '…'}</b></span>
            <div className="grow" />
            {signer && (
              <>
                <span>wallet <b data-testid="wallet">{short(signer.publicKey)}</b></span>
                <span>SOL <b data-testid="sol">{s.sol?.toFixed(4) ?? '…'}</b></span>
                <span>USDC <b data-testid="usdc">{s.usdc === undefined ? '…' : s.usdc === null ? '0.00 (no account)' : usdc(s.usdc)}</b></span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
