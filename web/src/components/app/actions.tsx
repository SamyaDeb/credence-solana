'use client';
// Action tiles and their dialogs: a tile in the dashboard style opens a dialog with amount fields, a preview read from
// the chain and one confirm button. The dialog sends through useSend and lists every transaction with its signature
// and compute units, or the decoded, redacted error.
import { useRef, useState, type ReactNode } from 'react';
import { type Sent, type SendState } from '@/lib/hooks/send';
import { Icon } from './Icon';
import { useSolana } from './Providers';

/** A decimal input as base units with `decimals`, or a readable error. */
export function units(v: string | undefined, decimals: number, what = 'an amount'): bigint {
  const s = (v ?? '').trim().replace(/,/g, '');
  if (!s || !/^\d*\.?\d*$/.test(s) || s === '.') throw new Error(`Enter ${what}.`);
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error(`At most ${decimals} decimals.`);
  const u = BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (u <= 0n) throw new Error(`Enter ${what} above zero.`);
  return u;
}

/** Base units as a plain input value (no grouping), rounded down to `dp`. */
export function plain(base: bigint, decimals: number, dp = decimals): string {
  const f = 10n ** BigInt(decimals - Math.min(dp, decimals));
  const x = base / f;
  const d = Math.min(dp, decimals);
  const s = x.toString().padStart(d + 1, '0');
  return d ? `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, '') : s;
}

export function SentList({ sent, testId = 'sent' }: { sent: Sent[]; testId?: string }) {
  if (!sent.length) return null;
  return (
    <ul className="cx-sent" data-testid={testId}>
      {sent.map((s) => (
        <li key={s.signature}>
          <span className="cx-sent-label">{s.label}</span>
          <span className="cx-mono" data-testid="signature" title={s.signature}>{s.signature}</span>
          <span className="cx-sent-cu" data-testid="cu">{s.cu.toLocaleString('en-US')} CU</span>
        </li>
      ))}
    </ul>
  );
}

export function SendStatus({ s, done, testId }: { s: SendState; done?: ReactNode; testId?: string }) {
  return (
    <>
      {s.busy && <p className="cx-hint" role="status">{s.busy}…</p>}
      {s.error && <p className="cx-hint is-bad" role="alert" data-testid={testId ? `${testId}-error` : 'tx-error'}>{s.error}</p>}
      {!s.busy && !s.error && s.sent.length > 0 && done && <p className="cx-hint is-good" role="status">{done}</p>}
      <SentList sent={s.sent} testId={testId ? `${testId}-sent` : 'sent'} />
    </>
  );
}

export type Field = { key: string; unit: string; label?: string; initial?: string; quick?: { label: string; value: string }[] };

export type Spec = {
  icon: string;
  title: string;
  sub: ReactNode;
  amount: ReactNode;
  testId?: string;
  /** Marks a fork-only action on the tile. */
  fork?: boolean;
  dialog: {
    title: string;
    description: ReactNode;
    fields?: Field[];
    preview?: (v: Record<string, string>) => [string, ReactNode][];
    confirm: string;
    blocked?: string | null;
    hint?: ReactNode;
    /** Runs the action (through useSend); returns true when it went through. */
    send: (v: Record<string, string>) => Promise<boolean>;
    state: SendState;
    /** Free content under the fields (the cover panel uses it). */
    body?: ReactNode;
  };
};

export function ActionTile({ spec }: { spec: Spec }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { signer } = useSolana();
  const d = spec.dialog;
  const init = () => Object.fromEntries((d.fields ?? []).map((f) => [f.key, f.initial ?? '']));
  const [values, setValues] = useState<Record<string, string>>(init);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const open = () => { setValues(init()); setInvalid(null); setOk(false); ref.current?.showModal(); };
  const go = async () => {
    if (d.state.busy || d.blocked) return;
    setInvalid(null); setOk(false);
    try { setOk(await d.send(values)); } catch (e) { setInvalid((e as Error).message); }
  };
  let preview: [string, ReactNode][] = [];
  try { preview = d.preview?.(values) ?? []; } catch { preview = []; }

  return (
    <>
      <button type="button" className="cx-tile" onClick={open} data-testid={spec.testId}>
        <span className="cx-tile-icon"><Icon name={spec.icon} size={24} strokeWidth={1.9} /></span>
        <span className="cx-tile-title">{spec.title}{spec.fork && <span className="cx-fork-dot" title="fork only">fork</span>}</span>
        <span className="cx-tile-sub">{spec.sub}</span>
        <span className="cx-tile-amount">{spec.amount}</span>
      </button>
      <dialog ref={ref} className="cx-dialog" aria-label={d.title} onClick={(e) => e.target === ref.current && !d.state.busy && ref.current?.close()}>
        <form method="dialog" className="cx-dialog-body" onSubmit={(e) => { e.preventDefault(); void go(); }}>
          <div className="cx-dialog-head">
            <div><h2>{d.title}</h2><p>{d.description}</p></div>
            <button type="button" className="cx-icon-btn" aria-label="Close" onClick={() => ref.current?.close()}><Icon name="close" size={18} strokeWidth={2} /></button>
          </div>
          {(d.fields ?? []).map((f) => (
            <div key={f.key} className="cx-field">
              {f.label && <span className="cx-field-label">{f.label}</span>}
              <label className="cx-amount">
                <span className="cx-sr">{f.label ?? 'Amount'} in {f.unit}</span>
                <input inputMode="decimal" value={values[f.key] ?? ''} placeholder="0" data-testid={`${spec.testId ?? 'action'}-${f.key}`}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value.replace(/[^\d.]/g, '') }))} />
                <span>{f.unit}</span>
              </label>
              {f.quick && f.quick.length > 0 && (
                <div className="cx-quick">
                  {f.quick.map((q) => <button key={q.label} type="button" onClick={() => setValues((v) => ({ ...v, [f.key]: q.value }))}>{q.label}</button>)}
                </div>
              )}
            </div>
          ))}
          {d.body}
          {preview.length > 0 && <dl className="cx-kv">{preview.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
          {!signer ? <p className="cx-hint">Connect a wallet (top right) to continue.</p> : (
            <button type="submit" className="cx-btn" aria-disabled={!!d.state.busy || !!d.blocked || undefined} data-testid={`${spec.testId ?? 'action'}-confirm`}>
              {d.state.busy ? `${d.state.busy}…` : d.confirm}
            </button>
          )}
          {invalid ? <p className="cx-hint is-bad" role="alert">{invalid}</p> : d.blocked ? <p className="cx-hint">{d.blocked}</p> : !d.state.sent.length && !d.state.error && d.hint ? <p className="cx-hint">{d.hint}</p> : null}
          <SendStatus s={d.state} done={ok ? 'Done. Read back from the chain:' : undefined} testId={spec.testId} />
        </form>
      </dialog>
    </>
  );
}

/** The card with its tiles beside it; three or more tiles go on a row below it. */
export function Row({ children, specs }: { children?: ReactNode; specs: Spec[] }) {
  const tiles = specs.map((s) => <ActionTile key={s.title} spec={s} />);
  if (specs.length < 3) return <div className="cx-row">{children}{tiles}</div>;
  return (
    <div className="cx-stack">
      {children && <div className="cx-row">{children}</div>}
      <div className="cx-row cx-row-even">{tiles}</div>
    </div>
  );
}
