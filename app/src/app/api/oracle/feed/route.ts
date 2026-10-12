// GET: the Gap Oracle feed computed OFF-CHAIN from mainnet inputs, for the public read-only mode where credence_core (and so
// the GapFeed account) is not deployed. The numbers are the program's own Rust (`examples/gap_feed.rs` →
// `credence_core::instructions::gap_feed::compute`, the function `update_gap_feed` runs), fed by
// scripts/src/gap-feed-mainnet.ts with mainnet's Scope and Pyth push accounts and the captured Friday close. This route
// only serves the latest file (from the data host when DATA_HOST_URL is set, lib/site/load.ts); nothing is priced here and
// no RPC key is read.
import { fail, json } from '@/lib/server/fork';
import { throttle } from '@/lib/server/limit';
import { loadGapFeed } from '@/lib/site/load';

export const dynamic = 'force-dynamic';
const FILE = 'data/live/gap-feed-mainnet.json';

export async function GET(req: Request) {
  const limited = throttle(req, 'read');
  if (limited) return limited;
  try {
    const doc = await loadGapFeed();
    if (!doc) return json({ error: `no off-chain feed yet: run scripts/src/gap-feed-mainnet.ts (writes ${FILE})` }, 404);
    return json(doc);
  } catch (e) {
    return fail(e, 500);
  }
}
