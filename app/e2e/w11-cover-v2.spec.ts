// Named w11-… so it runs after the other flows: it time-travels the fork weeks ahead (to the Dec 24 holiday).
// Cover v2 in the app (W11): one weekend with DOWN and UP cover netted in a group (UP paid to the short's wallet), then
// an overnight and a holiday-weekend cover, each settled, on the fork through the keeper.
import { expect, test } from '@playwright/test';

test('Cover v2: UP and DOWN netted, overnight and holiday weekend settled', async ({ page }) => {
  // The keeper's weekend walk takes 4.8 to 6+ minutes at the end of the suite (the fork's clock is weeks ahead by then, and
  // the pass walks the weekends behind it); the bound used to be exactly 6 (audit A-185).
  test.setTimeout(900_000);
  await page.goto('/app/demo');
  await expect(page.getByTestId('cover-v2')).toBeVisible();
  await page.getByTestId('cover-v2-run').click();
  await expect(page.getByTestId('cover-v2-netting')).toBeVisible({ timeout: 780_000 });
  await expect(page.getByTestId('cover-v2-error')).toHaveCount(0);
  const reserved = page.getByTestId('cover-v2-reserved');
  expect(Number(await reserved.getAttribute('data-reserved'))).toBeLessThan(Number(await reserved.getAttribute('data-sum')));
  const usdc = async (id: string) => Number((await page.getByTestId(id).innerText()).replace(/[^\d.]/g, ''));
  expect(await usdc('cover-v2-up-payout')).toBeGreaterThan(0);
  expect(await usdc('cover-v2-wallet')).toBeCloseTo(await usdc('cover-v2-up-payout'), 1);
  await expect(page.getByTestId('cover-v2-overnight')).toContainText('payout');
  await expect(page.getByTestId('cover-v2-holiday')).toContainText('payout');
  await expect(page.getByTestId('cover-v2-failed')).toHaveText('0');
  await expect(page.getByTestId('cover-v2-simulated')).toContainText('time travel');
});
