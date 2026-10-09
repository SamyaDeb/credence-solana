// The twin weekend in the app (W1 Liquidation Shield, W2 Monday Backstop): two identical $50k SPYx positions on the fork,
// A covered and B not. The shield repays into A on Sunday night; when Kamino's price moves −8% on Monday morning,
// Credence's backstop tries both: klend refuses A, the vault liquidates B and auctions its SPYx, and a buyer takes half
// the lot. A settles at the open. Then Auctions shows the rest of the lot on sale and a wallet buys some of it, and
// Underwrite shows the yield vault's APY split. Runs against the fork that scripts/demo-app.sh starts.
import { expect, test } from '@playwright/test';
import { burner } from './helpers';
import { chainVault } from './chain';

test('twin weekend: shield keeps A healthy, the backstop liquidates B, the lot sells', async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto('/app/demo');
  await expect(page.getByTestId('twin')).toBeVisible();
  await page.getByTestId('twin-run').click();
  await expect(page.getByTestId('twin-A-outcome')).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('twin-error')).toHaveCount(0);

  const h = async (id: string) => Number(await page.getByTestId(id).getAttribute('data-health'));
  expect(Math.abs((await h('twin-A-bought')) - (await h('twin-B-bought')))).toBeLessThan(0.001);
  expect(await h('twin-A-afterShield')).toBeGreaterThan((await h('twin-A-bought')) + 0.03);
  // Monday 08:00 ET at −8%: A at or above 1.02 (the shield counts the weekend's interest, task 1.2), B below 1.
  expect(await h('twin-A-atPremarketMove')).toBeGreaterThanOrEqual(1.02);
  expect(await h('twin-B-atPremarketMove')).toBeLessThan(1);
  await expect(page.getByTestId('twin-A-outcome')).toContainText('Not liquidated');
  await expect(page.getByTestId('twin-B-outcome')).toContainText("Liquidated by Credence's backstop");
  expect(Number((await page.getByTestId('twin-advance').innerText()).replace(/,/g, ''))).toBeGreaterThan(0);
  await expect(page.getByTestId('twin-sale')).toBeVisible();
  await expect(page.getByTestId('twin-sold')).toContainText('SPYx at');
  await expect(page.getByTestId('twin-simulated')).toContainText('push account');
  await expect(page.getByTestId('twin-simulated')).toContainText('cheatcode');
});

test('Auctions: the backstop lot is on sale and a wallet buys part of it', async ({ page }) => {
  test.setTimeout(180_000);
  await burner(page);
  await page.goto('/app/auctions');
  await expect(page.getByTestId('backstop-pool')).toBeVisible();
  await expect(page.getByTestId('lot-SPYx-onsale')).toBeVisible({ timeout: 30_000 });
  const held0 = Number((await page.getByTestId('lot-SPYx-held').innerText()).replace(/[^\d.]/g, ''));
  expect(held0).toBeGreaterThan(0);
  await expect(page.getByTestId('lot-SPYx-price')).toHaveText(/\d/);
  await page.getByTestId('buy-SPYx').click();
  await page.getByTestId('buy-SPYx-qty').fill('0.5');
  await page.getByTestId('buy-SPYx-confirm').click();
  await expect(page.getByTestId('buy-SPYx-sent')).toContainText('buy_from_sale', { timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect.poll(async () => Number((await page.getByTestId('lot-SPYx-held').innerText()).replace(/[^\d.]/g, '')), { timeout: 30_000 })
    .toBeCloseTo(held0 - 0.5, 3);
  expect(Number((await page.getByTestId('backstop-counts').innerText()).split('/')[1])).toBeGreaterThanOrEqual(2);
});

test('Underwrite: the yield vault lends cash above the buffer and splits the LP APY', async ({ page }) => {
  await page.goto('/app/underwrite');
  await expect(page.getByTestId('yield-split')).toBeVisible({ timeout: 30_000 });
  const v = await chainVault();
  await expect(page.getByTestId('vault-supply-apr')).toHaveText(/\d+\.\d\d%/);
  await expect(page.getByTestId('vault-apy-supply')).toHaveText(/\d+\.\d\d%/);
  expect(v.lentValue).toBeGreaterThan(0n); // the keeper's rebalance lent the surplus (demo-app.sh / twin runs keeper passes)
  expect(await page.getByTestId('vault-lent').innerText()).toContain((Number(v.lentValue) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
});
