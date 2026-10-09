// GET ?what=assets|calendar|scenarios&ticker=: the configuration the program is loaded with (data/onchain, the files
// scripts/src/load-onchain.ts uploads and hashes), for the public read-only mode, where credence_core is not deployed:
// the covered assets (mint, Kamino reserves, Scope chain, σ), the XNYS calendar and each asset's WEEKEND scenario set.
import { fail, json, readJson } from '@/lib/server/fork';

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const what = u.searchParams.get('what');
    if (what === 'assets') return json(readJson('data/onchain/assets.json'));
    if (what === 'calendar') return json(readJson('data/onchain/calendar-XNYS.json'));
    if (what === 'scenarios') {
      const t = u.searchParams.get('ticker') ?? '';
      const known = readJson<{ ticker: string }[]>('data/onchain/assets.json').map((a) => a.ticker);
      if (!known.includes(t)) throw new Error(`ticker must be one of ${known.join(', ')}`);
      return json({ ticker: t, z: readJson<{ z: number[] }>(`data/onchain/${t}-WEEKEND.json`).z });
    }
    throw new Error('what must be assets, calendar or scenarios');
  } catch (e) {
    return fail(e, 400);
  }
}
