// Server-only: the published snapshot (data/site/snapshot.json), parsed once per file version (path + mtime), so a refresh
// (scripts/src/site-snapshot.ts) is served without a restart.
import 'server-only';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson } from '@/lib/server/fork';
import type { Snapshot } from './snapshot';

const FILE = 'data/site/snapshot.json';
let cache: { key: string; doc: Snapshot } | null = null;

export function loadSnapshot(): Snapshot {
  const p = join(/* turbopackIgnore: true */ ROOT, FILE);
  if (!existsSync(p)) throw new Error('no snapshot yet: run scripts/src/site-snapshot.ts');
  const key = `${p}:${statSync(p).mtimeMs}`;
  if (cache?.key !== key) cache = { key, doc: readJson<Snapshot>(FILE) };
  return cache.doc;
}
