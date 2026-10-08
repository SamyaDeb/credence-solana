'use client';
// Every write in the app goes through useSend: each transaction is simulated (a failure is decoded into the program's
// error and never reaches the wallet), signed by the wallet, sent to the fork through the app's own Connection and
// confirmed; the result keeps its signature and compute units, and every error text is redacted. After a run, every
// chain query is re-read.
import type { TransactionInstruction } from '@solana/web3.js';
import { useCallback, useState } from 'react';
import { useSolana } from '@/components/app/Providers';
import { IS_MAINNET, READ_ONLY_NOTE } from '@/lib/network';
import { redact } from '@/lib/redact';
import { TxError, sendTx } from '@/lib/tx';

export type Sent = { label: string; signature: string; cu: number; cuLimit: number };
export type SendState = { busy: string | null; sent: Sent[]; error: string | null };

export function errorText(e: unknown, label?: string): string {
  const pre = label ? `${label}: ` : '';
  if (e instanceof TxError) return `${pre}${e.stage === 'simulate' ? 'simulation failed' : 'transaction failed'}: ${e.message}`;
  return pre + redact((e as Error)?.message ?? String(e));
}

export function useSend() {
  const { conn, signer, refresh } = useSolana();
  const [state, setState] = useState<SendState>({ busy: null, sent: [], error: null });

  /** Runs `steps` in order; each step returns the instructions of one transaction (built just before it is sent, so
   * it sees the previous step's result). Stops at the first failure. Returns the sent transactions, or null. */
  const run = useCallback(async (title: string, steps: { label: string; ixs: () => Promise<TransactionInstruction[]> | TransactionInstruction[] }[]) => {
    if (IS_MAINNET) { setState({ busy: null, sent: [], error: READ_ONLY_NOTE }); return null; }
    if (!signer) { setState({ busy: null, sent: [], error: 'Connect a wallet first.' }); return null; }
    setState({ busy: title, sent: [], error: null });
    const sent: Sent[] = [];
    let current = '';
    try {
      for (const s of steps) {
        current = s.label;
        const ixs = await s.ixs();
        if (!ixs.length) continue;
        const r = await sendTx(conn, signer, ixs);
        sent.push({ label: s.label, signature: r.signature, cu: r.cu, cuLimit: r.cuLimit });
        setState({ busy: title, sent: [...sent], error: null });
      }
      setState({ busy: null, sent, error: null });
      return sent;
    } catch (e) {
      setState({ busy: null, sent, error: errorText(e, current) });
      return null;
    } finally {
      void refresh();
    }
  }, [conn, signer, refresh]);

  const reset = useCallback(() => setState({ busy: null, sent: [], error: null }), []);
  return { ...state, run, reset };
}
