'use client';
// Friday alerts, opt-in (C4a.2): the wallet signs a structured message (lib/actions/alerts-message.ts) naming the
// channel and the threshold; the server checks the signature, the domain and a single-use nonce. Telegram: the bot's
// /start gives a link code; web push: this browser's push subscription. Before each weekend's bell the keeper's job
// reads the wallet's positions from the read-only mainnet scan and sends one message per position whose −8% need is over
// the threshold, numbers from the program's pricing, with a link back here.
import { useWallet } from '@solana/wallet-adapter-react';
import { useQuery } from '@tanstack/react-query';
import nacl from 'tweetnacl';
import { useState } from 'react';
import { type AlertMessage, alertMessageText, endpointHash } from '@/lib/actions/alerts-message';
import { useSolana } from '@/components/app/Providers';
import { H, Note, Pill } from '@/components/app/ui';
import { ConnectNote } from '@/components/app/views/shared';

type Config = { telegramBot: string | null; webPush: string | null };

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

export function AlertsCard() {
  const { signer, burner } = useSolana();
  const wallet = useWallet();
  const cfg = useQuery<Config>({ queryKey: ['alerts-config'], queryFn: async () => (await fetch('/api/alerts/config')).json(), staleTime: Infinity });
  const [channel, setChannel] = useState<'telegram' | 'webpush'>('telegram');
  const [code, setCode] = useState('');
  const [threshold, setThreshold] = useState(100);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function signText(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    let sig: Uint8Array;
    if (signer?.kind === 'burner' && burner) sig = nacl.sign.detached(bytes, burner.secretKey);
    else if (wallet.signMessage) sig = await wallet.signMessage(bytes);
    else throw new Error('this wallet cannot sign messages');
    return btoa(String.fromCharCode(...sig));
  }

  async function send(action: 'subscribe' | 'unsubscribe') {
    if (!signer) return;
    setBusy(true); setMsg(null);
    try {
      let ch = action === 'unsubscribe' ? 'all' : '';
      let subscription: PushSubscriptionJSON | undefined;
      if (action === 'subscribe' && channel === 'telegram') {
        if (!/^[A-Z2-7]{8}$/.test(code)) throw new Error('enter the 8-character code the bot sent you');
        ch = `telegram:${code}`;
      } else if (action === 'subscribe') {
        if (!cfg.data?.webPush || !('serviceWorker' in navigator)) throw new Error('web push is not available here');
        await navigator.serviceWorker.register('/alerts-sw.js');
        const reg = await navigator.serviceWorker.ready; // pushManager.subscribe needs an active worker (audit A-129)
        const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(cfg.data.webPush) });
        subscription = sub.toJSON();
        ch = `webpush:${await endpointHash(sub.endpoint)}`;
      }
      const n = await (await fetch('/api/alerts/nonce')).json() as { nonce: string; issuedAt: string; expiresAt: string; error?: string };
      if (n.error) throw new Error(n.error);
      const m: AlertMessage = { domain: window.location.host, wallet: signer.publicKey.toBase58(), action, channel: ch,
        threshold: action === 'subscribe' ? threshold : undefined, nonce: n.nonce, issuedAt: n.issuedAt, expiresAt: n.expiresAt };
      const text = alertMessageText(m);
      const signature = await signText(text);
      const r = await fetch(`/api/alerts/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, signature, wallet: m.wallet, subscription }) });
      const j = await r.json() as { ok?: boolean; error?: string; removed?: number };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setMsg({ ok: true, text: action === 'subscribe' ? `Subscribed: ${channel === 'telegram' ? 'Telegram' : 'this browser'}, positions whose −8% need is $${threshold} or more.` : `Unsubscribed (${j.removed} removed).` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cx-card" data-testid="alerts-card">
      <H right={<Pill tone="soft">opt-in</Pill>}>Friday alerts</H>
      <p className="cx-hint">Before each weekend&apos;s bell, one message per position of yours (from the read-only mainnet scan) whose −8% Monday would need at least your
        threshold to stay healthy, with what gap protection would cost (the program&apos;s pricing, model vault) and a link back to this Blink. The Blink and the purchase run on the
        local mainnet fork; not live. Stored: your wallet, the channel id, the threshold and the date; nothing else.</p>
      {!signer ? <ConnectNote>Connect to subscribe; your wallet signs a message (no transaction).</ConnectNote> : (
        <div className="cx-col" style={{ gap: 10 }}>
          <div className="cx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label><input type="radio" name="ch" checked={channel === 'telegram'} onChange={() => setChannel('telegram')} /> Telegram</label>
            <label><input type="radio" name="ch" checked={channel === 'webpush'} disabled={!cfg.data?.webPush} onChange={() => setChannel('webpush')} /> Web push{cfg.data && !cfg.data.webPush ? ' (not configured)' : ''}</label>
            <label>Threshold $<input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(Math.max(1, Math.min(10_000_000, Number(e.target.value.replace(/\D/g, '')) || 1)))}
              style={{ width: 100 }} data-testid="alerts-threshold" /></label>
          </div>
          {channel === 'telegram' && (
            <div className="cx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="cx-hint">{cfg.data?.telegramBot ? <>Send /start to <a href={`https://t.me/${cfg.data.telegramBot}`} target="_blank" rel="noreferrer">@{cfg.data.telegramBot}</a>, then enter its code:</> : 'Telegram is not configured on this server (TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME). Code:'}</span>
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z2-7]/g, '').slice(0, 8))} placeholder="ABCD2345" style={{ width: 120 }} data-testid="alerts-code" />
            </div>
          )}
          <div className="cx-row" style={{ gap: 8 }}>
            <button type="button" className="cx-btn" disabled={busy} onClick={() => send('subscribe')} data-testid="alerts-subscribe">Sign and subscribe</button>
            <button type="button" className="cx-btn is-ghost" disabled={busy} onClick={() => send('unsubscribe')} data-testid="alerts-unsubscribe">Sign and unsubscribe all</button>
          </div>
        </div>
      )}
      {msg && <Note icon={msg.ok ? 'bell' : 'alert'} tone={msg.ok ? undefined : 'bad'}>{msg.text}</Note>}
    </section>
  );
}
