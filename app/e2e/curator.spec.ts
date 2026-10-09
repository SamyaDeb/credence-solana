// Curator (C2): the book quote shown is the program's own pricing (/api/book-quote, examples/book_quote.rs) and is below
// the sum of the standalone quotes; a curator buys a book in batches with the burner, a reload resumes it (the legs are
// read back from the chain), and sealing pays one premium.
import { expect, test } from '@playwright/test';
import { burner } from './helpers';

const usd = (s: string) => Number(s.replace(/[$,]/g, ''));

test('the book quote is the program pricing and below the sum of standalone quotes', async ({ page }) => {
  await page.goto('/app/curator');
  await page.getByTestId('curator-market').selectOption('jl-SPYx');
  await page.getByTestId('curator-min-debt').fill('1000');
  await page.getByTestId('curator-target').selectOption('0.9');
  const book = page.getByTestId('curator-book-premium');
  await expect(book).toHaveText(/\$\d/);
  const [b, s] = [usd(await book.innerText()), usd(await page.getByTestId('curator-sum-standalone').innerText())];
  expect(b).toBeGreaterThan(0);
  expect(b).toBeLessThan(s);
  await expect(page.getByTestId('curator-saving')).toHaveText(/\d+\.\d%/);
  await expect(page.getByTestId('curator-annualised')).toHaveText(/%.* vs .*%/);
  // The same numbers from the route the page reads (program pricing; the page only formats them).
  const unlock = await (await page.request.get('/api/unlock?positions=1')).json();
  const ids = unlock.positions
    .filter((p: { lender: string; asset: string; debt: string }) => p.lender === 'jupiter' && p.asset === 'SPYx' && Number(p.debt) / 1e6 >= 1000)
    .map((p: { id: string }) => p.id);
  const q = await (await page.request.post('/api/book-quote', { data: { ids, target: '0.9' } })).json();
  expect(b).toBeCloseTo(Number(q.book.premium) / 1e6, 2);
  expect(s).toBeCloseTo(Number(q.sumStandalone) / 1e6, 2);
  // Debt-weighted size buckets (C1), never the median.
  await expect(page.getByTestId('curator-buckets')).toContainText('debt-weighted');
});

test('a curator buys a book in batches, resumes it after a reload and seals it', async ({ page }) => {
  await burner(page);
  await page.goto('/app/curator');
  await page.getByTestId('curator-market').selectOption('kamino');
  // The largest Kamino USDC positions: few enough for an e2e, far enough from their threshold to be coverable.
  await page.getByTestId('curator-min-debt').fill('20000');
  await page.getByTestId('curator-target').selectOption('');
  const progress = page.getByTestId('curator-progress');
  await expect(progress).toHaveText(/0 of (\d+) added/);
  const total = Number((await progress.innerText()).match(/of (\d+)/)![1]);
  expect(total).toBeGreaterThan(1);
  await page.getByTestId('curator-add').click();
  await expect(progress).toHaveText(`${total} of ${total} added`, { timeout: 240_000 });
  await expect(page.getByTestId('curator-book-state')).toHaveText('open');

  // A closed tab: the same book, the legs read back from the chain.
  await page.reload();
  await page.getByTestId('curator-market').selectOption('kamino');
  await page.getByTestId('curator-min-debt').fill('20000');
  await expect(progress).toHaveText(`${total} of ${total} added`);
  await page.getByTestId('curator-seal').click();
  await expect(page.getByTestId('curator-book-state')).toHaveText('sealed', { timeout: 120_000 });
  await expect(page.getByTestId('curator-weekend')).toContainText('open');
});
