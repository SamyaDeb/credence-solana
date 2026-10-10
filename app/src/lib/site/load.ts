// Server-only: the published snapshot (data/site/snapshot.json). Read per request so the as-of labels use the request's time.
import 'server-only';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson } from '@/lib/server/fork';
import type { Snapshot } from './snapshot';

const FILE = 'data/site/snapshot.json';
let cache: { mtime: number; doc: Snapshot } | null = null;

export function loadSnapshot(): Snapshot {
  const p = join(/* turbopackIgnore: true */ ROOT, FILE);
  if (!existsSync(p)) throw new Error('no snapshot yet: run scripts/src/site-snapshot.ts');
  return (cache ??= { mtime: 0, doc: readJson<Snapshot>(FILE) }).doc;
}
