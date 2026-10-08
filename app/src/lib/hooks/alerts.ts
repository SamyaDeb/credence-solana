'use client';
// The wallet's alerts, derived from chain state (lib/alerts.ts), and which ones were read (this browser's storage).
// Positions are read as klend stored them at their last refresh (no simulation, no fork cheatcode), so the sidebar
// badge never changes fork state in the background.
import type { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSolana } from '@/components/app/Providers';
import { deriveAlerts } from '@/lib/alerts';
import { POLICY } from '@/lib/credence';
import { reserveToAsset } from '@/lib/cover';
import { ineligibility, loadReserves, obligationsOf, snapshot, borrows, deposits } from '@/lib/kamino';
import { usePrefs } from '@/lib/prefs';
import { useAssets, useClock, useEpochs } from './chain';
import { usePolicies } from './positions';
import { useQueue, useVault } from './vault';

const READ_KEY = 'credence.alerts.read.v1';
const READ_EVENT = 'credence-alerts-read';

function useStoredPositions(owner: PublicKey | null | undefined) {
  const { conn } = useSolana();
  const assets = useAssets();
  return useQuery({
    queryKey: ['stored-positions', owner?.toBase58()],
    enabled: !!owner && !!assets.data,
    queryFn: async () => {
      const byReserve = reserveToAsset(assets.data!);
      const obs = await obligationsOf(conn, owner!);
      const reserves = await loadReserves(conn, obs.flatMap((o) => [...deposits(o.state), ...borrows(o.state)]));
      const tickers = new Map([...byReserve].map(([k, v]) => [k, v.ticker]));
      return obs.map((o) => {
        const s = snapshot(o.state);
        return { key: o.key, ticker: byReserve.get(deposits(o.state)[0]?.toBase58() ?? '')?.ticker ?? 'xStock', eligible: !ineligibility(o.state, reserves, tickers),
          ratio: s.coveredValue > 0n ? Number(s.debt) / Number(s.coveredValue) : null };
      });
    },
    refetchInterval: 30_000,
  });
}

export function useAlerts() {
  const { signer } = useSolana();
  const owner = signer?.publicKey;
  const { now } = useClock();
  const epochs = useEpochs();
  const policies = usePolicies(owner);
  const queue = useQueue(owner);
  const vault = useVault();
  const pos = useStoredPositions(owner);
  const [prefs] = usePrefs();
  const [read, setRead] = useState<Set<string>>(new Set());
  // Read ids are shared by every useAlerts on the page (the sidebar badge and the Alerts page) through an event.
  useEffect(() => {
    const load = () => { try { setRead(new Set(JSON.parse(localStorage.getItem(READ_KEY) ?? '[]') as string[])); } catch { /* none */ } };
    load();
    window.addEventListener(READ_EVENT, load);
    return () => window.removeEventListener(READ_EVENT, load);
  }, []);

  const alerts = useMemo(() => {
    if (!owner || now === null) return [];
    const active = new Set((policies.data ?? []).filter((p) => p.state === POLICY.ACTIVE).map((p) => p.obligation.toBase58()));
    return deriveAlerts({
      now, prefs, epochs: epochs.data ?? [], policies: policies.data ?? [], tickets: queue.data ?? [], live: vault.data?.view.live ?? [],
      positions: (pos.data ?? []).map((p) => ({ ...p, covered: active.has(p.key.toBase58()) })),
    });
  }, [owner, now, prefs, epochs.data, policies.data, queue.data, vault.data, pos.data]);

  const save = (s: Set<string>) => {
    setRead(s);
    try { localStorage.setItem(READ_KEY, JSON.stringify([...s])); } catch { /* this visit only */ }
    window.dispatchEvent(new Event(READ_EVENT));
  };
  const markRead = useCallback((ids: string[]) => save(new Set([...read, ...ids])), [read]);
  const markUnread = useCallback((id: string) => { const s = new Set(read); s.delete(id); save(s); }, [read]);
  const unread = alerts.filter((a) => !read.has(a.id)).length;
  return { alerts, read, unread, markRead, markUnread, loading: !!owner && (epochs.isLoading || policies.isLoading) };
}

