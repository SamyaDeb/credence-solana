// Jupiter Lend in the app (W12): Risk lists both lenders side by side from the mainnet scan, and the Jupiter Lend
// weekend runs on the fork: a real position covered, shielded and settled through Jupiter's own operate.
import { expect, test } from '@playwright/test';

test('Risk lists Kamino and Jupiter Lend side by side', async ({ page }) => {
  await page.goto('/app/risk');
  await expect(page.getByTestId('scan-lenders')).toBeVisible({ timeout: 60_000 });
  for (const l of ['Kamino', 'Jupiter']) {
    expect(Number((await page.getByTestId(`scan-lender-${l}-eligible`).innerText()).replace(/,/g, ''))).toBeGreaterThan(0);
  }
});

test('Jupiter Lend weekend: covered, shielded and settled into the position', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/app/demo');
  await expect(page.getByTestId('jupiter')).toBeVisible();
  await page.getByTestId('jupiter-run').click();
  await expect(page.getByTestId('jupiter-payout')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('jupiter-error')).toHaveCount(0);
  expect(Number((await page.getByTestId('jupiter-advance').innerText()).replace(/[^\d.]/g, ''))).toBeGreaterThan(0);
  const r = async (id: string) => Number(await page.getByTestId(id).getAttribute('data-ratio'));
  expect(await r('jupiter-afterShield')).toBeLessThan(await r('jupiter-bought'));
  expect(await r('jupiter-afterSettlement')).toBeLessThan(1); // healthy after the Monday payment
  await expect(page.getByTestId('jupiter-simulated')).toContainText('cheatcode');
});
