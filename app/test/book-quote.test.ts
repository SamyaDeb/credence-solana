// C2: the Curator page's book quote (/api/book-quote → examples/book_quote.rs) is the program's pricing: a one-leg book
// equals that position's standalone premium (risk-core's book_premium reduces to buy_cover's premium for one leg), a
// book is never above the sum of its legs' standalone premiums nor below its riskiest leg's, and the route rejects bad
// input. Skipped when the helper is not built (cargo build -p credence-core --example book_quote).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const root = new URL('../../', import.meta.url).pathname;
const file = readdirSync(root + 'data/unlock').filter((f) => /^unlock-\d{8}\.json$/.test(f)).sort().pop();
const built = ['target/release/examples/book_quote', 'target/debug/examples/book_quote'].some((p) => existsSync(root + p));

describe.skipIf(!file || !built)('book quote', () => {
  const d = JSON.parse(readFileSync(`${root}data/unlock/${file}`, 'utf8'));
  process.env.CREDENCE_ROOT = root.replace(/\/$/, '');
  const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/book-quote/route');
    const r = await POST(new Request('http://x/api/book-quote', { method: 'POST', body: JSON.stringify(body) }));
    return { status: r.status, j: await r.json() };
  };
  const ids = (pred: (p: any) => boolean, n: number) => (d.positions as any[]).filter(pred).slice(0, n).map((p) => p.id); // eslint-disable-line @typescript-eslint/no-explicit-any

  it('one leg is its standalone premium; a book sits between its riskiest leg and the sum', async () => {
    for (const lender of ['kamino', 'jupiter']) {
      const pick = ids((p) => p.lender === lender && p.path !== 'multi' && p.targets['0.9'], 60);
      for (const id of pick.slice(0, 5)) {
        const { j } = await post({ ids: [id], target: '0.9' });
        expect(j.book.premium, `${lender} ${id}`).toBe(j.legs[0].standalone);
      }
      const { j } = await post({ ids: pick, target: '0.9' });
      const legs = j.legs.map((l: { standalone: string }) => BigInt(l.standalone));
      const book = BigInt(j.book.premium);
      expect(book <= BigInt(j.sumStandalone)).toBe(true);
      expect(legs.every((s: bigint) => book >= s)).toBe(true);
      expect(book < BigInt(j.sumStandalone)).toBe(true); // 60 legs: one floor instead of sixty
    }
  });

  it('rejects bad input', async () => {
    expect((await post({ ids: [] })).status).toBe(400);
    expect((await post({ ids: ['x'], target: '0.5' })).status).toBe(400);
    expect((await post({ ids: ['x'], utilWad: '-1' })).status).toBe(400);
  });
});
