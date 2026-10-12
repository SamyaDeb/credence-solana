// GET: eligible near-threshold positions from the latest mainnet scan (task 3.3, data/positions), for the
// "Use a real mainnet position" button. Values are from the scan (each obligation's last klend refresh on mainnet).
// With DATA_HOST_URL, the data host's scan (refreshed every 6 h); otherwise, or if the host is down, the bundled one.
import { fail, json, latest, readJson } from '@/lib/server/fork';
import { throttle } from '@/lib/server/limit';
import { type ScanFile, candidates } from '@/lib/scan-candidates';
import { fromHost } from '@/lib/site/load';

export async function GET(req: Request) {
  const limited = throttle(req, 'read');
  if (limited) return limited;
  try {
    const hosted = await fromHost<ReturnType<typeof candidates>>('/candidates.json', (d) => Array.isArray((d as { rows?: unknown } | null)?.rows));
    if (hosted) return json(hosted);
    const f = latest('data/positions', /^positions-\d+\.json$/);
    if (!f) throw new Error('no data/positions scan (run scripts/src/positions.ts)');
    return json(candidates(f, readJson<ScanFile>(f)));
  } catch (e) {
    return fail(e);
  }
}
