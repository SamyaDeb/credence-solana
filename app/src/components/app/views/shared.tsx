'use client';
// Pieces several pages share: loading and error states, the connect prompt, the market-state pill and the chain clock.
import type { ReactNode } from 'react';
import { et, utc } from '@/lib/format';
import type { MarketState } from '@/lib/markets';
import { IS_MAINNET } from '@/lib/network';
import { redact } from '@/lib/redact';
import { Note, Pill, Sim, type Tone } from '../ui';

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <p className="cx-page-sub" style={{ margin: 0 }}>{what}…</p>;
}

export function ErrorNote({ error, what = 'the fork' }: { error: unknown; what?: string }) {
  const msg = redact(error instanceof Error ? error.message : String(error));
  return <Note icon="alert" tone="bad">Couldn&apos;t read {what}: {msg}. Is <code>scripts/demo-app.sh</code> running? The app retries on its own.</Note>;
}

export function ConnectNote({ children }: { children: ReactNode }) {
  return <Note icon="lock">{children} Use <b>Connect wallet</b> at the top right: Phantom, or the demo burner wallet.</Note>;
}

export const STATE_LABEL: Record<MarketState['state'], string> = { open: 'Open', closed: 'Closed overnight', weekend: 'Weekend', holiday: 'Holiday weekend', unknown: 'Off calendar' };
export const STATE_TONE: Record<MarketState['state'], Tone> = { open: 'good', closed: 'soft', weekend: 'warn', holiday: 'warn', unknown: 'soft' };

export function StatePill({ s, testId }: { s: MarketState['state']; testId?: string }) {
  return <Pill tone={STATE_TONE[s]} testId={testId}>{STATE_LABEL[s]}</Pill>;
}

/** Chain time with its label: surfpool moves the fork's clock in demo mode, so it is not the wall clock. */
export function ChainTime({ now }: { now: number | null }) {
  return (
    <span title={now ? et(now) : undefined}>
      <span className="cx-mono" data-testid="chain-time">{now ? utc(now) : '…'}</span>{' '}
      {!IS_MAINNET && <Sim title="The fork's Clock sysvar; demo mode moves it to the Friday close and the Monday open">fork clock</Sim>}
    </span>
  );
}
