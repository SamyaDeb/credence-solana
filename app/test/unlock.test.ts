// C1 (plan/09): the credit-unlock file's probabilities are the app's own. For every single-asset position (Kamino and
// Jupiter alias) the helper's P(liquidatable) today and at each target debt equals `modelPays` on the asset's WEEKEND
// set at its σ, and the history count equals `historyPays` on closure-gaps.json: one model, not two. Also the file's
// honesty and reconciliation fields, and the API route leaving the per-position rows out by default.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { historyPays, modelPays } from '@/lib/odds';

// The route's server module guards against client imports; the test runs it as the server does.
vi.mock('server-only', () => ({}));

const root = new URL('../../', import.meta.url).pathname;
const read = (p: string) => JSON.parse(readFileSync(root + p, 'utf8'));
const file = readdirSync(root + 'data/unlock').filter((f) => /^unlock-\d{8}\.json$/.test(f)).sort().pop();

type P = { id: string; path: string; legs: { ticker: string; covered: string }[]; debt: string; pLiquidatable: { n: number; of: number };
  history: { n: number; of: number }; targets: Record<string, { debt: string; pLiquidatable: { n: number; of: number } } | null> };

describe.skipIf(!file)('credit unlock', () => {
  const d = file ? read(`data/unlock/${file}`) : null;

  it('single-asset probabilities are modelPays and historyPays', () => {
    const assets = read('data/onchain/assets.json') as { ticker: string; sigmaWad: string }[];
    const gaps = read('data/sigma/closure-gaps.json').gaps as Record<string, { gap: number }[]>;
    const zs = new Map<string, Int16Array>();
    let checked = 0;
    for (const p of d.positions as P[]) {
      if (p.path === 'multi') continue;
      const t = p.legs[0].ticker.replace(/\.J$/, '');
      if (!zs.has(t)) zs.set(t, Int16Array.from(read(`data/onchain/${t}-WEEKEND.json`).z as number[]));
      const sigma = BigInt(assets.find((a) => a.ticker === t)!.sigmaWad);
      const c = BigInt(p.legs[0].covered);
      expect(modelPays(zs.get(t)!, sigma, c, BigInt(p.debt)).count, p.id).toBe(p.pLiquidatable.n);
      for (const x of Object.values(p.targets)) if (x) expect(modelPays(zs.get(t)!, sigma, c, BigInt(x.debt)).count, p.id).toBe(x.pLiquidatable.n);
      expect(historyPays(gaps[t].map((g) => g.gap), c, BigInt(p.debt)), p.id).toBe(p.history.n);
      checked++;
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('says what it is and reconciles with the scan', () => {
    expect(d.caveat).toBe('What cover would allow, not measured demand.');
    expect(readFileSync(root + `data/unlock/${file!.replace('.json', '.md')}`, 'utf8')).toContain('What cover would allow, not measured demand.');
    expect(d.reconciliation.kamino.positions).toBe(d.reconciliation.kamino.scan);
    expect(d.reconciliation.jupiter.positions).toBe(d.reconciliation.jupiter.scan);
    expect(Object.keys(d.excluded.kamino).length).toBeGreaterThan(0);
    expect(d.excluded.jupiter['debt-JupUSD']).toBeGreaterThan(0);
  });

  it('the API serves the summary without the rows unless asked', async () => {
    process.env.CREDENCE_ROOT = root.replace(/\/$/, '');
    const { GET } = await import('@/app/api/unlock/route');
    const a = await (await GET(new Request('http://x/api/unlock'))).json();
    expect(a.method).toBe(d.method);
    expect(a.positions).toBeUndefined();
    expect(a.aggregates.total.positions).toBe(d.positions.length);
    const b = await (await GET(new Request('http://x/api/unlock?positions=1'))).json();
    expect(b.positions.length).toBe(d.positions.length);
  });
});
