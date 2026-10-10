// GET: the Gap Oracle feed computed OFF-CHAIN from mainnet inputs, for the public read-only mode where credence_core (and so
// the GapFeed account) is not deployed. The numbers are the program's own Rust (`examples/gap_feed.rs` →
// `credence_core::instructions::gap_feed::compute`, the function `update_gap_feed` runs), fed by
// scripts/src/gap-feed-mainnet.ts with mainnet's Scope and Pyth push accounts and the captured Friday close. This route
// only serves the latest file; nothing is priced here and no RPC key is read.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, fail, json, readJson } from '@/lib/server/fork';

export const dynamic = 'force-dynamic';
const FILE = 'data/live/gap-feed-mainnet.json';

export async function GET() {
  try {
    if (!existsSync(join(/* turbopackIgnore: true */ ROOT, FILE))) return json({ error: `no off-chain feed yet: run scripts/src/gap-feed-mainnet.ts (writes ${FILE})` }, 404);
    const doc = readJson<{ computedAt: number }>(FILE);
    return json({ ...doc, fileUpdatedAt: statSync(join(/* turbopackIgnore: true */ ROOT, FILE)).mtimeMs / 1000 });
  } catch (e) {
    return fail(e, 500);
  }
}
