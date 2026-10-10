// GET: every real market closure's opening gap per asset since Apr 2016 (data/sigma/closure-gaps.json), for the
// "N of M closures would have paid" line next to each premium.
import { fail, json, readJson } from '@/lib/server/fork';
import { throttle } from '@/lib/server/limit';

type G = { source: string; closures: Record<string, number>; gaps: Record<string, { open: string; gap: number }[]> };

export async function GET(req: Request) {
  const limited = throttle(req, 'read');
  if (limited) return limited;
  try {
    const d = readJson<G>('data/sigma/closure-gaps.json');
    const first = Object.values(d.gaps)[0] ?? [];
    return json({ source: d.source, closures: d.closures, from: first[0]?.open, to: first.at(-1)?.open,
      gaps: Object.fromEntries(Object.entries(d.gaps).map(([t, g]) => [t, g.map((x) => x.gap)])) });
  } catch (e) {
    return fail(e);
  }
}
