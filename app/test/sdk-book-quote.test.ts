// C3: the SDK's two book-quote paths agree with each other and with examples/book_quote.rs. `bookQuoteHttp` goes through
// the app's /api/book-quote route (the route's handler is called directly), `bookQuoteLocal` (`@credence/sdk/node`)
// spawns the helper itself with the same positions; the replies must be equal field for field: the SDK prices nothing.
// Skipped when the helper is not built (cargo build -p credence-core --example book_quote).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { bookQuoteHttp } from '@credence/sdk';
import { bookQuoteLocal } from '@credence/sdk/node';

vi.mock('server-only', () => ({}));

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const file = readdirSync(root + '/data/unlock').filter((f) => /^unlock-\d{8}\.json$/.test(f)).sort().pop();
const bin = ['target/release/examples/book_quote', 'target/debug/examples/book_quote'].map((p) => `${root}/${p}`).find(existsSync);

describe.skipIf(!file || !bin)('SDK book quote', () => {
  const d = JSON.parse(readFileSync(`${root}/data/unlock/${file}`, 'utf8'));
  process.env.CREDENCE_ROOT = root;
  const fetchRoute: typeof fetch = async (_url, init) => {
    const { POST } = await import('@/app/api/book-quote/route');
    return POST(new Request('http://x/api/book-quote', { method: 'POST', body: init!.body as string }));
  };
  const rows = (lender: string, n: number) => (d.positions as any[]).filter((p) => p.lender === lender && p.path !== 'multi' && p.targets['0.9']).slice(0, n); // eslint-disable-line @typescript-eslint/no-explicit-any

  for (const lender of ['kamino', 'jupiter']) {
    it(`${lender}: bookQuoteHttp (the route) equals bookQuoteLocal (the helper)`, async () => {
      const picked = rows(lender, 25);
      const viaHttp = await bookQuoteHttp('http://x', { ids: picked.map((p) => p.id), target: '0.9' }, fetchRoute);
      const viaLocal = await bookQuoteLocal(root, {
        positions: picked.map((p) => ({ id: p.id, legs: p.legs, stable: p.stable, debt: p.debt, multi: false })),
        basisWad: d.parameters.basisWad, utilWad: '0', targetWad: (BigInt(Math.round(0.9 * 1e6)) * 10n ** 12n).toString(),
      }, { bin });
      expect(viaLocal.book).toEqual(viaHttp.book);
      expect(viaLocal.sumStandalone).toBe(viaHttp.sumStandalone);
      expect(viaLocal.legs).toEqual(viaHttp.legs);
      expect(BigInt(viaHttp.book!.premium) <= BigInt(viaHttp.sumStandalone)).toBe(true);
    });
  }

  it('a one-leg book is that position’s standalone premium (the program’s quote_cover, risk-core book_premium reducing to it)', async () => {
    const [p] = rows('kamino', 1);
    const q = await bookQuoteHttp('http://x', { ids: [p.id], target: '0.9' }, fetchRoute);
    expect(q.book!.premium).toBe(q.legs[0].standalone);
  });
});
