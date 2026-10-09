// The multi-collateral PYUSD weekend in the app (W4): a real Sentora xStocks Market obligation with SPYx and NVDAx
// deposits and a PYUSD debt is covered on both legs, the keeper funds the PYUSD sleeve, the shield repays from it on
// Sunday night and settlement pays the rest in PYUSD. Runs against the fork that scripts/demo-app.sh starts.
import { expect, test } from '@playwright/test';

test('multi-collateral PYUSD weekend: two legs covered, shielded and settled from the sleeve', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/app/demo');
  await expect(page.getByTestId('multi')).toBeVisible();
  await page.getByTestId('multi-run').click();
  await expect(page.getByTestId('multi-payout')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('multi-error')).toHaveCount(0);
  await expect(page.getByTestId('multi-legs')).toContainText('SPYx');
  await expect(page.getByTestId('multi-legs')).toContainText('NVDAx');
  const n = async (id: string) => Number((await page.getByTestId(id).innerText()).split('/')[0].replace(/[^\d.]/g, ''));
  expect(await n('multi-premium')).toBeGreaterThan(0);
  expect(await n('multi-advance')).toBeGreaterThan(0);
  const r = async (id: string) => Number(await page.getByTestId(id).getAttribute('data-ratio'));
  expect(await r('multi-afterShield')).toBeLessThan(await r('multi-bought')); // the advance lowered D/C′ before the move
  await expect(page.getByTestId('multi-payout')).toContainText('PYUSD');
  await expect(page.getByTestId('multi-simulated')).toContainText('owner field');
  await expect(page.getByTestId('multi-simulated')).toContainText('cheatcode');
});
