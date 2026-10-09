// GET: the latest credit-unlock analysis (C1, data/unlock/unlock-<yyyymmdd>.json from scripts/src/unlock.ts): how much
// more credit full Gap Cover with the Liquidation Shield would allow the scanned positions at D/C′ 0.85/0.90/0.95, its
// cost and the LP equity it needs. What cover would allow, not measured demand. Read-only, from the committed file:
// no RPC and no key. Without `?positions=1` the per-position rows are left out (the summary is a few kB, the rows MBs).
import { fail, json, latest, readJson } from '@/lib/server/fork';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const f = latest('data/unlock', /^unlock-\d{8}\.json$/);
    if (!f) return json({ error: 'no unlock analysis yet (scripts/src/unlock.ts)' }, 404);
    const d = readJson<Record<string, unknown>>(f);
    const withPositions = new URL(req.url).searchParams.get('positions') === '1';
    return json({ file: f, ...d, positions: withPositions ? d.positions : undefined });
  } catch (e) {
    return fail(e);
  }
}
