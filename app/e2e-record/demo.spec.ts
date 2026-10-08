// The demo video's shots in order. Each `hold` leaves time for the voice-over; `show`
// scrolls an element to the middle of the frame. Every number on screen comes from the fork.
import { type Locator, type Page, expect, test } from '@playwright/test';

const hold = (page: Page, s: number) => page.waitForTimeout(s * 1000);
const show = async (l: Locator) => l.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
const tab = (page: Page, name: string) => page.locator('nav.tabs').getByRole('link', { name }).click();

test('demo video', async ({ page }) => {
  // 0:15 Gap Oracle: the frozen weekend price and S7.
  await page.goto('/oracle');
  await hold(page, 6);
  await page.mouse.wheel(0, 700);
  await hold(page, 8);
  await page.mouse.wheel(0, 900);
  await hold(page, 8);

  // 0:40 Connect the burner, fund it, create the $50k position at D/C′ 0.96.
  await tab(page, 'Demo mode');
  await page.getByTestId('connect').click();
  await page.getByTestId('use-burner').click();
  await page.getByTestId('fund').click();
  await expect(page.getByTestId('usdc')).toHaveText('50,000.00');
  await hold(page, 2);
  await page.getByTestId('demo-create').click();
  await expect(page.getByTestId('demo-log')).toContainText('create done', { timeout: 120_000 });
  await hold(page, 3);

  // 1:00 My weekend risk: the position and the loss table.
  await tab(page, 'My weekend risk');
  const card = page.getByTestId('position').first();
  await expect(card.getByTestId('loss-table')).toBeVisible();
  await show(card.getByTestId('ratio'));
  await hold(page, 8);
  await show(card.getByTestId('loss-table'));
  await hold(page, 10);

  // 1:25 The quote and the chance it pays.
  await expect(card.getByTestId('pay-odds').first()).toBeVisible();
  await show(card.getByTestId('premium'));
  await hold(page, 14);

  // 1:50 Buy: one transaction, the Policy read back.
  await card.getByTestId('buy').click();
  await expect(card.getByTestId('policy-result')).toBeVisible({ timeout: 90_000 });
  await show(card.getByTestId('policy-result'));
  await hold(page, 9);

  // 2:05 The weekend: Friday close → Monday −8% → settle into the position.
  await tab(page, 'Demo mode');
  await show(page.getByTestId('demo-close'));
  await hold(page, 2);
  await page.getByTestId('demo-close').click();
  await expect(page.getByTestId('demo-log')).toContainText('close done', { timeout: 90_000 });
  await hold(page, 3);
  await page.getByTestId('demo-gap').selectOption('-0.08');
  await page.getByTestId('demo-open').click();
  await expect(page.getByTestId('demo-log')).toContainText('open done', { timeout: 90_000 });
  await hold(page, 3);
  await page.getByTestId('demo-settle').click();
  await expect(page.getByTestId('demo-log')).toContainText('settle done', { timeout: 90_000 });
  await hold(page, 4);
  await show(page.getByTestId('before-after'));
  await hold(page, 9);
  await show(page.getByTestId('simulated'));
  await hold(page, 5);

  // 2:35 Underwriters: vault from the chain, the backtest.
  await tab(page, 'Underwriters');
  await expect(page.getByTestId('vault')).toBeVisible();
  await hold(page, 5);
  await show(page.getByTestId('backtest'));
  await hold(page, 10);
});
