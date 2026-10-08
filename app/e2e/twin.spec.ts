// W1 twin demo in the app: two identical $50k SPYx positions on the fork, A covered and B not. The Liquidation Shield
// repays into A on Sunday night; when Kamino's price moves −8% on Monday morning a plain liquidator liquidates B and
// klend refuses to liquidate A; A settles at the open. Runs against the fork that scripts/demo-app.sh starts.
import { expect, test } from '@playwright/test';

test('twin weekend: the shield keeps A out of liquidation, B is liquidated', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/demo');
  const twin = page.getByTestId('twin');
  await expect(twin).toBeVisible();
  await page.getByTestId('twin-run').click();
  await expect(page.getByTestId('twin-A-outcome')).toBeVisible({ timeout: 280_000 });
  await expect(page.getByTestId('twin-error')).toHaveCount(0);

  // Same start: both at health ≈ 1/0.96.
  const h = async (id: string) => Number(await page.getByTestId(id).getAttribute('data-health'));
  expect(Math.abs((await h('twin-A-bought')) - (await h('twin-B-bought')))).toBeLessThan(0.001);
  // Sunday: the shield raised A's health; B unchanged (interest aside).
  expect(await h('twin-A-afterShield')).toBeGreaterThan((await h('twin-A-bought')) + 0.03);
  // Monday 08:00 ET at −8%: A above the liquidation line, B below it.
  expect(await h('twin-A-atPremarketMove')).toBeGreaterThanOrEqual(1);
  expect(await h('twin-B-atPremarketMove')).toBeLessThan(1);
  await expect(page.getByTestId('twin-A-outcome')).toContainText('Not liquidated');
  await expect(page.getByTestId('twin-B-outcome')).toContainText('Liquidated');
  expect(Number((await page.getByTestId('twin-advance').innerText()).replace(/,/g, ''))).toBeGreaterThan(0);
  // What was simulated is on screen.
  await expect(page.getByTestId('twin-simulated')).toContainText('push account');
  await expect(page.getByTestId('twin-simulated')).toContainText('cheatcode');
});
