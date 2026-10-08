// The failure paths a judge can hit (audit, step 2): buying twice on one position and weekend, buying from a page left
// open past the bell, and a position Phase 1 does not cover. Each must show a clear message, never a crash or a raw
// program error. Leaves the fork's demo weekend settled, so the happy path can run after it on the same fork.
import { expect, test, type Page } from '@playwright/test';

// A real mainnet obligation with two xStock deposits (QQQx + NVDAx): not eligible in Phase 1.
const MULTI = 'AzVQTzc4hRGkVSJ8MPAtS78D7k34VjqDsAvM9wKmfwxF';
const REAL = 'p2D7cLwDgSXwwMxbnverJVAMACkTb8ruURGKBfsyuoQ';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: number[]): string {
  let n = bytes.reduce((x, b) => x * 256n + BigInt(b), 0n);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

async function burner(page: Page, path = '/') {
  await page.goto(path);
  await page.getByTestId('connect').click();
  await page.getByTestId('use-burner').click();
  await page.getByTestId('fund').click();
  await expect(page.getByTestId('usdc')).toHaveText('50,000.00');
  // The burner's public key is the second half of its stored 64-byte secret key.
  const secret = await page.evaluate(() => JSON.parse(localStorage.getItem('credence.burner.v1') ?? '[]') as number[]);
  return base58(secret.slice(32));
}

async function demoStep(page: Page, step: string, extra: Record<string, unknown> = {}) {
  const r = await page.request.post('/api/demo/step', { data: { step, ...extra }, timeout: 120_000 });
  const out = await r.text();
  expect(out, out).toContain('@@exit 0');
}

test('a position already covered this weekend cannot be bought again', async ({ page }) => {
  await burner(page, '/demo');
  await page.getByTestId('demo-create').click();
  await expect(page.getByTestId('demo-log')).toContainText('create done', { timeout: 120_000 });
  await page.locator('nav.tabs').getByRole('link', { name: 'My weekend risk' }).click();
  const card = page.getByTestId('position').first();
  await expect(card.getByTestId('premium')).toHaveText(/USDC/);
  await card.getByTestId('buy').click();
  await expect(card.getByTestId('policy-result')).toBeVisible({ timeout: 90_000 });

  await page.reload();
  const again = page.getByTestId('position').first();
  await expect(again.getByTestId('existing-policy')).toContainText('One policy per position and weekend');
  await expect(again.getByTestId('buy')).toBeDisabled();
});

test('a buy from a page left open past the bell fails with a clear message', async ({ page }) => {
  await burner(page);
  await page.getByTestId('real-positions').click();
  await page.getByTestId(`take-${REAL}`).click();
  const card = page.getByTestId('position').first();
  await expect(card.getByTestId('premium')).toHaveText(/USDC/);
  // Friday 4 PM arrives while the page still shows the quote (demo mode moves the fork's clock).
  await demoStep(page, 'close');
  // The page reads the chain clock every 5 s; a click that lands before it notices goes to the program, which refuses.
  const buy = card.getByTestId('buy');
  if ((await buy.count()) > 0 && (await buy.isEnabled())) await buy.click();
  // Either the page noticed the bell, or the program refused the purchase and the page says why.
  await expect(card.getByTestId('sales-closed').or(card.getByTestId('buy-error'))).toBeVisible({ timeout: 90_000 });
  if (await card.getByTestId('buy-error').isVisible()) {
    await expect(card.getByTestId('buy-error')).toContainText(/sales for this epoch are closed|INV-3/);
  }
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
  await page.reload();
  const card = page.getByTestId('position').filter({ hasText: 'not eligible' }).first();
  await expect(card.getByTestId('ineligible')).toContainText('not eligible');
  await expect(card.getByTestId('buy')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Application error');
});
