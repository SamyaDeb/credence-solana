'use client';
// Protect my position, as a Blink (C4a.1): the app's own Action (/api/actions/protect) rendered with Dialect's Blink
// client (@dialectlabs/blinks), so a judge sees the Blink flow without a mainnet wallet. The Blink's adapter signs with
// the app's signer (demo burner or Phantom) and sends to the local mainnet fork; the Action's chain id is the fork's,
// which mainnet blink clients refuse. Nothing here is live.
import '@dialectlabs/blinks/index.css';
import { Blink, useAction } from '@dialectlabs/blinks';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { type SentTx, forkBlinkAdapter } from '@/lib/actions/blink-adapter';
import { POLICY_NAME } from '@/lib/credence';
import { short, usdc } from '@/lib/format';
import { usePolicies } from '@/lib/hooks/positions';
import { obligationsOf } from '@/lib/kamino';
import { IS_MAINNET, READ_ONLY_NOTE } from '@/lib/network';
import { useSolana } from '@/components/app/Providers';
import { H, KV, Note, PageHead, Pill } from '@/components/app/ui';
import { ConnectNote } from '@/components/app/views/shared';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function ProtectView() {
  const params = useSearchParams();
  const router = useRouter();
  const { conn, signer } = useSolana();
  const position = params.get('position');
  const lender = params.get('lender') === 'jupiter' ? 'jupiter' : 'kamino';
  const valid = !!position && BASE58.test(position);
  const [sent, setSent] = useState<SentTx[]>([]);
  const policies = usePolicies(signer?.publicKey);
  const mine = useQuery({
    queryKey: ['protect-obligations', signer?.publicKey.toBase58()],
    enabled: !!signer && !IS_MAINNET,
    queryFn: () => obligationsOf(conn, signer!.publicKey),
  });

  const open = (p: string, l: string) => router.push(`/app/protect?${new URLSearchParams({ position: p, lender: l })}`);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    open(String(f.get('position') ?? '').trim(), String(f.get('lender') ?? 'kamino'));
  };

  return (
    <>
      <PageHead title="Protect my position" sub="A Solana Action, shown as a Blink. Gap protection for this weekend on a Kamino or Jupiter Lend position, bought in one signature."
        right={<Pill tone="warn" testId="blink-fork-label">fork · not live</Pill>} />
      <Note icon="alert" tone="warn">
        This Blink runs against the <b>local mainnet fork</b> (scripts/demo-app.sh): its transactions are built for the fork and sent to it by this app.
        Not live, not insurance. Mainnet blink clients refuse it: the Action declares the fork&apos;s chain id (<code>solana:credence-local-fork</code>), never mainnet&apos;s.
      </Note>
      {IS_MAINNET ? <Note icon="lock">{READ_ONLY_NOTE}</Note> : (
        <>
          <section className="cx-card">
            <H>Position</H>
            <form onSubmit={onSubmit} className="cx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input name="position" defaultValue={position ?? ''} placeholder="Kamino obligation or Jupiter Lend position address" aria-label="position"
                style={{ flex: '1 1 360px' }} data-testid="protect-position" />
              <select name="lender" defaultValue={lender} aria-label="lender" data-testid="protect-lender">
                <option value="kamino">Kamino</option>
                <option value="jupiter">Jupiter Lend</option>
              </select>
              <button type="submit" className="cx-btn" data-testid="protect-open">Open the Blink</button>
            </form>
            {!signer ? <ConnectNote>Connect to list your Kamino positions and to sign.</ConnectNote> : (mine.data?.length ?? 0) > 0 && (
              <div className="cx-row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                {mine.data!.map((o) => (
                  <button key={o.key.toBase58()} type="button" className="cx-btn is-ghost" onClick={() => open(o.key.toBase58(), 'kamino')} data-testid="protect-mine">
                    Kamino {short(o.key, 6)}
                  </button>
                ))}
              </div>
            )}
          </section>
          {valid && <BlinkCard key={`${position}-${lender}-${signer?.publicKey.toBase58() ?? ''}`} position={position!} lender={lender} onSent={(s) => { setSent((x) => [s, ...x]); void policies.refetch(); }} />}
          {position && !valid && <Note icon="alert" tone="bad">Not a base58 address.</Note>}
          {sent.length > 0 && (
            <section className="cx-card" data-testid="protect-sent">
              <H>Sent to the fork</H>
              <KV rows={sent.map((s) => [<span key={s.signature} className="cx-mono">{short(s.signature, 10)}</span>, `${s.cu.toLocaleString('en-US')} CU`])} />
            </section>
          )}
          {signer && (policies.data?.length ?? 0) > 0 && (
            <section className="cx-card" data-testid="protect-policies">
              <H>Your policies (fork)</H>
              <KV rows={policies.data!.slice(0, 6).map((p) => [
                <span key={p.key.toBase58()}>{p.ticker} · {short(p.obligation, 6)}</span>,
                <span key="v" data-testid="protect-policy">cap {usdc(p.maxPayout)} · premium {usdc(p.premium)} USDC · {POLICY_NAME[p.state] ?? p.state}</span>,
              ])} />
            </section>
          )}
        </>
      )}
    </>
  );
}

function BlinkCard({ position, lender, onSent }: { position: string; lender: string; onSent: (s: SentTx) => void }) {
  const { conn, signer } = useSolana();
  const sentRef = useRef(onSent);
  sentRef.current = onSent;
  const url = useMemo(() => `solana-action:${window.location.origin}/api/actions/protect?${new URLSearchParams({ position, lender })}`, [position, lender]);
  const { blink, isLoading } = useAction({ url });
  const adapter = useMemo(() => forkBlinkAdapter(conn, signer, (s) => sentRef.current(s)), [conn, signer]);
  // The Blink client drops a failed Action silently; read the Action's own `{ message }` to say why.
  const why = useQuery({
    queryKey: ['protect-why', position, lender],
    enabled: !isLoading && !blink,
    queryFn: async () => ((await (await fetch(`/api/actions/protect?${new URLSearchParams({ position, lender })}`)).json()) as { message?: string }).message ?? null,
  });
  return (
    <section className="cx-card" data-testid="protect-blink">
      <H right={<Pill tone="warn">fork</Pill>}>Blink</H>
      {isLoading ? <p className="cx-page-sub" style={{ margin: 0 }}>Loading the Action (a quote is simulated on the fork)…</p>
        : !blink ? <Note icon="alert" tone="bad">The Action did not load{why.data ? `: ${why.data}` : '.'}</Note>
        : <div style={{ maxWidth: 520 }}><Blink blink={blink} adapter={adapter} securityLevel="all" stylePreset="default" websiteText="Credence (local fork)" /></div>}
    </section>
  );
}
