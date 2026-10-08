// The failure paths a judge can hit: buying twice on one position and weekend (A-13), buying from a page left open past
// the bell (INV-3), and a position Phase 1 does not cover. Each shows a clear message, never a crash or a raw program
// error. Leaves the fork's demo weekend settled, so the other specs can run after it on the same fork.
import { expect, test } from '@playwright/test';
import { burner, buyCover, demoStep } from './helpers';

// A real mainnet obligation with two xStock deposits (QQQx + NVDAx): not eligible in Phase 1.
const MULTI = 'AzVQTzc4hRGkVSJ8MPAtS78D7k34VjqDsAvM9wKmfwxF';
const REAL = 'p2D7cLwDgSXwwMxbnverJVAMACkTb8ruURGKBfsyuoQ';

test('a position already covered this weekend cannot be bought again', async ({ page }) => {
  await burner(page);
  await page.goto('/app/demo');
  // A smaller position: each created position borrows from the fork's USDC reserve, whose liquidity is finite.
  await page.getByTestId('demo-debt').fill('10000');
  await page.getByTestId('demo-create').click();
  await expect(page.getByTestId('demo-log')).toContainText('create done', { timeout: 180_000 });
  await page.goto('/app/borrow');
  await buyCover(page);
  await page.reload();
  const again = page.getByTestId('position').first();
  await expect(again.getByTestId('existing-policy')).toContainText('One policy per position and weekend');
  await expect(again.getByTestId('buy')).toBeDisabled();
});

test('a buy from a page left open past the bell fails with a clear message', async ({ page }) => {
  await burner(page);
  await page.goto('/app/borrow');
  await page.getByTestId('real-positions').click();
  await page.getByTestId(`take-${REAL}`).click();
  const card = page.getByTestId('position').first();
  await expect(card.getByTestId('premium')).toHaveText(/USDC/);
  // Friday 4 PM arrives while the page still shows the quote (demo mode moves the fork's clock).
  await demoStep(page, 'close');
  // The page reads the chain clock every 5 s; a click that lands before it notices goes to the program, which refuses.
  const buy = card.getByTestId('buy');
  if ((await buy.count()) > 0 && (await buy.isEnabled())) await buy.click();
  await expect(card.getByTestId('sales-closed').or(card.getByTestId('buy-error'))).toBeVisible({ timeout: 90_000 });
  if (await card.getByTestId('buy-error').isVisible()) await expect(card.getByTestId('buy-error')).toContainText(/sales for this epoch are closed|INV-3/);
  await expect(page.locator('body')).not.toContainText('Application error');
  await page.reload();
  await expect(page.getByTestId('position').first().getByTestId('sales-closed')).toBeVisible();
  // Finish the weekend so the fork is ready for the next one.
  await demoStep(page, 'open', { gap: -0.08 });
  await demoStep(page, 'settle');
});

test('a position Phase 1 does not cover is labelled, with no way to buy', async ({ page }) => {
  const owner = await burner(page);
  const r = await page.request.post('/api/fork/take-position', { data: { obligation: MULTI, owner } });
  expect(r.ok(), await r.text()).toBeTruthy();
  await page.goto('/app/borrow');
  const card = page.getByTestId('position').filter({ hasText: 'not eligible' }).first();
  await expect(card.getByTestId('ineligible')).toContainText('not eligible');
  await expect(card.getByTestId('buy')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Application error');
});
