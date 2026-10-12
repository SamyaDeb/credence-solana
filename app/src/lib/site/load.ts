// Server-only: the published snapshot (data/site/snapshot.json) and the off-chain Gap Oracle feed.
// With DATA_HOST_URL set (the Railway data host, deploy/railway/runner.ts), both come from it: its jobs refresh them every
// 10 minutes. Each fetch is cached for a minute; if the host is down or answers something else, the file bundled with the
// deploy is served instead, so a page never fails because of the host. Without DATA_HOST_URL, the local file only, parsed
// once per file version (path + mtime), so a refresh (scripts/src/site-snapshot.ts) is served without a restart.
import 'server-only';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson } from '@/lib/server/fork';
import type { Snapshot } from './snapshot';

const FILE = 'data/site/snapshot.json';
const FEED_FILE = 'data/live/gap-feed-mainnet.json';
const TTL_MS = 60_000;
let cache: { key: string; doc: Snapshot } | null = null;
const remote = new Map<string, { at: number; doc: unknown }>();

/** A published file from the data host, or null (not configured, unreachable, or not the expected document). */
export async function fromHost<T>(path: string, valid: (d: unknown) => boolean): Promise<T | null> {
  const base = process.env.DATA_HOST_URL;
  if (!base) return null;
  const hit = remote.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.doc as T;
  try {
    const r = await fetch(new URL(path, base), { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!r.ok) return (hit?.doc as T) ?? null;
    const doc: unknown = await r.json();
    if (!valid(doc)) return (hit?.doc as T) ?? null;
    remote.set(path, { at: Date.now(), doc });
    return doc as T;
  } catch {
    return (hit?.doc as T) ?? null;
  }
}

function localSnapshot(): Snapshot {
  const p = join(/* turbopackIgnore: true */ ROOT, FILE);
  if (!existsSync(p)) throw new Error('no snapshot yet: run scripts/src/site-snapshot.ts');
  const key = `${p}:${statSync(p).mtimeMs}`;
  if (cache?.key !== key) cache = { key, doc: readJson<Snapshot>(FILE) };
  return cache.doc;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const doc = await fromHost<Snapshot>('/snapshot.json', (d) => (d as Snapshot | null)?.kind === 'credence.site.v1');
  return doc ?? localSnapshot();
}

/** The off-chain feed document (scripts/src/gap-feed-mainnet.ts) with the time its file was written, or null. */
export async function loadGapFeed(): Promise<(Record<string, unknown> & { computedAt: number; fileUpdatedAt: number }) | null> {
  const doc = await fromHost<Record<string, unknown> & { computedAt: number }>('/gap-feed.json', (d) => typeof (d as { computedAt?: unknown } | null)?.computedAt === 'number');
  if (doc) return { ...doc, fileUpdatedAt: doc.computedAt };
  const p = join(/* turbopackIgnore: true */ ROOT, FEED_FILE);
  if (!existsSync(p)) return null;
  return { ...readJson<{ computedAt: number }>(FEED_FILE), fileUpdatedAt: statSync(p).mtimeMs / 1000 };
}
